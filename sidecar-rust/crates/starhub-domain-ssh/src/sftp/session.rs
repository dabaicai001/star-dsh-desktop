use anyhow::Result;
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::session::SshSession;

pub struct SftpSessionWrapper {
    pub session_id: String,
    sftp: Arc<Mutex<SftpSession>>,
}

impl SftpSessionWrapper {
    pub async fn connect(ssh_session: &mut SshSession, session_id: String) -> Result<Self> {
        let sftp = ssh_session
            .open_sftp()
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(Self {
            session_id,
            sftp: Arc::new(Mutex::new(sftp)),
        })
    }

    pub fn sftp(&self) -> Arc<Mutex<SftpSession>> {
        self.sftp.clone()
    }

    pub async fn disconnect(&self) -> Result<()> {
        let sftp = self.sftp.lock().await;
        sftp.close().await?;
        Ok(())
    }
}
