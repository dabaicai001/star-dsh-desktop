//! Android 帧源:scrcpy H.264 + 截图轮询兜底 + 接管输入。
//!
//! 从 `src-tauri/src/android/mod.rs` 的直播窗口面平移(零改动级):
//! - **scrcpy 模式**:bundled scrcpy-server v2.7 推送到设备 → `app_process`
//!   启动 → H.264 经 `adb forward` 回本机 → 帧元头解析进帧枢纽;
//! - **轮询模式(兜底)**:pump 周期 `exec-out screencap`,scrcpy 就绪即跳过;
//! - **接管输入**:面板手势 → 通道 mpsc → pump 顺序 `adb shell input`;
//! - **失败降级**:任一步失败把原因写进通道元数据 `error`,面板据此展示,
//!   直播保持轮询模式(与 Tauri 的 meta 端点同语义)。
//!
//! 与 Tauri 版的差异只有两处,都是「窗口面 → 帧出口」的必然:
//! 1. 帧不再进 `LiveSession.frame` 单槽,而是 `channel.push_frame`(广播 + 环);
//! 2. 会话存活性不再查 `live` 注册表,而是查帧枢纽是否还持有该通道
//!    (最后一个订阅者离开即关闭,等价关窗口)。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use starhub_domain_android::adb::Adb;
use starhub_domain_android::keys::{
    escape_input_text, is_ascii_input, map_keycode, sh_quote, valid_serial,
};
use starhub_domain_android::manager::AndroidManager;
use starhub_domain_android::{resolve_adb, SettingsStore};
use tokio::io::AsyncReadExt;
use tokio::process::Child;

use crate::frames::{FLAG_CONFIG, FLAG_KEYFRAME, MSG_H264};
use crate::hub::{Channel, ChannelMeta, FrameHub, Gesture, LiveInput, KIND_ANDROID};

/// scrcpy-server 版本(server 校验首个参数必须等于自身版本号)。
pub const SCRCPY_SERVER_VERSION: &str = "2.7";
/// 设备端 scrcpy-server 投放路径。
pub const SCRCPY_DEVICE_PATH: &str = "/data/local/tmp/starhub/scrcpy-server";
/// 直播 pump 两帧之间的间隔(轮询模式;截图自身耗时 300-500ms)。
pub const LIVE_PUMP_INTERVAL: std::time::Duration = std::time::Duration::from_millis(400);
/// 环境变量:scrcpy-server 本地路径(M4 provisioning 落盘后由 bridge 注入)。
pub const SCRCPY_SERVER_ENV_KEY: &str = "STARHUB_SCRCPY_SERVER";

/// Android 帧源(与 sidecar 的 Android 域运行时共用 adb / 设置 / 管理器)。
///
/// 可 Clone(全是 Arc + 一个路径):帧枢纽与 `LiveLauncher` seam 各持一份,
/// 指向同一个 hub 与同一套 adb 注入点。
#[derive(Clone)]
pub struct AndroidLiveSource {
    hub: Arc<FrameHub>,
    adb: Arc<dyn Adb>,
    settings: Arc<dyn SettingsStore>,
    manager: Arc<AndroidManager>,
    scrcpy_server: Option<PathBuf>,
}

impl AndroidLiveSource {
    pub fn new(
        hub: Arc<FrameHub>,
        adb: Arc<dyn Adb>,
        settings: Arc<dyn SettingsStore>,
        manager: Arc<AndroidManager>,
    ) -> Self {
        Self {
            hub,
            adb,
            settings,
            manager,
            scrcpy_server: resolve_scrcpy_server(),
        }
    }

    /// 通道 id(`android:<serial>`)。
    pub fn channel_id(serial: &str) -> String {
        format!("{KIND_ANDROID}:{serial}")
    }

