//! Avatar upload and serving routes.
//!
//! GET  /api/avatar/:type  — serve user-uploaded avatar or embedded default
//! POST /api/avatar/:type  — accept raw image bytes, save to ~/.moltis/avatars/

use axum::{
    body::Bytes,
    extract::Path,
    http::{StatusCode, header},
    response::IntoResponse,
    Json,
};
use tokio::fs;
use tracing::warn;

/// Maximum avatar upload size: 5 MB.
pub const MAX_AVATAR_SIZE: usize = 5 * 1024 * 1024;

const VALID_TYPES: &[&str] = &["agent", "user"];
const VALID_EXTS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
];

fn avatars_dir() -> std::path::PathBuf {
    moltis_config::data_dir().join("avatars")
}

/// GET /api/avatar/:type
///
/// Serves the user-uploaded avatar for `type` ("agent" or "user").
/// For "agent", falls back to the embedded Sparky avatar if none uploaded.
/// For "user", returns 404 if none uploaded.
pub async fn get_avatar(Path(kind): Path<String>) -> impl IntoResponse {
    if !VALID_TYPES.contains(&kind.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            Bytes::from_static(b"{\"ok\":false,\"error\":\"invalid type\"}"),
        )
            .into_response();
    }

    let dir = avatars_dir();
    for (ext, mime) in VALID_EXTS {
        let path = dir.join(format!("{kind}.{ext}"));
        if let Ok(bytes) = fs::read(&path).await {
            return (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, *mime),
                    (header::CACHE_CONTROL, "no-store, no-cache"),
                ],
                bytes,
            )
                .into_response();
        }
    }

    // Fallback for agent: redirect to embedded default.
    if kind == "agent" {
        return axum::response::Redirect::temporary("/assets/icons/sparky_avatar.png")
            .into_response();
    }

    (StatusCode::NOT_FOUND, "no avatar set").into_response()
}

/// POST /api/avatar/:type
///
/// Accepts raw image bytes (`Content-Type: image/*`), saves to
/// `~/.moltis/avatars/{type}.{ext}`. Replaces any existing avatar for that type.
pub async fn upload_avatar(
    Path(kind): Path<String>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if !VALID_TYPES.contains(&kind.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok": false, "error": "invalid type"})),
        )
            .into_response();
    }

    if body.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "empty body"})),
        )
            .into_response();
    }

    if body.len() > MAX_AVATAR_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"ok": false, "error": "image too large (max 5 MB)"})),
        )
            .into_response();
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let ext = if content_type.starts_with("image/png") {
        "png"
    } else if content_type.starts_with("image/jpeg") {
        "jpg"
    } else if content_type.starts_with("image/webp") {
        "webp"
    } else if content_type.starts_with("image/gif") {
        "gif"
    } else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Json(serde_json::json!({"ok": false, "error": "unsupported image type; use png/jpeg/webp/gif"})),
        )
            .into_response();
    };

    let dir = avatars_dir();
    if let Err(e) = fs::create_dir_all(&dir).await {
        warn!("avatar: failed to create avatars dir: {e}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": "storage error"})),
        )
            .into_response();
    }

    // Remove any previously uploaded avatar for this type (all extensions).
    for (old_ext, _) in VALID_EXTS {
        let _ = fs::remove_file(dir.join(format!("{kind}.{old_ext}"))).await;
    }

    let dest = dir.join(format!("{kind}.{ext}"));
    if let Err(e) = fs::write(&dest, &body).await {
        warn!("avatar: failed to write {}: {e}", dest.display());
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": "storage error"})),
        )
            .into_response();
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// DELETE /api/avatar/:type — reset to default.
pub async fn delete_avatar(Path(kind): Path<String>) -> impl IntoResponse {
    if !VALID_TYPES.contains(&kind.as_str()) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok": false, "error": "invalid type"})),
        )
            .into_response();
    }

    let dir = avatars_dir();
    for (ext, _) in VALID_EXTS {
        let _ = fs::remove_file(dir.join(format!("{kind}.{ext}"))).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}
