//! SSH/SFTP 域运行时:sidecar 侧的「SshManager + TransferManager + 资产解析」
//! 装配,以及 8 个 `ssh_*` / `sftp_*` 方法共用的会话生命周期逻辑。
//!
//! 行为与结果文本逐字对齐 `src-tauri/src/harness/domain.rs` 的域执行器
//! (模型可读文本是契约,不许漂移):connId 规则、连接级失败重连一次、长 sleep
//! 软引导、后台任务命令拼装、SFTP 列表/统计/传输汇总格式全部原样平移。
//! 差异只有两处,都是 Tauri 专属耦合的消除:
//! - 会话状态来自本结构体而非 `app.state::<SshManager>()`;
//! - 资产配置来自 [`AssetStore`](crate::assets::AssetStore) 而非 SQLite + Keyring。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use starhub_domain_ssh::events::{EventSink, KnownHostsStore};
use starhub_domain_ssh::manager::{
    connect_session, ssh_exec_abort_core, ssh_exec_core, SshManager,
};
use starhub_domain_ssh::sftp::transfer::TransferManager;

use crate::assets::AssetStore;
use crate::known_hosts_store::FileKnownHostsStore;

/// connId 前缀:与前端 dshToolExecutor 的 `dsh:{assetId}:ssh` 保持一致,
/// 可复用前端已建立的 AI exec 会话(避免重复连接)。
pub fn ai_conn_id(asset_id: &str) -> String {
    format!("dsh:{asset_id}:ssh")
}

/// 端口 sshBackgroundTask.ts 的后台任务纯函数。
const AI_BG_TASK_ROOT: &str = "/tmp/starhub-ai-bg";
const AI_BG_MAX_WAIT_S: u64 = 55;
const AI_BG_LOG_TAIL_BYTES: u64 = 4000;

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// UTF-8 安全 base64(与前端 TextEncoder+btoa 等价;自实现避免新增依赖)。
fn to_base64(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn new_background_task_id() -> String {
    format!("task-{}", uuid::Uuid::new_v4().simple())
}

fn is_valid_task_id(task_id: &str) -> bool {
    !task_id.is_empty()
        && task_id.len() <= 64
        && task_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn clamp_task_wait_seconds(value: Option<&serde_json::Value>) -> u64 {
    value
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(30)
        .clamp(1, AI_BG_MAX_WAIT_S)
}

fn build_background_start_command(command: &str, task_id: &str) -> String {
    let dir = format!("{AI_BG_TASK_ROOT}/{task_id}");
    let b64 = to_base64(command);
    [
        format!("d={}", shell_quote(&dir)),
        "mkdir -p \"$d\"".to_string(),
        format!("printf '%s' {} | base64 -d > \"$d/run.sh\"", shell_quote(&b64)),
        "chmod +x \"$d/run.sh\"".to_string(),
        "{ nohup bash -c 'bash \"$1\" > \"$2\" 2>&1; echo $? > \"$3\"' _ \"$d/run.sh\" \"$d/out.log\" \"$d/exit\" >/dev/null 2>&1 & echo $! > \"$d/pid\"; }".to_string(),
        format!("echo \"[TASK] {task_id} STARTED PID=$(cat \"$d/pid\")\""),
    ]
    .join(" && ")
}

fn build_task_poll_command(task_id: &str, wait_seconds: u64) -> String {
    let dir = format!("{AI_BG_TASK_ROOT}/{task_id}");
    let w = wait_seconds.clamp(1, AI_BG_MAX_WAIT_S);
    format!(
        "d={dir}; if [ ! -d \"$d\" ]; then echo \"[STATUS] NOT_FOUND\"; exit 1; fi; i=0; while [ \"$i\" -lt {w} ] && [ ! -f \"$d/exit\" ]; do sleep 1; i=$((i+1)); done; if [ -f \"$d/exit\" ]; then echo \"[STATUS] FINISHED EXIT=$(cat \"$d/exit\" 2>/dev/null)\"; else echo \"[STATUS] RUNNING PID=$(cat \"$d/pid\" 2>/dev/null)\"; fi; echo \"[LOG TAIL]\"; tail -c {AI_BG_LOG_TAIL_BYTES} \"$d/out.log\" 2>/dev/null"
    )
}

/// 检测命令里的长 sleep(阈值 15s,支持 s/m/h 后缀),返回等待秒数。
/// 自实现轻量扫描(与前端 findLongSleepSeconds 语义一致),避免 regex 依赖。
fn find_long_sleep_seconds(command: &str, threshold_sec: f64) -> Option<f64> {
    let lower = command.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"sleep") {
            let after = &bytes[index + 5..];
            let trimmed = after.iter().take_while(|b| b.is_ascii_whitespace()).count();
            let num_start = index + 5 + trimmed;
            let mut num_end = num_start;
            while num_end < bytes.len()
                && (bytes[num_end].is_ascii_digit() || bytes[num_end] == b'.')
            {
                num_end += 1;
            }
            if num_end > num_start {
                if let Ok(value) = lower[num_start..num_end].parse::<f64>() {
                    let unit = lower[num_end..].chars().next().unwrap_or(' ');
                    let seconds = match unit {
                        'm' => value * 60.0,
                        'h' => value * 3600.0,
                        _ => value,
                    };
                    if seconds >= threshold_sec {
                        return Some(seconds);
                    }
                }
            }
            index = num_end.max(index + 5);
        } else {
            index += 1;
        }
    }
    None
}

