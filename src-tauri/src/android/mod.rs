//! Android 实体机直连(adb)— Rust 语义层。
//!
//! 设计:`docs/superpowers/specs/2026-08-30-android-device-design.md`。
//! 与沙箱桌面(desktop/)并列、互不影响:那里是一次性 Ubuntu 容器,这里是
//! 用户真实的 Android 手机——误操作是真实后果,因此:
//! - `android_connect` 的一次确认 = 任务级授权(60 分钟,对齐沙箱模型),
//!   授权只覆盖选定 serial;授权存在性/过期/serial 匹配由本模块在执行点强制;
//! - 直播窗口(android-live custom protocol)内「接管」开启期间 AI 写操作一律
//!   拒绝(不撤销授权);用户随时可以直接拿起手机操作(物理接管无法互斥,
//!   AI 约定从截图感知界面变化);
//! - 每次写操作前自动截屏留档(android_replay_frames),支持回放;
//! - `android_type` 文本不进审计(审计摘要在 events.rs 只记长度);
//! - `android_exec` 恒确认 hard 档(approval-bridge),任何预设不静默放行;
//! - `android_pull`/`android_push`/`android_wireless` 恒确认软档(对齐 sftp)。
//!
//! adb 二进制解析顺序(§3):settings `android.adb_path` → STARHUB_ADB_PATH →
//! PATH → 平台常见安装位置;全部缺失时报错文本带安装引导(AI 可用本机
//! pwsh/bash 工具代装 platform-tools)。不做自动下载(供应链风险,见 §3)。
//!
//! 直播双模(§4.4,Phase 2 已并入本期):
//! - scrcpy 模式:bundled scrcpy-server v2.7(SHA256 钉死,来源与校验记录见
//!   resources/scrcpy/PROVENANCE.md)推送到设备,app_process 启动,H.264 经
//!   adb forward 回本机;协议处理器按 since 偏移量增量供给,直播页 WebCodecs
//!   解码(不支持 WebCodecs 的 webview 自动降级轮询模式);
//! - 轮询模式(兜底):pump 周期 exec-out screencap,页面轮询 frame.png。
//! 接管输入一律经 mpsc → pump → adb shell input(scrcpy 控制通道未启用,
//! control=false;见踩坑记录)。

//! 去 Tauri 化 M1:20 个 `android_*` 工具执行体、adb 解析/调用、纯函数
//! (白名单 / 键名映射 / uiautomator 解析 / PNG 修复)已平移到
//! `starhub-domain-android`;本模块只剩直播窗口面(scrcpy H.264 / 轮询帧 /
//! custom protocol)与六个 seam 的 Tauri 实现。直播面板化是 M3。

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::Value;
use sqlx::Row;
use tauri::Manager;

use crate::harness::HostBridgeState;

pub use starhub_domain_android::exec::ANDROID_TOOLS;
pub use starhub_domain_android::manager::ADB_PATH_SETTING_KEY;

/// scrcpy-server 版本(与 resources/scrcpy/scrcpy-server 一致;server 校验
/// 首个参数必须等于自身版本号,不匹配即退出)。
const SCRCPY_SERVER_VERSION: &str = "2.7";
/// 设备端 scrcpy-server 投放路径。
const SCRCPY_DEVICE_PATH: &str = "/data/local/tmp/starhub/scrcpy-server";
/// 视频环形缓冲上限(2Mbps × ~10s GOP 约 2.5MB,留足余量)。
const VIDEO_RING_CAP_BYTES: usize = 8 << 20;
/// 直播 pump 两帧之间的间隔(轮询模式;截图自身耗时 300-500ms)。
const LIVE_PUMP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);

/// 直播输入动作(页面 POST → mpsc → pump 顺序执行)。
#[derive(Debug)]
enum LiveAction {
    Tap(i64, i64),
    Swipe(i64, i64, i64, i64, i64),
    Key(String),
    Type(String),
    SetTakeover(bool),
}

/// 一台设备的直播会话(轮询模式帧缓存 + 接管标志 + 动作队列)。
/// protocol 处理器在 webview 线程同步读,因此整个 live 注册表用 std Mutex。
struct LiveSession {
    frame: Option<(Vec<u8>, std::time::Instant)>,
    takeover: bool,
    action_tx: std::sync::mpsc::Sender<LiveAction>,
    /// 设备物理分辨率(meta 端点给页面做坐标映射)。
    resolution: (i64, i64),
}

/// scrcpy 视频包(keyframe/config 标志 + annexb 负载 + 绝对偏移)。
struct VideoPacket {
    /// bit0 = keyframe,bit1 = config(SPS/PPS)。
    flags: u8,
    data: Vec<u8>,
    /// 在线性流里的绝对偏移(含 5 字节记录头),客户端 since 游标语义。
    offset: u64,
}

/// 环形缓冲:保留最近若干包;超限时从头部丢弃(丢弃关键帧后
/// last_key_offset 清空,新客户端等下一个关键帧)。
#[derive(Default)]
struct PacketRing {
    packets: VecDeque<VideoPacket>,
    bytes: usize,
    next_offset: u64,
    last_key_offset: Option<u64>,
}

impl PacketRing {
    fn push(&mut self, flags: u8, data: Vec<u8>) {
        let record_len = 5 + data.len() as u64;
        let offset = self.next_offset;
        self.next_offset += record_len;
        self.bytes += record_len as usize;
        if flags & 1 != 0 {
            self.last_key_offset = Some(offset);
        }
        self.packets.push_back(VideoPacket { flags, data, offset });
        while self.bytes > VIDEO_RING_CAP_BYTES {
            let Some(front) = self.packets.pop_front() else { break };
            self.bytes -= 5 + front.data.len();
            if self.last_key_offset == Some(front.offset) {
                self.last_key_offset = None;
            }
        }
    }

    fn first_offset(&self) -> u64 {
        self.packets.front().map(|p| p.offset).unwrap_or(self.next_offset)
    }

    /// 从 since 读取增量:返回 (base_offset, 编码字节, resync)。
    /// since=0 或 since 已丢出环外 → 从最近关键帧重同步;since 已最新 → 空。
    /// 编码:[u64 base BE][记录…],记录 = [u8 flags][u32 len BE][payload]。
    fn read_since(&self, since: u64) -> (u64, Vec<u8>, bool) {
        let mut base = since;
        let mut resync = false;
        if since == 0 || since < self.first_offset() {
            base = self.last_key_offset.unwrap_or_else(|| self.first_offset());
            resync = true;
        }
        let mut body = Vec::new();
        for packet in &self.packets {
            if packet.offset < base {
                continue;
            }
            body.push(packet.flags);
            body.extend_from_slice(&(packet.data.len() as u32).to_be_bytes());
            body.extend_from_slice(&packet.data);
        }
        (base, body, resync)
    }
}

