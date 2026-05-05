use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

use {
    async_trait::async_trait,
    secrecy::ExposeSecret,
    tracing::{info, warn},
};

use moltis_channels::{
    Error as ChannelError, Result as ChannelResult,
    message_log::MessageLog,
    plugin::{
        ChannelEventSink, ChannelHealthSnapshot, ChannelOutbound, ChannelPlugin, ChannelStatus,
        ChannelStreamOutbound,
    },
};

use moltis_channels::otp::OtpState;

use crate::{
    config::DiscordAccountConfig,
    handler::{Handler, required_intents},
    outbound::DiscordOutbound,
    state::{AccountState, AccountStateMap},
};

/// Discord channel plugin.
pub struct DiscordPlugin {
    accounts: AccountStateMap,
    outbound: DiscordOutbound,
    message_log: Option<Arc<dyn MessageLog>>,
    event_sink: Option<Arc<dyn ChannelEventSink>>,
}

impl DiscordPlugin {
    pub fn new() -> Self {
        let accounts: AccountStateMap = Arc::new(RwLock::new(HashMap::new()));
        let outbound = DiscordOutbound {
            accounts: Arc::clone(&accounts),
        };
        Self {
            accounts,
            outbound,
            message_log: None,
            event_sink: None,
        }
    }

    pub fn with_message_log(mut self, log: Arc<dyn MessageLog>) -> Self {
        self.message_log = Some(log);
        self
    }

    pub fn with_event_sink(mut self, sink: Arc<dyn ChannelEventSink>) -> Self {
        self.event_sink = Some(sink);
        self
    }

    pub fn shared_outbound(&self) -> Arc<dyn ChannelOutbound> {
        Arc::new(DiscordOutbound {
            accounts: Arc::clone(&self.accounts),
        })
    }

    pub fn shared_stream_outbound(&self) -> Arc<dyn ChannelStreamOutbound> {
        Arc::new(DiscordOutbound {
            accounts: Arc::clone(&self.accounts),
        })
    }

    pub fn account_ids(&self) -> Vec<String> {
        let accounts = self.accounts.read().unwrap_or_else(|e| e.into_inner());
        accounts.keys().cloned().collect()
    }

    pub fn has_account(&self, account_id: &str) -> bool {
        let accounts = self.accounts.read().unwrap_or_else(|e| e.into_inner());
        accounts.contains_key(account_id)
    }

    pub fn account_config(&self, account_id: &str) -> Option<serde_json::Value> {
        let accounts = self.accounts.read().unwrap_or_else(|e| e.into_inner());
        accounts
            .get(account_id)
            .and_then(|s| serde_json::to_value(&s.config).ok())
    }

    pub fn update_account_config(
        &self,
        account_id: &str,
        config: serde_json::Value,
    ) -> ChannelResult<()> {
        let parsed: DiscordAccountConfig = serde_json::from_value(config)?;
        let mut accounts = self.accounts.write().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = accounts.get_mut(account_id) {
            state.config = parsed;
            Ok(())
        } else {
            Err(ChannelError::unknown_account(account_id))
        }
    }
}

impl Default for DiscordPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ChannelPlugin for DiscordPlugin {
    fn id(&self) -> &str {
        "discord"
    }

    fn name(&self) -> &str {
        "Discord"
    }

