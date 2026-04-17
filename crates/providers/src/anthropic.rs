use std::io::Cursor;
use std::pin::Pin;

use {async_trait::async_trait, futures::StreamExt, secrecy::ExposeSecret, tokio_stream::Stream};

use tracing::{debug, trace, warn};

use moltis_agents::model::{
    ChatMessage, CompletionResponse, ContentPart, LlmProvider, StreamEvent, ToolCall, Usage,
    UserContent,
};

pub struct AnthropicProvider {
    api_key: secrecy::Secret<String>,
    model: String,
    base_url: String,
    client: &'static reqwest::Client,
    /// Optional alias for metrics differentiation (e.g., "anthropic-work", "anthropic-2").
    alias: Option<String>,
    /// Use Bearer auth (Claude OAuth) instead of x-api-key header.
    use_bearer: bool,
}

impl AnthropicProvider {
    pub fn new(api_key: secrecy::Secret<String>, model: String, base_url: String) -> Self {
        Self {
            api_key,
            model,
            base_url,
            client: crate::shared_http_client(),
            alias: None,
            use_bearer: false,
        }
    }

    /// Create a new provider with a custom alias for metrics.
    pub fn with_alias(
        api_key: secrecy::Secret<String>,
        model: String,
        base_url: String,
        alias: Option<String>,
    ) -> Self {
        Self {
            api_key,
            model,
            base_url,
            client: crate::shared_http_client(),
            alias,
            use_bearer: false,
        }
    }

    pub fn with_alias_bearer(
        token: secrecy::Secret<String>,
        model: String,
        base_url: String,
        alias: Option<String>,
    ) -> Self {
        Self {
            api_key: token,
            model,
            base_url,
            client: crate::shared_http_client(),
            alias,
            use_bearer: true,
        }
    }

    /// Read the current Bearer token from disk (for OAuth mode).
    /// Falls back to the stored api_key if the file cannot be read.
    /// This allows Claude Code to refresh the token without restarting moltis.
    fn live_token(&self) -> String {
        if !self.use_bearer {
            return self.api_key.expose_secret().to_string();
        }
        let token = std::env::var("HOME").ok().and_then(|home| {
            let path = std::path::Path::new(&home)
                .join(".claude")
                .join(".credentials.json");
            let content = std::fs::read_to_string(&path).ok()?;
            let json: serde_json::Value = serde_json::from_str(&content).ok()?;
            let token = json["claudeAiOauth"]["accessToken"].as_str()?.to_string();
            if token.is_empty() {
                None
            } else {
                Some(token)
            }
        });
        token.unwrap_or_else(|| self.api_key.expose_secret().to_string())
    }
}


/// Billing header required for OAuth Bearer auth with Claude 4+ models.
/// Without this in the system prompt, the API returns invalid_request_error.
const OAUTH_BILLING_HEADER: &str =
    "x-anthropic-billing-header: cc_version=moltis; cc_entrypoint=gateway; cch=0;";

/// Beta headers for OAuth Bearer requests (matches Claude Code).
const OAUTH_BETA_HEADERS: &str =
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";

/// Convert tool schemas from the generic format to Anthropic's tool format.
fn to_anthropic_tools(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t["description"],
                "input_schema": t["parameters"],
            })
        })
        .collect()
}

/// Parse tool_use blocks from an Anthropic response.
fn parse_tool_calls(content: &[serde_json::Value]) -> Vec<ToolCall> {
    content
        .iter()
        .filter_map(|block| {
            if block["type"].as_str() == Some("tool_use") {
                Some(ToolCall {
                    id: block["id"].as_str().unwrap_or("").to_string(),
                    name: block["name"].as_str().unwrap_or("").to_string(),
                    arguments: block["input"].clone(),
                    thought_signature: None,
                })
            } else {
                None
            }
        })
        .collect()
}

fn retry_after_ms_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    super::retry_after_ms_from_headers(headers)
}

fn with_retry_after_marker(base: String, retry_after_ms: Option<u64>) -> String {
    super::with_retry_after_marker(base, retry_after_ms)
}

