use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(120);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// sidecar 单行响应上限,超出即判定进程异常并重建,防止异常输出打爆内存。
const MAX_SIDECAR_LINE_BYTES: usize = 64 * 1024 * 1024;
const SIDECAR_PROTOCOL_VERSION: u32 = 2;
const REQUIRED_METHODS: &[&str] = &[
    "db.mysql.getTableMeta",
    "db.mysql.getTableData",
    "db.clickhouse.getTableMeta",
    "db.clickhouse.getTableData",
    "file.csv.open",
    "file.csv.readSheet",
    "file.csv.writeCells",
    "file.csv.save",
    "file.csv.removeDuplicates",
    "file.excel.open",
    "file.excel.readSheet",
    "file.excel.writeCells",
    "file.excel.save",
    "file.excel.removeDuplicates",
    "docker.execSessionStart",
    "docker.execSessionRead",
    "docker.execSessionWrite",
    "docker.execSessionResize",
    "docker.execSessionClose",
];

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarInfo {
    version: String,
    protocol_version: u32,
    methods: Vec<String>,
}

type ResponseSender = oneshot::Sender<Result<RpcResponse, String>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<String, ResponseSender>>>;

pub struct SidecarManager {
    tx: Arc<Mutex<Option<mpsc::Sender<RpcRequest>>>>,
    pending: PendingResponses,
    child: Arc<Mutex<Option<Child>>>,
    /// 串行化 start/restart,消除并发 start 的 TOCTOU(检查与赋值在锁内)
    start_lock: tokio::sync::Mutex<()>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            child: Arc::new(Mutex::new(None)),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn start(&self, _app: &tauri::AppHandle) -> Result<(), String> {
        self.start_inner().await
    }