    async fn start_account(
        &mut self,
        account_id: &str,
        config: serde_json::Value,
    ) -> ChannelResult<()> {
        let cfg: DiscordAccountConfig = serde_json::from_value(config)?;
        if cfg.token.expose_secret().is_empty() {
            return Err(ChannelError::invalid_input("Discord bot token is required"));
        }

        info!(account_id, "starting discord account");

        let cancel = tokio_util::sync::CancellationToken::new();
        let accounts_clone = Arc::clone(&self.accounts);
        let account_id_owned = account_id.to_string();
        let token = cfg.token.expose_secret().clone();

        {
            let otp_cooldown = cfg.otp_cooldown_secs;
            let mut accounts = self.accounts.write().unwrap_or_else(|e| e.into_inner());
            accounts.insert(account_id.to_string(), AccountState {
                account_id: account_id.to_string(),
                config: cfg,
                message_log: self.message_log.clone(),
                event_sink: self.event_sink.clone(),
                cancel: cancel.clone(),
                task_handle: std::sync::Mutex::new(None),
                bot_user_id: None,
                http: None,
                otp: std::sync::Mutex::new(OtpState::new(otp_cooldown)),
            });
        }

        // Spawn the serenity client in a background task.
        let cancel_for_task = cancel.clone();
        let account_id_for_handle = account_id_owned.clone();
        let task_handle = tokio::spawn(async move {
            let handler = Handler {
                account_id: account_id_owned.clone(),
                accounts: Arc::clone(&accounts_clone),
            };

            let mut client = match serenity::Client::builder(&token, required_intents())
                .event_handler(handler)
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    warn!(
                        account_id = %account_id_owned,
                        "failed to build Discord client: {e}"
                    );
                    return;
                },
            };

            // Store the Http handle so outbound messages can use it.
            {
                let mut accounts = accounts_clone.write().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = accounts.get_mut(&account_id_owned) {
                    state.http = Some(Arc::clone(&client.http));
                }
            }

            tokio::select! {
                result = client.start() => {
                    if let Err(e) = result {
                        warn!(
                            account_id = %account_id_owned,
                            "Discord client stopped with error: {e}"
                        );
                    }
                }
                () = cancel_for_task.cancelled() => {
                    info!(account_id = %account_id_owned, "Discord client shutting down");
                    client.shard_manager.shutdown_all().await;
                    // shard_manager.shutdown_all() returns once each shard's
                    // disconnect frame is sent; serenity's event-pump tasks
                    // may still be flushing. Give them a brief moment so the
                    // gateway session is cleanly torn down before this task
                    // returns and a replacement client may connect.
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        });

        // Stash the JoinHandle so stop_account can await termination —
        // critical for the channel-update path (stop → start) to avoid
        // having two clients connected to the same bot user simultaneously.
        {
            let accounts = self.accounts.read().unwrap_or_else(|e| e.into_inner());
            if let Some(state) = accounts.get(&account_id_for_handle) {
                let mut slot = state
                    .task_handle
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                *slot = Some(task_handle);
            }
        }

        Ok(())
    }

    async fn stop_account(&mut self, account_id: &str) -> ChannelResult<()> {
        let removed = {
            let mut accounts = self.accounts.write().unwrap_or_else(|e| e.into_inner());
            accounts.remove(account_id)
        };
        let Some(state) = removed else {
            warn!(account_id, "Discord account not found");
            return Ok(());
        };
        state.cancel.cancel();

        // Await the gateway task so the next start_account doesn't race a
        // still-connected old client. Cap with a timeout so a wedged gateway
        // doesn't block the orchestrator forever.
        let handle = state
            .task_handle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(handle) = handle {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {},
                Ok(Err(join_err)) => warn!(
                    account_id,
                    error = %join_err,
                    "Discord gateway task ended with join error"
                ),
                Err(_) => warn!(
                    account_id,
                    "Discord gateway task did not exit within 5s — proceeding; may briefly double-deliver events"
                ),
            }
        }
        Ok(())
    }

    fn outbound(&self) -> Option<&dyn ChannelOutbound> {
        Some(&self.outbound)
    }

    fn status(&self) -> Option<&dyn ChannelStatus> {
        Some(self)
    }
}

#[async_trait]
impl ChannelStatus for DiscordPlugin {
    async fn probe(&self, account_id: &str) -> ChannelResult<ChannelHealthSnapshot> {
        let accounts = self.accounts.read().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = accounts.get(account_id) {
            let connected = state.bot_user_id.is_some();
            let details = if connected {
                "gateway connected".to_string()
            } else {
                "connecting to Discord gateway...".to_string()
            };
            Ok(ChannelHealthSnapshot {
                connected,
                account_id: state.account_id.clone(),
                details: Some(details),
            })
        } else {
            Ok(ChannelHealthSnapshot {
                connected: false,
                account_id: account_id.to_string(),
                details: Some("account not started".into()),
            })
        }
    }
}