/// Convert `ChatMessage` list to Anthropic format.
///
/// Returns `(system_text, anthropic_messages)`. System messages are extracted
/// (Anthropic takes them as a top-level `system` field). Tool messages become
/// user messages with `tool_result` content blocks. Assistant messages with
/// tool calls become `content` arrays with `tool_use` blocks.
/// Resize an image if either dimension exceeds 1568px (Anthropic recommended max,
/// safely under the 2000px hard limit for multi-image requests).
/// Returns (base64_data, media_type) — may convert to JPEG if resizing.
fn resize_image_if_needed(data: &str, media_type: &str) -> (String, String) {
    use base64::Engine as _;
    const MAX_DIM: u32 = 1568;

    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
        return (data.to_string(), media_type.to_string());
    };
    let Ok(img) = image::load_from_memory(&bytes) else {
        return (data.to_string(), media_type.to_string());
    };

    if img.width() <= MAX_DIM && img.height() <= MAX_DIM {
        return (data.to_string(), media_type.to_string());
    }

    let resized = img.resize(MAX_DIM, MAX_DIM, image::imageops::FilterType::Lanczos3);
    let mut buf = Vec::new();
    if resized
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .is_err()
    {
        return (data.to_string(), media_type.to_string());
    }

    (
        base64::engine::general_purpose::STANDARD.encode(&buf),
        "image/jpeg".to_string(),
    )
}

