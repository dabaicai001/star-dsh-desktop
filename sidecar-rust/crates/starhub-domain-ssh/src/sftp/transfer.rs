use anyhow::Result;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use crate::events::{EventSink, EventSinkExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::ops::{download_file, list_dir, mkdir, stat, upload_file};
use super::{TransferDirection, TransferFile, TransferProgress, TransferStatus, TransferTask};

/// 终态任务(Done/Failed/Cancelled)保留上限,超出后按插入顺序淘汰最旧的,
/// 避免 tasks map 只增不减。进行中 / 已暂停的任务永远保留,不影响现有查询 API。
const MAX_RETAINED_TERMINAL_TASKS: usize = 100;

fn is_terminal(status: &TransferStatus) -> bool {
    matches!(
        status,
        TransferStatus::Done | TransferStatus::Failed | TransferStatus::Cancelled
    )
}

/// 重试契约:失败 / 已取消可重试(复用原任务续传),其余状态拒绝。
/// 前端按同一规则渲染「重试」按钮,两端必须一致。
const RETRYABLE: &[TransferStatus] = &[TransferStatus::Failed, TransferStatus::Cancelled];

/// 状态变更事件 payload(emit 到 `sftp://transfer-status`)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatusEvent {
    pub transfer_id: String,
    pub session_id: String,
    pub direction: TransferDirection,
    pub status: TransferStatus,
    pub error: Option<String>,
}

/// 每个传输任务的控制令牌。
/// - cancel:取消(终态,任务不可再恢复)
/// - pause:暂停(worker 在块边界退出,任务与断点偏移保留,可 resume 继续)
#[derive(Clone)]
struct TransferControl {
    cancel: CancellationToken,
    pause: CancellationToken,
}

impl TransferControl {
    fn new() -> Self {
        Self {
            cancel: CancellationToken::new(),
            pause: CancellationToken::new(),
        }
    }

    fn interrupted(&self) -> bool {
        self.cancel.is_cancelled() || self.pause.is_cancelled()
    }
}

/// 进度事件节流间隔:每文件最多每 100ms 发一次,文件完成(终块)必发。
/// 此前每 64KB chunk 一次 emit,10GB 文件 ≈ 16 万次 IPC + React setState。
const PROGRESS_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Recursively collect all files under `path`, returning `(local_path, remote_relative_path, size)` tuples.
/// `relative_prefix` is the base name used to build the remote relative path.
async fn collect_local_files(
    path: &str,
    relative_prefix: &str,
) -> Result<Vec<(String, String, u64)>> {
    let meta = tokio::fs::metadata(path).await?;
    if meta.is_file() {
        return Ok(vec![(
            path.to_string(),
            relative_prefix.to_string(),
            meta.len(),
        )]);
    }

    let mut results = Vec::new();
    let mut read_dir = tokio::fs::read_dir(path).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let child_name = entry.file_name().to_string_lossy().to_string();
        let child_path = entry.path().to_string_lossy().to_string();
        let child_relative = if relative_prefix.is_empty() {
            child_name.clone()
        } else {
            format!("{}/{}", relative_prefix, child_name)
        };
        let sub = Box::pin(collect_local_files(&child_path, &child_relative)).await?;
        results.extend(sub);
    }
    Ok(results)
}

/// 递归收集远端文件(目录下载):返回 `(remote_path, local_relative_path, size)`。
/// stat 失败的条目降级为单文件 size 0(某些远端/FUSE stat 不可用但可读),
/// 让 worker 尝试 open,与原单文件行为一致。
async fn collect_remote_files(
    sftp: &Arc<Mutex<SftpSession>>,
    remote_path: &str,
    relative_prefix: &str,
) -> Result<Vec<(String, String, u64)>> {
    let entry = match stat(sftp, remote_path).await {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(
                "[collect_remote_files] stat failed for {}: {}; treating as single file",
                remote_path,
                err
            );
            return Ok(vec![(
                remote_path.to_string(),
                relative_prefix.to_string(),
                0,
            )]);
        }
    };
    if !entry.is_dir {
        return Ok(vec![(
            remote_path.to_string(),
            relative_prefix.to_string(),
            entry.size,
        )]);
    }
    let mut results = Vec::new();
    for child in list_dir(sftp, remote_path).await? {
        // 防环:符号链接目录不递归(按链接本身的大小当文件下,open 失败会落任务失败)
        if child.is_symlink && child.is_dir {
            continue;
        }
        let child_relative = format!("{}/{}", relative_prefix, child.name);
        let mut sub = Box::pin(collect_remote_files(sftp, &child.path, &child_relative)).await?;
        results.append(&mut sub);
    }
    Ok(results)
}