    /// 打开一台设备的直播通道(幂等):注册通道 + 起轮询泵 + 后台尝试 scrcpy。
    ///
    /// `resolution` 是 connect 时探测的设备物理分辨率(坐标映射缺省值;
    /// 首帧 PNG 到手后按 IHDR 真值纠正)。
    pub async fn open(&self, serial: &str, resolution: (i64, i64)) -> Result<Arc<Channel>, String> {
        if !valid_serial(serial) {
            return Err(format!("设备 serial 非法: {serial:?}"));
        }
        let channel_id = Self::channel_id(serial);
        let channel = self.hub.open(
            &channel_id,
            KIND_ANDROID,
            ChannelMeta {
                mode: "frames".to_string(),
                width: resolution.0,
                height: resolution.1,
                vw: None,
                vh: None,
                error: None,
            },
        )?;
        let Some(input_rx) = channel.take_input_rx() else {
            // 已有源在跑(重复 open):直接返回既有通道
            return Ok(channel);
        };

        let session = Arc::new(ScrcpySession::new());
        let hub = self.hub.clone();
        let channel_for_pump = channel_id.clone();
        let serial_owned = serial.to_string();
        let ctx = AdbContext {
            adb: self.adb.clone(),
            settings: self.settings.clone(),
            manager: self.manager.clone(),
        };
        let pump_session = session.clone();
        let pump_ctx = ctx.clone();
        tokio::spawn(async move {
            live_pump(
                hub,
                channel_for_pump,
                serial_owned,
                pump_ctx,
                pump_session,
                input_rx,
            )
            .await;
        });

        if let Some(server) = self.scrcpy_server.clone() {
            let hub = self.hub.clone();
            let channel_id = channel_id.clone();
            let serial_owned = serial.to_string();
            let scrcpy_session = session.clone();
            tokio::spawn(async move {
                scrcpy_run(hub, channel_id, serial_owned, server, ctx, scrcpy_session).await;
            });
        } else {
            // 没有 server 二进制:明确告知降级原因(面板展示,直播走轮询)
            channel.patch_meta(|meta| {
                meta.error =
                    Some("scrcpy-server 资源缺失,直播为截图轮询模式(画质/帧率较低)".to_string());
            });
        }
        Ok(channel)
    }
}

/// scrcpy-server 本地路径:环境变量 → 可执行文件同级的 `resources/scrcpy/` →
/// 可执行文件同级。都没有返回 None(降级轮询,不报错)。
pub fn resolve_scrcpy_server() -> Option<PathBuf> {
    if let Ok(path) = std::env::var(SCRCPY_SERVER_ENV_KEY) {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [
        dir.join("resources").join("scrcpy").join("scrcpy-server"),
        dir.join("scrcpy").join("scrcpy-server"),
        dir.join("scrcpy-server"),
    ]
    .into_iter()
    .find(|candidate| candidate.exists())
}

/// scrcpy 视频包在帧枢纽里的标记(关键帧 / 配置包)。
struct ScrcpySession {
    /// (宽,高),codec meta 就绪后写入。
    video_size: Mutex<Option<(u32, u32)>>,
    error: Mutex<Option<String>>,
    child: Mutex<Option<Child>>,
    /// adb forward 本地端口(0 = 尚未绑定),回收用。
    forward_port: Mutex<u16>,
    /// 已回收(幂等)。
    recycled: AtomicBool,
}

impl ScrcpySession {
    fn new() -> Self {
        Self {
            video_size: Mutex::new(None),
            error: Mutex::new(None),
            child: Mutex::new(None),
            forward_port: Mutex::new(0),
            recycled: AtomicBool::new(false),
        }
    }

    fn set_error(&self, message: String) {
        if let Ok(mut slot) = self.error.lock() {
            *slot = Some(message);
        }
    }

    fn take_error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }

    fn is_ready(&self) -> bool {
        self.video_size.lock().map(|m| m.is_some()).unwrap_or(false) && self.take_error().is_none()
    }

    fn video_size(&self) -> Option<(u32, u32)> {
        self.video_size.lock().ok().and_then(|m| *m)
    }

    /// 回收:杀子进程 + 解除 adb forward(best-effort,幂等)。
    async fn shutdown(&self, adb: &dyn Adb, adb_path: &str, serial: &str) {
        if self.recycled.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut slot) = self.child.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.start_kill();
            }
        }
        let port = self.forward_port.lock().map(|p| *p).unwrap_or(0);
        if port != 0 {
            let _ = adb
                .raw(
                    adb_path,
                    Some(serial),
                    &[
                        "forward".to_string(),
                        "--remove".to_string(),
                        format!("tcp:{port}"),
                    ],
                    10,
                )
                .await;
        }
    }
}