/// 一台设备的 scrcpy 会话(视频环 + 元数据 + 错误 + 子进程/端口回收信息)。
struct ScrcpySession {
    ring: std::sync::Mutex<PacketRing>,
    /// (宽,高),codec meta 就绪后写入。
    video_size: std::sync::Mutex<Option<(u32, u32)>>,
    error: std::sync::Mutex<Option<String>>,
    child: std::sync::Mutex<Option<tokio::process::Child>>,
    /// adb forward 本地端口(0 = 尚未绑定),stop_live 回收用。
    forward_port: std::sync::Mutex<u16>,
}

impl ScrcpySession {
    fn set_error(&self, message: String) {
        if let Ok(mut slot) = self.error.lock() {
            *slot = Some(message);
        }
    }

    fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }

    fn is_ready(&self) -> bool {
        self.video_size.lock().map(|m| m.is_some()).unwrap_or(false)
            && self.take_error().is_none()
    }
}

/// Android 设备管理器(经 `app.manage` 注入;字段全 Arc,可 Clone 进泵任务)。
///
/// 去 Tauri 化 M1:`core` 是域 crate 的管理器(任务授权 + adb 路径缓存,
/// 与 sidecar 同一份代码);`live` / `scrcpy` 是直播窗口面(M3 面板化后
/// 随本结构一起退役)。
#[derive(Clone, Default)]
pub struct AndroidManager {
    pub core: Arc<starhub_domain_android::AndroidManager>,
    live: Arc<std::sync::Mutex<HashMap<String, LiveSession>>>,
    scrcpy: Arc<std::sync::Mutex<HashMap<String, Arc<ScrcpySession>>>>,
}

impl AndroidManager {
    pub fn new() -> Self {
        Self {
            core: Arc::new(starhub_domain_android::AndroidManager::new()),
            ..Self::default()
        }
    }

    /// adb 路径设置被设置页修改后清缓存,下次调用重新解析。
    pub async fn invalidate_adb_cache(&self) {
        self.core.invalidate_adb_cache().await;
    }

    /// 当前解析到的 adb 路径(设置页展示用;None = 尚未解析过)。
    pub async fn cached_adb_path(&self) -> Option<String> {
        self.core.cached_adb_path().await
    }

    /// 直播接管中(AI 写操作互斥;不撤销授权)。
    pub fn is_takeover(&self, serial: &str) -> bool {
        self.live
            .lock()
            .map(|live| live.get(serial).map(|s| s.takeover).unwrap_or(false))
            .unwrap_or(false)
    }

    // ---------- 直播注册表(protocol 处理器与泵用,全部同步) ----------

    fn live_exists(&self, serial: &str) -> bool {
        self.live
            .lock()
            .map(|live| live.contains_key(serial))
            .unwrap_or(false)
    }

    fn live_frame(&self, serial: &str) -> Option<Vec<u8>> {
        self.live
            .lock()
            .ok()?
            .get(serial)?
            .frame
            .as_ref()
            .map(|(bytes, _)| bytes.clone())
    }

    fn live_resolution(&self, serial: &str) -> Option<(i64, i64)> {
        self.live.lock().ok()?.get(serial).map(|s| s.resolution)
    }

    fn live_enqueue(&self, serial: &str, action: LiveAction) -> bool {
        let Ok(live) = self.live.lock() else { return false };
        match live.get(serial) {
            Some(session) => session.action_tx.send(action).is_ok(),
            None => false,
        }
    }

    fn scrcpy_session(&self, serial: &str) -> Option<Arc<ScrcpySession>> {
        self.scrcpy.lock().ok()?.get(serial).cloned()
    }

    /// 直播模式判定:scrcpy 就绪 = "scrcpy",否则轮询兜底(附 scrcpy 失败原因)。
    fn live_mode(&self, serial: &str) -> (bool, Option<String>) {
        match self.scrcpy_session(serial) {
            Some(session) => (session.is_ready(), session.take_error()),
            None => (false, None),
        }
    }

    /// 开启直播会话(幂等):注册 session + 启动轮询泵 + 后台尝试 scrcpy。
    fn start_live(&self, app: &tauri::AppHandle, serial: &str, resolution: (i64, i64)) {
        let rx = {
            let mut live = match self.live.lock() {
                Ok(live) => live,
                Err(_) => return,
            };
            if live.contains_key(serial) {
                return;
            }
            let (tx, rx) = std::sync::mpsc::channel::<LiveAction>();
            live.insert(
                serial.to_string(),
                LiveSession {
                    frame: None,
                    takeover: false,
                    action_tx: tx,
                    resolution,
                },
            );
            rx
        };
        let manager = self.clone();
        let serial_owned = serial.to_string();
        tauri::async_runtime::spawn(async move {
            live_pump(manager, serial_owned, rx).await;
        });
        let manager = self.clone();
        let app_for_scrcpy = app.clone();
        let serial_owned = serial.to_string();
        tauri::async_runtime::spawn(async move {
            scrcpy_run(app_for_scrcpy, manager, serial_owned).await;
        });
    }

    /// 直播窗口销毁:摘除 session(泵下一轮退出)并回收 scrcpy(杀子进程 +
    /// 解除 adb forward,后者 best-effort 异步)。
    pub fn stop_live(&self, serial: &str) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(serial);
        }
        let session = self
            .scrcpy
            .lock()
            .ok()
            .and_then(|mut map| map.remove(serial));
        if let Some(session) = session {
            if let Ok(mut slot) = session.child.lock() {
                if let Some(mut child) = slot.take() {
                    let _ = child.start_kill();
                }
            }
            let manager = self.clone();
            let serial = serial.to_string();
            let port = *session.forward_port.lock().unwrap_or_else(|e| e.into_inner());
            tauri::async_runtime::spawn(async move {
                if let Ok(adb) = resolve_adb(&manager).await {
                    let _ = adb_raw(
                        &manager,
                        &adb,
                        Some(&serial),
                        &["forward".to_string(), "--remove".to_string(), format!("tcp:{port}")],
                        10,
                    )
                    .await;
                }
            });
        }
    }
}

// ============================================================
// adb 执行封装(直播面自用;工具面走 crate 的 Adb seam)
// ============================================================

/// Tauri 的 adb 路径解析(settings 表 + 域 crate 的解析顺序)。
async fn resolve_adb(manager: &AndroidManager) -> Result<String, String> {
    starhub_domain_android::adb::resolve_adb(&manager.core, &SqliteSettingsStore).await
}

/// settings 表版设置存储(供 adb 路径解析)。
struct SqliteSettingsStore;

impl starhub_domain_android::SettingsStore for SqliteSettingsStore {
    fn get<'a>(
        &'a self,
        key: &'a str,
    ) -> starhub_domain_android::BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let Ok(pool) = crate::db::get_pool() else {
                return Ok(None);
            };
            let value: Option<String> =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                    .bind(key)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("读取设置失败: {e}"))?;
            Ok(value.filter(|v| !v.trim().is_empty()))
        })
    }
}