/// 为文件名生成冲突后缀:`a.txt` → `a (1).txt`;无扩展名/点前缀直接追加。
fn suffixed_name(name: &str, n: usize) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{} ({})", name, n),
    }
}

/// 任务内下载落盘重名保护:不同远端路径的同名文件/目录落到同一本地目录时,
/// 后到的根组件加 ` (n)` 后缀(子项随根一起改),避免互相覆盖丢数据。
/// 返回每个输入根实际使用的根名(与输入等长、按序)。
fn dedupe_download_roots(base_names: &[String]) -> Vec<String> {
    let mut used: HashSet<String> = HashSet::new();
    let mut roots = Vec::with_capacity(base_names.len());
    for base in base_names {
        let mut root = base.clone();
        let mut n = 1;
        while used.contains(&root) {
            root = suffixed_name(base, n);
            n += 1;
        }
        used.insert(root.clone());
        roots.push(root);
    }
    roots
}

/// Recursively create directories on remote (like `mkdir -p`).
/// 用 stat 判定「已存在」而不是字符串匹配错误文本(此前 `contains("Failure")`
/// 会把权限失败等真错误当已存在吞掉,后续 create 报误导性错误)。
async fn mkdir_p(sftp: &Arc<Mutex<SftpSession>>, path: &str) -> Result<()> {
    let mut current = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        current.push('/');
        current.push_str(segment);
        match stat(sftp, &current).await {
            Ok(entry) if entry.is_dir => continue,
            Ok(_) => {
                anyhow::bail!("mkdir_p: {} exists and is not a directory", current)
            }
            Err(_) => {
                if let Err(e) = mkdir(sftp, &current).await {
                    // 并发/竞争下可能恰好被他人创建:再 stat 一次确认,仍不是目录才报错。
                    match stat(sftp, &current).await {
                        Ok(entry) if entry.is_dir => continue,
                        _ => return Err(e),
                    }
                }
            }
        }
    }
    Ok(())
}

pub struct TransferManager {
    tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
    /// 任务插入顺序,用于终态任务的滚动淘汰
    task_order: Arc<Mutex<std::collections::VecDeque<String>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>>,
    controls: Arc<Mutex<HashMap<String, TransferControl>>>,
    app_handle: Arc<dyn EventSink>,
}

