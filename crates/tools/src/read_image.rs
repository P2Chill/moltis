//! `read_image` tool — read a local image file and inject it into the model's
//! vision context for the next turn.
//!
//! Returns a JSON object containing a `data:{mime};base64,...` URI. The runner
//! detects extractable image data in tool results and, for vision-capable
//! providers, appends a synthetic User-role multimodal message carrying the
//! image so the model can see it on the next API call.

use {
    async_trait::async_trait,
    base64::{Engine as _, engine::general_purpose::STANDARD as BASE64},
    moltis_agents::tool_registry::AgentTool,
    serde_json::{Value, json},
    std::{
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    },
    tracing::{debug, warn},
};

use crate::error::Error;
use crate::{exec::ExecOpts, sandbox::SandboxRouter};

const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
const MAX_SANDBOX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const SANDBOX_TOO_LARGE_PREFIX: &str = "__MOLTIS_READ_IMAGE_TOO_LARGE__:";

#[derive(Default)]
pub struct ReadImageTool {
    sandbox_router: Option<Arc<SandboxRouter>>,
}

impl ReadImageTool {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_sandbox_router(mut self, router: Arc<SandboxRouter>) -> Self {
        self.sandbox_router = Some(router);
        self
    }

    async fn read_host_file(path: &str) -> crate::Result<Vec<u8>> {
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|e| Error::message(format!("cannot access '{path}': {e}")))?;
        if !meta.is_file() {
            return Err(Error::message(format!("'{path}' is not a regular file")));
        }
        if meta.len() > MAX_FILE_SIZE {
            return Err(Error::message(format!(
                "file is too large ({:.1} MB) — maximum is {:.0} MB",
                meta.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0),
            )));
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| Error::message(format!("failed to read '{path}': {e}")))?;
        if bytes.len() as u64 > MAX_FILE_SIZE {
            return Err(Error::message(format!(
                "file is too large ({:.1} MB) — maximum is {:.0} MB",
                bytes.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0),
            )));
        }
        Ok(bytes)
    }

    async fn read_sandbox_file(
        router: &SandboxRouter,
        session_key: &str,
        path: &str,
    ) -> crate::Result<Vec<u8>> {
        let sandbox_id = router.sandbox_id_for(session_key);
        let image = router.resolve_image(session_key, None).await;
        let backend = router.backend();
        backend.ensure_ready(&sandbox_id, Some(&image)).await?;
        let quoted_path = shell_single_quote(path);
        let command = format!(
            "if [ ! -f {quoted_path} ]; then echo \"path is not a regular file\" >&2; exit 2; fi; \
             size=$(wc -c < {quoted_path}); \
             if [ \"$size\" -gt {MAX_FILE_SIZE} ]; then echo \"{SANDBOX_TOO_LARGE_PREFIX}$size\" >&2; exit 3; fi; \
             base64 < {quoted_path} | tr -d '\\n'"
        );
        let opts = ExecOpts {
            timeout: Duration::from_secs(30),
            max_output_bytes: MAX_SANDBOX_OUTPUT_BYTES,
            working_dir: Some(PathBuf::from("/home/sandbox")),
            env: Vec::new(),
        };
        let result = backend.exec(&sandbox_id, &command, &opts).await?;
        if result.exit_code != 0 {
            if let Some(size_str) = result
                .stderr
                .lines()
                .find_map(|line| line.strip_prefix(SANDBOX_TOO_LARGE_PREFIX))
                && let Ok(size) = size_str.trim().parse::<u64>()
            {
                return Err(Error::message(format!(
                    "file is too large ({:.1} MB) — maximum is {:.0} MB",
                    size as f64 / (1024.0 * 1024.0),
                    MAX_FILE_SIZE as f64 / (1024.0 * 1024.0),
                )));
            }
            let detail = if !result.stderr.trim().is_empty() {
                result.stderr.trim().to_string()
            } else if !result.stdout.trim().is_empty() {
                result.stdout.trim().to_string()
            } else {
                format!("sandbox command failed with exit code {}", result.exit_code)
            };
            return Err(Error::message(format!(
                "cannot access '{path}' in sandbox: {detail}"
            )));
        }
        let bytes = BASE64
            .decode(result.stdout.trim())
            .map_err(|e| Error::message(format!("failed to decode sandbox file '{path}': {e}")))?;
        if bytes.len() as u64 > MAX_FILE_SIZE {
            return Err(Error::message(format!(
                "file is too large ({:.1} MB) — maximum is {:.0} MB",
                bytes.len() as f64 / (1024.0 * 1024.0),
                MAX_FILE_SIZE as f64 / (1024.0 * 1024.0),
            )));
        }
        Ok(bytes)
    }

    async fn read_file_for_session(&self, session_key: &str, path: &str) -> crate::Result<Vec<u8>> {
        let Some(ref router) = self.sandbox_router else {
            return Self::read_host_file(path).await;
        };
        if !router.is_sandboxed(session_key).await {
            return Self::read_host_file(path).await;
        }
        match Self::read_sandbox_file(router, session_key, path).await {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                warn!(session_key, path, error = %error, "read_image failed to read from sandbox");
                Err(error)
            },
        }
    }
}