/// 执行一次 adb 命令,返回 (stdout 字节, stderr 文本, exit code)。
async fn adb_raw(
    manager: &AndroidManager,
    adb: &str,
    serial: Option<&str>,
    args: &[String],
    timeout_secs: u64,
) -> Result<(Vec<u8>, String, i32), String> {
    let mut cmd = tokio::process::Command::new(adb);
    if let Some(serial) = serial {
        cmd.arg("-s").arg(serial);
    }
    cmd.args(args);
    // tokio Command 自带 creation_flags 方法(无需 CommandExt import)。
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let result =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            manager.invalidate_adb_cache().await;
            return Err(starhub_domain_android::adb::adb_missing_guidance());
        }
        Ok(Err(e)) => return Err(format!("adb 执行失败: {e}")),
        Err(_) => return Err(format!("adb 命令超时({timeout_secs}s)")),
    };
    Ok((
        output.stdout,
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

/// adb shell 便利封装:返回 stdout 文本;非零退出带 stderr 报错。
async fn adb_shell(
    manager: &AndroidManager,
    adb: &str,
    serial: &str,
    script: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let (stdout, stderr, code) = adb_raw(
        manager,
        adb,
        Some(serial),
        &["shell".to_string(), script.to_string()],
        timeout_secs,
    )
    .await?;
    let text = String::from_utf8_lossy(&stdout).to_string();
    if code != 0 {
        return Err(format!(
            "adb shell 失败(exit {code}): {}",
            stderr.trim()
        ));
    }
    Ok(text)
}

// ============================================================
// PNG / scrcpy 帧解析(直播面仍需要,留在此处)
// ============================================================

/// PNG 完整性保障:旧版 adb(<1.0.41)Windows 上 exec-out 把每个 \n 改写为
/// \r\n(原有 \r\n 变 \r\r\n),PNG 流损坏。先验 8 字节完整 magic(自身即含
/// \r\n\x1a\n,恰好是探针),损坏则按「k 个 \r + \n → k-1 个 \r + \n」修复
/// (逆向 \n→\r\n 变换)重验;仍失败报升级指引(踩坑记录)。
///
/// 直播 pump 的轮询模式兜底路径仍用它(工具面已走 crate 的 ensure_png)。
#[allow(dead_code)]
fn ensure_png(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    const MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(MAGIC) {
        return Ok(bytes);
    }
    let mut repaired = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            let mut j = i;
            while j < bytes.len() && bytes[j] == b'\r' {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'\n' {
                // k 个 \r 后跟 \n:原始流是 k-1 个 \r + \n(mangling 把每个 \n
                // 变成 \r\n,原本 k-1 个 \r 原样保留)
                for _ in 0..(j - i - 1) {
                    repaired.push(b'\r');
                }
                repaired.push(b'\n');
                i = j + 1;
                continue;
            }
        }
        repaired.push(bytes[i]);
        i += 1;
    }
    if repaired.starts_with(MAGIC) {
        Ok(repaired)
    } else {
        Err("截图数据损坏(当前 adb 版本 exec-out 二进制不安全),请升级 platform-tools 后重试".to_string())
    }
}

/// PNG IHDR 解析宽高(8 字节签名 + 4 长度 + "IHDR" 后两个 BE u32)。
/// 截图真实像素 = 坐标契约的事实来源:不同机型/分辨率/横竖屏都以它为准,
/// 不信任 connect 时缓存的分辨率(wm size 可能被改、设备可能旋转)。
///
/// 直播 meta 端点仍用它(工具面已走 crate 的 png_dimensions)。
#[allow(dead_code)]
fn png_dimensions(bytes: &[u8]) -> Option<(i64, i64)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w as i64, h as i64))
}

/// scrcpy 帧元头(12 字节 BE):u64 pts_and_flags + u32 packet_size。
/// bit63 = config 包(SPS/PPS),bit62 = keyframe。
fn parse_frame_meta(header: &[u8]) -> Option<(bool, bool, usize)> {
    if header.len() != 12 {
        return None;
    }
    let pts_flags = u64::from_be_bytes(header[..8].try_into().ok()?);
    let size = u32::from_be_bytes(header[8..12].try_into().ok()?) as usize;
    if size == 0 || size > 16 << 20 {
        return None;
    }
    Some((pts_flags & (1 << 62) != 0, pts_flags & (1 << 63) != 0, size))
}

// ============================================================
// scrcpy 视频通道(Phase 2:bundled server + H.264 增量供给)
// ============================================================

/// scrcpy-server jar 本地路径:prod 取 resource_dir(打包 resources/scrcpy/),
/// dev 回退仓库内 src-tauri/resources/scrcpy/。
fn scrcpy_server_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let path = dir.join("resources").join("scrcpy").join("scrcpy-server");
        if path.exists() {
            return Ok(path);
        }
    }
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("scrcpy")
        .join("scrcpy-server");
    if path.exists() {
        return Ok(path);
    }
    Err("scrcpy-server 资源缺失(resources/scrcpy/scrcpy-server),直播降级为截图轮询".to_string())
}

/// scrcpy 会话全流程:推送 server → adb forward → 启动 app_process →
/// 读 H.264 流进环形缓冲。任一步失败把原因写进 session.error,
/// 直播页 meta 端点据此降级轮询模式。session 被摘除(窗口销毁)即退出。
async fn scrcpy_run(app: tauri::AppHandle, manager: AndroidManager, serial: String) {
    let session = Arc::new(ScrcpySession {
        ring: std::sync::Mutex::new(PacketRing::default()),
        video_size: std::sync::Mutex::new(None),
        error: std::sync::Mutex::new(None),
        child: std::sync::Mutex::new(None),
        forward_port: std::sync::Mutex::new(0),
    });
    // 注册(已存在说明重复启动,直接退出;窗口销毁后 map 里已无此项)
    {
        let Ok(mut map) = manager.scrcpy.lock() else { return };
        if map.contains_key(&serial) {
            return;
        }
        map.insert(serial.clone(), session.clone());
    }
    let result = scrcpy_run_inner(&app, &manager, &serial, &session).await;
    if let Err(error) = result {
        tracing::info!("scrcpy 通道不可用({serial}),直播保持轮询模式: {error}");
        session.set_error(error);
    }
}

