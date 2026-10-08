use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

const MAX_REMOTE_STDERR_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default)]
pub struct SftpChannelDiagnostics {
    state: Arc<StdMutex<SftpChannelDiagnosticState>>,
    terminated: Arc<Notify>,
}

#[derive(Clone, Debug, Default)]
struct SftpChannelDiagnosticState {
    stderr: Vec<u8>,
    stderr_truncated: bool,
    exit_status: Option<u32>,
    exit_signal: Option<String>,
    request_failed: bool,
    terminated: bool,
}

impl SftpChannelDiagnostics {
    fn with_state<R>(&self, f: impl FnOnce(&mut SftpChannelDiagnosticState) -> R) -> R {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&mut state)
    }

    pub fn record_extended_data(&self, data: &[u8]) {
        self.with_state(|state| {
            let remaining = MAX_REMOTE_STDERR_BYTES.saturating_sub(state.stderr.len());
            if data.len() > remaining {
                state.stderr.extend_from_slice(&data[..remaining]);
                state.stderr_truncated = true;
            } else {
                state.stderr.extend_from_slice(data);
            }
        });
    }

    pub fn record_exit_status(&self, exit_status: u32) {
        self.with_state(|state| state.exit_status = Some(exit_status));
    }

    pub fn record_exit_signal(&self, signal: impl Into<String>, error_message: &str) {
        let signal = signal.into();
        self.with_state(|state| {
            state.exit_signal = Some(if error_message.trim().is_empty() {
                signal
            } else {
                format!("{signal}: {}", normalize_remote_text(error_message))
            });
            state.terminated = true;
        });
        self.terminated.notify_waiters();
    }

    pub fn record_request_failure(&self) {
        self.with_state(|state| {
            state.request_failed = true;
            state.terminated = true;
        });
        self.terminated.notify_waiters();
    }

    pub fn record_terminated(&self) {
        self.with_state(|state| state.terminated = true);
        self.terminated.notify_waiters();
    }

    pub fn has_remote_failure(&self) -> bool {
        self.with_state(|state| {
            state.request_failed
                || state.terminated
                || state.exit_status.is_some_and(|status| status != 0)
                || state.exit_signal.is_some()
                || !state.stderr.is_empty()
        })
    }

    pub async fn wait_terminated(&self) {
        loop {
            let notified = self.terminated.notified();
            if self.with_state(|state| state.terminated) {
                return;
            }
            notified.await;
        }
    }

    pub fn summary(&self) -> Option<String> {
        let state = self.with_state(|state| state.clone());
        let mut details = Vec::new();

        if state.request_failed {
            details.push("remote server rejected the channel request".to_string());
        }
        if !state.stderr.is_empty() {
            let mut stderr = normalize_remote_text(&String::from_utf8_lossy(&state.stderr));
            if state.stderr_truncated {
                stderr.push_str(" [truncated at 64 KiB]");
            }
            if !stderr.is_empty() {
                details.push(format!("remote stderr: {stderr}"));
            }
        }
        if let Some(exit_status) = state.exit_status {
            details.push(format!("remote exit status: {exit_status}"));
        }
        if let Some(exit_signal) = state.exit_signal {
            details.push(format!("remote exit signal: {exit_signal}"));
        }
        if state.terminated && details.is_empty() {
            details.push("remote channel closed before the SFTP handshake completed".to_string());
        }

        (!details.is_empty()).then(|| details.join("; "))
    }
}

fn normalize_remote_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

type ChannelWaitFuture =
    Pin<Box<dyn Future<Output = (ChannelReadHalf, Option<ChannelMsg>)> + Send + 'static>>;

/// Keeps SFTP protocol bytes on stdout while retaining the SSH channel's
/// stderr/exit messages for connection diagnostics.
pub struct SftpChannelStream {
    read_half: Option<ChannelReadHalf>,
    read_wait: Option<ChannelWaitFuture>,
    buffered: Vec<u8>,
    buffered_offset: usize,
    writer: Pin<Box<dyn AsyncWrite + Send + 'static>>,
    close_half: Option<ChannelWriteHalf<Msg>>,
    diagnostics: SftpChannelDiagnostics,
    closed: bool,
}

