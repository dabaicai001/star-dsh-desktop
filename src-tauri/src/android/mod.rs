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

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::Value;
use sqlx::Row;
use tauri::Manager;

use crate::harness::HostBridgeState;

/// 本模块处理的 AI 工具清单(harness/tools.rs 分发用)。
pub const ANDROID_TOOLS: &[&str] = &[
    // 发现与管理
    "android_list_devices",
    "android_connect",
    "android_disconnect",
    "android_device_status",
    "android_replay",
    // 无线调试(配对/连接;配对码只能用户从手机上读)
    "android_wireless",
    // 感知(授权内放行)
    "android_screenshot",
    "android_current_app",
    // 操作(授权内放行,接管互斥)
    "android_tap",
    "android_double_tap",
    "android_swipe",
    "android_scroll",
    "android_type",
    "android_press_key",
    "android_launch_app",
    // 直播窗口(软确认)
    "android_open_live",
    // 文件传输(恒确认软档,对齐 sftp)
    "android_pull",
    "android_push",
    // 万能钥匙(恒确认 hard 档)
    "android_exec",
];

/// 设置表 key:adb 二进制显式路径(设置页「Android 设备」可写)。
pub const ADB_PATH_SETTING_KEY: &str = "android.adb_path";
/// 任务授权时长(秒),与沙箱桌面同档。
const AUTHZ_TTL_SECS: i64 = 60 * 60;
/// 直播 pump 两帧之间的间隔(轮询模式;截图自身耗时 300-500ms)。
const LIVE_PUMP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);
/// scrcpy-server 版本(与 resources/scrcpy/scrcpy-server 一致;server 校验
/// 首个参数必须等于自身版本号,不匹配即退出)。
const SCRCPY_SERVER_VERSION: &str = "2.7";
/// 设备端 scrcpy-server 投放路径。
const SCRCPY_DEVICE_PATH: &str = "/data/local/tmp/starhub/scrcpy-server";
/// 视频环形缓冲上限(2Mbps × ~10s GOP 约 2.5MB,留足余量)。
const VIDEO_RING_CAP_BYTES: usize = 8 << 20;

/// 授权条目:android_connect 建立,到期/断开即失效。
#[derive(Debug, Clone)]
struct Authz {
    serial: String,
    /// connect 时探测的物理分辨率(w,h),scroll 默认中心点/swipe 裁剪/
    /// 直播页坐标映射用。
    resolution: (i64, i64),
    expires_at: i64,
}

#[derive(Default)]
struct AndroidState {
    /// session_id → 任务级授权。
    authz: HashMap<String, Authz>,
    /// adb 二进制路径解析缓存(NotFound 时清除重解析)。
    adb_path: Option<String>,
}

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
#[derive(Clone, Default)]
pub struct AndroidManager {
    state: Arc<tokio::sync::Mutex<AndroidState>>,
    live: Arc<std::sync::Mutex<HashMap<String, LiveSession>>>,
    scrcpy: Arc<std::sync::Mutex<HashMap<String, Arc<ScrcpySession>>>>,
}

impl AndroidManager {
    pub fn new() -> Self {
        Self::default()
    }

    async fn grant(&self, session_id: &str, serial: &str, resolution: (i64, i64)) {
        let expires_at = chrono::Utc::now().timestamp() + AUTHZ_TTL_SECS;
        self.state.lock().await.authz.insert(
            session_id.to_string(),
            Authz {
                serial: serial.to_string(),
                resolution,
                expires_at,
            },
        );
    }

    async fn revoke(&self, session_id: &str) {
        self.state.lock().await.authz.remove(session_id);
    }

    /// adb 路径设置被设置页修改后清缓存,下次调用重新解析。
    pub async fn invalidate_adb_cache(&self) {
        self.state.lock().await.adb_path = None;
    }

    /// 当前解析到的 adb 路径(设置页展示用;None = 尚未解析过)。
    pub async fn cached_adb_path(&self) -> Option<String> {
        self.state.lock().await.adb_path.clone()
    }

    /// 校验会话对目标设备的写授权;返回授权条目(serial + 分辨率)。
    async fn require_authz(
        &self,
        session_id: &str,
        serial_arg: Option<&str>,
    ) -> Result<Authz, String> {
        let state = self.state.lock().await;
        let authz = state.authz.get(session_id).ok_or_else(|| {
            "当前会话没有设备授权:请先调用 android_connect 连接设备(会请求用户确认)"
                .to_string()
        })?;
        if authz.expires_at < chrono::Utc::now().timestamp() {
            return Err("设备授权已过期(60 分钟),请重新 android_connect".to_string());
        }
        if let Some(want) = serial_arg {
            if !want.is_empty() && want != authz.serial {
                return Err(format!(
                    "授权仅覆盖设备 {},不能操作 {want}",
                    authz.serial
                ));
            }
        }
        Ok(authz.clone())
    }