async fn scrcpy_run_inner(
    app: &tauri::AppHandle,
    manager: &AndroidManager,
    serial: &str,
    session: &Arc<ScrcpySession>,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let adb = resolve_adb(manager).await?;
    let jar = scrcpy_server_path(app)?;

    // 1. 推送 server(尺寸不符才重推,避免每次开窗都传 70KB)
    let remote_size = adb_shell(
        manager,
        &adb,
        serial,
        &format!("stat -c %s {} 2>/dev/null || echo 0", starhub_domain_android::keys::sh_quote(SCRCPY_DEVICE_PATH)),
        15,
    )
    .await
    .unwrap_or_else(|_| "0".to_string());
    let local_size = std::fs::metadata(&jar)
        .map_err(|e| format!("读取 scrcpy-server 失败: {e}"))?
        .len();
    if remote_size.trim().parse::<u64>().unwrap_or(0) != local_size {
        adb_shell(manager, &adb, serial, "mkdir -p /data/local/tmp/starhub", 10).await?;
        let (_, stderr, code) = adb_raw(
            manager,
            &adb,
            Some(serial),
            &[
                "push".to_string(),
                jar.display().to_string(),
                SCRCPY_DEVICE_PATH.to_string(),
            ],
            60,
        )
        .await?;
        if code != 0 {
            return Err(format!("推送 scrcpy-server 失败: {}", stderr.trim()));
        }
    }

    // 2. adb forward(端口先抢一个空闲号;TOCTOU 竞争窗口见踩坑记录)
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("分配本地端口失败: {e}"))?
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    if let Ok(mut slot) = session.forward_port.lock() {
        *slot = port;
    }
    let (_, stderr, code) = adb_raw(
        manager,
        &adb,
        Some(serial),
        &[
            "forward".to_string(),
            format!("tcp:{port}"),
            "localabstract:scrcpy".to_string(),
        ],
        15,
    )
    .await?;
    if code != 0 {
        return Err(format!("adb forward 失败: {}", stderr.trim()));
    }

    // 3. 启动 server(stdout/stderr 留管道:失败时读 stderr 诊断)
    let mut cmd = tokio::process::Command::new(&adb);
    cmd.arg("-s").arg(serial).arg("shell").arg(format!(
        "CLASSPATH={} app_process / com.genymobile.scrcpy.Server {} \
         log_level=warn tunnel_forward=true audio=false control=false \
         send_device_meta=true send_frame_meta=true send_codec_meta=true \
         max_size=1280 max_fps=12 video_bit_rate=2000000 cleanup=false",
        starhub_domain_android::keys::sh_quote(SCRCPY_DEVICE_PATH),
        SCRCPY_SERVER_VERSION,
    ));
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 scrcpy-server 失败: {e}"))?;
    let mut child_stderr = child.stderr.take();
    if let Ok(mut slot) = session.child.lock() {
        *slot = Some(child);
    } else {
        return Err("scrcpy session 锁失效".to_string());
    }

    // 4. 连视频 socket(server 启动需要 1-2s,重试 ~5s)
    let mut stream = None;
    for _ in 0..50 {
        if !manager.live_exists(serial) {
            return Ok(()); // 窗口已关,静默退出
        }
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
    let mut stream = match stream {
        Some(s) => s,
        None => {
            let mut diag = String::new();
            if let Some(mut stderr) = child_stderr.take() {
                let mut buf = vec![0u8; 2048];
                let _ = tokio::time::timeout(
                    std::time::Duration::from_millis(300),
                    stderr.read_buf(&mut buf),
                )
                .await;
                diag = String::from_utf8_lossy(&buf).trim().to_string();
            }
            return Err(format!(
                "scrcpy-server 未就绪(连接 127.0.0.1:{port} 超时){}",
                if diag.is_empty() { String::new() } else { format!(": {diag}") }
            ));
        }
    };
    let _ = stream.set_nodelay(true);

    // 5. 协议头:tunnel_forward 哑字节 → 64B 设备名 → 12B codec meta
    let mut dummy = [0u8; 1];
    stream
        .read_exact(&mut dummy)
        .await
        .map_err(|e| format!("scrcpy 隧道握手失败(哑字节): {e}"))?;
    let mut name_buf = [0u8; 64];
    stream
        .read_exact(&mut name_buf)
        .await
        .map_err(|e| format!("scrcpy 设备元数据读取失败: {e}"))?;
    let mut meta_buf = [0u8; 12];
    stream
        .read_exact(&mut meta_buf)
        .await
        .map_err(|e| format!("scrcpy codec 元数据读取失败: {e}"))?;
    let codec = u32::from_be_bytes(meta_buf[0..4].try_into().map_err(|_| "codec meta")?);
    if codec != 0x6832_6334 {
        // 'h264'
        return Err(format!("scrcpy 视频编码非 H.264(codec=0x{codec:08x}),当前仅支持 H.264"));
    }
    let width = u32::from_be_bytes(meta_buf[4..8].try_into().map_err(|_| "codec meta")?);
    let height = u32::from_be_bytes(meta_buf[8..12].try_into().map_err(|_| "codec meta")?);
    if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) {
        return Err(format!("scrcpy 视频尺寸异常: {width}x{height}(协议不匹配?)"));
    }
    if let Ok(mut slot) = session.video_size.lock() {
        *slot = Some((width, height));
    }
    tracing::info!("scrcpy 通道就绪({serial}): {width}x{height} → 127.0.0.1:{port}");

    // 6. 帧循环:12B 帧元头 + 负载 → 环形缓冲;stderr 同管 drain(server 异常即 EOF)
    if let Some(mut stderr) = child_stderr.take() {
        let session = session.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = String::new();
            let mut chunk = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
                if buf.len() > 4096 {
                    buf.drain(..buf.len() - 4096);
                }
            }
            let text = buf.trim().to_string();
            if !text.is_empty() && !session.is_ready() {
                session.set_error(format!("scrcpy-server 退出: {text}"));
            }
        });
    }
    let mut header = [0u8; 12];
    loop {
        if !manager.live_exists(serial) {
            return Ok(());
        }
        if let Err(e) = stream.read_exact(&mut header).await {
            return Err(format!("scrcpy 流中断: {e}"));
        }
        let Some((key, config, size)) = parse_frame_meta(&header) else {
            return Err("scrcpy 帧元头解析失败(协议不匹配?)".to_string());
        };
        let mut payload = vec![0u8; size];
        if let Err(e) = stream.read_exact(&mut payload).await {
            return Err(format!("scrcpy 负载读取中断: {e}"));
        }
        let flags = (key as u8) | ((config as u8) << 1);
        if let Ok(mut ring) = session.ring.lock() {
            ring.push(flags, payload);
        }
    }
}

// ============================================================
// 直播泵与 custom protocol 处理器
// ============================================================

