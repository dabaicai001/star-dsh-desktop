//! Go sidecar stdio JSON-RPC 客户端(去 Tauri 化 M1 从
//! `src-tauri/src/sidecar/mod.rs` 平移,逻辑零改动)。
//!
//! sidecar 二进制(`starhub-sidecar-rust`)在 M1 架构里是 Go sidecar 的**父进程**:
//! 模型工具 → sidecar-rust → Go sidecar(全部数据库/中间件适配)。
//! 与 Tauri 时代的差异只有两点:
//! 1. `start()` 不再收 `tauri::AppHandle`——进程生命周期由持有者自负;
//! 2. 二进制查找优先环境变量 `STARHUB_GO_SIDECAR`(部署形态从「Tauri 壳的
//!    同级目录」变成「sidecar-rust 的同级目录 / 配置注入」)。
//!
//! 协议:换行分帧 JSON-RPC 2.0(`{id, method, params}` → `{id, result|error}`),
//! 与 Go 侧 `sidecar/rpc` 一致;响应单行上限 64MB,超限判定进程异常并重建。

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

/// 测试替身:假 Go sidecar 的启动命令(`python tests/fixtures/fake-go-sidecar.py`)。
///
/// 契约测试(sidecar 二进制的方法面 roundtrip)不必真连 MySQL/Redis——用一个
/// 说同款协议的假 sidecar 就能验证「wire 形状 + 结果文本格式」两件不许漂移
/// 的事。路径相对本 crate 的 `CARGO_MANIFEST_DIR`,跨 crate 引用不会找错。
pub fn fake_go_sidecar_command() -> Result<(String, Vec<String>), String> {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-go-sidecar.py");
    if !fixture.exists() {
        return Err(format!(
            "fake Go sidecar fixture not found at {}",
            fixture.display()
        ));
    }
    let python = if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    };
    Ok((python.to_string(), vec![fixture.display().to_string()]))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RpcRequest {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RpcResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarInfo {
    version: String,
    protocol_version: u32,
    methods: Vec<String>,
}

type ResponseSender = oneshot::Sender<Result<RpcResponse, String>>;
type PendingResponses = Arc<tokio::sync::Mutex<HashMap<String, ResponseSender>>>;

/// Go sidecar 客户端:惰性启动 + 在途请求表 + 死亡自愈(下一次 call 重启)。
pub struct GoSidecar {
    tx: Arc<Mutex<Option<mpsc::Sender<RpcRequest>>>>,
    pending: PendingResponses,
    child: Arc<Mutex<Option<Child>>>,
    /// 串行化 start/restart,消除并发 start 的 TOCTOU(检查与赋值在锁内)
    start_lock: tokio::sync::Mutex<()>,
    /// 启动命令覆盖(测试替身 / 部署注入);None = 按 current_exe 相对查找二进制。
    command: Option<(std::path::PathBuf, Vec<String>)>,
}

impl Default for GoSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl GoSidecar {
    pub fn new() -> Self {
        Self {
            tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            child: Arc::new(Mutex::new(None)),
            start_lock: tokio::sync::Mutex::new(()),
            command: None,
        }
    }

    /// 指定 Go sidecar 二进制路径(测试 / 部署注入)。
    pub fn with_binary(path: impl Into<std::path::PathBuf>) -> Self {
        let mut sidecar = Self::new();
        sidecar.command = Some((path.into(), Vec::new()));
        sidecar
    }

    /// 指定「解释器 + 脚本」形式的启动命令(测试替身:python fake-go-sidecar.py)。
    pub fn with_command(program: impl Into<std::path::PathBuf>, args: Vec<String>) -> Self {
        let mut sidecar = Self::new();
        sidecar.command = Some((program.into(), args));
        sidecar
    }

    /// 启动(或确认已在运行)。幂等:并发调用由 start_lock 串行化。
    pub async fn start(&self) -> Result<(), String> {
        self.start_inner().await
    }

    fn binary_name() -> &'static str {
        if cfg!(target_os = "windows") {
            "starhub-sidecar.exe"
        } else {
            "starhub-sidecar"
        }
    }

    /// 解析启动命令:显式覆盖优先,否则环境变量 `STARHUB_GO_SIDECAR`,
    /// 最后按 current_exe 相对查找(打包形态与开发形态各一组候选)。
    fn resolve_command(&self) -> Result<(std::path::PathBuf, Vec<String>), String> {
        if let Some(command) = &self.command {
            return Ok(command.clone());
        }
        if let Some(path) = std::env::var_os("STARHUB_GO_SIDECAR") {
            let path = std::path::PathBuf::from(path);
            if path.exists() {
                return Ok((path, Vec::new()));
            }
            return Err(format!(
                "STARHUB_GO_SIDECAR 指向的 Go sidecar 不存在: {}",
                path.display()
            ));
        }

        let sidecar_name = Self::binary_name();
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

        candidates
            .into_iter()
            .find(|path| path.exists())
            .map(|path| (path, Vec::new()))
            .ok_or_else(|| {
                format!(
                    "Go sidecar not found. Set STARHUB_GO_SIDECAR or place {} next to the sidecar binary (looked relative to exe at {exe_dir:?})",
                    sidecar_name
                )
            })
    }

    async fn start_inner(&self) -> Result<(), String> {
        // 整个启动过程(含 is_some 检查与赋值)都在 start_lock 内,
        // 并发的 start / 惰性重启不会各自 spawn 出重复进程。
        let _start_guard = self.start_lock.lock().await;
        if self.tx.lock().map_err(|e| e.to_string())?.is_some() {
            return Ok(());
        }

        let (program, args) = self.resolve_command()?;
        let sidecar_path = program.clone();
        tracing::info!("Go sidecar path: {:?} args={:?}", sidecar_path, args);

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .stdin(Stdio::piped())
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
            .map_err(|e| format!("Failed to start Go sidecar: {e}"))?;
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
                "Incompatible Go sidecar at {}: {error}. Rebuild or reinstall StarHub.",
                sidecar_path.display()
            ));
        }

        tracing::info!("Go sidecar started and validated successfully");
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
                "Go sidecar {} is missing required RPC methods: {}",
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
                    format!("Failed to write to Go sidecar: {error}"),
                )
                .await;
                Self::fail_all(&pending, "Go sidecar stdin closed").await;
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
                        &format!("Failed to read Go sidecar response: {error}"),
                    )
                    .await;
                    break;
                }
            };
            if chunk.is_empty() {
                Self::fail_all(&pending, "Go sidecar closed stdout").await;
                break;
            }
            match chunk.iter().position(|byte| *byte == b'\n') {
                Some(pos) => {
                    if line.len() + pos > MAX_SIDECAR_LINE_BYTES {
                        Self::fail_all(&pending, "Go sidecar response line exceeded 64MB limit")
                            .await;
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
                            tracing::error!("Failed to parse Go sidecar response: {error}");
                        }
                    }
                    line.clear();
                    reader.consume(consumed);
                }
                None => {
                    // 增量检查单行上限,避免超长行先把内存打爆才被截断
                    if line.len() + chunk.len() > MAX_SIDECAR_LINE_BYTES {
                        Self::fail_all(&pending, "Go sidecar response line exceeded 64MB limit")
                            .await;
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
            tracing::warn!("Go sidecar stderr: {}", line.trim());
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
                tracing::warn!("Go sidecar not running, attempting lazy restart");
                Box::pin(self.start_inner()).await?;
                self.tx
                    .lock()
                    .map_err(|e| e.to_string())?
                    .clone()
                    .ok_or_else(|| "Go sidecar not running".to_string())?
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
            return Err("Go sidecar not running".to_string());
        }

        let response = match tokio::time::timeout(timeout, response_rx).await {
            Ok(result) => {
                result.map_err(|_| "Failed to receive Go sidecar response".to_string())??
            }
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                return Err(format!(
                    "Go sidecar RPC timed out after {} seconds",
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_override_short_circuits_lookup() {
        let sidecar = GoSidecar::with_binary("/tmp/fake-starhub-sidecar");
        assert_eq!(
            sidecar.resolve_command().unwrap().0,
            std::path::PathBuf::from("/tmp/fake-starhub-sidecar"),
            "显式覆盖优先于一切相对查找(测试替身因此可以指向任意路径)"
        );
    }

    #[test]
    fn command_override_carries_arguments() {
        let sidecar = GoSidecar::with_command("python", vec!["fake.py".to_string()]);
        let (program, args) = sidecar.resolve_command().unwrap();
        assert_eq!(program, std::path::PathBuf::from("python"));
        assert_eq!(args, vec!["fake.py".to_string()]);
    }

    #[tokio::test]
    async fn spawn_failure_fails_loud() {
        // 二进制不存在:spawn 失败必须是响亮的错误,而不是空结果/静默挂起
        let sidecar = GoSidecar::with_binary("/definitely/not/here/starhub-sidecar");
        let error = sidecar
            .call("db.mysql.connect", serde_json::json!({}))
            .await
            .expect_err("missing binary → error");
        assert!(error.contains("Failed to start Go sidecar"), "{error}");
    }

    /// 端到端契约:真 spawn 一个说同款协议的假 Go sidecar,验证 version 握手
    /// (协议版本 + 必需方法表)与 connect 全链。
    #[tokio::test]
    async fn real_roundtrip_against_the_fake_go_sidecar() {
        let Ok((python, args)) = fake_go_sidecar_command() else {
            eprintln!("skip: fake Go sidecar fixture not found");
            return;
        };
        let sidecar = GoSidecar::with_command(python, args);
        let version = sidecar
            .call_with_timeout(
                "version",
                serde_json::json!({}),
                std::time::Duration::from_secs(15),
            )
            .await
            .expect("version handshake");
        assert_eq!(version["protocolVersion"], 2);
        assert!(version["methods"]
            .as_array()
            .expect("methods array")
            .iter()
            .any(|m| m == "db.mysql.getTableMeta"));

        let connected = sidecar
            .call("db.mysql.connect", serde_json::json!({"host": "fake"}))
            .await
            .expect("connect");
        // 假 sidecar 按调用递增生成 connId;这里只验证形状(前缀 + 序号)
        let conn_id = connected["connId"].as_str().expect("connId string");
        assert!(conn_id.starts_with("mysql-conn-"), "{conn_id}");
    }
}