    /// 直播接管中(AI 写操作互斥;不撤销授权)。
    fn is_takeover(&self, serial: &str) -> bool {
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
// adb 二进制解析(§3:设置 → 环境变量 → PATH → 常见位置)
// ============================================================

/// 平台常见 adb 安装位置。
fn common_adb_locations() -> Vec<std::path::PathBuf> {
    let mut out: Vec<std::path::PathBuf> = Vec::new();
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(
                std::path::Path::new(&local)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
        out.push(std::path::PathBuf::from(r"C:\platform-tools\adb.exe"));
        if !home.is_empty() {
            out.push(
                std::path::Path::new(&home)
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    if !home.is_empty() {
        out.push(
            std::path::Path::new(&home)
                .join("Library")
                .join("Android")
                .join("sdk")
                .join("platform-tools")
                .join("adb"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if !home.is_empty() {
            out.push(
                std::path::Path::new(&home)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb"),
            );
        }
        out.push(std::path::PathBuf::from("/usr/bin/adb"));
    }
    out
}

/// PATH 查找(Windows `where`,Unix `which`);命中第一条。
async fn find_in_path() -> Option<String> {
    #[cfg(target_os = "windows")]
    let (prog, args) = ("where", ["adb"].as_slice());
    #[cfg(not(target_os = "windows"))]
    let (prog, args) = ("which", ["adb"].as_slice());
    let output = tokio::process::Command::new(prog)
        .args(args)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// 「找不到 adb」的引导文案(三平台安装命令 + AI 代装提示)。
fn adb_missing_guidance() -> String {
    "未找到 adb 二进制。可按以下任一方式安装 Android platform-tools 后重试:\n\
     - Windows(管理员 PowerShell):winget install --id Google.PlatformTools -e\n\
     - macOS:brew install android-platform-tools\n\
     - Linux:sudo apt install adb(或发行版对应包名)\n\
     也可以让 AI 用本机工具(pwsh/bash)代为执行上述安装;已装在非标准位置时,\n\
     在 设置 → Android 设备 填写 adb 完整路径(或设置环境变量 STARHUB_ADB_PATH)。"
        .to_string()
}

/// 解析 adb 路径(带缓存;显式配置与常见位置做 exists 校验)。
pub async fn resolve_adb(manager: &AndroidManager) -> Result<String, String> {
    if let Some(cached) = manager.state.lock().await.adb_path.clone() {
        return Ok(cached);
    }
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(pool) = crate::db::get_pool() {
        if let Ok(Some(value)) =
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
                .bind(ADB_PATH_SETTING_KEY)
                .fetch_optional(pool)
                .await
        {
            if !value.trim().is_empty() {
                candidates.push(value.trim().to_string());
            }
        }
    }
    if let Ok(env_path) = std::env::var("STARHUB_ADB_PATH") {
        if !env_path.trim().is_empty() {
            candidates.push(env_path.trim().to_string());
        }
    }
    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            manager.state.lock().await.adb_path = Some(candidate.clone());
            return Ok(candidate.clone());
        }
    }
    if let Some(found) = find_in_path().await {
        manager.state.lock().await.adb_path = Some(found.clone());
        return Ok(found);
    }
    for location in common_adb_locations() {
        if location.exists() {
            let path = location.display().to_string();
            manager.state.lock().await.adb_path = Some(path.clone());
            return Ok(path);
        }
    }
    Err(adb_missing_guidance())
}

/// spawn 报 NotFound 时清除缓存(二进制被移走),下次调用重新解析。
async fn evict_adb_cache(manager: &AndroidManager) {
    manager.state.lock().await.adb_path = None;
}

// ============================================================
// adb 执行封装
// ============================================================

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
            evict_adb_cache(manager).await;
            return Err(adb_missing_guidance());
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
// 解析与白名单(纯函数,单测覆盖)
// ============================================================

/// `adb devices -l` 的一台设备。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AdbDevice {
    pub serial: String,
    /// device / unauthorized / offline 等。
    pub state: String,
    /// -l 附加信息里的 model(可能为空)。
    pub model: String,
}

/// 解析 `adb devices -l` 输出(跳过表头与空行)。
fn parse_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
                return None;
            }
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let model = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("model:").map(str::to_string))
                .unwrap_or_default();
            Some(AdbDevice { serial, state, model })
        })
        .collect()
}

/// serial 白名单(防参数注入 adb 命令行)。
fn valid_serial(serial: &str) -> bool {
    !serial.is_empty()
        && serial.len() <= 64
        && serial
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

/// 包名白名单(com.example.app 形态)。
fn valid_package(pkg: &str) -> bool {
    !pkg.is_empty()
        && pkg.len() <= 128
        && pkg.contains('.')
        && pkg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

/// 主机名/IP 白名单(android_wireless)。
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 128
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
}

/// 设备端可写目录白名单(android_push 落地根)。
fn valid_push_dir(dir: &str) -> bool {
    (dir.starts_with("/sdcard/")
        || dir == "/sdcard"
        || dir.starts_with("/storage/emulated/0")
        || dir.starts_with("/data/local/tmp"))
        && !dir.contains("..")
        && dir.len() <= 256
}

/// `wm size` 输出解析(有 Override 行时优先——它才是当前真实分辨率)。
fn parse_wm_size(output: &str) -> Option<(i64, i64)> {
    let mut physical: Option<(i64, i64)> = None;
    for line in output.lines() {
        let Some((_, size)) = line.split_once(':') else { continue };
        let size = size.trim();
        let Some((w, h)) = size.split_once('x') else { continue };
        let Ok(w) = w.parse::<i64>() else { continue };
        let Ok(h) = h.parse::<i64>() else { continue };
        if line.contains("Override") {
            return Some((w, h));
        }
        physical = physical.or(Some((w, h)));
    }
    physical
}

/// shell 单引号转义(与 desktop 模块同规则)。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `input text` 转义:% 是 input 的格式符(%% 字面量、%s 空格),
/// 先转 input 层再 sh_quote 防 toybox sh 展开。
fn escape_input_text(text: &str) -> String {
    text.replace('%', "%%").replace(' ', "%s")
}

/// 是否纯 ASCII 可打印(input text 只认 ASCII;非 ASCII 走 ADBKeyBoard)。
fn is_ascii_input(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| (0x20..=0x7e).contains(&(c as u32)))
}