fn mime_from_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[async_trait]
impl AgentTool for ReadImageTool {
    fn name(&self) -> &str {
        "read_image"
    }

    fn description(&self) -> &str {
        "Read a local image file and load it into your vision context for THIS \
         response. The image becomes visible to you immediately within the same \
         turn — describe what you see directly in your reply, do NOT say 'I'll \
         describe it next turn' or wait for follow-up. Use when the user \
         references an image by file path (screenshot, photo, etc.). Do NOT use \
         for sending images to a chat channel — that's `send_image`. Supported: \
         PNG, JPEG, GIF, WebP. Max 20 MB. Note: the image is only visible during \
         this turn; if the user asks about it again later, call `read_image` again."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute file path to the image (e.g. /tmp/screenshot.png)"
                }
            }
        })
    }

    async fn execute(&self, params: Value) -> anyhow::Result<Value> {
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::message("missing 'path' parameter"))?;
        let session_key = params
            .get("_session_key")
            .and_then(Value::as_str)
            .unwrap_or("main");

        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .ok_or_else(|| {
                Error::message("file has no extension — supported: png, jpg, jpeg, gif, webp")
            })?;
        let mime = mime_from_extension(ext).ok_or_else(|| {
            Error::message(format!(
                "unsupported image format '.{ext}' — supported: png, jpg, jpeg, gif, webp"
            ))
        })?;

        let bytes = self.read_file_for_session(session_key, path).await?;
        let size = bytes.len();
        debug!(path, session_key, mime, size, "read_image: encoded file");

        let b64 = BASE64.encode(&bytes);
        drop(bytes);

        // Push the image into the per-session vision cache via a side channel,
        // not the tool result. The tool result stays small (just metadata) so
        // base64 doesn't bloat session history or get re-sent on every turn.
        // The runner picks the image up from this cache and injects it as a
        // multimodal user message in the same turn the tool was called.
        // TTL=6 (5+1): the cache decrement at next turn's loop start lands at
        // 5 visible turns of follow-up.
        moltis_agents::runner::cache_image_for_vision(
            session_key,
            mime.to_string(),
            b64,
            6,
        )
        .await;

        Ok(json!({
            "path": path,
            "mime": mime,
            "size_bytes": size,
            "loaded": true,
            "note": "Image is now in your vision context for this turn — describe what you see directly in your reply.",
        }))
    }
}

fn shell_single_quote(input: &str) -> String {
    let mut quoted = String::with_capacity(input.len() + 2);
    quoted.push('\'');
    for ch in input.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mime_from_extension_known() {
        assert_eq!(mime_from_extension("png"), Some("image/png"));
        assert_eq!(mime_from_extension("PNG"), Some("image/png"));
        assert_eq!(mime_from_extension("jpg"), Some("image/jpeg"));
        assert_eq!(mime_from_extension("jpeg"), Some("image/jpeg"));
        assert_eq!(mime_from_extension("gif"), Some("image/gif"));
        assert_eq!(mime_from_extension("webp"), Some("image/webp"));
    }

    #[test]
    fn test_mime_from_extension_unknown() {
        assert_eq!(mime_from_extension("txt"), None);
        assert_eq!(mime_from_extension(""), None);
        assert_eq!(mime_from_extension("bmp"), None);
    }

    #[test]
    fn test_shell_single_quote_simple() {
        assert_eq!(shell_single_quote("/tmp/foo.png"), "'/tmp/foo.png'");
    }

    #[test]
    fn test_shell_single_quote_with_apostrophe() {
        assert_eq!(shell_single_quote("/tmp/it's.png"), "'/tmp/it'\\''s.png'");
    }

    #[tokio::test]
    async fn test_read_host_file_missing() {
        let result = ReadImageTool::read_host_file("/nonexistent/path/foo.png").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_unsupported_extension() {
        let tool = ReadImageTool::new();
        let result = tool.execute(json!({ "path": "/tmp/foo.txt" })).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unsupported image format"));
    }

    #[tokio::test]
    async fn test_execute_no_extension() {
        let tool = ReadImageTool::new();
        let result = tool.execute(json!({ "path": "/tmp/no_extension" })).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("no extension"));
    }

    #[tokio::test]
    async fn test_execute_real_file_round_trip() {
        let png_bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
            0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let dir = std::env::temp_dir();
        let path = dir.join("__moltis_read_image_test.png");
        tokio::fs::write(&path, &png_bytes).await.unwrap();

        let tool = ReadImageTool::new();
        let result = tool
            .execute(json!({ "path": path.to_str().unwrap() }))
            .await
            .unwrap();
        assert_eq!(result["mime"], "image/png");
        assert_eq!(result["size_bytes"], png_bytes.len());
        assert!(result["image"].as_str().unwrap().starts_with("data:image/png;base64,"));

        let _ = tokio::fs::remove_file(&path).await;
    }
}