impl SftpChannelStream {
    pub fn new(channel: Channel<Msg>, diagnostics: SftpChannelDiagnostics) -> Self {
        let (read_half, write_half) = channel.split();
        let writer = Box::pin(write_half.make_writer());
        Self {
            read_half: Some(read_half),
            read_wait: None,
            buffered: Vec::new(),
            buffered_offset: 0,
            writer,
            close_half: Some(write_half),
            diagnostics,
            closed: false,
        }
    }

    fn copy_buffered(&mut self, buf: &mut ReadBuf<'_>) -> bool {
        if self.buffered_offset >= self.buffered.len() || buf.remaining() == 0 {
            return false;
        }

        let available = self.buffered.len() - self.buffered_offset;
        let readable = available.min(buf.remaining());
        let end = self.buffered_offset + readable;
        buf.put_slice(&self.buffered[self.buffered_offset..end]);
        self.buffered_offset = end;
        if self.buffered_offset == self.buffered.len() {
            self.buffered.clear();
            self.buffered_offset = 0;
        }
        true
    }

    fn start_waiting(&mut self) {
        if self.read_wait.is_some() || self.closed {
            return;
        }
        let Some(mut read_half) = self.read_half.take() else {
            self.closed = true;
            self.diagnostics.record_terminated();
            return;
        };
        self.read_wait = Some(Box::pin(async move {
            let message = read_half.wait().await;
            (read_half, message)
        }));
    }
}

impl AsyncRead for SftpChannelStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = &mut *self;
        if this.copy_buffered(buf) || this.closed || buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }

        loop {
            this.start_waiting();
            if this.closed {
                return Poll::Ready(Ok(()));
            }

            let Some(wait) = this.read_wait.as_mut() else {
                return Poll::Ready(Ok(()));
            };
            let (read_half, message) = match wait.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => result,
            };
            this.read_wait = None;
            this.read_half = Some(read_half);

            match message {
                Some(ChannelMsg::Data { data }) => {
                    this.buffered = data.to_vec();
                    this.buffered_offset = 0;
                    let _ = this.copy_buffered(buf);
                    return Poll::Ready(Ok(()));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    this.diagnostics.record_extended_data(&data);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    this.diagnostics.record_exit_status(exit_status);
                }
                Some(ChannelMsg::ExitSignal {
                    signal_name,
                    error_message,
                    ..
                }) => {
                    this.diagnostics
                        .record_exit_signal(format!("{signal_name:?}"), &error_message);
                    this.closed = true;
                    return Poll::Ready(Ok(()));
                }
                Some(ChannelMsg::Failure) => {
                    this.diagnostics.record_request_failure();
                    this.closed = true;
                    return Poll::Ready(Ok(()));
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    this.diagnostics.record_terminated();
                    this.closed = true;
                    return Poll::Ready(Ok(()));
                }
                Some(_) => {}
            }
        }
    }
}

impl AsyncWrite for SftpChannelStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.writer.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.writer.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.writer.as_mut().poll_shutdown(cx)
    }
}

impl Drop for SftpChannelStream {
    fn drop(&mut self) {
        if let Some(close_half) = self.close_half.take() {
            tokio::spawn(async move {
                let _ = close_half.close().await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_preserve_remote_stderr_and_exit_status() {
        let diagnostics = SftpChannelDiagnostics::default();
        diagnostics
            .record_extended_data(b"/usr/lib/openssh/sftp-server: No such file or directory\n");
        diagnostics.record_exit_status(127);
        diagnostics.record_terminated();

        assert_eq!(
            diagnostics.summary().as_deref(),
            Some(
                "remote stderr: /usr/lib/openssh/sftp-server: No such file or directory; remote exit status: 127"
            )
        );
    }

    #[test]
    fn diagnostics_collapse_multiline_remote_errors() {
        let diagnostics = SftpChannelDiagnostics::default();
        diagnostics.record_extended_data(b"first line\n\n  second line  \n");

        assert_eq!(
            diagnostics.summary().as_deref(),
            Some("remote stderr: first line | second line")
        );
    }
}