/// 键名白名单:AI 友好名 → KEYCODE_*;单字母/数字直映射;拒绝组合键。
fn map_keycode(key: &str) -> Result<String, String> {
    let lower = key.trim().to_ascii_lowercase();
    if lower.contains('+') {
        return Err(format!(
            "Android 不支持组合键: {key:?}(请拆成多次 android_press_key)"
        ));
    }
    let code = match lower.as_str() {
        "enter" | "return" => "KEYCODE_ENTER",
        "back" | "esc" | "escape" => "KEYCODE_BACK",
        "home" => "KEYCODE_HOME",
        "recents" | "recent" | "overview" | "app_switch" => "KEYCODE_APP_SWITCH",
        "backspace" | "delete" => "KEYCODE_DEL",
        "forwarddelete" | "forward_del" => "KEYCODE_FORWARD_DEL",
        "tab" => "KEYCODE_TAB",
        "space" | "空格" => "KEYCODE_SPACE",
        "up" | "arrowup" => "KEYCODE_DPAD_UP",
        "down" | "arrowdown" => "KEYCODE_DPAD_DOWN",
        "left" | "arrowleft" => "KEYCODE_DPAD_LEFT",
        "right" | "arrowright" => "KEYCODE_DPAD_RIGHT",
        "center" | "ok" => "KEYCODE_DPAD_CENTER",
        "pageup" => "KEYCODE_PAGE_UP",
        "pagedown" => "KEYCODE_PAGE_DOWN",
        "movehome" => "KEYCODE_MOVE_HOME",
        "moveend" => "KEYCODE_MOVE_END",
        "volumeup" => "KEYCODE_VOLUME_UP",
        "volumedown" => "KEYCODE_VOLUME_DOWN",
        "volumemute" | "mute" => "KEYCODE_VOLUME_MUTE",
        "power" => "KEYCODE_POWER",
        "wake" | "wakeup" => "KEYCODE_WAKEUP",
        "sleep" => "KEYCODE_SLEEP",
        "search" => "KEYCODE_SEARCH",
        "menu" => "KEYCODE_MENU",
        "camera" => "KEYCODE_CAMERA",
        other if other.len() == 1 && other.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) => {
            return Ok(format!("KEYCODE_{}", other.to_ascii_uppercase()));
        }
        other if other.len() == 1 && other.chars().next().is_some_and(|c| c.is_ascii_digit()) => {
            return Ok(format!("KEYCODE_{other}"));
        }
        other => {
            return Err(format!(
                "不支持的键名: {other:?}(back/home/recents/enter/tab/space/delete/方向键/音量/power 等)"
            ))
        }
    };
    Ok(code.to_string())
}

/// scroll 方向+像素量 → swipe 起止(以 (x,y) 为中心;方向指内容滚动方向,
/// 手指反向滑动)。端点裁剪进屏幕边界。
fn scroll_swipe(
    x: i64,
    y: i64,
    direction: &str,
    amount: i64,
    resolution: (i64, i64),
) -> Result<(i64, i64, i64, i64), String> {
    let half = (amount.max(60)) / 2;
    let (w, h) = resolution;
    let clamp = |v: i64, max: i64| v.clamp(0, (max - 1).max(0));
    let (dx, dy) = match direction {
        // 内容向下滚(看下方内容)= 手指上滑
        "down" => (0, -half),
        "up" => (0, half),
        "left" => (half, 0),
        "right" => (-half, 0),
        other => return Err(format!("不支持的滚动方向: {other:?}(up/down/left/right)")),
    };
    Ok((
        clamp(x - dx, w),
        clamp(y - dy, h),
        clamp(x + dx, w),
        clamp(y + dy, h),
    ))
}

/// PNG 完整性保障:旧版 adb(<1.0.41)Windows 上 exec-out 把每个 \n 改写为
/// \r\n(原有 \r\n 变 \r\r\n),PNG 流损坏。先验 8 字节完整 magic(自身即含
/// \r\n\x1a\n,恰好是探针),损坏则按「k 个 \r + \n → k-1 个 \r + \n」修复
/// (逆向 \n→\r\n 变换)重验;仍失败报升级指引(踩坑记录)。
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
// 截图与回放
// ============================================================

/// exec-out screencap → PNG 字节(含 CRLF 修复)。
async fn capture_png(
    manager: &AndroidManager,
    adb: &str,
    serial: &str,
) -> Result<Vec<u8>, String> {
    let (stdout, stderr, code) = adb_raw(
        manager,
        adb,
        Some(serial),
        &["exec-out".to_string(), "screencap".to_string(), "-p".to_string()],
        30,
    )
    .await?;
    if code != 0 {
        return Err(format!("设备截图失败(exit {code}): {}", stderr.trim()));
    }
    ensure_png(stdout)
}