/// 轮询泵:周期 screencap 更新帧缓存(scrcpy 就绪时跳过截图,只排空输入
/// 队列),session 摘除即退出。
async fn live_pump(
    manager: AndroidManager,
    serial: String,
    rx: std::sync::mpsc::Receiver<LiveAction>,
) {
    let adb = match resolve_adb(&manager).await {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("Android 直播泵无 adb({serial}): {error}");
            manager.stop_live(&serial);
            return;
        }
    };
    loop {
        if !manager.live_exists(&serial) {
            break;
        }
        // 排空动作队列(顺序执行;动作失败只记日志,不中断泵)
        while let Ok(action) = rx.try_recv() {
            match action {
                LiveAction::Tap(x, y) => {
                    let _ = adb_shell(&manager, &adb, &serial, &format!("input tap {x} {y}"), 10).await;
                }
                LiveAction::Swipe(x1, y1, x2, y2, ms) => {
                    let _ = adb_shell(
                        &manager,
                        &adb,
                        &serial,
                        &format!("input swipe {x1} {y1} {x2} {y2} {ms}"),
                        15,
                    )
                    .await;
                }
                LiveAction::Key(key) => {
                    if let Ok(code) = starhub_domain_android::keys::map_keycode(&key) {
                        let _ = adb_shell(&manager, &adb, &serial, &format!("input keyevent {code}"), 10).await;
                    }
                }
                LiveAction::Type(text) => {
                    let _ = type_text_via_crate(&manager, &adb, &serial, &text).await;
                }
                LiveAction::SetTakeover(active) => {
                    if let Ok(mut live) = manager.live.lock() {
                        if let Some(session) = live.get_mut(&serial) {
                            session.takeover = active;
                        }
                    }
                }
            }
        }
        // scrcpy 就绪时跳过截图(省电省 adb 往返);轮询模式照常捕帧
        let (scrcpy_ready, _) = manager.live_mode(&serial);
        if !scrcpy_ready {
            match crate::android::capture_png_via_crate(&adb, &serial).await {
                Ok(bytes) => {
                    if let Ok(mut live) = manager.live.lock() {
                        if let Some(session) = live.get_mut(&serial) {
                            session.frame = Some((bytes, std::time::Instant::now()));
                        }
                    }
                }
                Err(error) => {
                    tracing::debug!("Android 直播帧捕获失败({serial}): {error}");
                }
            }
        }
        tokio::time::sleep(LIVE_PUMP_INTERVAL).await;
    }
}

