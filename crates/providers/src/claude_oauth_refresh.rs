//! Background refresher for Claude OAuth tokens.
//!
//! Periodically checks ~/.claude/.credentials.json and refreshes the access
//! token before it expires, so moltis never hits a stale token.

use std::path::PathBuf;

use tracing::{debug, info, warn};

/// Claude Code OAuth constants (from claude-code cli.js).
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://console.anthropic.com/v1/oauth/token";

/// How often to check the token (seconds).
const CHECK_INTERVAL_SECS: u64 = 60;

/// Refresh when token expires within this many seconds.
const REFRESH_BEFORE_EXPIRY_SECS: u64 = 300; // 5 minutes

fn credentials_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude").join(".credentials.json"))
}

/// Read the credentials file and return (access_token, refresh_token, expires_at_ms).
fn read_credentials() -> Option<(String, String, u64)> {
    let path = credentials_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let oauth = json.get("claudeAiOauth")?;

    let access_token = oauth.get("accessToken")?.as_str()?.to_string();
    let refresh_token = oauth.get("refreshToken")?.as_str()?.to_string();
    let expires_at = oauth.get("expiresAt")?.as_u64()?;

    if access_token.is_empty() || refresh_token.is_empty() {
        return None;
    }

    Some((access_token, refresh_token, expires_at))
}

/// Write updated tokens back to the credentials file.
fn write_credentials(access_token: &str, refresh_token: &str, expires_at: u64) -> anyhow::Result<()> {
    let path = credentials_path().ok_or_else(|| anyhow::anyhow!("no HOME"))?;
    let content = std::fs::read_to_string(&path)?;
    let mut json: serde_json::Value = serde_json::from_str(&content)?;

    if let Some(oauth) = json.get_mut("claudeAiOauth") {
        oauth["accessToken"] = serde_json::Value::String(access_token.to_string());
        oauth["refreshToken"] = serde_json::Value::String(refresh_token.to_string());
        oauth["expiresAt"] = serde_json::json!(expires_at);
    }

    let updated = serde_json::to_string_pretty(&json)?;
    std::fs::write(&path, updated)?;
    Ok(())
}

/// Perform the token refresh against Anthropic's OAuth endpoint.
async fn do_refresh(refresh_token: &str) -> anyhow::Result<(String, String, u64)> {
    let client = reqwest::Client::new();

    let resp = client
        .post(CLAUDE_OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLAUDE_OAUTH_CLIENT_ID),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let access_token = resp["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing access_token in refresh response"))?
        .to_string();

    let new_refresh = resp["refresh_token"]
        .as_str()
        .unwrap_or(refresh_token)
        .to_string();

    let expires_at = resp["expires_in"]
        .as_u64()
        .map(|secs| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
                + secs * 1000
        })
        .unwrap_or(0);

    Ok((access_token, new_refresh, expires_at))
}

/// Spawn a background task that keeps the Claude OAuth token fresh.
///
/// Does nothing if no credentials file exists or it has no OAuth tokens.
pub fn spawn_refresher() {
    tokio::spawn(async {
        info!("Claude OAuth token refresher started");

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(CHECK_INTERVAL_SECS)).await;

            let Some((_access, refresh, expires_at_ms)) = read_credentials() else {
                // No credentials or no OAuth tokens — skip silently
                continue;
            };

            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;

            let expires_in_secs = expires_at_ms.saturating_sub(now_ms) / 1000;

            if expires_in_secs > REFRESH_BEFORE_EXPIRY_SECS {
                debug!(
                    "Claude OAuth token still valid for {}m {}s",
                    expires_in_secs / 60,
                    expires_in_secs % 60
                );
                continue;
            }

            info!(
                "Claude OAuth token expires in {}s, refreshing...",
                expires_in_secs
            );

            match do_refresh(&refresh).await {
                Ok((new_access, new_refresh, new_expires)) => {
                    if let Err(e) = write_credentials(&new_access, &new_refresh, new_expires) {
                        warn!("Failed to write refreshed credentials: {e}");
                    } else {
                        let valid_for = new_expires.saturating_sub(now_ms) / 1000 / 60;
                        info!("Claude OAuth token refreshed, valid for ~{valid_for}m");
                    }
                }
                Err(e) => {
                    warn!("Claude OAuth token refresh failed: {e}");
                }
            }
        }
    });
}