fn to_anthropic_messages(messages: &[ChatMessage]) -> (Option<String>, Vec<serde_json::Value>) {
    let mut system_text: Option<String> = None;
    let mut out = Vec::new();

    for msg in messages {
        match msg {
            ChatMessage::System { content } => {
                system_text = Some(match system_text {
                    Some(existing) => format!("{existing}\n\n{content}"),
                    None => content.clone(),
                });
            },
            ChatMessage::User { content } => match content {
                UserContent::Text(text) => {
                    out.push(serde_json::json!({"role": "user", "content": text}));
                },
                UserContent::Multimodal(parts) => {
                    let blocks: Vec<serde_json::Value> = parts
                        .iter()
                        .map(|part| match part {
                            ContentPart::Text(text) => {
                                serde_json::json!({"type": "text", "text": text})
                            },
                            ContentPart::Image { media_type, data } => {
                                let (resized_data, resized_type) = resize_image_if_needed(data, media_type);
                                serde_json::json!({
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": resized_type,
                                        "data": resized_data,
                                    }
                                })
                            },
                        })
                        .collect();
                    out.push(serde_json::json!({"role": "user", "content": blocks}));
                },
            },
            ChatMessage::Assistant {
                content,
                tool_calls,
            } => {
                if tool_calls.is_empty() {
                    out.push(serde_json::json!({
                        "role": "assistant",
                        "content": content.as_deref().unwrap_or(""),
                    }));
                } else {
                    let mut blocks = Vec::new();
                    if let Some(text) = content
                        && !text.is_empty()
                    {
                        blocks.push(serde_json::json!({"type": "text", "text": text}));
                    }
                    for tc in tool_calls {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.arguments,
                        }));
                    }
                    out.push(serde_json::json!({"role": "assistant", "content": blocks}));
                }
            },
            ChatMessage::Tool {
                tool_call_id,
                content,
            } => {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content,
                    }]
                }));
            },
        }
    }

    (system_text, out)
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn name(&self) -> &str {
        self.alias.as_deref().unwrap_or("anthropic")
    }

    fn id(&self) -> &str {
        &self.model
    }

    fn supports_tools(&self) -> bool {
        true
    }

    fn context_window(&self) -> u32 {
        super::context_window_for_model(&self.model)
    }

    fn supports_vision(&self) -> bool {
        super::supports_vision_for_model(&self.model)
    }

    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[serde_json::Value],
    ) -> anyhow::Result<CompletionResponse> {
        let (system_text, anthropic_messages) = to_anthropic_messages(messages);

        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "messages": anthropic_messages,
        });

        // Build system prompt — OAuth Bearer requires billing header + array format
        if self.use_bearer {
            let mut system_blocks = vec![
                serde_json::json!({"type": "text", "text": OAUTH_BILLING_HEADER}),
            ];
            if let Some(ref sys) = system_text {
                system_blocks.push(serde_json::json!({"type": "text", "text": sys}));
            }
            body["system"] = serde_json::Value::Array(system_blocks);
        } else if let Some(ref sys) = system_text {
            body["system"] = serde_json::Value::String(sys.clone());
        }

        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(to_anthropic_tools(tools));
        }

        let thinking_budget = moltis_agents::model::THINKING_BUDGET.try_with(|b| *b).unwrap_or(0);
        // Claude 4.6+ OAuth path: always use adaptive thinking. Opus 4.7 does
        // NOT stream thinking_delta events in explicit `enabled` mode even with
        // `display: summarized` - only adaptive mode streams thinking.
        if self.use_bearer && (self.model.contains("4-6") || self.model.contains("4-7")) {
            body["thinking"] = serde_json::json!({"type": "adaptive", "display": "summarized"});
            body["max_tokens"] = serde_json::json!(16384);
        } else if thinking_budget > 0 {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": thinking_budget,
                "display": "summarized",
            });
            // Anthropic requires max_tokens >= budget_tokens for thinking models
            let min_max = (thinking_budget + 16384) as u64;
            if body["max_tokens"].as_u64().unwrap_or(0) < min_max {
                body["max_tokens"] = serde_json::json!(min_max);
            }
        }

        debug!(
            model = %self.model,
            messages_count = anthropic_messages.len(),
            tools_count = tools.len(),
            has_system = system_text.is_some(),
            "anthropic complete request"
        );
        trace!(body = %serde_json::to_string(&body).unwrap_or_default(), "anthropic request body");

        let http_resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header(
                if self.use_bearer { "Authorization" } else { "x-api-key" },
                if self.use_bearer {
                    format!("Bearer {}", self.live_token())
                } else {
                    self.api_key.expose_secret().to_string()
                },
            )
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .header(
                "anthropic-beta",
                if self.use_bearer {
                    OAUTH_BETA_HEADERS.to_string()
                } else {
                    let mut beta = String::new();
                    if thinking_budget > 0 {
                        beta.push_str("interleaved-thinking-2025-05-14");
                    }
                    beta
                },
            )
            .json(&body)
            .send()
            .await?;

        let status = http_resp.status();
        if !status.is_success() {
            let retry_after_ms = retry_after_ms_from_headers(http_resp.headers());
            let body_text = http_resp.text().await.unwrap_or_default();
            warn!(status = %status, body = %body_text, "anthropic API error");
            anyhow::bail!(
                "{}",
                with_retry_after_marker(
                    format!("Anthropic API error HTTP {status}: {body_text}"),
                    retry_after_ms
                )
            );
        }

        let resp = http_resp.json::<serde_json::Value>().await?;
        trace!(response = %resp, "anthropic raw response");

        let content = resp["content"].as_array().cloned().unwrap_or_default();

        let text = content
            .iter()
            .filter_map(|b| {
                if b["type"].as_str() == Some("text") {
                    b["text"].as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .reduce(|a, b| a + &b);

        let tool_calls = parse_tool_calls(&content);

        let usage = Usage {
            input_tokens: resp["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32,
            output_tokens: resp["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32,
            cache_read_tokens: resp["usage"]["cache_read_input_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
            cache_write_tokens: resp["usage"]["cache_creation_input_tokens"]
                .as_u64()
                .unwrap_or(0) as u32,
        };

        Ok(CompletionResponse {
            text,
            tool_calls,
            usage,
        })
    }

    #[allow(clippy::collapsible_if)]
    fn stream(
        &self,
        messages: Vec<ChatMessage>,
    ) -> Pin<Box<dyn Stream<Item = StreamEvent> + Send + '_>> {
        self.stream_with_tools(messages, vec![])
    }

    #[allow(clippy::collapsible_if)]
    fn stream_with_tools(
        &self,
        messages: Vec<ChatMessage>,
        tools: Vec<serde_json::Value>,
    ) -> Pin<Box<dyn Stream<Item = StreamEvent> + Send + '_>> {
        Box::pin(async_stream::stream! {
            let (system_text, anthropic_messages) = to_anthropic_messages(&messages);

            let mut body = serde_json::json!({
                "model": self.model,
                "max_tokens": 4096,
                "messages": anthropic_messages,
                "stream": true,
            });

            // Build system prompt — OAuth Bearer requires billing header + array format
            if self.use_bearer {
                let mut system_blocks = vec![
                    serde_json::json!({"type": "text", "text": OAUTH_BILLING_HEADER}),
                ];
                if let Some(ref sys) = system_text {
                    system_blocks.push(serde_json::json!({"type": "text", "text": sys}));
                }
                body["system"] = serde_json::Value::Array(system_blocks);
            } else if let Some(ref sys) = system_text {
                body["system"] = serde_json::Value::String(sys.clone());
            }

            if !tools.is_empty() {
                body["tools"] = serde_json::Value::Array(to_anthropic_tools(&tools));
            }

            let thinking_budget = moltis_agents::model::THINKING_BUDGET.try_with(|b| *b).unwrap_or(0);

            // Claude 4.6+ OAuth: always use adaptive thinking. Explicit enabled
            // mode with budget_tokens does NOT stream thinking_delta events on
            // Opus 4.7, even with display: summarized. Only adaptive mode streams.
            if self.use_bearer && (self.model.contains("4-6") || self.model.contains("4-7")) {
                body["thinking"] = serde_json::json!({"type": "adaptive", "display": "summarized"});
                body["max_tokens"] = serde_json::json!(16384);
            } else if thinking_budget > 0 {
                body["thinking"] = serde_json::json!({
                    "type": "enabled",
                    "budget_tokens": thinking_budget,
                    "display": "summarized",
                });
                let min_max = (thinking_budget + 16384) as u64;
                if body["max_tokens"].as_u64().unwrap_or(0) < min_max {
                    body["max_tokens"] = serde_json::json!(min_max);
                }
            }

            debug!(
                model = %self.model,
                messages_count = anthropic_messages.len(),
                tools_count = tools.len(),
                has_system = system_text.is_some(),
                "anthropic stream_with_tools request"
            );

            let resp = match self
                .client
                .post(format!("{}/v1/messages", self.base_url))
                .header(
                    if self.use_bearer { "Authorization" } else { "x-api-key" },
                    if self.use_bearer {
                        format!("Bearer {}", self.live_token())
                    } else {
                        self.api_key.expose_secret().to_string()
                    },
                )
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .header("anthropic-beta",
                    if self.use_bearer {
                        OAUTH_BETA_HEADERS.to_string()
                    } else {
                        let mut beta = String::new();
                        if thinking_budget > 0 {
                            beta.push_str("interleaved-thinking-2025-05-14");
                        }
                        beta
                    },
                )
                .json(&body)
                .send()
                .await
            {
                Ok(r) => {
                    if let Err(e) = r.error_for_status_ref() {
                        let status = e.status().map(|s| s.as_u16()).unwrap_or(0);
                        let retry_after_ms = retry_after_ms_from_headers(r.headers());
                        let body_text = r.text().await.unwrap_or_default();
                        yield StreamEvent::Error(with_retry_after_marker(
                            format!("HTTP {status}: {body_text}"),
                            retry_after_ms,
                        ));
                        return;
                    }
                    r
                }
                Err(e) => {
                    yield StreamEvent::Error(e.to_string());
                    return;
                }
            };

            let mut byte_stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut input_tokens: u32 = 0;
            let mut output_tokens: u32 = 0;
            let mut cache_read_tokens: u32 = 0;
            let mut cache_write_tokens: u32 = 0;

            // Track current content block index for tool calls.
            let mut current_block_index: Option<usize> = None;

            while let Some(chunk) = byte_stream.next().await {
                let chunk = match chunk {
                    Ok(c) => c,
                    Err(e) => {
                        yield StreamEvent::Error(e.to_string());
                        return;
                    }
                };
                buf.push_str(&String::from_utf8_lossy(&chunk));

                while let Some(pos) = buf.find("\n\n") {
                    let block = buf[..pos].to_string();
                    buf = buf[pos + 2..].to_string();

                    for line in block.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
                            if let Ok(evt) = serde_json::from_str::<serde_json::Value>(data) {
                                let evt_type = evt["type"].as_str().unwrap_or("");
                                match evt_type {
                                    "content_block_start" => {
                                        let index = evt["index"].as_u64().unwrap_or(0) as usize;
                                        let content_block = &evt["content_block"];
                                        let block_type = content_block["type"].as_str().unwrap_or("");

                                        if block_type == "thinking" {
                                            // Track thinking block — deltas will emit ReasoningDelta
                                        } else if block_type == "tool_use" {
                                            let id = content_block["id"].as_str().unwrap_or("").to_string();
                                            let name = content_block["name"].as_str().unwrap_or("").to_string();
                                            current_block_index = Some(index);
                                            yield StreamEvent::ToolCallStart { id, name, index, thought_signature: None };
                                        }
                                    }
                                    "content_block_delta" => {
                                        let delta = &evt["delta"];
                                        let delta_type = delta["type"].as_str().unwrap_or("");

                                        if delta_type == "thinking_delta" {
                                            if let Some(text) = delta["thinking"].as_str() {
                                                if !text.is_empty() {
                                                    yield StreamEvent::ReasoningDelta(text.to_string());
                                                }
                                            }
                                        } else if delta_type == "text_delta" {
                                            if let Some(text) = delta["text"].as_str() {
                                                if !text.is_empty() {
                                                    yield StreamEvent::Delta(text.to_string());
                                                }
                                            }
                                        } else if delta_type == "input_json_delta" {
                                            if let Some(partial_json) = delta["partial_json"].as_str() {
                                                let index = evt["index"].as_u64().unwrap_or(0) as usize;
                                                yield StreamEvent::ToolCallArgumentsDelta {
                                                    index,
                                                    delta: partial_json.to_string(),
                                                };
                                            }
                                        }
                                    }
                                    "content_block_stop" => {
                                        let index = evt["index"].as_u64().unwrap_or(0) as usize;
                                        // Only emit ToolCallComplete if this was a tool_use block.
                                        if current_block_index == Some(index) {
                                            yield StreamEvent::ToolCallComplete { index };
                                            current_block_index = None;
                                        }
                                    }
                                    "message_delta" => {
                                        let u = &evt["usage"];
                                        if let Some(v) = u["output_tokens"].as_u64() {
                                            output_tokens = v as u32;
                                        }
                                        // Anthropic may report cache tokens in delta
                                        if let Some(v) = u["cache_read_input_tokens"].as_u64() {
                                            cache_read_tokens = v as u32;
                                        }
                                        if let Some(v) = u["cache_creation_input_tokens"].as_u64() {
                                            cache_write_tokens = v as u32;
                                        }
                                    }
                                    "message_start" => {
                                        let u = &evt["message"]["usage"];
                                        if let Some(v) = u["input_tokens"].as_u64() {
                                            input_tokens = v as u32;
                                        }
                                        if let Some(v) = u["cache_read_input_tokens"].as_u64() {
                                            cache_read_tokens = v as u32;
                                        }
                                        if let Some(v) = u["cache_creation_input_tokens"].as_u64() {
                                            cache_write_tokens = v as u32;
                                        }
                                    }
                                    "message_stop" => {
                                        yield StreamEvent::Done(Usage {
                                            input_tokens,
                                            output_tokens,
                                            cache_read_tokens,
                                            cache_write_tokens,
                                        });
                                        return;
                                    }
                                    "error" => {
                                        let msg = evt["error"]["message"]
                                            .as_str()
                                            .unwrap_or("unknown error");
                                        yield StreamEvent::Error(msg.to_string());
                                        return;
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
        })
    }
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_ms_from_headers_parses_seconds() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("12"),
        );
        assert_eq!(retry_after_ms_from_headers(&headers), Some(12_000));
    }

    #[test]
    fn retry_after_ms_from_headers_ignores_non_numeric_values() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"),
        );
        assert_eq!(retry_after_ms_from_headers(&headers), None);
    }

    #[test]
    fn with_retry_after_marker_appends_retry_hint() {
        let base = "HTTP 429: rate limit exceeded".to_string();
        assert_eq!(
            with_retry_after_marker(base.clone(), Some(3_000)),
            "HTTP 429: rate limit exceeded (retry_after_ms=3000)"
        );
        assert_eq!(
            with_retry_after_marker(base.clone(), None),
            "HTTP 429: rate limit exceeded"
        );
    }
}