/// 泵与 scrcpy 任务共享的 adb 执行上下文(三个注入点打包,少传参)。
#[derive(Clone)]
struct AdbContext {
    adb: Arc<dyn Adb>,
    settings: Arc<dyn SettingsStore>,
    manager: Arc<AndroidManager>,
}

impl AdbContext {
    /// 解析 adb 路径(带缓存;设置 → 环境变量 → PATH → 常见位置)。
    async fn resolve(&self) -> Result<String, String> {
        resolve_adb(&self.manager, self.settings.as_ref()).await
    }
}

/// 轮询泵:排空输入队列 + 周期截图(scrcpy 就绪时跳过);通道被关即退出并回收。
async fn live_pump(
    hub: Arc<FrameHub>,
    channel_id: String,
    serial: String,
    ctx: AdbContext,
    session: Arc<ScrcpySession>,
    mut input_rx: tokio::sync::mpsc::UnboundedReceiver<LiveInput>,
) {
    let adb_path = match ctx.resolve().await {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[starhub-live] Android 直播泵无 adb({serial}): {error}");
            session.shutdown(ctx.adb.as_ref(), "", &serial).await;
            hub.close(&channel_id);
            return;
        }
    };
    loop {
        if hub.get(&channel_id).is_none() {
            break;
        }
        // 排空动作队列(顺序执行;动作失败只记日志,不中断泵)
        while let Ok(action) = input_rx.try_recv() {
            match action {
                LiveInput::Gesture(gesture) => {
                    run_gesture(ctx.adb.as_ref(), &adb_path, &serial, gesture).await;
                }
                LiveInput::Raw(_) => {
                    eprintln!("[starhub-live] Android 直播通道忽略源自定义动作");
                }
                LiveInput::SetTakeover(active) => {
                    if let Some(channel) = hub.get(&channel_id) {
                        channel.set_takeover(active);
                    }
                }
            }
        }
        // scrcpy 就绪时跳过截图(省电省 adb 往返);轮询模式照常捕帧
        if !session.is_ready() {
            match capture_png(ctx.adb.as_ref(), &adb_path, &serial).await {
                Ok(bytes) => {
                    if let Some(channel) = hub.get(&channel_id) {
                        // 截图真实物理分辨率纠正坐标映射(不信任 connect 缓存)
                        if let Some((w, h)) = starhub_domain_android::keys::png_dimensions(&bytes) {
                            channel.patch_meta(|meta| {
                                meta.width = w;
                                meta.height = h;
                            });
                        }
                        channel.push_png(&bytes);
                    }
                }
                Err(error) => {
                    eprintln!("[starhub-live] Android 直播帧捕获失败({serial}): {error}");
                }
            }
        }
        tokio::time::sleep(LIVE_PUMP_INTERVAL).await;
    }
    session.shutdown(ctx.adb.as_ref(), &adb_path, &serial).await;
}

/// 执行一个手势(接管输入)。
async fn run_gesture(adb: &dyn Adb, adb_path: &str, serial: &str, gesture: Gesture) {
    let result = match gesture {
        Gesture::Tap { x, y } => adb
            .shell(adb_path, serial, &format!("input tap {x} {y}"), 10)
            .await
            .map(|_| ()),
        Gesture::Swipe { x1, y1, x2, y2, ms } => adb
            .shell(
                adb_path,
                serial,
                &format!("input swipe {x1} {y1} {x2} {y2} {ms}"),
                15,
            )
            .await
            .map(|_| ()),
        Gesture::Key { key } => match map_keycode(&key) {
            Ok(code) => adb
                .shell(adb_path, serial, &format!("input keyevent {code}"), 10)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        },
        Gesture::Text { text } => type_text(adb, adb_path, serial, &text).await.map(|_| ()),
    };
    if let Err(error) = result {
        eprintln!("[starhub-live] Android 直播输入失败({serial}): {error}");
    }
}