/// 直播页 HTML(自包含,无外部依赖)。双模:meta 报 scrcpy 且 webview 支持
/// WebCodecs → H.264 增量解码;否则轮询 frame.png。围观默认;接管开关打开后:
/// 点击 = tap,拖拽 = swipe,底栏 Back/Home/Recents 与文本输入。
/// 坐标一律按「显示矩形 → 设备物理像素」映射,免疫视频缩放与分辨率差(§7.6)。
const LIVE_PAGE: &str = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Android 直播</title>
<style>
  html,body{margin:0;height:100%;background:#141414;color:#ddd;font:13px/1.5 system-ui,sans-serif;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1f1f1f;flex:none;flex-wrap:wrap}
  header .title{font-weight:600}
  header .dim{color:#888}
  .badge{background:#2d4a2d;color:#8f8;border-radius:4px;padding:1px 6px;font-size:11px}
  .badge.slow{background:#4a3a2d;color:#fc8}
  label.takeover{display:flex;align-items:center;gap:4px;cursor:pointer;color:#f0a020}
  button{background:#2d2d2d;color:#ddd;border:1px solid #444;border-radius:6px;padding:4px 12px;cursor:pointer}
  button:hover{background:#3a3a3a}
  #controls{display:none;gap:6px;align-items:center}
  body.takeover #controls{display:flex}
  body.takeover #stage{cursor:crosshair}
  #textin{flex:1;min-width:120px;background:#111;border:1px solid #444;border-radius:6px;color:#ddd;padding:4px 8px}
  main{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative}
  #stage{max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none}
</style>
</head>
<body>
<header>
  <span class="title">Android 直播</span>
  <span class="dim" id="serial"></span>
  <span class="badge slow" id="mode">连接中…</span>
  <span class="dim" id="fps"></span>
  <label class="takeover"><input type="checkbox" id="tk"> 接管(AI 操作暂停)</label>
  <span id="controls">
    <button data-key="back">← 返回</button>
    <button data-key="home">⌂ 主页</button>
    <button data-key="recents">▢ 多任务</button>
    <input id="textin" placeholder="输入文本回车发送(中文需设备装 ADBKeyBoard)">
  </span>
</header>
<main><canvas id="stage" style="display:none"></canvas><img id="frame" alt="等待首帧…" style="max-width:100%;max-height:100%;object-fit:contain;user-select:none"></main>
<script>
const SERIAL = "__SERIAL__";
const canvas = document.getElementById('stage');
const img = document.getElementById('frame');
const fpsEl = document.getElementById('fps');
const modeEl = document.getElementById('mode');
document.getElementById('serial').textContent = SERIAL;
let META = { mode: 'frames', width: 1080, height: 2400 };
let frames = 0, fpsTimer = Date.now();
function tickFps() {
  frames++;
  const now = Date.now();
  if (now - fpsTimer >= 2000) {
    fpsEl.textContent = (frames * 1000 / (now - fpsTimer)).toFixed(1) + ' fps';
    frames = 0; fpsTimer = now;
  }
}
function post(path, body) {
  return fetch('/' + SERIAL + '/' + path, {method:'POST', body: JSON.stringify(body)});
}

// ── 模式协商:每 3s 复核一次(scrcpy 就绪即升级,出错即降级) ──
let mode = 'frames';
async function refreshMeta() {
  try {
    const resp = await fetch('/' + SERIAL + '/meta?t=' + Date.now());
    if (resp.ok) {
      const m = await resp.json();
      META = m;
      const want = (m.mode === 'scrcpy' && typeof VideoDecoder !== 'undefined') ? 'scrcpy' : 'frames';
      if (want !== mode) switchMode(want);
      modeEl.textContent = mode === 'scrcpy' ? 'H.264 实时' : '截图轮询';
      modeEl.className = 'badge' + (mode === 'scrcpy' ? '' : ' slow');
      modeEl.title = m.error ? ('scrcpy 不可用:' + m.error) : '';
    }
  } catch (e) { /* 下一轮重试 */ }
  setTimeout(refreshMeta, 3000);
}

// ── 轮询模式 ──
async function pollFrame() {
  if (mode !== 'frames') return;
  try {
    const resp = await fetch('/' + SERIAL + '/frame.png?t=' + Date.now());
    if (resp.ok && resp.status === 200) {
      img.src = URL.createObjectURL(await resp.blob());
      tickFps();
    }
  } catch (e) { /* 下一拍重试 */ }
  setTimeout(pollFrame, 400);
}

// ── scrcpy 模式(WebCodecs annexb 增量解码) ──
let decoder = null, videoOffset = 0, decoding = false;
function makeDecoder() {
  decoder = new VideoDecoder({
    output: (frame) => {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      tickFps();
    },
    error: () => { videoOffset = 0; }, // 解码失败:强制重同步(等关键帧)
  });
  decoder.configure({ codec: 'avc1.42E01E', format: 'annexb' });
}
async function pumpVideo() {
  if (mode !== 'scrcpy') return;
  if (decoding) return;
  decoding = true;
  try {
    const resp = await fetch('/' + SERIAL + '/video?since=' + videoOffset);
    if (resp.ok) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length >= 8) {
        const view = new DataView(buf.buffer);
        const base = Number(view.getBigUint64(0));
        let pos = 8;
        const resync = resp.headers.get('X-Resync') === '1';
        if (resync && decoder) { decoder.reset(); makeDecoder(); }
        while (pos + 5 <= buf.length) {
          const flags = buf[pos];
          const len = view.getUint32(pos + 1);
          pos += 5;
          if (pos + len > buf.length) break;
          const data = buf.subarray(pos, pos + len);
          pos += len;
          if (decoder && decoder.state === 'configured' && (flags & 2) === 0) {
            decoder.decode(new EncodedVideoChunk({
              type: (flags & 1) ? 'key' : 'delta',
              timestamp: performance.now() * 1000,
              data,
            }));
          }
        }
        videoOffset = base + (buf.length - 8);
      }
    }
  } catch (e) { /* 下一拍重试 */ }
  decoding = false;
  if (mode === 'scrcpy') setTimeout(pumpVideo, 60);
}
function switchMode(next) {
  mode = next;
  if (next === 'scrcpy') {
    canvas.width = META.vw || META.width; canvas.height = META.vh || META.height;
    canvas.style.display = ''; img.style.display = 'none';
    videoOffset = 0; makeDecoder(); pumpVideo();
  } else {
    canvas.style.display = 'none'; img.style.display = '';
    if (decoder) { try { decoder.close(); } catch (e) {} decoder = null; }
    pollFrame();
  }
}

// ── 接管:点击/拖拽/按键/文本 ──
const tk = document.getElementById('tk');
tk.addEventListener('change', () => {
  document.body.classList.toggle('takeover', tk.checked);
  post('takeover', {active: tk.checked});
});
let downAt = null, downPos = null;
function toDevice(e) {
  const el = mode === 'scrcpy' ? canvas : img;
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width * META.width;
  const y = (e.clientY - r.top) / r.height * META.height;
  return [Math.round(x), Math.round(y)];
}
for (const el of [canvas, img]) {
  el.addEventListener('mousedown', e => { if (tk.checked) { downAt = Date.now(); downPos = toDevice(e); } });
  el.addEventListener('mouseup', e => {
    if (!tk.checked || !downPos) return;
    const [x1, y1] = downPos, [x2, y2] = toDevice(e);
    const ms = Math.min(1500, Math.max(80, Date.now() - downAt));
    downPos = null;
    if (Math.abs(x2 - x1) < 12 && Math.abs(y2 - y1) < 12) post('input', {type:'tap', x:x1, y:y1});
    else post('input', {type:'swipe', x1, y1, x2, y2, ms});
  });
}
document.querySelectorAll('#controls button').forEach(b =>
  b.addEventListener('click', () => post('input', {type:'key', key: b.dataset.key})));
document.getElementById('textin').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value) { post('input', {type:'text', text: e.target.value}); e.target.value = ''; }
});

pollFrame();   // 先按轮询模式起,meta 就绪后自动升级
refreshMeta();
</script>
</body>
</html>
"#;

type HttpResponse = tauri::http::Response<Cow<'static, [u8]>>;

fn http_response(status: u16, content_type: &str, body: Vec<u8>) -> HttpResponse {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Cow::Owned(body))
        .expect("构建直播响应失败")
}

/// `android-live://localhost/<serial>/<资源>` custom protocol 处理器。
/// 在 webview 线程同步执行,只读写注册表(std Mutex),不做任何 await
/// (帧/视频包由泵与 scrcpy 任务预捕获;接管输入经 mpsc 转交泵)。
pub fn live_protocol_handler(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> HttpResponse {
    let path = request.uri().path().to_string();
    let segments: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.len() != 2 || !starhub_domain_android::keys::valid_serial(segments[0]) {
        return http_response(404, "text/plain; charset=utf-8", b"bad request".to_vec());
    }
    let (serial, resource) = (segments[0], segments[1]);
    let manager = app.state::<AndroidManager>();
    match (request.method().as_str(), resource) {
        ("GET", "index.html") | ("GET", "") => {
            let page = LIVE_PAGE.replace("__SERIAL__", serial);
            http_response(200, "text/html; charset=utf-8", page.into_bytes())
        }
        ("GET", "frame.png") => match manager.live_frame(serial) {
            Some(bytes) => http_response(200, "image/png", bytes),
            None => http_response(204, "image/png", Vec::new()),
        },
        ("GET", "meta") => {
            let (scrcpy_ready, error) = manager.live_mode(serial);
            let (w, h) = manager.live_resolution(serial).unwrap_or((0, 0));
            let video_size = manager
                .scrcpy_session(serial)
                .and_then(|s| s.video_size.lock().ok().and_then(|m| *m));
            let body = serde_json::json!({
                "mode": if scrcpy_ready { "scrcpy" } else { "frames" },
                "width": w,
                "height": h,
                "vw": video_size.map(|(w, _)| w),
                "vh": video_size.map(|(_, h)| h),
                "error": error,
            });
            http_response(200, "application/json", body.to_string().into_bytes())
        }
        ("GET", "video") => {
            let Some(session) = manager.scrcpy_session(serial) else {
                return http_response(404, "text/plain", b"no scrcpy session".to_vec());
            };
            let since = request
                .uri()
                .query()
                .and_then(|q| {
                    q.split('&')
                        .find_map(|kv| kv.strip_prefix("since=").and_then(|v| v.parse::<u64>().ok()))
                })
                .unwrap_or(0);
            let (base, body, resync) = match session.ring.lock() {
                Ok(ring) => ring.read_since(since),
                Err(_) => (0, Vec::new(), false),
            };
            let mut out = Vec::with_capacity(body.len() + 8);
            out.extend_from_slice(&base.to_be_bytes());
            out.extend_from_slice(&body);
            tauri::http::Response::builder()
                .status(200)
                .header("content-type", "application/octet-stream")
                .header("cache-control", "no-store")
                .header("x-resync", if resync { "1" } else { "0" })
                .body(Cow::Owned(out))
                .expect("构建视频响应失败")
        }
        ("POST", "takeover") => {
            let active = serde_json::from_slice::<Value>(request.body())
                .ok()
                .and_then(|v| v.get("active").and_then(Value::as_bool))
                .unwrap_or(false);
            let ok = manager.live_enqueue(serial, LiveAction::SetTakeover(active));
            http_response(
                if ok { 202 } else { 409 },
                "application/json",
                format!("{{\"ok\":{ok}}}").into_bytes(),
            )
        }
        ("POST", "input") => {
            let action = serde_json::from_slice::<Value>(request.body())
                .ok()
                .and_then(|v| {
                    let num = |key: &str| v.get(key).and_then(Value::as_i64);
                    match v.get("type").and_then(Value::as_str) {
                        Some("tap") => Some(LiveAction::Tap(num("x")?, num("y")?)),
                        Some("swipe") => Some(LiveAction::Swipe(
                            num("x1")?,
                            num("y1")?,
                            num("x2")?,
                            num("y2")?,
                            v.get("ms").and_then(Value::as_i64).unwrap_or(300).clamp(50, 5000),
                        )),
                        Some("key") => v
                            .get("key")
                            .and_then(Value::as_str)
                            .map(|k| LiveAction::Key(k.to_string())),
                        Some("text") => v
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|t| !t.is_empty())
                            .map(|t| LiveAction::Type(t.to_string())),
                        _ => None,
                    }
                });
            match action {
                Some(action) if manager.is_takeover(serial) => {
                    let ok = manager.live_enqueue(serial, action);
                    http_response(
                        if ok { 202 } else { 409 },
                        "application/json",
                        format!("{{\"ok\":{ok}}}").into_bytes(),
                    )
                }
                Some(_) => http_response(
                    423,
                    "application/json",
                    b"{\"ok\":false,\"error\":\"not in takeover\"}".to_vec(),
                ),
                None => http_response(400, "application/json", b"{\"ok\":false}".to_vec()),
            }
        }
        _ => http_response(404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}

// ============================================================
// Tauri 侧 seam 实现 + 桥入口
// ============================================================

/// 输入文本(直播面板的接管输入用):ASCII 走 input text,非 ASCII 走
/// ADBKeyBoard 广播(与域 crate 的 type_text 同规则)。
async fn type_text_via_crate(
    _manager: &AndroidManager,
    adb: &str,
    serial: &str,
    text: &str,
) -> Result<String, String> {
    use starhub_domain_android::adb::Adb;
    if starhub_domain_android::keys::is_ascii_input(text) {
        TauriAdb
            .shell(
                adb,
                serial,
                &format!(
                    "input text {}",
                    starhub_domain_android::keys::sh_quote(
                        &starhub_domain_android::keys::escape_input_text(text)
                    )
                ),
                30,
            )
            .await?;
        return Ok(format!("已输入 {} 字符", text.chars().count()));
    }
    let pm = TauriAdb
        .shell(adb, serial, "pm path com.android.adbkeyboard", 15)
        .await
        .unwrap_or_default();
    if !pm.contains("package:") {
        return Err(
            "输入含非 ASCII 字符(如中文),需要设备已安装 ADBKeyBoard(见 android_type 的引导)"
                .to_string(),
        );
    }
    TauriAdb
        .shell(
            adb,
            serial,
            &format!(
                "am broadcast -a ADB_INPUT_TEXT --es msg {}",
                starhub_domain_android::keys::sh_quote(text)
            ),
            30,
        )
        .await?;
    Ok(format!(
        "已经 ADBKeyBoard 广播输入 {} 字符",
        text.chars().count()
    ))
}

/// 截图(直播 pump 轮询模式用;CRLF 修复经 crate 的 ensure_png)。
async fn capture_png_via_crate(adb: &str, serial: &str) -> Result<Vec<u8>, String> {
    use starhub_domain_android::adb::Adb;
    let (stdout, stderr, code) = TauriAdb
        .raw(
            adb,
            Some(serial),
            &[
                "exec-out".to_string(),
                "screencap".to_string(),
                "-p".to_string(),
            ],
            30,
        )
        .await?;
    if code != 0 {
        return Err(format!("设备截图失败(exit {code}): {}", stderr.trim()));
    }
    starhub_domain_android::keys::ensure_png(stdout)
}

/// 打开(或重建)一台设备的直播窗口:先销毁旧窗口(其 Destroyed 钩子停旧泵
/// 并回收 scrcpy),再 start_live + 建新会话。AI 工具(android_open_live)
/// 与 UI 命令(android_ui_open_live)共用。窗口 label android-live-* 不匹配
/// 任何 capability:直播页无任何 app command 权限(与 sandbox-live 同姿势);
/// 输入/帧/视频全部经 custom protocol。
pub(crate) fn open_live_window(
    app: &tauri::AppHandle,
    manager: &AndroidManager,
    serial: &str,
    resolution: (i64, i64),
) -> Result<(), String> {
    let short: String = serial.chars().take(8).collect();
    let label = format!("android-live-{short}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing
            .destroy()
            .map_err(|e| format!("关闭旧直播窗口失败:{e}"))?;
    }
    manager.start_live(app, serial, resolution);
    let url = format!("android-live://localhost/{serial}/index.html");
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("直播 URL 非法:{e}"))?;
    let window = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(parsed))
        .title(format!("Android 直播 - {short}"))
        .inner_size(420.0, 860.0)
        .build()
        .map_err(|e| format!("创建直播窗口失败:{e}"))?;
    let _ = window;
    Ok(())
}

/// UI 命令:列出设备(工具面板/直播 tab 用;只读,不需要授权)。
pub async fn ui_list_devices(app: &tauri::AppHandle) -> Result<Value, String> {
    let manager = app.state::<AndroidManager>().inner().clone();
    let adb = resolve_adb(&manager).await?;
    let (stdout, _, _) = adb_raw(
        &manager,
        &adb,
        None,
        &["devices".to_string(), "-l".to_string()],
        15,
    )
    .await?;
    let devices = starhub_domain_android::keys::parse_devices(&String::from_utf8_lossy(&stdout));
    Ok(serde_json::json!(devices
        .iter()
        .map(|d| {
            serde_json::json!({
                "serial": d.serial,
                "state": d.state,
                "model": d.model,
            })
        })
        .collect::<Vec<_>>()))
}

/// UI 命令:打开设备直播窗口(用户点击 = 审批表达)。
pub async fn ui_open_live(app: &tauri::AppHandle, serial: String) -> Result<(), String> {
    let manager = app.state::<AndroidManager>().inner().clone();
    let resolution = manager
        .live_resolution(&serial)
        .unwrap_or((1080, 2400));
    open_live_window(app, &manager, &serial, resolution)
}

/// 应用缓存目录(截图落盘 android-shots/)。
struct AppCacheDir<'a>(&'a tauri::AppHandle);