/// 截图落应用缓存目录 android-shots/,返回文件路径 + 截图真实物理分辨率
/// (PNG IHDR 直读,任意机型/横竖屏都准确);有直播会话时同步最新帧。
async fn capture_screenshot(
    app: &tauri::AppHandle,
    manager: &AndroidManager,
    adb: &str,
    serial: &str,
) -> Result<(String, (i64, i64)), String> {
    let bytes = capture_png(manager, adb, serial).await?;
    let dims = png_dimensions(&bytes)
        .ok_or_else(|| "截图 PNG 头解析失败(无法确定物理分辨率)".to_string())?;
    if let Ok(mut live) = manager.live.lock() {
        if let Some(session) = live.get_mut(serial) {
            session.frame = Some((bytes.clone(), std::time::Instant::now()));
        }
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用: {e}"))?
        .join("android-shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    let short: String = serial.chars().take(8).collect();
    let path = dir.join(format!(
        "{short}-{}.png",
        chrono::Local::now().format("%Y%m%d-%H%M%S-%3f")
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
    Ok((path.display().to_string(), dims))
}

/// 写操作前的自动截屏留档(回放帧);失败只记日志不阻断操作。
async fn record_frame(
    app: &tauri::AppHandle,
    manager: &AndroidManager,
    adb: &str,
    serial: &str,
    session_id: &str,
    action: &str,
) {
    let shot = capture_screenshot(app, manager, adb, serial)
        .await
        .map(|(path, _dims)| path);
    if let Ok(pool) = crate::db::get_pool() {
        let (action_text, shot_path) = match &shot {
            Ok(path) => (action.to_string(), Some(path.clone())),
            Err(error) => {
                tracing::warn!("Android 回放帧截图失败({serial}): {error}");
                (format!("{action}(截屏失败)"), None)
            }
        };
        if let Err(e) = sqlx::query(
            "INSERT INTO android_replay_frames (serial, session_id, action, shot_path) VALUES (?, ?, ?, ?)",
        )
        .bind(serial)
        .bind(session_id)
        .bind(action_text)
        .bind(shot_path)
        .execute(pool)
        .await
        {
            tracing::warn!("Android 回放帧落库失败: {e}");
        }
    }
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
        &format!("stat -c %s {} 2>/dev/null || echo 0", sh_quote(SCRCPY_DEVICE_PATH)),
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
        sh_quote(SCRCPY_DEVICE_PATH),
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
                    if let Ok(code) = map_keycode(&key) {
                        let _ = adb_shell(&manager, &adb, &serial, &format!("input keyevent {code}"), 10).await;
                    }
                }
                LiveAction::Type(text) => {
                    let _ = type_text(&manager, &adb, &serial, &text).await;
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
            match capture_png(&manager, &adb, &serial).await {
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
    if segments.len() != 2 || !valid_serial(segments[0]) {
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
// 工具执行(桥入口)
// ============================================================

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

fn arg_num(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("缺少坐标参数 {key}"))
}

async fn guard_takeover(manager: &AndroidManager, serial: &str) -> Result<(), String> {
    if manager.is_takeover(serial) {
        return Err("用户正在直播窗口中接管设备操作,请稍后重试(接管不撤销授权)".to_string());
    }
    Ok(())
}

/// 执行上下文:adb 路径 + 授权设备。
struct DeviceCtx {
    adb: String,
    authz: Authz,
}

async fn device_ctx(
    manager: &AndroidManager,
    session_id: &str,
    args: &Value,
) -> Result<DeviceCtx, String> {
    let serial_arg = args.get("serial").and_then(Value::as_str);
    if let Some(serial) = serial_arg {
        if !serial.is_empty() && !valid_serial(serial) {
            return Err(format!("设备 serial 非法: {serial:?}"));
        }
    }
    let authz = manager.require_authz(session_id, serial_arg).await?;
    let adb = resolve_adb(manager).await?;
    Ok(DeviceCtx { adb, authz })
}

/// 输入文本:ASCII 走 input text;非 ASCII 走 ADBKeyBoard 广播,
/// 未装时返回安装引导(§7.2)。
async fn type_text(
    manager: &AndroidManager,
    adb: &str,
    serial: &str,
    text: &str,
) -> Result<String, String> {
    if is_ascii_input(text) {
        adb_shell(
            manager,
            adb,
            serial,
            &format!("input text {}", sh_quote(&escape_input_text(text))),
            30,
        )
        .await?;
        return Ok(format!("已输入 {} 字符", text.chars().count()));
    }
    let pm = adb_shell(manager, adb, serial, "pm path com.android.adbkeyboard", 15)
        .await
        .unwrap_or_default();
    if !pm.contains("package:") {
        return Err(
            "输入含非 ASCII 字符(如中文),需要设备已安装 ADBKeyBoard:\n\
             1. 下载 https://github.com/senzhk/ADBKeyBoard 的 APK;\n\
             2. 用 android_exec 执行 adb install(会请求用户确认);\n\
             3. 在设备 设置 → 系统 → 语言与输入法 → 虚拟键盘 中启用 ADBKeyBoard(用户操作)。"
                .to_string(),
        );
    }
    adb_shell(
        manager,
        adb,
        serial,
        &format!("am broadcast -a ADB_INPUT_TEXT --es msg {}", sh_quote(text)),
        30,
    )
    .await?;
    Ok(format!("已经 ADBKeyBoard 广播输入 {} 字符", text.chars().count()))
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
    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::External(parsed),
    )
    .title(format!("Android 直播 {short}"))
    .inner_size(420.0, 860.0)
    .center()
    .build()
    .map_err(|e| format!("创建直播窗口失败:{e}"))?;
    let manager_clone = manager.clone();
    let serial_for_hook = serial.to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            manager_clone.stop_live(&serial_for_hook);
        }
    });
    Ok(())
}

/// UI 命令用(工具面板「Android」子类):adb 设备列表。只读,不需要授权。
pub(crate) async fn ui_list_devices(manager: &AndroidManager) -> Result<Vec<AdbDevice>, String> {
    let adb = resolve_adb(manager).await?;
    let (stdout, _, _) = adb_raw(
        manager,
        &adb,
        None,
        &["devices".to_string(), "-l".to_string()],
        15,
    )
    .await?;
    Ok(parse_devices(&String::from_utf8_lossy(&stdout)))
}

/// UI 命令用:打开设备直播窗口(用户在面板上点击 = 审批表达,围观/接管)。
/// 分辨率现场探测(wm size),不依赖 AI 授权缓存——面板路径没有授权条目。
pub(crate) async fn ui_open_live(
    app: &tauri::AppHandle,
    manager: &AndroidManager,
    serial: &str,
) -> Result<(), String> {
    if !valid_serial(serial) {
        return Err(format!("设备 serial 非法: {serial:?}"));
    }
    let adb = resolve_adb(manager).await?;
    let out = adb_shell(manager, &adb, serial, "wm size", 15).await?;
    let resolution =
        parse_wm_size(&out).ok_or_else(|| format!("分辨率探测失败(wm size 输出异常): {out}"))?;
    open_live_window(app, manager, serial, resolution)
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
    let pool = crate::db::get_pool()?;

    match name {
        "android_list_devices" => {
            let adb = resolve_adb(&manager).await?;
            let (stdout, _, _) = adb_raw(
                &manager,
                &adb,
                None,
                &["devices".to_string(), "-l".to_string()],
                15,
            )
            .await?;
            let devices = parse_devices(&String::from_utf8_lossy(&stdout));
            if devices.is_empty() {
                return Ok("未发现设备。请确认:手机已开 开发者模式 → USB 调试,并用数据线连接(或已配置无线调试)。".to_string());
            }
            let mut lines = vec!["serial | 状态 | 型号".to_string()];
            for device in &devices {
                let note = match device.state.as_str() {
                    "unauthorized" => "(请在手机上点「允许 USB 调试」)",
                    "offline" => "(离线:拔插数据线重试)",
                    _ => "",
                };
                lines.push(format!(
                    "{} | {} | {}{}",
                    device.serial, device.state, device.model, note
                ));
            }
            Ok(format!(
                "{}\nandroid_connect 用 serial 绑定设备;仅一台且状态为 device 时 serial 可省略。",
                lines.join("\n")
            ))
        }
        "android_connect" => {
            let adb = resolve_adb(&manager).await?;
            let serial_arg = args.get("serial").and_then(Value::as_str).unwrap_or("");
            if !serial_arg.is_empty() && !valid_serial(serial_arg) {
                return Err(format!("设备 serial 非法: {serial_arg:?}"));
            }
            let (stdout, _, _) = adb_raw(
                &manager,
                &adb,
                None,
                &["devices".to_string(), "-l".to_string()],
                15,
            )
            .await?;
            let devices = parse_devices(&String::from_utf8_lossy(&stdout));
            let ready: Vec<&AdbDevice> =
                devices.iter().filter(|d| d.state == "device").collect();
            let serial = if !serial_arg.is_empty() {
                let device = devices
                    .iter()
                    .find(|d| d.serial == serial_arg)
                    .ok_or_else(|| format!("设备 {serial_arg} 不在 adb 设备列表中"))?;
                if device.state != "device" {
                    return Err(format!(
                        "设备 {serial_arg} 状态为 {}(需要 device;unauthorized 请在手机上点「允许 USB 调试」)",
                        device.state
                    ));
                }
                device.serial.clone()
            } else if ready.len() == 1 {
                ready[0].serial.clone()
            } else if ready.is_empty() {
                return Err("没有就绪(状态 device)的设备:请检查 USB 调试授权后用 android_list_devices 复核".to_string());
            } else {
                return Err(format!(
                    "发现 {} 台就绪设备,请显式指定 serial:{}",
                    ready.len(),
                    ready.iter().map(|d| format!("\n- {}", d.serial)).collect::<String>()
                ));
            };

            // 探测型号 / Android 版本 / 分辨率(一次 shell 减少往返)
            let probe = adb_shell(
                &manager,
                &adb,
                &serial,
                "getprop ro.product.model; getprop ro.build.version.release; wm size",
                20,
            )
            .await?;
            let mut lines = probe.lines();
            let model = lines.next().unwrap_or("").trim().to_string();
            let version = lines.next().unwrap_or("").trim().to_string();
            let resolution = parse_wm_size(&probe)
                .ok_or_else(|| format!("分辨率探测失败(wm size 输出异常): {probe}"))?;

            manager.grant(session_id, &serial, resolution).await;
            let task = args.get("task").and_then(Value::as_str).unwrap_or("");
            Ok(format!(
                "已连接设备(任务授权 {ttl} 分钟内有效):\n\
                 serial:{serial}\n型号:{model} | Android {version} | 分辨率:{}x{}\n\
                 任务:{task}\n\
                 接下来用 android_screenshot 看屏幕,android_tap/android_swipe/android_type 等操作;\
                 android_open_live 可为用户打开直播窗口(围观/接管)。",
                resolution.0,
                resolution.1,
                ttl = AUTHZ_TTL_SECS / 60,
            ))
        }
        "android_disconnect" => {
            manager.revoke(session_id).await;
            Ok("已撤销本会话的设备授权(不改动设备本身;直播窗口如开着会继续播放)".to_string())
        }
        "android_wireless" => {
            let host = arg_str(args, "host")?;
            if !valid_host(host) {
                return Err(format!("主机地址非法: {host:?}(应为 IP 或主机名)"));
            }
            let adb = resolve_adb(&manager).await?;
            let mut outputs: Vec<String> = Vec::new();
            let pair_port = args.get("pairPort").and_then(Value::as_i64);
            let connect_port = args.get("connectPort").and_then(Value::as_i64);
            if let Some(port) = pair_port {
                let code = arg_str(args, "code")?;
                if !(100000..=999999).contains(&code.parse::<i64>().unwrap_or(0)) {
                    return Err("配对码应为手机「无线调试 → 使用配对码配对」页显示的 6 位数字".to_string());
                }
                let (stdout, stderr, exit) = adb_raw(
                    &manager,
                    &adb,
                    None,
                    &[
                        "pair".to_string(),
                        format!("{host}:{port}"),
                        code.to_string(),
                    ],
                    30,
                )
                .await?;
                let text = format!("{}{}", String::from_utf8_lossy(&stdout), stderr);
                outputs.push(format!(
                    "pair {host}:{port} → {}{}",
                    if exit == 0 { "成功" } else { "失败" },
                    if text.trim().is_empty() { String::new() } else { format!("({})", text.trim()) }
                ));
            }
            if let Some(port) = connect_port {
                let (stdout, stderr, _) = adb_raw(
                    &manager,
                    &adb,
                    None,
                    &["connect".to_string(), format!("{host}:{port}")],
                    30,
                )
                .await?;
                let text = format!("{}{}", String::from_utf8_lossy(&stdout), stderr);
                outputs.push(format!("connect {host}:{port} → {}", text.trim()));
            }
            if outputs.is_empty() {
                return Err("android_wireless 需要 pairPort+code(配对)或 connectPort(连接)至少一组;手机「无线调试」主页的端口是 connectPort,配对页的是 pairPort+配对码".to_string());
            }
            Ok(format!(
                "{}\n完成后用 android_list_devices 确认设备出现(serial 形如 {host}:端口),再 android_connect。",
                outputs.join("\n")
            ))
        }
        "android_device_status" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let out = adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                "getprop ro.product.model; getprop ro.build.version.release; wm size; dumpsys window | grep -m 1 mCurrentFocus; dumpsys battery | grep -m 1 'level'",
                25,
            )
            .await?;
            Ok(format!("设备 {} 状态:\n{}", ctx.authz.serial, out.trim()))
        }
        "android_replay" => {
            let serial = match args.get("serial").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {
                    if !valid_serial(s) {
                        return Err(format!("设备 serial 非法: {s:?}"));
                    }
                    s.to_string()
                }
                _ => manager.require_authz(session_id, None).await?.serial,
            };
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(50)
                .clamp(1, 500);
            let rows = sqlx::query(
                "SELECT action, shot_path, created_at FROM android_replay_frames WHERE serial = ? ORDER BY id LIMIT ?",
            )
            .bind(&serial)
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("读取回放帧失败: {e}"))?;
            if rows.is_empty() {
                return Ok(format!("设备 {serial} 没有回放帧"));
            }
            let mut lines = vec![format!("设备 {serial} 回放(帧 | 时间 | 截图):")];
            for (index, row) in rows.iter().enumerate() {
                let action: String = row.try_get("action").map_err(|e| e.to_string())?;
                let shot: Option<String> = row.try_get("shot_path").map_err(|e| e.to_string())?;
                let ts: i64 = row.try_get("created_at").map_err(|e| e.to_string())?;
                let time = chrono::DateTime::from_timestamp(ts, 0)
                    .map(|t| t.format("%H:%M:%S").to_string())
                    .unwrap_or_default();
                lines.push(format!(
                    "#{} {} | {} | {}",
                    index + 1,
                    action,
                    time,
                    shot.unwrap_or_else(|| "(无截图)".to_string())
                ));
            }
            Ok(lines.join("\n"))
        }
        "android_screenshot" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let (path, (w, h)) =
                capture_screenshot(&app, &manager, &ctx.adb, &ctx.authz.serial).await?;
            Ok(format!(
                "已截取设备屏幕(PNG,物理像素 {w}x{h}),保存于:{path}\n\
                 调用 read_image 读取该文件即可看到画面。\n\
                 坐标约定(覆盖任意机型,以本条分辨率为准):android_tap/android_double_tap/\
                 android_swipe/android_scroll 的坐标 = 本截图原始文件的像素(设备物理像素 \
                 {w}x{h})。read_image 展示给你的图可能被缩小——其结果会注明 \
                 \"downscaled from {w}x{h} … multiply coordinates by k\",此时把你在显示图上\
                 量到的坐标乘以 k 再传入;未注明缩放时直接用图上坐标。"
            ))
        }
        "android_current_app" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let out = adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                "dumpsys window | grep -m 1 mCurrentFocus; wm size",
                20,
            )
            .await?;
            Ok(format!(
                "当前前台(设备 {}):\n{}",
                ctx.authz.serial,
                out.trim()
            ))
        }
        "android_tap" | "android_double_tap" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let (x, y) = (arg_num(args, "x")?, arg_num(args, "y")?);
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("tap({x},{y})"),
            )
            .await;
            let script = if name == "android_double_tap" {
                format!("input tap {x} {y}; sleep 0.12; input tap {x} {y}")
            } else {
                format!("input tap {x} {y}")
            };
            adb_shell(&manager, &ctx.adb, &ctx.authz.serial, &script, 15).await?;
            Ok(format!(
                "已在 ({x},{y}) {}击",
                if name == "android_double_tap" { "双" } else { "单" }
            ))
        }
        "android_swipe" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let (x1, y1, x2, y2) = (
                arg_num(args, "fromX")?,
                arg_num(args, "fromY")?,
                arg_num(args, "toX")?,
                arg_num(args, "toY")?,
            );
            let ms = args
                .get("durationMs")
                .and_then(Value::as_i64)
                .unwrap_or(300)
                .clamp(50, 5000);
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("swipe({x1},{y1}→{x2},{y2})"),
            )
            .await;
            adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                &format!("input swipe {x1} {y1} {x2} {y2} {ms}"),
                20,
            )
            .await?;
            Ok(format!("已滑动 ({x1},{y1}) → ({x2},{y2})({ms}ms)"))
        }
        "android_scroll" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let (w, h) = ctx.authz.resolution;
            let x = args.get("x").and_then(Value::as_i64).unwrap_or(w / 2);
            let y = args.get("y").and_then(Value::as_i64).unwrap_or(h / 2);
            let direction = args
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("down");
            let amount = args
                .get("amount")
                .and_then(Value::as_i64)
                .unwrap_or(600);
            let (x1, y1, x2, y2) = scroll_swipe(x, y, direction, amount, (w, h))?;
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("scroll({direction},{amount})"),
            )
            .await;
            adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                &format!("input swipe {x1} {y1} {x2} {y2} 250"),
                20,
            )
            .await?;
            Ok(format!("已在 ({x},{y}) 向 {direction} 滚动 {amount} 像素"))
        }
        "android_type" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let text = arg_str(args, "text")?;
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("type({} 字符)", text.chars().count()),
            )
            .await;
            type_text(&manager, &ctx.adb, &ctx.authz.serial, text).await
        }
        "android_press_key" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let code = map_keycode(arg_str(args, "key")?)?;
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("press_key({code})"),
            )
            .await;
            adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                &format!("input keyevent {code}"),
                15,
            )
            .await?;
            Ok(format!("已按键 {code}"))
        }
        "android_launch_app" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let package = arg_str(args, "package")?;
            if !valid_package(package) {
                return Err(format!("包名非法: {package:?}"));
            }
            record_frame(
                &app,
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                session_id,
                &format!("launch_app({package})"),
            )
            .await;
            let out = adb_shell(
                &manager,
                &ctx.adb,
                &ctx.authz.serial,
                &format!("monkey -p {} -c android.intent.category.LAUNCHER 1", sh_quote(package)),
                25,
            )
            .await?;
            if out.contains("No activities found") {
                return Err(format!("包 {package} 没有可启动的 Activity(未安装?)"));
            }
            Ok(format!("已启动 {package}(用 android_screenshot 确认界面)"))
        }
        "android_open_live" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let serial = ctx.authz.serial.clone();
            open_live_window(&app, &manager, &serial, ctx.authz.resolution)?;
            Ok(format!(
                "直播窗口已打开(设备 {serial})。scrcpy 通道就绪后自动切换 H.264 实时画面,否则截图轮询兜底;窗口内勾选「接管」后用户可亲手操作,期间你的写操作会被拒绝。"
            ))
        }
        "android_pull" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let remote = arg_str(args, "remotePath")?;
            if !remote.starts_with('/') || remote.contains("..") || remote.len() > 512 {
                return Err(format!("远端路径非法: {remote:?}(须为设备绝对路径,不含 ..)"));
            }
            let local_dir = arg_str(args, "localDir")?;
            let local = std::path::Path::new(local_dir);
            if !local.is_dir() {
                return Err(format!("本机目录不存在: {local_dir}"));
            }
            let (stdout, stderr, code) = adb_raw(
                &manager,
                &ctx.adb,
                Some(&ctx.authz.serial),
                &[
                    "pull".to_string(),
                    remote.to_string(),
                    local_dir.to_string(),
                ],
                300,
            )
            .await?;
            let text = format!("{}{}", String::from_utf8_lossy(&stdout), stderr);
            if code != 0 {
                return Err(format!("adb pull 失败: {}", text.trim()));
            }
            Ok(format!("已拉取 {remote} → {local_dir}\n{}", text.trim()))
        }
        "android_push" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            let remote_dir = arg_str(args, "remoteDir")?;
            if !valid_push_dir(remote_dir) {
                return Err(format!(
                    "远端目录非法: {remote_dir:?}(只允许 /sdcard、/storage/emulated/0、/data/local/tmp 之下)"
                ));
            }
            let paths = args
                .get("localPaths")
                .and_then(Value::as_array)
                .ok_or_else(|| "缺少参数 localPaths".to_string())?;
            if paths.is_empty() || paths.len() > 20 {
                return Err("localPaths 需为 1-20 个本机文件路径".to_string());
            }
            let mut results: Vec<String> = Vec::new();
            for path in paths {
                let Some(local) = path.as_str() else {
                    return Err("localPaths 元素必须是字符串".to_string());
                };
                if !std::path::Path::new(local).is_file() {
                    return Err(format!("本机文件不存在: {local}"));
                }
                let (stdout, stderr, code) = adb_raw(
                    &manager,
                    &ctx.adb,
                    Some(&ctx.authz.serial),
                    &[
                        "push".to_string(),
                        local.to_string(),
                        remote_dir.to_string(),
                    ],
                    300,
                )
                .await?;
                let text = format!("{}{}", String::from_utf8_lossy(&stdout), stderr);
                if code != 0 {
                    return Err(format!("推送 {local} 失败: {}", text.trim()));
                }
                results.push(format!("{local} → {}", text.trim()));
            }
            Ok(format!("已推送 {} 个文件到 {remote_dir}:\n{}", results.len(), results.join("\n")))
        }
        "android_exec" => {
            let ctx = device_ctx(&manager, session_id, args).await?;
            guard_takeover(&manager, &ctx.authz.serial).await?;
            let command = arg_str(args, "command")?;
            let timeout = args
                .get("timeoutSec")
                .and_then(Value::as_i64)
                .unwrap_or(60)
                .clamp(1, 600) as u64;
            let (stdout, stderr, code) = adb_raw(
                &manager,
                &ctx.adb,
                Some(&ctx.authz.serial),
                &["shell".to_string(), command.to_string()],
                timeout,
            )
            .await?;
            let out_text = String::from_utf8_lossy(&stdout).to_string();
            Ok([
                out_text.trim_end().to_string(),
                if stderr.trim().is_empty() {
                    String::new()
                } else {
                    format!("[stderr]\n{}", stderr.trim())
                },
                if code > 0 {
                    format!("[exit {code}]")
                } else {
                    String::new()
                },
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
        }
        other => Err(format!("Unknown android tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_devices_handles_models_and_states() {
        let out = "List of devices attached\n\
                   emulator-5554\tdevice product:sdk model:Pixel_7 device:panther\n\
                   9b241faz\tunauthorized\n\
                   \n\
                   * daemon started successfully\n";
        let devices = parse_devices(out);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "emulator-5554");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model, "Pixel_7");
        assert_eq!(devices[1].state, "unauthorized");
        assert_eq!(devices[1].model, "");
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn whitelists() {
        assert!(valid_serial("emulator-5554"));
        assert!(valid_serial("192.168.1.5:43217"));
        assert!(!valid_serial(""));
        assert!(!valid_serial("a b"));
        assert!(!valid_serial("$(reboot)"));
        assert!(valid_package("com.tencent.mm"));
        assert!(!valid_package("noDot"));
        assert!(!valid_package("com.evil;rm"));
        assert!(valid_host("192.168.1.5"));
        assert!(!valid_host("$(x)"));
        assert!(valid_push_dir("/sdcard/Download"));
        assert!(valid_push_dir("/data/local/tmp"));
        assert!(!valid_push_dir("/data/data/com.tencent.mm"));
        assert!(!valid_push_dir("/sdcard/../system"));
    }

    #[test]
    fn wm_size_prefers_override() {
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400"),
            Some((1080, 2400))
        );
        assert_eq!(
            parse_wm_size("Physical size: 1080x2400\nOverride size: 900x2000"),
            Some((900, 2000))
        );
        assert_eq!(parse_wm_size("garbage"), None);
    }

    #[test]
    fn input_text_escaping() {
        assert_eq!(escape_input_text("hello world"), "hello%sworld");
        assert_eq!(escape_input_text("100%"), "100%%");
        assert!(is_ascii_input("plain ASCII 123!"));
        assert!(!is_ascii_input("中文"));
        assert!(!is_ascii_input(""));
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn keycode_mapping() {
        assert_eq!(map_keycode("back").unwrap(), "KEYCODE_BACK");
        assert_eq!(map_keycode("Enter").unwrap(), "KEYCODE_ENTER");
        assert_eq!(map_keycode("ArrowUp").unwrap(), "KEYCODE_DPAD_UP");
        assert_eq!(map_keycode("a").unwrap(), "KEYCODE_A");
        assert_eq!(map_keycode("5").unwrap(), "KEYCODE_5");
        assert_eq!(map_keycode("recents").unwrap(), "KEYCODE_APP_SWITCH");
        assert!(map_keycode("ctrl+s").is_err());
        assert!(map_keycode("$(reboot)").is_err());
        assert!(map_keycode("F5").is_err());
    }

    #[test]
    fn scroll_maps_to_swipe_and_clamps() {
        // down(看下方内容)= 手指上滑:起点在下,终点在上
        let (x1, y1, x2, y2) = scroll_swipe(500, 1000, "down", 600, (1080, 2400)).unwrap();
        assert_eq!((x1, y1, x2, y2), (500, 1300, 500, 700));
        let (x1, y1, x2, y2) = scroll_swipe(500, 1000, "up", 600, (1080, 2400)).unwrap();
        assert_eq!((x1, y1, x2, y2), (500, 700, 500, 1300));
        // 边界裁剪:贴左缘左滚不出屏
        let (x1, _, x2, _) = scroll_swipe(10, 1000, "left", 600, (1080, 2400)).unwrap();
        assert!(x1 >= 0 && x2 < 1080);
        assert!(scroll_swipe(0, 0, "diagonal", 100, (1080, 2400)).is_err());
    }

    #[test]
    fn png_dimensions_reads_ihdr() {
        // 1200x2670(小米一类 20:9 机型)与 1080x2400 都必须直读 IHDR
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&13u32.to_be_bytes()); // IHDR 数据长度
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&1200u32.to_be_bytes());
        png.extend_from_slice(&2670u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((1200, 2670)));
        png.truncate(16);
        png.extend_from_slice(&1080u32.to_be_bytes());
        png.extend_from_slice(&2400u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((1080, 2400)));
        // 横屏(旋转后 w > h)同样直读
        png.truncate(16);
        png.extend_from_slice(&2670u32.to_be_bytes());
        png.extend_from_slice(&1200u32.to_be_bytes());
        assert_eq!(png_dimensions(&png), Some((2670, 1200)));

        assert_eq!(png_dimensions(b"NOTPNG"), None);
        assert_eq!(png_dimensions(&png[..20]), None);
    }

    #[test]
    fn ensure_png_accepts_repairs_rejects() {
        // 完整 8 字节 magic 含合法 \r\n——修复不得破坏它
        let good = b"\x89PNG\r\n\x1a\nIHDR-body\n".to_vec();
        assert_eq!(ensure_png(good.clone()).unwrap(), good);

        // CRLF 损坏:每个 \n → \r\n(原有 \r\n 变 \r\r\n)
        let broken = b"\x89PNG\r\r\n\x1a\r\nIHDR-body\r\n".to_vec();
        let repaired = ensure_png(broken).unwrap();
        assert_eq!(repaired, good);

        assert!(ensure_png(b"NOTPNG".to_vec()).is_err());
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
}