/// 连接级失败判定:exec 通道都打不开 / 会话句柄不在位——命令一定没有在远端
/// 开始执行,丢弃会话重建后重试是安全的。业务级失败(退出码非 0 /
/// [EXEC_TIMEOUT] / [EXEC_ABORTED])不在此列,原样返回由模型决策。
fn is_connection_level_failure(error: &str) -> bool {
    error.starts_with("[EXEC_FAILED]")
        || error.starts_with("[CONN_FAILED]")
        || error.contains("SSH session not connected")
}

const TRANSFER_POLL_MS: u64 = 400;
const TRANSFER_TIMEOUT_MS: u64 = 30 * 60 * 1000;

fn as_str(value: &serde_json::Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn required_path(value: Option<&serde_json::Value>) -> Result<String, String> {
    let text = as_str(value.unwrap_or(&serde_json::Value::Null))
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if text.len() > 4096 {
        return Err("路径过长".to_string());
    }
    Ok(text)
}

fn required_remote_path(value: Option<&serde_json::Value>) -> Result<String, String> {
    let text = required_path(value)?;
    if !text.starts_with('/') && !text.starts_with('~') {
        return Err(format!("必须是远端绝对路径(以 / 或 ~ 开头),收到: {text}"));
    }
    Ok(text)
}

fn format_json(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// sidecar 的域运行时(全部 `ssh_*` / `sftp_*` 方法共享的可变状态)。
pub struct SshRuntime {
    manager: SshManager,
    transfers: TransferManager,
    assets: Arc<AssetStore>,
    sink: Arc<dyn EventSink>,
    bindings: crate::bindings::SessionBindings,
    registry: crate::session_registry::SessionRegistry,
    /// 在途 exec 的 exec_id → conn_id(停止生成时按 exec_id 中断)。
    inflight: Mutex<HashMap<String, String>>,
}

impl SshRuntime {
    /// 装配运行时;`sink` 接收域事件(JSON-RPC 通知出口)。
    pub fn new(
        assets: Arc<AssetStore>,
        sink: Arc<dyn EventSink>,
        known_hosts: Arc<dyn KnownHostsStore>,
    ) -> Self {
        Self {
            manager: SshManager::new(known_hosts),
            transfers: TransferManager::new(Arc::clone(&sink)),
            assets,
            sink,
            bindings: crate::bindings::SessionBindings::new(),
            registry: crate::session_registry::SessionRegistry::new(),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    /// 用默认文件存储装配(资产/密钥/known_hosts 路径均走环境变量)。
    pub fn from_env(sink: Arc<dyn EventSink>) -> anyhow::Result<Self> {
        let assets = Arc::new(AssetStore::from_env().map_err(|error| anyhow::anyhow!(error))?);
        let known_hosts: Arc<dyn KnownHostsStore> = Arc::new(FileKnownHostsStore::from_env());
        Ok(Self::new(assets, sink, known_hosts))
    }

    /// 资产存储(全局方法 `starhub_list_assets` 用)。
    pub fn assets(&self) -> &Arc<AssetStore> {
        &self.assets
    }

    /// 记录 会话→资产 绑定(`bind_asset_context`)。
    pub fn bind_session(&self, session_id: &str, asset_type: &str, asset_id: &str) {
        self.bindings.bind(session_id, asset_type, asset_id);
    }

    /// 记录 subagent 子→父会话映射(子代理继承父会话绑定)。
    pub fn record_subagent_parent(&self, child_session_id: &str, parent_session_id: &str) {
        self.bindings
            .record_subagent_parent(child_session_id, parent_session_id);
    }

    /// 沿父链解析会话绑定(方法面在参数缺 assetId 时用)。
    pub fn resolve_bound_asset(&self, session_id: &str) -> Option<(String, String)> {
        self.bindings.resolve(session_id)
    }

    /// 会话注册表(`starhub/registry.sync` 快照源)。
    pub fn registry(&self) -> &crate::session_registry::SessionRegistry {
        &self.registry
    }

    /// 存活的 SSH 会话 id 集合(注册表快照的剔除依据)。
    pub async fn live_session_ids(&self) -> std::collections::HashSet<String> {
        self.manager.sessions.lock().await.keys().cloned().collect()
    }

    /// 丢弃一个(死)SSH 会话:map 条目 + 代次 + pending 应答通道一并清理,
    /// 下一次 ensure_ssh_session 按资产配置重建。
    async fn drop_ssh_session(&self, conn_id: &str) {
        self.manager.drop_session(conn_id).await;
    }

    /// 确保 AI exec SSH 会话存在(connId 与前端一致,复用已建会话)。
    /// 返回 connId。死会话自动丢弃重建(与 Tauri 版同语义)。
    pub async fn ensure_ssh_session(&self, asset_id: &str) -> Result<String, String> {
        let conn_id = ai_conn_id(asset_id);
        {
            let session_arc = self.manager.sessions.lock().await.get(&conn_id).cloned();
            match session_arc {
                Some(arc) if arc.lock().await.is_alive() => return Ok(conn_id),
                Some(_) => {
                    // 死会话:网络断开 / 被服务端踢掉。丢弃后走下方建连路径重建
                    // (MFA 资产重建会重新弹验证卡,属于人工配合的必要环节)。
                    self.drop_ssh_session(&conn_id).await;
                }
                None => {}
            }
        }
        // 无会话:按资产配置建立(密码/密钥从资产存储合并)
        let (_name, config) = self.assets.asset_ssh_config(asset_id)?;
        connect_session(
            &self.manager,
            &self.transfers,
            conn_id.clone(),
            config,
            &self.sink,
            false,
        )
        .await?;
        Ok(conn_id)
    }

    /// 执行一条 AI SSH 命令;连接级失败时丢弃死会话、重建一次并重试——
    /// 连接级失败意味着命令尚未在远端开始执行,重试安全。业务级失败原样返回,
    /// 由模型决策下一步。
    async fn exec_with_reconnect(
        &self,
        asset_id: &str,
        conn_id: &str,
        command: &str,
        timeout_sec: u64,
    ) -> Result<String, String> {
        match self.exec_ssh_command(conn_id, command, timeout_sec).await {
            Ok(output) => Ok(output),
            Err(error) if is_connection_level_failure(&error) => {
                self.drop_ssh_session(conn_id).await;
                let fresh_conn = self.ensure_ssh_session(asset_id).await?;
                self.exec_ssh_command(&fresh_conn, command, timeout_sec)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    /// 带 exec_id 的进程内执行,注册取消句柄(停止生成时中断)。
    async fn exec_ssh_command(
        &self,
        conn_id: &str,
        command: &str,
        timeout_sec: u64,
    ) -> Result<String, String> {
        let exec_id = format!("dsh-exec-{}", uuid::Uuid::new_v4());
        self.inflight
            .lock()
            .await
            .insert(exec_id.clone(), conn_id.to_string());
        let result = ssh_exec_core(
            &self.manager,
            &self.sink,
            conn_id,
            command,
            Some(timeout_sec),
            Some(&exec_id),
            true,
        )
        .await;
        self.inflight.lock().await.remove(&exec_id);
        result
    }

    /// 中断一条在途 exec(停止生成);exec_id 未知时返回 false。
    pub async fn abort_exec(&self, exec_id: &str) -> Result<bool, String> {
        let conn_id = self
            .inflight
            .lock()
            .await
            .get(exec_id)
            .cloned()
            .ok_or_else(|| format!("未知或已结束的 exec_id: {exec_id}"))?;
        self.inflight.lock().await.remove(exec_id);
        ssh_exec_abort_core(&self.manager, &conn_id, exec_id).await
    }

    /// `ssh_exec` / `ssh_exec_background` / `ssh_wait_task`。
    pub async fn execute_ssh(
        &self,
        name: &str,
        asset_id: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        if asset_id.is_empty() {
            return Err("缺少 assetId,无法执行 SSH 工具".to_string());
        }
        let conn_id = self.ensure_ssh_session(asset_id).await?;
        if name == "ssh_wait_task" {
            let task_id = as_str(args.get("task_id").unwrap_or(&serde_json::Value::Null))
                .trim()
                .to_string();
            if !is_valid_task_id(&task_id) {
                return Ok("[Error] 无效的 task_id".to_string());
            }
            let wait_sec = clamp_task_wait_seconds(args.get("wait_seconds"));
            let output = self
                .exec_with_reconnect(
                    asset_id,
                    &conn_id,
                    &build_task_poll_command(&task_id, wait_sec),
                    wait_sec + 15,
                )
                .await?;
            return Ok(if output.is_empty() {
                "(无输出)".to_string()
            } else {
                output
            });
        }

        let command = as_str(args.get("command").unwrap_or(&serde_json::Value::Null))
            .trim()
            .to_string();
        if command.is_empty() {
            return Ok("[Error] Empty command".to_string());
        }
        let is_background = name == "ssh_exec_background";
        if !is_background {
            if let Some(sleep_sec) = find_long_sleep_seconds(&command, 15.0) {
                return Ok(format!(
                    "命令包含 sleep 约 {:.0} 秒的长时间等待;请改用 ssh_exec_background 后台执行,再用 ssh_wait_task 轮询结果",
                    sleep_sec
                ));
            }
        }

        let task_id = if is_background {
            new_background_task_id()
        } else {
            String::new()
        };
        let final_command = if is_background {
            build_background_start_command(&command, &task_id)
        } else {
            command.clone()
        };
        let output = self
            .exec_with_reconnect(asset_id, &conn_id, &final_command, 30)
            .await?;
        if is_background {
            Ok(format!(
                "{output}\n后台任务已启动,task_id: {task_id};请调用 ssh_wait_task(task_id=\"{task_id}\") 查询进度与结果。"
            ))
        } else {
            Ok(if output.is_empty() {
                "(无输出)".to_string()
            } else {
                output
            })
        }
    }

    /// 查询当前绑定资产 SSH 会话状态(功能①:给模型透出「已选中机器」等状态)。
    ///
    /// **不触发连接**:只读 `SshManager.sessions`,让模型在发命令前判断是否会
    /// 弹「选机器」浮层 / 命令是否静默执行。
    pub async fn execute_ssh_status(&self, asset_id: &str) -> Result<String, String> {
        let conn_id = ai_conn_id(asset_id);
        let session_arc = {
            let sessions = self.manager.sessions.lock().await;
            sessions.get(&conn_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            return Ok(format!(
                "SSH 会话未建立(资产 {asset_id}):首次命令会自动连接,堡垒机会依次弹出 MFA 验证卡与「选机器」终端,需要一次人工配合;之后会话复用,命令静默执行。"
            ));
        };
        let session = session_arc.lock().await;
        if !session.is_alive() {
            return Ok(format!(
                "SSH 会话已断开(资产 {asset_id}):连接已死亡(网络断开或被服务端踢掉),下一条命令会自动重建连接;堡垒机资产重建时会重新弹出 MFA 验证与选机器流程。"
            ));
        }
        if session.bastion_shell_ready() {
            Ok(format!(
                "SSH 会话已就绪(资产 {asset_id}):堡垒机已选中目标机器,后续命令直接静默执行,不会弹窗。"
            ))
        } else if session.is_bastion() {
            Ok(format!(
                "SSH 会话已连接(资产 {asset_id},堡垒机):尚未选择目标机器,下一条命令会弹出「选机器」实时终端,请准备在终端里输入序号选择。"
            ))
        } else {
            Ok(format!(
                "SSH 会话已连接(资产 {asset_id}),命令将直接执行,不会弹窗。"
            ))
        }
    }

    /// `sftp_list` / `sftp_stat` / `sftp_upload` / `sftp_download`(复用 SSH 会话)。
    pub async fn execute_sftp(
        &self,
        name: &str,
        asset_id: &str,
        args: &serde_json::Value,
    ) -> Result<String, String> {
        if asset_id.is_empty() {
            return Err("缺少 assetId,无法执行 SFTP 工具".to_string());
        }
        let conn_id = self.ensure_ssh_session(asset_id).await?;

        // 确保 SFTP 通道已注册(惰性建立)
        if !self.transfers.has_session(&conn_id).await {
            let session_arc = {
                let sessions = self.manager.sessions.lock().await;
                sessions
                    .get(&conn_id)
                    .cloned()
                    .ok_or_else(|| format!("SSH session {conn_id} not found"))?
            };
            let mut session = session_arc.lock().await;
            let (sftp, _launch_info) = session.open_sftp_with_info().await?;
            self.transfers
                .register_sftp(conn_id.clone(), Arc::new(tokio::sync::Mutex::new(sftp)))
                .await;
        }

        match name {
            "sftp_list" => {
                let path = required_remote_path(args.get("path"))?;
                let session_arc = {
                    let sessions = self.manager.sessions.lock().await;
                    sessions
                        .get(&conn_id)
                        .cloned()
                        .ok_or_else(|| "session not found".to_string())?
                };
                let mut session = session_arc.lock().await;
                let entries = session
                    .with_browse_sftp(|sftp| {
                        Box::pin(
                            async move { sftp.read_dir(&path).await.map_err(|e| e.to_string()) },
                        )
                    })
                    .await?;
                let mut lines: Vec<String> = Vec::new();
                for entry in entries {
                    let metadata = entry.metadata();
                    let is_dir = metadata.is_dir();
                    let size = if is_dir {
                        0
                    } else {
                        metadata.size.unwrap_or(0)
                    };
                    let path = entry.path();
                    lines.push(format!(
                        "{} | {} | {} | {:o}",
                        if is_dir { "DIR " } else { "FILE" },
                        path,
                        if is_dir {
                            "-".to_string()
                        } else {
                            size.to_string()
                        },
                        metadata.permissions.unwrap_or(0)
                    ));
                }
                if lines.len() > 200 {
                    let shown = lines.len();
                    lines.truncate(200);
                    lines.push(format!("… (共 {shown} 项,仅显示前 200 项)"));
                }
                Ok(if lines.is_empty() {
                    "(空目录)".to_string()
                } else {
                    lines.join("\n")
                })
            }
            "sftp_stat" => {
                let path = required_remote_path(args.get("path"))?;
                let session_arc = {
                    let sessions = self.manager.sessions.lock().await;
                    sessions
                        .get(&conn_id)
                        .cloned()
                        .ok_or_else(|| "session not found".to_string())?
                };
                let mut session = session_arc.lock().await;
                let meta_path = path.clone();
                let metadata = session
                    .with_browse_sftp(|sftp| {
                        Box::pin(async move {
                            sftp.metadata(&meta_path).await.map_err(|e| e.to_string())
                        })
                    })
                    .await?;
                Ok(format_json(&serde_json::json!({
                    "path": path,
                    "is_dir": metadata.is_dir(),
                    "size": metadata.size.unwrap_or(0),
                    "permissions": metadata.permissions.unwrap_or(0),
                })))
            }
            "sftp_upload" | "sftp_download" => {
                let speed_limit = args
                    .get("speedLimit")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                if name == "sftp_upload" {
                    let local_paths: Vec<String> = args
                        .get("localPaths")
                        .and_then(serde_json::Value::as_array)
                        .map(|arr| arr.iter().map(as_str).collect())
                        .unwrap_or_default();
                    if local_paths.is_empty() {
                        return Err("localPaths 不能为空".to_string());
                    }
                    let remote_dir = required_remote_path(args.get("remoteDir"))?;
                    let transfer_id = self
                        .transfers
                        .upload(&conn_id, local_paths, remote_dir, speed_limit)
                        .await
                        .map_err(|e| e.to_string())?;
                    self.wait_for_transfer(&conn_id, &transfer_id).await
                } else {
                    let remote_paths: Vec<String> = args
                        .get("remotePaths")
                        .and_then(serde_json::Value::as_array)
                        .map(|arr| arr.iter().map(as_str).collect())
                        .unwrap_or_default();
                    if remote_paths.is_empty() {
                        return Err("remotePaths 不能为空".to_string());
                    }
                    let local_dir = required_path(args.get("localDir"))?;
                    let transfer_id = self
                        .transfers
                        .download(&conn_id, remote_paths, local_dir, speed_limit)
                        .await
                        .map_err(|e| e.to_string())?;
                    self.wait_for_transfer(&conn_id, &transfer_id).await
                }
            }
            other => Err(format!("Unknown SFTP tool: {other}")),
        }
    }

    /// 等一次传输到达终态,返回模型可读汇总(文案与 Tauri 版逐字一致)。
    async fn wait_for_transfer(&self, conn_id: &str, transfer_id: &str) -> Result<String, String> {
        use starhub_domain_ssh::sftp::{TransferDirection, TransferStatus};
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(TRANSFER_TIMEOUT_MS);
        loop {
            let task = self
                .transfers
                .list_tasks(conn_id)
                .await
                .into_iter()
                .find(|t| t.id == transfer_id);
            if let Some(task) = task {
                match task.status {
                    TransferStatus::Done => {
                        let direction = match task.direction {
                            TransferDirection::Upload => "上传",
                            TransferDirection::Download => "下载",
                        };
                        return Ok(format!(
                            "传输已完成 ({direction}):\n任务: {}\n文件: {}\n大小: {}",
                            task.id,
                            task.files.len(),
                            task.total_bytes
                        ));
                    }
                    TransferStatus::Failed => {
                        return Err(format!(
                            "SFTP 传输失败: {}{}",
                            transfer_id,
                            task.error
                                .as_deref()
                                .map(|e| format!(" ({e})"))
                                .unwrap_or_default()
                        ));
                    }
                    TransferStatus::Cancelled => {
                        return Err(format!("SFTP 传输已取消: {transfer_id}"));
                    }
                    TransferStatus::Paused => {
                        return Err(format!(
                            "SFTP 传输已被用户暂停: {transfer_id}。如需继续,请在传输队列中恢复后重试。"
                        ));
                    }
                    TransferStatus::Queued | TransferStatus::Running => {}
                }
            }
            if std::time::Instant::now() > deadline {
                return Err(format!("SFTP 传输等待超过 30 分钟: {transfer_id}"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(TRANSFER_POLL_MS)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 纯函数:base64 / 后台任务命令 / sleep 检测 ----------

    #[test]
    fn base64_roundtrip_matches_standard() {
        // 与前端 TextEncoder + btoa 等价:ASCII、中文、空串、3 字节对齐边界
        for text in ["", "a", "ab", "abc", "abcd", "ls -la /var/log", "你好世界"] {
            let encoded = to_base64(text);
            let expected: &str = match text {
                "" => "",
                "a" => "YQ==",
                "ab" => "YWI=",
                "abc" => "YWJj",
                "abcd" => "YWJjZA==",
                "ls -la /var/log" => "bHMgLWxhIC92YXIvbG9n",
                "你好世界" => "5L2g5aW95LiW55WM",
                _ => unreachable!(),
            };
            assert_eq!(encoded, expected, "base64 编码不符: {text:?}");
            let decoded = decode_base64_for_test(&encoded);
            assert_eq!(decoded, text.as_bytes(), "base64 往返失败: {text:?}");
        }
    }

    fn decode_base64_for_test(encoded: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer = 0u32;
        let mut bits = 0u32;
        for ch in encoded.chars() {
            if ch == '=' {
                break;
            }
            let value = ALPHABET.iter().position(|&c| c as char == ch);
            let Some(value) = value else { continue };
            buffer = (buffer << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
                buffer &= (1 << bits) - 1;
            }
        }
        out
    }

    #[test]
    fn background_start_command_builds_expected_shape() {
        let command = "echo hi";
        let task_id = "task-abc123";
        let built = build_background_start_command(command, task_id);
        assert!(
            built.contains(&format!("/tmp/starhub-ai-bg/{task_id}")),
            "{built}"
        );
        assert!(built.contains("mkdir -p"), "{built}");
        assert!(built.contains("nohup bash"), "{built}");
        assert!(built.contains("run.sh"), "{built}");
        assert!(built.contains("out.log"), "{built}");
        // 命令体经 base64 落盘,不应以明文出现
        assert!(!built.contains("echo hi"), "命令应以 base64 传输: {built}");
        assert!(built.contains("[TASK] task-abc123 STARTED"), "{built}");
    }

    #[test]
    fn poll_command_validates_and_writes_status() {
        let built = build_task_poll_command("task-x", 30);
        assert!(built.contains("NOT_FOUND"), "{built}");
        assert!(built.contains("FINISHED EXIT"), "{built}");
        assert!(built.contains("RUNNING PID"), "{built}");
        assert!(built.contains("[LOG TAIL]"), "{built}");
        assert!(built.contains("tail -c 4000"), "{built}");
    }

    #[test]
    fn task_id_validation() {
        assert!(is_valid_task_id("task-abc_123"));
        assert!(is_valid_task_id("TASK-x9"));
        assert!(!is_valid_task_id(""));
        assert!(!is_valid_task_id("task id with spaces"));
        assert!(!is_valid_task_id(&"x".repeat(65)));
        assert!(!is_valid_task_id("task;rm -rf /"));
    }

    #[test]
    fn clamp_wait_seconds_bounds() {
        assert_eq!(clamp_task_wait_seconds(None), 30);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(1))), 1);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(55))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(999))), 55);
        assert_eq!(clamp_task_wait_seconds(Some(&serde_json::json!(0))), 1);
    }

    #[test]
    fn long_sleep_detection() {
        assert!(find_long_sleep_seconds("sleep 30", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1m", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 1h", 15.0).is_some());
        assert!(find_long_sleep_seconds("sleep 5", 15.0).is_none());
        assert!(find_long_sleep_seconds("ls -la", 15.0).is_none());
        assert!(find_long_sleep_seconds("SLEEP 20 && echo x", 15.0).is_some());
        assert!(
            find_long_sleep_seconds("echo 'sleep 999'", 15.0).is_some(),
            "字符串内也应命中(与前端 regex 一致)"
        );
    }

    // ---------- 连接级失败判定 ----------

    #[test]
    fn connection_level_failure_matches_only_transport_errors() {
        assert!(is_connection_level_failure(
            "[EXEC_FAILED] Failed to open exec channel: Channel send error"
        ));
        assert!(is_connection_level_failure("SSH session not connected"));
        assert!(is_connection_level_failure(
            "[CONN_FAILED] Failed to connect to 10.0.0.7:22: timeout"
        ));
        assert!(!is_connection_level_failure(
            "Command exited with code 1: no such file"
        ));
        assert!(!is_connection_level_failure(
            "[EXEC_TIMEOUT] Command timed out after 30s: apt-get install"
        ));
        assert!(!is_connection_level_failure(
            "[EXEC_ABORTED] Command aborted by user: ls"
        ));
    }

    // ---------- 路径参数校验 ----------

    #[test]
    fn remote_path_requires_absolute_or_tilde() {
        assert_eq!(
            required_remote_path(Some(&serde_json::json!("/var/log"))).unwrap(),
            "/var/log"
        );
        assert_eq!(
            required_remote_path(Some(&serde_json::json!("~/x"))).unwrap(),
            "~/x"
        );
        let err = required_remote_path(Some(&serde_json::json!("var/log"))).unwrap_err();
        assert!(err.contains("必须是远端绝对路径"), "{err}");
        assert!(required_remote_path(Some(&serde_json::json!("  "))).is_err());
        assert!(required_remote_path(None).is_err());
    }

    // ---------- 运行时:空资产库上的软错误(不触网) ----------

    #[tokio::test]
    async fn ssh_tools_report_missing_asset_without_touching_the_network() {
        let dir =
            std::env::temp_dir().join(format!("starhub-runtime-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let assets = Arc::new(crate::assets::AssetStore::new(
            dir.join("assets.json"),
            Box::new(crate::assets::MemorySecretStore::new()),
        ));
        let runtime = SshRuntime::new(
            Arc::clone(&assets),
            Arc::new(NoopSink),
            Arc::new(starhub_domain_ssh::events::MemoryKnownHostsStore::default()),
        );

        // 未知资产:ensure_ssh_session 在解析资产配置处失败,文案与 Tauri 版一致
        let err = runtime
            .execute_ssh("ssh_exec", "ghost", &serde_json::json!({ "command": "ls" }))
            .await
            .unwrap_err();
        assert_eq!(err, "资产不存在: ghost");

        // 状态查询不触发连接:无会话 → 引导文案
        let status = runtime.execute_ssh_status("ghost").await.unwrap();
        assert!(status.contains("SSH 会话未建立(资产 ghost)"), "{status}");

        // 空资产库的清单
        assert_eq!(assets.list_assets_text(None).unwrap(), "[]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct NoopSink;

    impl starhub_domain_ssh::events::EventSink for NoopSink {
        fn emit(&self, _event: &str, _payload: serde_json::Value) {}
    }
}
