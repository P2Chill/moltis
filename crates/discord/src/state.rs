use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
};

use {
    moltis_channels::{ChannelEventSink, message_log::MessageLog, otp::OtpState},
    serenity::all::UserId,
    tokio::task::JoinHandle,
    tokio_util::sync::CancellationToken,
};

use crate::config::DiscordAccountConfig;

/// Shared account state map.
pub type AccountStateMap = Arc<RwLock<HashMap<String, AccountState>>>;

/// Per-account runtime state.
pub struct AccountState {
    pub account_id: String,
    pub config: DiscordAccountConfig,
    pub message_log: Option<Arc<dyn MessageLog>>,
    pub event_sink: Option<Arc<dyn ChannelEventSink>>,
    pub cancel: CancellationToken,
    /// Handle to the spawned gateway task. Held by the plugin so `stop_account`
    /// can await its termination — without this, `cancel.cancel()` only
    /// signals; the next `start_account` (e.g. on a config-update path) racing
    /// before the old client's `shard_manager.shutdown_all()` completes leaves
    /// two clients subscribed to the same Discord gateway, producing duplicate
    /// inbound events for several seconds (or longer).
    pub task_handle: Mutex<Option<JoinHandle<()>>>,
    pub bot_user_id: Option<UserId>,
    pub http: Option<Arc<serenity::http::Http>>,
    /// In-memory OTP challenges for self-approval (std::sync::Mutex because
    /// all OTP operations are synchronous HashMap lookups, never held across
    /// `.await` points).
    pub otp: Mutex<OtpState>,
}