impl TransferManager {
    pub fn new(app_handle: Arc<dyn EventSink>) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            task_order: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            controls: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
        }
    }

    /// 终态任务滚动淘汰:保留最近 MAX_RETAINED_TERMINAL_TASKS 条,超出后淘汰最旧的。
    /// 调用方必须同时持有 tasks 锁;task_order 锁在其后获取(固定锁顺序)。
    fn prune_terminal_tasks(
        tasks: &mut HashMap<String, TransferTask>,
        order: &mut std::collections::VecDeque<String>,
    ) {
        let mut terminal = tasks.values().filter(|t| is_terminal(&t.status)).count();
        let mut scanned = 0;
        while terminal > MAX_RETAINED_TERMINAL_TASKS && scanned < order.len() {
            scanned += 1;
            let Some(id) = order.pop_front() else {
                break;
            };
            match tasks.get(&id) {
                Some(task) if is_terminal(&task.status) => {
                    tasks.remove(&id);
                    terminal -= 1;
                }
                // 仍在进行的任务不淘汰,移到队尾等待下次扫描
                Some(_) => order.push_back(id),
                None => {}
            }
        }
    }

    pub async fn register_sftp(&self, session_id: String, sftp: Arc<Mutex<SftpSession>>) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.insert(session_id, sftp);
    }

    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sftp_sessions.lock().await.contains_key(session_id)
    }

    /// 轻量探活已注册的传输通道(canonicalize ".");SSH 正常但 sftp 通道死亡
    /// 时返回 false,调用方应 unregister 后重建(此前 has_session 短路导致
    /// 死通道永久不自愈,只能重连 SSH)。
    pub async fn probe_sftp(&self, session_id: &str) -> bool {
        let sftp = { self.sftp_sessions.lock().await.get(session_id).cloned() };
        match sftp {
            Some(s) => {
                let guard = s.lock().await;
                guard.canonicalize(".").await.is_ok()
            }
            None => false,
        }
    }

    pub async fn unregister_sftp(&self, session_id: &str) {
        let mut sessions = self.sftp_sessions.lock().await;
        sessions.remove(session_id);
    }

    /// 清除终态任务(Done/Failed/Cancelled):transfer_id 给定时只清该条,
    /// 否则清掉该会话全部终态任务;进行中的任务不动。返回清除条数。
    pub async fn clear_terminal(&self, session_id: &str, transfer_id: Option<&str>) -> u32 {
        let mut tasks = self.tasks.lock().await;
        let mut order = self.task_order.lock().await;
        let removed_ids: Vec<String> = tasks
            .values()
            .filter(|t| {
                t.session_id == session_id
                    && is_terminal(&t.status)
                    && (transfer_id.is_none() || transfer_id == Some(t.id.as_str()))
            })
            .map(|t| t.id.clone())
            .collect();
        let count = removed_ids.len() as u32;
        for rid in &removed_ids {
            tasks.remove(rid);
        }
        if !removed_ids.is_empty() {
            order.retain(|id| !removed_ids.contains(id));
        }
        count
    }

    /// 拿到当前 session 的所有任务(给前端做断线重连/刷新用)
    pub async fn list_tasks(&self, session_id: &str) -> Vec<TransferTask> {
        let tasks = self.tasks.lock().await;
        tasks
            .values()
            .filter(|t| t.session_id == session_id)
            .cloned()
            .collect()
    }

    /// 全量任务(跨全部 session;dsh 联动 `starhub/live.snapshot` 的 transfers 用)。
    pub async fn list_all_tasks(&self) -> Vec<TransferTask> {
        self.tasks.lock().await.values().cloned().collect()
    }

    pub async fn upload(
        &self,
        session_id: &str,
        local_paths: Vec<String>,
        remote_dir: String,
        speed_limit: u64,
    ) -> Result<String> {
        tracing::info!(
            "[TransferManager::upload] start: session={}, files={}, remote_dir={}",
            session_id,
            local_paths.len(),
            remote_dir
        );

        // 早转 owned,后面 spawn 闭包要 'static
        let session_id = session_id.to_string();

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            let s = sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?;
            tracing::info!(
                "[TransferManager::upload] SFTP session found for {}",
                session_id
            );
            s
        };

        let transfer_id = Uuid::new_v4().to_string();

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;
        let mut all_files: Vec<(String, String, u64)> = Vec::new();

        for local_path in &local_paths {
            let base_name = Path::new(local_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| local_path.clone());
            let collected = collect_local_files(local_path, &base_name).await?;
            if collected.is_empty()
                && tokio::fs::metadata(local_path)
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
            {
                // 空目录上传:远端仍建出目录(否则任务 0 文件直接 Done,远端什么都没发生)
                let remote_base = if remote_dir.ends_with('/') {
                    format!("{}{}", remote_dir, base_name)
                } else {
                    format!("{}/{}", remote_dir, base_name)
                };
                mkdir_p(&sftp, &remote_base).await?;
            }
            for (_lp, rp, size) in &collected {
                files.push(TransferFile {
                    name: rp.clone(),
                    size: *size,
                    transferred: 0,
                });
                total_bytes += size;
            }
            all_files.extend(collected);
        }

        let task = TransferTask {
            id: transfer_id.clone(),
            session_id: session_id.clone(),
            direction: TransferDirection::Upload,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            speed_limit,
            error: None,
            upload_local_paths: Some(local_paths.clone()),
            upload_remote_dir: Some(remote_dir.clone()),
            download_remote_paths: None,
            download_local_dir: None,
            upload_all_files: Some(all_files.clone()),
            download_all_files: None,
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
            let mut order = self.task_order.lock().await;
            order.push_back(transfer_id.clone());
            Self::prune_terminal_tasks(&mut tasks, &mut order);
        }

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.clone(), control.clone());
        }

        self.spawn_upload_worker(
            transfer_id.clone(),
            session_id,
            sftp,
            all_files,
            remote_dir,
            control,
        );

        Ok(transfer_id)
    }

    /// 上传 worker:逐文件传输,响应取消/暂停;暂停后任务与断点偏移保留,可 resume 再进本 worker。
    fn spawn_upload_worker(
        &self,
        tid: String,
        session_id: String,
        sftp: Arc<Mutex<SftpSession>>,
        all_files: Vec<(String, String, u64)>,
        remote_dir: String,
        control: TransferControl,
    ) {
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let app_handle = self.app_handle.clone();
        let session_id_for_emit = session_id;

        tokio::spawn(async move {
            tracing::info!("[TransferManager::upload] spawned task {} starting", tid);
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }
            // 通知前端:开始
            let _ = app_handle.emit_ser(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: tid.clone(),
                    session_id: session_id_for_emit.clone(),
                    direction: TransferDirection::Upload,
                    status: TransferStatus::Running,
                    error: None,
                },
            );

            let mut cumulative_transferred: u64 = 0;
            let mut final_status: Option<(TransferStatus, Option<String>)> = None;

            for (i, (local_path, relative_path, _size)) in all_files.iter().enumerate() {
                if control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }
                if control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                let remote_path = if remote_dir.ends_with('/') {
                    format!("{}{}", remote_dir, relative_path)
                } else {
                    format!("{}/{}", remote_dir, relative_path)
                };

                // Ensure parent directory exists on remote (mkdir -p);
                // 真错误(权限等)不再被吞:落 Failed 并给出准确原因。
                if let Some(parent) = Path::new(&remote_path).parent() {
                    let parent_str = parent.to_string_lossy().to_string();
                    if !parent_str.is_empty() && parent_str != "/" {
                        if let Err(e) = mkdir_p(&sftp, &parent_str).await {
                            tracing::error!(
                                "[TransferManager::upload] task {} mkdir_p failed: {}",
                                tid,
                                e
                            );
                            let mut tasks = tasks.lock().await;
                            if let Some(t) = tasks.get_mut(&tid) {
                                t.status = TransferStatus::Failed;
                                t.error = Some(e.to_string());
                            }
                            final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                            break;
                        }
                    }
                }

                tracing::info!(
                    "[TransferManager::upload] uploading file {}: {} -> {}",
                    i,
                    local_path,
                    remote_path
                );

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let tid_for_emit = tid.clone();
                let sid_for_progress = session_id_for_emit.clone();
                let fname = relative_path.clone();
                let tasks_ref = tasks.clone();
                let tasks_for_speed = tasks.clone();
                let tid_for_speed = tid.clone();
                // 进度事件节流:上次发送时间(初始为「一个间隔前」,首块必发)。
                let last_emit = Arc::new(std::sync::Mutex::new(
                    std::time::Instant::now() - PROGRESS_EMIT_INTERVAL,
                ));

                // Read per-file resume offset from task
                let resume_from = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.transferred)
                        .unwrap_or(0)
                };

                // Skip already-completed files (resume/retry scenario)
                let file_size = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.size)
                        .unwrap_or(0)
                };
                if resume_from > 0 && resume_from >= file_size {
                    cumulative_transferred += file_size;
                    {
                        let mut tasks_guard = tasks.lock().await;
                        if let Some(t) = tasks_guard.get_mut(&tid) {
                            t.transferred_bytes = cumulative_transferred;
                            if let Some(f) = t.files.get_mut(i) {
                                f.transferred = file_size;
                            }
                        }
                    }
                    continue;
                }

                let control_for_check = control.clone();
                let result = upload_file(
                    &sftp,
                    local_path,
                    &remote_path,
                    resume_from,
                    move |trans, total| {
                        // 先更新任务聚合(try_lock 失败时退回本地估算值),
                        // 再按节流 emit——事件携带任务级聚合进度。
                        let mut task_transferred = offset + trans;
                        let mut task_total = total;
                        if let Ok(mut tasks) = tasks_ref.try_lock() {
                            if let Some(t) = tasks.get_mut(&tid_clone) {
                                t.transferred_bytes = offset + trans;
                                if let Some(f) = t.files.get_mut(i) {
                                    f.transferred = trans;
                                }
                                task_transferred = t.transferred_bytes;
                                task_total = t.total_bytes;
                            }
                        }
                        let due = match last_emit.lock() {
                            Ok(mut last) => {
                                // 文件完成(终块)必发,不丢边界;其余按间隔节流
                                if trans >= total || last.elapsed() >= PROGRESS_EMIT_INTERVAL {
                                    *last = std::time::Instant::now();
                                    true
                                } else {
                                    false
                                }
                            }
                            Err(_) => true,
                        };
                        if due {
                            let _ = ah.emit_ser(
                                "sftp://transfer-progress",
                                TransferProgress {
                                    transfer_id: tid_for_emit.clone(),
                                    session_id: sid_for_progress.clone(),
                                    file_name: fname.clone(),
                                    transferred: trans,
                                    total,
                                    task_transferred,
                                    task_total,
                                    direction: TransferDirection::Upload,
                                },
                            );
                        }
                    },
                    move || {
                        tasks_for_speed
                            .try_lock()
                            .ok()
                            .and_then(|g| g.get(&tid_for_speed).map(|t| t.speed_limit))
                            .unwrap_or(0)
                    },
                    move || control_for_check.interrupted(),
                )
                .await;

                if result.is_err() && control.pause.is_cancelled() {
                    tracing::info!("[TransferManager::upload] task {} paused", tid);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                if result.is_err() && control.cancel.is_cancelled() {
                    tracing::info!("[TransferManager::upload] task {} cancelled", tid);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }

                if let Err(e) = result {
                    tracing::error!("[TransferManager::upload] task {} failed: {}", tid, e);
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    break;
                }

                tracing::info!("[TransferManager::upload] file {} uploaded successfully", i);
                let file_size = tokio::fs::metadata(local_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                cumulative_transferred += file_size;

                {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.transferred_bytes = cumulative_transferred;
                        if let Some(f) = t.files.get_mut(i) {
                            f.transferred = file_size;
                        }
                    }
                }
            }

            if final_status.is_none() {
                let status = if control.cancel.is_cancelled() {
                    TransferStatus::Cancelled
                } else if control.pause.is_cancelled() {
                    TransferStatus::Paused
                } else {
                    TransferStatus::Done
                };
                tracing::info!(
                    "[TransferManager::upload] task {} finished: {:?}",
                    tid,
                    status
                );
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = status.clone();
                }
                final_status = Some((status, None));
            }

            // 通知前端:终态 / 暂停
            if let Some((status, error)) = &final_status {
                let _ = app_handle.emit_ser(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Upload,
                        status: status.clone(),
                        error: error.clone(),
                    },
                );
            }

            // 暂停的任务保留 control(resume 时会换新);其余状态清理
            if !matches!(final_status, Some((TransferStatus::Paused, _))) {
                let mut controls = controls.lock().await;
                controls.remove(&tid);
            }
        });
    }

    pub async fn download(
        &self,
        session_id: &str,
        remote_paths: Vec<String>,
        local_dir: String,
        speed_limit: u64,
    ) -> Result<String> {
        // 早转 owned,后面 spawn 闭包要 'static
        let session_id = session_id.to_string();

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?
        };

        let transfer_id = Uuid::new_v4().to_string();

        // 递归展开(目录下载与上传递归对称);同名根加 ` (n)` 后缀防互相覆盖。
        let base_names: Vec<String> = remote_paths
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone())
            })
            .collect();
        let roots = dedupe_download_roots(&base_names);

        let mut files = Vec::new();
        let mut total_bytes: u64 = 0;
        let mut all_files: Vec<(String, String, u64)> = Vec::new();

        for (remote_path, root) in remote_paths.iter().zip(roots.iter()) {
            let collected = collect_remote_files(&sftp, remote_path, root).await?;
            for (rp, rel, size) in collected {
                // files[].name 即本地落盘相对路径(含重命名后缀),展示与落盘一致
                files.push(TransferFile {
                    name: rel.clone(),
                    size,
                    transferred: 0,
                });
                total_bytes += size;
                all_files.push((rp, rel, size));
            }
        }

        let task = TransferTask {
            id: transfer_id.clone(),
            session_id: session_id.clone(),
            direction: TransferDirection::Download,
            files,
            status: TransferStatus::Queued,
            total_bytes,
            transferred_bytes: 0,
            speed_limit,
            error: None,
            upload_local_paths: None,
            upload_remote_dir: None,
            download_remote_paths: Some(remote_paths.clone()),
            download_local_dir: Some(local_dir.clone()),
            upload_all_files: None,
            download_all_files: Some(all_files.clone()),
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(transfer_id.clone(), task);
            let mut order = self.task_order.lock().await;
            order.push_back(transfer_id.clone());
            Self::prune_terminal_tasks(&mut tasks, &mut order);
        }

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.clone(), control.clone());
        }

        self.spawn_download_worker(
            transfer_id.clone(),
            session_id,
            sftp,
            all_files,
            local_dir,
            control,
        );

        Ok(transfer_id)
    }

    /// 下载 worker:语义同 spawn_upload_worker,逐 (remote, rel) 对传输,
    /// rel 即本地落盘相对路径(含重名后缀);暂停后保留任务与断点偏移。
    fn spawn_download_worker(
        &self,
        tid: String,
        session_id: String,
        sftp: Arc<Mutex<SftpSession>>,
        all_files: Vec<(String, String, u64)>,
        local_dir: String,
        control: TransferControl,
    ) {
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let app_handle = self.app_handle.clone();
        let session_id_for_emit = session_id;

        tokio::spawn(async move {
            {
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = TransferStatus::Running;
                }
            }
            // 通知前端:开始
            let _ = app_handle.emit_ser(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: tid.clone(),
                    session_id: session_id_for_emit.clone(),
                    direction: TransferDirection::Download,
                    status: TransferStatus::Running,
                    error: None,
                },
            );

            let mut cumulative_transferred: u64 = 0;
            let mut final_status: Option<(TransferStatus, Option<String>)> = None;

            for (i, (remote_path, rel_path, _size)) in all_files.iter().enumerate() {
                if control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }
                if control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                // rel 即本地落盘相对路径(任务创建期已做重名后缀保护);
                // 子目录由 download_file 内的 create_dir_all 兜底创建。
                let local_path = if local_dir.ends_with('/') || local_dir.ends_with('\\') {
                    format!("{}{}", local_dir, rel_path)
                } else {
                    format!("{}/{}", local_dir, rel_path)
                };

                let offset = cumulative_transferred;
                let ah = app_handle.clone();
                let tid_clone = tid.clone();
                let tid_for_emit = tid.clone();
                let sid_for_progress = session_id_for_emit.clone();
                let fname = rel_path.clone();
                let tasks_ref = tasks.clone();
                let tasks_for_speed = tasks.clone();
                let tid_for_speed = tid.clone();
                // 进度事件节流:上次发送时间(初始为「一个间隔前」,首块必发)。
                let last_emit = Arc::new(std::sync::Mutex::new(
                    std::time::Instant::now() - PROGRESS_EMIT_INTERVAL,
                ));

                // Read per-file resume offset from task
                let resume_from = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.transferred)
                        .unwrap_or(0)
                };

                // Skip already-completed files (resume/retry scenario)
                let file_size = {
                    let tasks_guard = tasks.lock().await;
                    tasks_guard
                        .get(&tid)
                        .and_then(|t| t.files.get(i))
                        .map(|f| f.size)
                        .unwrap_or(0)
                };
                if resume_from > 0 && resume_from >= file_size {
                    cumulative_transferred += file_size;
                    {
                        let mut tasks_guard = tasks.lock().await;
                        if let Some(t) = tasks_guard.get_mut(&tid) {
                            t.transferred_bytes = cumulative_transferred;
                            if let Some(f) = t.files.get_mut(i) {
                                f.transferred = file_size;
                            }
                        }
                    }
                    continue;
                }

                let control_for_check = control.clone();
                let result = download_file(
                    &sftp,
                    remote_path,
                    &local_path,
                    resume_from,
                    move |trans, total| {
                        // 先更新任务聚合(try_lock 失败时退回本地估算值),
                        // 再按节流 emit——事件携带任务级聚合进度。
                        let mut task_transferred = offset + trans;
                        let mut task_total = total;
                        if let Ok(mut tasks) = tasks_ref.try_lock() {
                            if let Some(t) = tasks.get_mut(&tid_clone) {
                                t.transferred_bytes = offset + trans;
                                if let Some(f) = t.files.get_mut(i) {
                                    f.transferred = trans;
                                }
                                task_transferred = t.transferred_bytes;
                                task_total = t.total_bytes;
                            }
                        }
                        let due = match last_emit.lock() {
                            Ok(mut last) => {
                                // 文件完成(终块)必发,不丢边界;其余按间隔节流
                                if trans >= total || last.elapsed() >= PROGRESS_EMIT_INTERVAL {
                                    *last = std::time::Instant::now();
                                    true
                                } else {
                                    false
                                }
                            }
                            Err(_) => true,
                        };
                        if due {
                            let _ = ah.emit_ser(
                                "sftp://transfer-progress",
                                TransferProgress {
                                    transfer_id: tid_for_emit.clone(),
                                    session_id: sid_for_progress.clone(),
                                    file_name: fname.clone(),
                                    transferred: trans,
                                    total,
                                    task_transferred,
                                    task_total,
                                    direction: TransferDirection::Download,
                                },
                            );
                        }
                    },
                    move || {
                        tasks_for_speed
                            .try_lock()
                            .ok()
                            .and_then(|g| g.get(&tid_for_speed).map(|t| t.speed_limit))
                            .unwrap_or(0)
                    },
                    move || control_for_check.interrupted(),
                )
                .await;

                if result.is_err() && control.pause.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Paused;
                    }
                    final_status = Some((TransferStatus::Paused, None));
                    break;
                }

                if result.is_err() && control.cancel.is_cancelled() {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Cancelled;
                    }
                    final_status = Some((TransferStatus::Cancelled, None));
                    break;
                }

                if let Err(e) = result {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        t.status = TransferStatus::Failed;
                        t.error = Some(e.to_string());
                    }
                    final_status = Some((TransferStatus::Failed, Some(e.to_string())));
                    break;
                }

                let file_size = result.unwrap();
                cumulative_transferred += file_size;

                {
                    let mut tasks = tasks.lock().await;
                    if let Some(t) = tasks.get_mut(&tid) {
                        let old_size = t.files.get(i).map(|f| f.size).unwrap_or(0);
                        t.total_bytes = t
                            .total_bytes
                            .saturating_sub(old_size)
                            .saturating_add(file_size);
                        t.transferred_bytes = cumulative_transferred;
                        if let Some(f) = t.files.get_mut(i) {
                            f.size = file_size;
                            f.transferred = file_size;
                        }
                    }
                }
            }

            if final_status.is_none() {
                let status = if control.cancel.is_cancelled() {
                    TransferStatus::Cancelled
                } else if control.pause.is_cancelled() {
                    TransferStatus::Paused
                } else {
                    TransferStatus::Done
                };
                let mut tasks = tasks.lock().await;
                if let Some(t) = tasks.get_mut(&tid) {
                    t.status = status.clone();
                }
                final_status = Some((status, None));
            }

            // 通知前端:终态 / 暂停
            if let Some((status, error)) = &final_status {
                let _ = app_handle.emit_ser(
                    "sftp://transfer-status",
                    TransferStatusEvent {
                        transfer_id: tid.clone(),
                        session_id: session_id_for_emit.clone(),
                        direction: TransferDirection::Download,
                        status: status.clone(),
                        error: error.clone(),
                    },
                );
            }

            // 暂停的任务保留 control(resume 时会换新);其余状态清理
            if !matches!(final_status, Some((TransferStatus::Paused, _))) {
                let mut controls = controls.lock().await;
                controls.remove(&tid);
            }
        });
    }

    /// 取消一个传输。运行中的由 worker 在块边界退出;
    /// 已暂停的任务没有 worker 在监听令牌,这里直接落终态并通知前端。
    pub async fn cancel(&self, transfer_id: &str) {
        {
            let controls = self.controls.lock().await;
            if let Some(c) = controls.get(transfer_id) {
                c.cancel.cancel();
            }
        }

        let paused_info = {
            let mut tasks = self.tasks.lock().await;
            tasks.get_mut(transfer_id).and_then(|t| {
                if t.status == TransferStatus::Paused {
                    t.status = TransferStatus::Cancelled;
                    Some((t.session_id.clone(), t.direction.clone()))
                } else {
                    None
                }
            })
        };

        if let Some((session_id, direction)) = paused_info {
            let _ = self.app_handle.emit_ser(
                "sftp://transfer-status",
                TransferStatusEvent {
                    transfer_id: transfer_id.to_string(),
                    session_id,
                    direction,
                    status: TransferStatus::Cancelled,
                    error: None,
                },
            );
            let mut controls = self.controls.lock().await;
            controls.remove(transfer_id);
        }
    }

    /// 暂停一个运行中的传输:worker 在块边界退出,任务与断点偏移保留
    pub async fn pause(&self, transfer_id: &str) {
        let controls = self.controls.lock().await;
        if let Some(c) = controls.get(transfer_id) {
            c.pause.cancel();
        }
    }

    /// 继续一个已暂停的传输:换新控制令牌,重新 spawn worker,从断点偏移续传
    pub async fn resume(&self, transfer_id: &str) -> Result<()> {
        self.respawn(transfer_id, &[TransferStatus::Paused], "resume")
            .await
    }

    /// 重试失败/已取消的传输:复用原任务(同一 id,原行复活),从断点偏移续传。
    /// 此前 retry 用原始参数重建全新任务、偏移清零(99% 处失败要重传 100%),
    /// 且只接受 Failed——前端对 cancelled 行的「重试」必报错。
    pub async fn retry(&self, transfer_id: &str) -> Result<String> {
        self.respawn(transfer_id, RETRYABLE, "retry").await?;
        Ok(transfer_id.to_string())
    }

    /// 重新 spawn 处于 allowed 状态的任务的 worker。断点偏移保留在 task.files,
    /// worker 跳过已完成文件、从部分偏移续传。session 查找先于状态变更,
    /// 失败不会留下 Queued 残态。
    async fn respawn(
        &self,
        transfer_id: &str,
        allowed: &[TransferStatus],
        verb: &str,
    ) -> Result<()> {
        let session_id = {
            let tasks = self.tasks.lock().await;
            let task = tasks
                .get(transfer_id)
                .ok_or_else(|| anyhow::anyhow!("Transfer not found: {}", transfer_id))?;
            if !allowed.contains(&task.status) {
                return Err(anyhow::anyhow!("Can only {} {:?} transfers", verb, allowed));
            }
            task.session_id.clone()
        };

        let sftp = {
            let sessions = self.sftp_sessions.lock().await;
            sessions
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("SFTP session not found: {}", session_id))?
        };

        let (
            direction,
            upload_all_files,
            upload_remote_dir,
            download_all_files,
            download_local_dir,
        ) = {
            let mut tasks = self.tasks.lock().await;
            let task = tasks
                .get_mut(transfer_id)
                .ok_or_else(|| anyhow::anyhow!("Transfer not found: {}", transfer_id))?;
            // 并发下状态可能在两把锁之间变化,二次确认。
            if !allowed.contains(&task.status) {
                return Err(anyhow::anyhow!("Can only {} {:?} transfers", verb, allowed));
            }
            task.status = TransferStatus::Queued;
            task.error = None;
            (
                task.direction.clone(),
                task.upload_all_files.clone(),
                task.upload_remote_dir.clone(),
                task.download_all_files.clone(),
                task.download_local_dir.clone(),
            )
        };

        let control = TransferControl::new();
        {
            let mut controls = self.controls.lock().await;
            controls.insert(transfer_id.to_string(), control.clone());
        }

        match direction {
            TransferDirection::Upload => self.spawn_upload_worker(
                transfer_id.to_string(),
                session_id,
                sftp,
                upload_all_files.unwrap_or_default(),
                upload_remote_dir.unwrap_or_default(),
                control,
            ),
            TransferDirection::Download => self.spawn_download_worker(
                transfer_id.to_string(),
                session_id,
                sftp,
                download_all_files.unwrap_or_default(),
                download_local_dir.unwrap_or_default(),
                control,
            ),
        }

        Ok(())
    }

    pub async fn set_speed_limit(&self, transfer_id: &str, speed_limit: u64) {
        let mut tasks = self.tasks.lock().await;
        if let Some(t) = tasks.get_mut(transfer_id) {
            t.speed_limit = speed_limit;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn task(id: &str, session: &str, status: TransferStatus) -> TransferTask {
        TransferTask {
            id: id.to_string(),
            session_id: session.to_string(),
            direction: TransferDirection::Download,
            files: vec![],
            status,
            total_bytes: 0,
            transferred_bytes: 0,
            speed_limit: 0,
            error: None,
            upload_local_paths: None,
            upload_remote_dir: None,
            download_remote_paths: None,
            download_local_dir: None,
            upload_all_files: None,
            download_all_files: None,
        }
    }

    #[test]
    fn suffixed_name_appends_before_extension() {
        assert_eq!(suffixed_name("a.txt", 1), "a (1).txt");
        assert_eq!(suffixed_name("dir", 2), "dir (2)");
        // 点前缀(.env)不走扩展名分支,整体追加
        assert_eq!(suffixed_name(".env", 1), ".env (1)");
        assert_eq!(suffixed_name("归档.tar.gz", 1), "归档.tar (1).gz");
    }

    #[test]
    fn dedupe_download_roots_suffixes_only_collisions() {
        let roots = dedupe_download_roots(&owned(&["a.txt", "a.txt", "b", "a.txt"]));
        assert_eq!(roots, owned(&["a.txt", "a (1).txt", "b", "a (2).txt"]));
        // 无冲突时原样返回
        let plain = dedupe_download_roots(&owned(&["x", "y"]));
        assert_eq!(plain, owned(&["x", "y"]));
    }

    #[test]
    fn retry_contract_accepts_failed_and_cancelled_only() {
        assert!(RETRYABLE.contains(&TransferStatus::Failed));
        assert!(RETRYABLE.contains(&TransferStatus::Cancelled));
        for s in [
            TransferStatus::Queued,
            TransferStatus::Running,
            TransferStatus::Paused,
            TransferStatus::Done,
        ] {
            assert!(!RETRYABLE.contains(&s), "{:?} must not be retryable", s);
        }
    }

    #[test]
    fn prune_terminal_tasks_keeps_running_and_caps_terminal() {
        let mut tasks: HashMap<String, TransferTask> = HashMap::new();
        let mut order: std::collections::VecDeque<String> = std::collections::VecDeque::new();
        // 1 个进行中 + MAX+2 个终态 → 淘汰最旧的 2 个终态
        tasks.insert("run".into(), task("run", "s", TransferStatus::Running));
        order.push_back("run".into());
        for i in 0..(MAX_RETAINED_TERMINAL_TASKS + 2) {
            let id = format!("done-{}", i);
            tasks.insert(id.clone(), task(&id, "s", TransferStatus::Done));
            order.push_back(id);
        }
        TransferManager::prune_terminal_tasks(&mut tasks, &mut order);
        assert!(tasks.contains_key("run"), "进行中的任务不淘汰");
        assert!(!tasks.contains_key("done-0") && !tasks.contains_key("done-1"));
        assert!(tasks.contains_key(&format!("done-{}", MAX_RETAINED_TERMINAL_TASKS + 1)));
        assert_eq!(
            tasks.values().filter(|t| is_terminal(&t.status)).count(),
            MAX_RETAINED_TERMINAL_TASKS
        );
    }

    #[test]
    fn terminal_status_classification() {
        for s in [
            TransferStatus::Done,
            TransferStatus::Failed,
            TransferStatus::Cancelled,
        ] {
            assert!(is_terminal(&s));
        }
        for s in [
            TransferStatus::Queued,
            TransferStatus::Running,
            TransferStatus::Paused,
        ] {
            assert!(!is_terminal(&s));
        }
    }
}