/// 输入文本:ASCII 走 `input text`,非 ASCII 走 ADBKeyBoard 广播
/// (与域工具的 `android_type` 同规则)。
async fn type_text(
    adb: &dyn Adb,
    adb_path: &str,
    serial: &str,
    text: &str,
) -> Result<String, String> {
    if is_ascii_input(text) {
        adb.shell(
            adb_path,
            serial,
            &format!("input text {}", sh_quote(&escape_input_text(text))),
            30,
        )
        .await?;
        return Ok(format!("已输入 {} 字符", text.chars().count()));
    }
    let pm = adb
        .shell(adb_path, serial, "pm path com.android.adbkeyboard", 15)
        .await
        .unwrap_or_default();
    if !pm.contains("package:") {
        return Err(
            "输入含非 ASCII 字符(如中文),需要设备已安装 ADBKeyBoard(见 android_type 的引导)"
                .to_string(),
        );
    }
    adb.shell(
        adb_path,
        serial,
        &format!("am broadcast -a ADB_INPUT_TEXT --es msg {}", sh_quote(text)),
        30,
    )
    .await?;
    Ok(format!(
        "已经 ADBKeyBoard 广播输入 {} 字符",
        text.chars().count()
    ))
}

/// `exec-out screencap -p` → PNG 字节(含 CRLF 修复)。
async fn capture_png(adb: &dyn Adb, adb_path: &str, serial: &str) -> Result<Vec<u8>, String> {
    let (stdout, stderr, code) = adb
        .raw(
            adb_path,
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

/// scrcpy 会话全流程:推送 server → adb forward → 启动 app_process →
/// 读 H.264 流进帧枢纽。任一步失败把原因写进通道元数据 `error`,
/// 直播保持轮询模式。通道被摘除即退出。
async fn scrcpy_run(
    hub: Arc<FrameHub>,
    channel_id: String,
    serial: String,
    server: PathBuf,
    ctx: AdbContext,
    session: Arc<ScrcpySession>,
) {
    let result = scrcpy_run_inner(&hub, &channel_id, &serial, &server, &ctx, &session).await;
    if let Err(error) = result {
        eprintln!("[starhub-live] scrcpy 通道不可用({serial}),直播保持轮询模式: {error}");
        session.set_error(error.clone());
        if let Some(channel) = hub.get(&channel_id) {
            channel.patch_meta(|meta| meta.error = Some(error));
        }
    }
}

async fn scrcpy_run_inner(
    hub: &Arc<FrameHub>,
    channel_id: &str,
    serial: &str,
    server: &PathBuf,
    ctx: &AdbContext,
    session: &Arc<ScrcpySession>,
) -> Result<(), String> {
    let adb_path = ctx.resolve().await?;

    // 1. 推送 server(尺寸不符才重推,避免每次开通道都传 70KB)
    let remote_size = ctx
        .adb
        .shell(
            &adb_path,
            serial,
            &format!(
                "stat -c %s {} 2>/dev/null || echo 0",
                sh_quote(SCRCPY_DEVICE_PATH)
            ),
            15,
        )
        .await
        .unwrap_or_else(|_| "0".to_string());
    let local_size = std::fs::metadata(server)
        .map_err(|e| format!("读取 scrcpy-server 失败: {e}"))?
        .len();
    if remote_size.trim().parse::<u64>().unwrap_or(0) != local_size {
        ctx.adb
            .shell(&adb_path, serial, "mkdir -p /data/local/tmp/starhub", 10)
            .await?;
        let (_, stderr, code) = ctx
            .adb
            .raw(
                &adb_path,
                Some(serial),
                &[
                    "push".to_string(),
                    server.display().to_string(),
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
    let (_, stderr, code) = ctx
        .adb
        .raw(
            &adb_path,
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
    let mut cmd = tokio::process::Command::new(&adb_path);
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
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 scrcpy-server 失败: {e}"))?;
    let mut child_stderr = child.stderr.take();
    if let Ok(mut slot) = session.child.lock() {
        *slot = Some(child);
    } else {
        return Err("scrcpy session 锁失效".to_string());
    }

    // 4. 连视频 socket(server 启动需要 1-2s,重试 ~5s)
    let mut stream = None;
    for _ in 0..50 {
        if hub.get(channel_id).is_none() {
            return Ok(()); // 通道已关,静默退出
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
                if diag.is_empty() {
                    String::new()
                } else {
                    format!(": {diag}")
                }
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
        return Err(format!(
            "scrcpy 视频编码非 H.264(codec=0x{codec:08x}),当前仅支持 H.264"
        ));
    }
    let width = u32::from_be_bytes(meta_buf[4..8].try_into().map_err(|_| "codec meta")?);
    let height = u32::from_be_bytes(meta_buf[8..12].try_into().map_err(|_| "codec meta")?);
    if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) {
        return Err(format!(
            "scrcpy 视频尺寸异常: {width}x{height}(协议不匹配?)"
        ));
    }
    if let Ok(mut slot) = session.video_size.lock() {
        *slot = Some((width, height));
    }
    // 元数据升级:面板据此从 img 切到 canvas + WebCodecs 解码
    if let Some(channel) = hub.get(channel_id) {
        let (vw, vh) = session.video_size().unwrap_or((width, height));
        channel.patch_meta(|meta| {
            meta.mode = "scrcpy".to_string();
            meta.vw = Some(vw);
            meta.vh = Some(vh);
            meta.error = None;
        });
    }

    // 6. 帧循环:12B 帧元头 + 负载 → 帧枢纽;stderr 同管 drain(server 异常即 EOF)
    if let Some(mut stderr) = child_stderr.take() {
        let channel = hub.get(channel_id);
        tokio::spawn(async move {
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
            if !text.is_empty() {
                if let Some(channel) = channel {
                    channel.patch_meta(|meta| {
                        meta.error = Some(format!("scrcpy-server 退出: {text}"))
                    });
                }
            }
        });
    }
    let mut header = [0u8; 12];
    loop {
        if hub.get(channel_id).is_none() {
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
        let flags = (if key { FLAG_KEYFRAME } else { 0 }) | (if config { FLAG_CONFIG } else { 0 });
        if let Some(channel) = hub.get(channel_id) {
            channel.push_frame(MSG_H264, flags, &payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrcpy_frame_meta_parsing() {
        // keyframe + 100 字节负载
        let mut header = Vec::new();
        header.extend_from_slice(&((1u64 << 62) | 42).to_be_bytes());
        header.extend_from_slice(&100u32.to_be_bytes());
        let (key, config, size) = parse_frame_meta(&header).unwrap();
        assert!(key);
        assert!(!config);
        assert_eq!(size, 100);

        let mut header = Vec::new();
        header.extend_from_slice(&((1u64 << 63) | 42).to_be_bytes());
        header.extend_from_slice(&8u32.to_be_bytes());
        let (key, config, _) = parse_frame_meta(&header).unwrap();
        assert!(!key);
        assert!(config, "bit63 = config(SPS/PPS)");

        assert!(parse_frame_meta(&[0u8; 11]).is_none());
        assert!(parse_frame_meta(&[0u8; 12]).is_none(), "size=0 拒绝");
    }

    #[test]
    fn channel_id_shape() {
        assert_eq!(
            AndroidLiveSource::channel_id("emulator-5554"),
            "android:emulator-5554"
        );
        assert!(crate::hub::valid_channel_id(
            &AndroidLiveSource::channel_id("192.168.1.5:43217")
        ));
    }

    #[tokio::test]
    async fn open_rejects_bad_serial_and_registers_a_channel() {
        let hub = Arc::new(FrameHub::new());
        let manager = Arc::new(AndroidManager::new());
        let source = AndroidLiveSource::new(
            hub.clone(),
            Arc::new(starhub_domain_android::adb::LocalAdb::new()),
            Arc::new(NullSettings),
            manager,
        );
        assert!(source.open("bad serial", (1080, 2400)).await.is_err());
        // 真 serial 能开通道(adb 缺失时泵会自行退出,但通道先注册成功)
        let channel = source.open("serial-a", (1080, 2400)).await.unwrap();
        assert_eq!(channel.id(), "android:serial-a");
        assert_eq!(channel.meta().mode, "frames", "初始为轮询模式");
        assert_eq!((channel.meta().width, channel.meta().height), (1080, 2400));
        assert_eq!(hub.list().len(), 1);
        // 重复 open 幂等(同一通道,不重复起泵)
        let again = source.open("serial-a", (1080, 2400)).await.unwrap();
        assert_eq!(again.id(), channel.id());
        hub.close("android:serial-a");
    }

    /// 空设置存储(测试用;adb 解析必然失败 → 泵自行退出)。
    struct NullSettings;

    impl starhub_domain_android::SettingsStore for NullSettings {
        fn get<'a>(
            &'a self,
            _key: &'a str,
        ) -> starhub_domain_android::BoxFuture<'a, Result<Option<String>, String>> {
            Box::pin(async move { Ok(None) })
        }
    }
}