    async fn start_inner(&self) -> Result<(), String> {
        // 整个启动过程(含 is_some 检查与赋值)都在 start_lock 内,
        // 并发的 start / 惰性重启不会各自 spawn 出重复进程。
        let _start_guard = self.start_lock.lock().await;
        if self.tx.lock().map_err(|e| e.to_string())?.is_some() {
            return Ok(());
        }

        let sidecar_name = if cfg!(target_os = "windows") {
            "starhub-sidecar.exe"
        } else {
            "starhub-sidecar"
        };

        let exe_dir = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Failed to get exe directory")?
            .to_path_buf();

        let packaged = [
            exe_dir.join(sidecar_name),
            exe_dir.join("sidecar").join(sidecar_name),
        ];
        let development = [
            exe_dir
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
            exe_dir
                .join("..")
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
            exe_dir
                .join("..")
                .join("..")
                .join("..")
                .join("sidecar")
                .join("bin")
                .join(sidecar_name),
        ];
        let candidates = if cfg!(debug_assertions) {
            development.into_iter().chain(packaged).collect::<Vec<_>>()
        } else {
            packaged.into_iter().chain(development).collect::<Vec<_>>()
        };

        let sidecar_path = candidates
            .into_iter()
            .find(|path| path.exists())
            .ok_or_else(|| format!("Sidecar not found. Looked relative to exe at {exe_dir:?}"))?;

        tracing::info!("Sidecar path: {:?}", sidecar_path);

        let mut cmd = Command::new(&sidecar_path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {e}"))?;
        let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to get stderr")?;
        let (tx, rx) = mpsc::channel::<RpcRequest>(100);

        *self.tx.lock().map_err(|e| e.to_string())? = Some(tx.clone());
        *self.child.lock().map_err(|e| e.to_string())? = Some(child);

        tokio::spawn(Self::write_loop(stdin, rx, self.pending.clone()));
        tokio::spawn(Self::read_loop(
            stdout,
            self.pending.clone(),
            self.tx.clone(),
            tx.clone(),
            self.child.clone(),
        ));
        tokio::spawn(Self::stderr_drain(stderr));

        if let Err(error) = self.validate_sidecar().await {
            *self.tx.lock().map_err(|e| e.to_string())? = None;
            if let Some(child) = self.child.lock().map_err(|e| e.to_string())?.as_mut() {
                let _ = child.start_kill();
            }
            return Err(format!(
                "Incompatible Sidecar at {}: {error}. Rebuild or reinstall StarHub.",
                sidecar_path.display()
            ));
        }

        tracing::info!("Sidecar started and validated successfully");
        Ok(())
    }

    async fn validate_sidecar(&self) -> Result<(), String> {
        let value = self
            .call_with_timeout("version", serde_json::json!({}), HANDSHAKE_TIMEOUT)
            .await?;
        let info: SidecarInfo =
            serde_json::from_value(value).map_err(|e| format!("invalid version response: {e}"))?;
        if info.protocol_version != SIDECAR_PROTOCOL_VERSION {
            return Err(format!(
                "protocol version {} is unsupported (expected {})",
                info.protocol_version, SIDECAR_PROTOCOL_VERSION
            ));
        }

        let missing = REQUIRED_METHODS
            .iter()
            .filter(|method| !info.methods.iter().any(|registered| registered == **method))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "Sidecar {} is missing required RPC methods: {}",
                info.version,
                missing.join(", ")
            ));
        }
        Ok(())
    }

    async fn write_loop(
        mut stdin: tokio::process::ChildStdin,
        mut rx: mpsc::Receiver<RpcRequest>,
        pending: PendingResponses,
    ) {
        while let Some(request) = rx.recv().await {
            let request_id = request.id.clone();
            let request_json = match serde_json::to_string(&request) {
                Ok(json) => json,
                Err(error) => {
                    Self::fail_request(
                        &pending,
                        &request_id,
                        format!("Failed to serialize request: {error}"),
                    )
                    .await;
                    continue;
                }
            };

            let write_result = async {
                stdin.write_all(request_json.as_bytes()).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            }
            .await;

            if let Err(error) = write_result {
                Self::fail_request(
                    &pending,
                    &request_id,
                    format!("Failed to write to sidecar: {error}"),
                )
                .await;
                Self::fail_all(&pending, "Sidecar stdin closed").await;
                break;
            }
        }
    }

    async fn read_loop(
        stdout: tokio::process::ChildStdout,
        pending: PendingResponses,
        tx_slot: Arc<Mutex<Option<mpsc::Sender<RpcRequest>>>>,
        own_tx: mpsc::Sender<RpcRequest>,
        child_slot: Arc<Mutex<Option<Child>>>,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut line: Vec<u8> = Vec::new();
        loop {
            let chunk = match reader.fill_buf().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    Self::fail_all(
                        &pending,
                        &format!("Failed to read sidecar response: {error}"),
                    )
                    .await;
                    break;
                }
            };
            if chunk.is_empty() {
                Self::fail_all(&pending, "Sidecar closed stdout").await;
                break;
            }
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(pos) => {
                    if line.len() + pos > MAX_SIDECAR_LINE_BYTES {
                        Self::fail_all(&pending, "Sidecar response line exceeded 64MB limit").await;
                        break;
                    }
                    line.extend_from_slice(&chunk[..pos]);
                    let consumed = pos + 1;
                    match serde_json::from_slice::<RpcResponse>(&line) {
                        Ok(response) => {
                            if let Some(response_tx) = pending.lock().await.remove(&response.id) {
                                let _ = response_tx.send(Ok(response));
                            } else {
                                tracing::warn!("Received response for unknown request");
                            }
                        }
                        Err(error) => {
                            tracing::error!("Failed to parse sidecar response: {error}");
                        }
                    }
                    line.clear();
                    reader.consume(consumed);
                }
                None => {
                    // 增量检查单行上限,避免超长行先把内存打爆才被截断
                    if line.len() + chunk.len() > MAX_SIDECAR_LINE_BYTES {
                        Self::fail_all(&pending, "Sidecar response line exceeded 64MB limit").await;
                        break;
                    }
                    line.extend_from_slice(chunk);
                    let consumed = chunk.len();
                    reader.consume(consumed);
                }
            }
        }
        // sidecar 已不可用:清空 tx 让下一次 call 惰性重启,并杀掉残留子进程。
        // 仅当槽位里仍是本进程的通道时才清理,避免误清掉并发重启后的新 sidecar。
        if let Ok(mut guard) = tx_slot.lock() {
            if guard
                .as_ref()
                .is_some_and(|current| current.same_channel(&own_tx))
            {
                *guard = None;
                if let Ok(mut child_guard) = child_slot.lock() {
                    if let Some(mut child) = child_guard.take() {
                        let _ = child.start_kill();
                    }
                }
            }
        }
    }

    async fn fail_request(pending: &PendingResponses, request_id: &str, message: String) {
        if let Some(response_tx) = pending.lock().await.remove(request_id) {
            let _ = response_tx.send(Err(message));
        }
    }

    async fn fail_all(pending: &PendingResponses, message: &str) {
        let responses = {
            let mut pending = pending.lock().await;
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for response_tx in responses {
            let _ = response_tx.send(Err(message.to_string()));
        }
    }

    async fn stderr_drain(stderr: tokio::process::ChildStderr) {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::warn!("Sidecar stderr: {}", line.trim());
        }
    }

    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.call_with_timeout(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    /// 长耗时 RPC(镜像构建等)用自定义超时;常规调用走 `call`(120s)。
    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        // 先在独立作用域取锁,避免 std MutexGuard 跨 await 持有(非 Send)
        let existing_tx = { self.tx.lock().map_err(|e| e.to_string())?.clone() };
        let tx = match existing_tx {
            Some(tx) => tx,
            None => {
                // sidecar 已死(read_loop 检测到 EOF/错误后清空了 tx):惰性重启。
                // start_inner -> validate_sidecar -> call_with_timeout 存在递归,
                // 用 Box::pin 引入间接层。
                tracing::warn!("Sidecar not running, attempting lazy restart");
                Box::pin(self.start_inner()).await?;
                self.tx
                    .lock()
                    .map_err(|e| e.to_string())?
                    .clone()
                    .ok_or_else(|| "Sidecar not running".to_string())?
            }
        };
        let request = RpcRequest {
            id: uuid::Uuid::new_v4().to_string(),
            method: method.to_string(),
            params,
        };
        let request_id = request.id.clone();
        let (response_tx, response_rx) = oneshot::channel();

        self.pending
            .lock()
            .await
            .insert(request_id.clone(), response_tx);
        if tx.send(request).await.is_err() {
            self.pending.lock().await.remove(&request_id);
            return Err("Sidecar not running".to_string());
        }

        let response = match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => {
                result.map_err(|_| "Failed to receive sidecar response".to_string())??
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                return Err(format!(
                    "Sidecar RPC timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
        };

        if let Some(error) = response.error {
            return Err(format!("RPC error {}: {}", error.code, error.message));
        }
        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }
}