impl starhub_domain_android::CacheDir for AppCacheDir<'_> {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String> {
        let base = self
            .0
            .path()
            .app_cache_dir()
            .map_err(|e| format!("缓存目录不可用: {e}"))?;
        Ok(base.join(sub))
    }
}

/// SQLite 版回放帧存储(android_replay_frames 表)。
struct SqliteFrameStore;

impl starhub_domain_android::store::FrameStore for SqliteFrameStore {
    fn insert_frame<'a>(
        &'a self,
        serial: &'a str,
        session_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> starhub_domain_android::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query(
                "INSERT INTO android_replay_frames (serial, session_id, action, shot_path) VALUES (?, ?, ?, ?)",
            )
            .bind(serial)
            .bind(session_id)
            .bind(action)
            .bind(shot_path)
            .execute(pool)
            .await
            .map_err(|e| format!("回放帧落库失败: {e}"))?;
            Ok(())
        })
    }

    fn list_frames<'a>(
        &'a self,
        serial: &'a str,
        limit: i64,
    ) -> starhub_domain_android::BoxFuture<'a, Result<Vec<starhub_domain_android::store::ReplayFrame>, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let rows = sqlx::query(
                "SELECT action, shot_path, created_at FROM android_replay_frames WHERE serial = ? ORDER BY id LIMIT ?",
            )
            .bind(serial)
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("读取回放帧失败: {e}"))?;
            rows.iter()
                .map(|row| {
                    Ok(starhub_domain_android::store::ReplayFrame {
                        action: row.try_get("action").map_err(|e| e.to_string())?,
                        shot_path: row.try_get("shot_path").ok(),
                        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
                    })
                })
                .collect()
        })
    }
}

/// Tauri 的 adb 执行器(本地 spawn; NotFound 时清路径缓存)。
struct TauriAdb;

impl starhub_domain_android::adb::Adb for TauriAdb {
    fn raw<'a>(
        &'a self,
        adb: &'a str,
        serial: Option<&'a str>,
        args: &'a [String],
        timeout_secs: u64,
    ) -> starhub_domain_android::BoxFuture<'a, Result<(Vec<u8>, String, i32), String>> {
        Box::pin(async move { adb_raw_standalone(adb, serial, args, timeout_secs).await })
    }
}

/// 无 manager 的 adb 执行(域 crate 的 Adb seam 不持有管理器)。
async fn adb_raw_standalone(
    adb: &str,
    serial: Option<&str>,
    args: &[String],
    timeout_secs: u64,
) -> Result<(Vec<u8>, String, i32), String> {
    let mut cmd = tokio::process::Command::new(adb);
    if let Some(serial) = serial {
        cmd.arg("-s").arg(serial);
    }
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let result =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await;
    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(starhub_domain_android::adb::adb_missing_guidance());
        }
        Ok(Err(e)) => return Err(format!("adb 执行失败: {e}")),
        Err(_) => return Err(format!("adb 命令超时({timeout_secs}s)")),
    };
    Ok((
        output.stdout,
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    ))
}

/// 直播启动:开(或重建)Tauri 直播窗口。
struct TauriLiveLauncher<'a> {
    app: &'a tauri::AppHandle,
    manager: &'a AndroidManager,
}

impl starhub_domain_android::LiveLauncher for TauriLiveLauncher<'_> {
    fn open<'a>(
        &'a self,
        serial: &'a str,
        resolution: (i64, i64),
    ) -> starhub_domain_android::BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { open_live_window(self.app, self.manager, serial, resolution) })
    }
}

/// 接管状态:读 live 注册表。
struct TauriTakeover<'a>(&'a AndroidManager);

impl starhub_domain_android::TakeoverState for TauriTakeover<'_> {
    fn is_takeover(&self, serial: &str) -> bool {
        self.0.is_takeover(serial)
    }
}

/// harness 桥入口:android_* 工具在此分发执行,返回模型可读文本。
pub async fn execute_from_bridge(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "应用句柄未就绪(启动序列未完成)".to_string())?;
    let manager = app.state::<AndroidManager>().inner().clone();
    // seam 实例必须是本作用域的局部值(借用随 context 一起活着)
    let adb = TauriAdb;
    let settings = SqliteSettingsStore;
    let cache = AppCacheDir(&app);
    let frames = SqliteFrameStore;
    let live = TauriLiveLauncher {
        app: &app,
        manager: &manager,
    };
    let takeover = TauriTakeover(&manager);
    let context = starhub_domain_android::Android {
        manager: &manager.core,
        adb: &adb,
        settings: &settings,
        cache: &cache,
        frames: &frames,
        live: &live,
        takeover: &takeover,
        session_id,
    };
    starhub_domain_android::execute(&context, name, args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // 纯函数测试(白名单 / 键名映射 / uiautomator 解析 / PNG 修复 / scrcpy 帧)
    // 已随执行体搬到 starhub-domain-android;这里只留直播面(窗口/协议)的测试。

    #[test]
    fn packet_ring_incremental_and_resync() {
        let mut ring = PacketRing::default();
        ring.push(1, vec![1, 2, 3]); // keyframe @ 0
        ring.push(0, vec![4]); // delta
        // 增量:从第 2 个包开始
        let (base, body, resync) = ring.read_since(8);
        assert!(!resync && base == 8);
        assert_eq!(body, vec![0, 0, 0, 0, 1, 4]); // flags=0,len=1,payload=4
        // 已最新:空
        let (_, body, _) = ring.read_since(ring.next_offset);
        assert!(body.is_empty());
        // 重同步:since=0 → 从关键帧
        let (base, body, resync) = ring.read_since(0);
        assert!(resync && base == 0);
        assert_eq!(body[..6], [1, 0, 0, 0, 3, 1]);
        // since 丢出环外 → 同样重同步
        let (_, _, resync) = ring.read_since(u64::MAX);
        assert!(!resync, "超过 next_offset 视为最新,空增量");
    }

    #[test]
    fn scrcpy_frame_meta_parsing() {
        // keyframe + 100 字节负载
        let mut header = [0u8; 12];
        header[..8].copy_from_slice(&(1u64 << 62 | 42).to_be_bytes());
        header[8..].copy_from_slice(&100u32.to_be_bytes());
        let (key, config, size) = parse_frame_meta(&header).unwrap();
        assert!(key && !config && size == 100);

        // config 包
        header[..8].copy_from_slice(&(1u64 << 63).to_be_bytes());
        let (key, config, _) = parse_frame_meta(&header).unwrap();
        assert!(!key && config);

        // 长度异常拒绝
        header[..8].copy_from_slice(&0u64.to_be_bytes());
        header[8..].copy_from_slice(&(20u32 << 20).to_be_bytes());
        assert!(parse_frame_meta(&header).is_none());
        assert!(parse_frame_meta(&header[..11]).is_none());
    }

    #[test]
    fn png_helpers_still_back_the_live_pump() {
        // 直播 pump 的轮询模式仍用 ensure_png / png_dimensions
        let good = b"\x89PNG\r\n\x1a\nIHDR-body\n".to_vec();
        assert_eq!(ensure_png(good.clone()).unwrap(), good);
        let broken = b"\x89PNG\r\r\n\x1a\r\nIHDR-body\r\n".to_vec();
        assert_eq!(ensure_png(broken).unwrap(), good);
        assert!(ensure_png(b"NOTPNG".to_vec()).is_err());
        assert_eq!(png_dimensions(&good), None, "IHDR 数据不全 → None");
    }
}
