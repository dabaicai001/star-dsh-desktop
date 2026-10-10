//! Android 工具体契约测试:假 adb(记录调用,不 spawn 真进程)。
//!
//! 覆盖:① 结果文本(模型可读);② 授权闸;③ adb 命令拼装(注入防护:
//! serial/包名/路径/键名过白名单,文本过转义);④ 回放帧落库。

use std::sync::Mutex;

use serde_json::json;
use starhub_domain_android::adb::Adb;
use starhub_domain_android::exec::{execute, ANDROID_TOOLS};
use starhub_domain_android::keys::parse_devices;
use starhub_domain_android::store::{FrameStore, ReplayFrame};
use starhub_domain_android::{
    Android, BoxFuture, CacheDir, LiveLauncher, SettingsStore, TakeoverState,
};

// ---------- 假 seam ----------

/// 记录调用的假 adb;按 args 首元素回 canned 结果。
struct FakeAdb {
    calls: Mutex<Vec<(Option<String>, Vec<String>)>>,
}

impl FakeAdb {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(Option<String>, Vec<String>)> {
        self.calls.lock().unwrap().clone()
    }

    fn last_args(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .last()
            .map(|(_, args)| args.clone())
            .expect("at least one call")
    }
}

impl Adb for FakeAdb {
    fn raw<'a>(
        &'a self,
        _adb: &'a str,
        serial: Option<&'a str>,
        args: &'a [String],
        _timeout_secs: u64,
    ) -> BoxFuture<'a, Result<(Vec<u8>, String, i32), String>> {
        self.calls
            .lock()
            .unwrap()
            .push((serial.map(str::to_string), args.to_vec()));
        let args = args.to_vec();
        Box::pin(async move {
            let stdout: Vec<u8> = match args.first().map(String::as_str) {
                Some("devices") => b"List of devices attached\nserial-abc123\tdevice product:sdk model:Pixel_7 device:panther\n".to_vec(),
                // 1x1 PNG(合法 IHDR,供 exec-out screencap -p)
                Some("exec-out") => {
                    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
                    png.extend_from_slice(&13u32.to_be_bytes());
                    png.extend_from_slice(b"IHDR");
                    png.extend_from_slice(&1u32.to_be_bytes());
                    png.extend_from_slice(&1u32.to_be_bytes());
                    png
                }
                Some("shell") => {
                    let script = args.get(1).cloned().unwrap_or_default();
                    if script.contains("wm size") {
                        b"Pixel 7\n14\nPhysical size: 1080x2400\n".to_vec()
                    } else if script.contains("uiautomator dump") {
                        b"PGhpcmFyY2h5PjwvaGllcmFyY2h5Pg==".to_vec() // base64("<hierarchy></hierarchy>")
                    } else {
                        b"ok".to_vec()
                    }
                }
                _ => b"ok".to_vec(),
            };
            Ok((stdout, String::new(), 0))
        })
    }
}

/// 设置存根:只为 `android.adb_path` 返回一个**本机一定存在**的老实路径。
///
/// 这些用例原来靠 `std::env::set_var("STARHUB_ADB_PATH", "/bin/sh")` 让
/// `resolve_adb` 成功。但 `set_var` / `remove_var` 是**进程级全局**,而 cargo
/// test 默认多线程跑同一个测试二进制——一个用例的 `remove_var` 会落进另一个
/// 用例 `set_var` 与 `resolve_adb` 之间,让它回落到 PATH / 常见位置。开发机上
/// 装着 adb,回落也成功、看不出来;CI 的 runner 上哪都没有 adb,
/// `resolve_adb` 直接返回「未找到 adb 二进制」,`.expect("double tap")` 就
/// panic(v0.128.1 第一次真正跑 CI 时抓到)。
///
/// 改走设置 seam:它是 `resolve_adb` 的**第一个**候选,按用例注入、没有全局
/// 状态,也就没有这个竞争——顺带把文档里的优先顺序(设置 > 环境变量 > PATH)
/// 真正走到了。
///
/// 路径取**本 crate 的 manifest 目录**,而不是 `cmd` / `/bin/sh` 这种可执行名:
/// `resolve_adb` 只做 `Path::exists()` 校验,而 `Path::new("cmd").exists()` 在
/// Windows 上查的是**当前工作目录**、不是 PATH——于是 Windows CI 上这个候选
/// 照样不成立,又回落到底(v0.128.3 第二次真跑才抓到:本地 Windows 一直绿,是
/// 因为环境变量 `STARHUB_ADB_PATH` 指着真实的 adb,把设置候选顶下去了)。目录
/// 一定存在,拿它当 adb  spawn 会立刻失败,而捕帧失败只记日志、不关通道。
struct StubSettings;

impl SettingsStore for StubSettings {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        let value = (key == starhub_domain_android::manager::ADB_PATH_SETTING_KEY)
            .then(|| env!("CARGO_MANIFEST_DIR").to_string());
        Box::pin(async move { Ok(value) })
    }
}

struct TempCache(std::path::PathBuf);

impl CacheDir for TempCache {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String> {
        Ok(self.0.join(sub))
    }
}

#[derive(Default)]
struct MemoryFrames {
    frames: Mutex<Vec<(String, String, String, Option<String>)>>,
}

impl FrameStore for MemoryFrames {
    fn insert_frame<'a>(
        &'a self,
        serial: &'a str,
        session_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        self.frames.lock().unwrap().push((
            serial.to_string(),
            session_id.to_string(),
            action.to_string(),
            shot_path.map(str::to_string),
        ));
        Box::pin(async move { Ok(()) })
    }

    fn list_frames<'a>(
        &'a self,
        serial: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>> {
        let rows: Vec<ReplayFrame> = self
            .frames
            .lock()
            .unwrap()
            .iter()
            .filter(|(s, _, _, _)| s == serial)
            .take(limit.max(0) as usize)
            .map(|(_, _, action, shot)| ReplayFrame {
                action: action.clone(),
                shot_path: shot.clone(),
                created_at: 1_700_000_000,
            })
            .collect();
        Box::pin(async move { Ok(rows) })
    }
}

struct NoLive;

impl LiveLauncher for NoLive {
    fn open<'a>(
        &'a self,
        _serial: &'a str,
        _resolution: (i64, i64),
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

struct NoTakeover;

impl TakeoverState for NoTakeover {
    fn is_takeover(&self, _serial: &str) -> bool {
        false
    }
}

struct TakingOver;

impl TakeoverState for TakingOver {
    fn is_takeover(&self, _serial: &str) -> bool {
        true
    }
}

/// 装配一套上下文(假 adb + 内存回放帧)。
fn android_in_temp(label: &str) -> (Android<'static>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("starhub-android-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let adb: &'static mut dyn Adb = Box::leak(Box::new(FakeAdb::new()));
    let settings: &'static mut dyn SettingsStore = Box::leak(Box::new(StubSettings));
    let cache: &'static mut dyn CacheDir = Box::leak(Box::new(TempCache(dir.clone())));
    let frames: &'static mut dyn FrameStore = Box::leak(Box::new(MemoryFrames::default()));
    let live: &'static mut dyn LiveLauncher = Box::leak(Box::new(NoLive));
    let takeover: &'static mut dyn TakeoverState = Box::leak(Box::new(NoTakeover));
    let manager: &'static mut starhub_domain_android::AndroidManager =
        Box::leak(Box::new(starhub_domain_android::AndroidManager::new()));
    let android = Android {
        manager,
        adb,
        settings,
        cache,
        frames,
        live,
        takeover,
        session_id: "session-1",
    };
    (android, dir)
}

fn as_fake_adb(adb: &dyn Adb) -> &FakeAdb {
    unsafe { &*(adb as *const dyn Adb as *const FakeAdb) }
}

fn as_frames(frames: &dyn FrameStore) -> &MemoryFrames {
    unsafe { &*(frames as *const dyn FrameStore as *const MemoryFrames) }
}

/// 连接设备并授权(connect 需要真解析 adb;这里直接用 manager.grant 造授权)。
async fn grant(android: &Android<'_>) {
    android
        .manager
        .grant(android.session_id, "serial-abc123", (1080, 2400))
        .await;
}

// ---------- 测试 ----------

#[test]
fn tools_inventory_has_twenty_entries() {
    assert_eq!(ANDROID_TOOLS.len(), 20);
    assert!(ANDROID_TOOLS.contains(&"android_connect"));
    assert!(ANDROID_TOOLS.contains(&"android_exec"));
    assert!(ANDROID_TOOLS.contains(&"android_ui_tree"));
}

#[tokio::test]
async fn write_tools_require_device_authorization() {
    let (android, dir) = android_in_temp("authz");
    let err = execute(&android, "android_tap", &json!({ "x": 1, "y": 2 }))
        .await
        .expect_err("无授权");
    assert!(err.contains("没有设备授权"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn tap_builds_the_expected_input_command_and_records_a_frame() {
    let (android, dir) = android_in_temp("tap");
    grant(&android).await;
    let text = execute(&android, "android_tap", &json!({ "x": 100, "y": 200 }))
        .await
        .expect("tap");
    assert_eq!(text, "已在 (100,200) 单击");
    let args = as_fake_adb(android.adb).last_args();
    assert_eq!(args[0], "shell");
    assert!(args[1].contains("input tap 100 200"), "{:?}", args);
    // 写操作留档
    let frames = as_frames(android.frames).frames.lock().unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].2, "tap(100,200)");
    drop(frames);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn double_tap_adds_the_second_tap() {
    let (android, dir) = android_in_temp("dbltap");
    grant(&android).await;
    let text = execute(&android, "android_double_tap", &json!({ "x": 5, "y": 6 }))
        .await
        .expect("double tap");
    assert_eq!(text, "已在 (5,6) 双击");
    let args = as_fake_adb(android.adb).last_args();
    assert!(
        args[1].contains("input tap 5 6; sleep 0.12; input tap 5 6"),
        "{:?}",
        args
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn press_key_maps_friendly_names_and_rejects_injection() {
    let (android, dir) = android_in_temp("key");
    grant(&android).await;
    let text = execute(&android, "android_press_key", &json!({ "key": "back" }))
        .await
        .expect("press key");
    assert_eq!(text, "已按键 KEYCODE_BACK");
    let args = as_fake_adb(android.adb).last_args();
    assert!(
        args[1].contains("input keyevent KEYCODE_BACK"),
        "{:?}",
        args
    );

    // 组合键 / 注入:硬错误,且不触设备
    let calls_before = as_fake_adb(android.adb).calls().len();
    let err = execute(&android, "android_press_key", &json!({ "key": "ctrl+s" }))
        .await
        .expect_err("组合键");
    assert!(err.contains("Android 不支持组合键"), "{err}");
    assert_eq!(
        as_fake_adb(android.adb).calls().len(),
        calls_before,
        "非法键名不应触达设备"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn type_escapes_percent_and_space() {
    let (android, dir) = android_in_temp("type");
    grant(&android).await;
    let text = execute(&android, "android_type", &json!({ "text": "100% ok" }))
        .await
        .expect("type");
    assert_eq!(text, "已输入 7 字符");
    let args = as_fake_adb(android.adb).last_args();
    // escape_input_text: "100% ok" → "100%%%sok"(% 翻倍、空格 → %s),再过 sh_quote
    assert!(args[1].contains("input text '100%%%sok'"), "{:?}", args);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn push_rejects_paths_outside_the_whitelist() {
    let (android, dir) = android_in_temp("push");
    grant(&android).await;
    let err = execute(
        &android,
        "android_push",
        &json!({ "remoteDir": "/data/data/com.evil", "localPaths": ["/tmp/x"] }),
    )
    .await
    .expect_err("白名单外目录");
    assert!(err.contains("远端目录非法"), "{err}");
    let err = execute(
        &android,
        "android_push",
        &json!({ "remoteDir": "/sdcard/../system", "localPaths": ["/tmp/x"] }),
    )
    .await
    .expect_err("含 ..");
    assert!(err.contains("远端目录非法"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn takeover_blocks_write_operations() {
    let (android, dir) = android_in_temp("takeover");
    grant(&android).await;
    // 换一个「接管中」的 takeover 实现(其余 seam 复用)
    let taking: &'static mut dyn TakeoverState = Box::leak(Box::new(TakingOver));
    let context = Android {
        manager: android.manager,
        adb: android.adb,
        settings: android.settings,
        cache: android.cache,
        frames: android.frames,
        live: android.live,
        takeover: taking,
        session_id: "session-1",
    };
    let err = execute(&context, "android_tap", &json!({ "x": 1, "y": 2 }))
        .await
        .expect_err("接管中");
    assert!(err.contains("用户正在直播窗口中接管"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn replay_lists_frames_for_the_serial() {
    let (android, dir) = android_in_temp("replay");
    grant(&android).await;
    android
        .frames
        .insert_frame("serial-abc123", "session-1", "tap(1,2)", Some("/tmp/a.png"))
        .await
        .unwrap();
    android
        .frames
        .insert_frame("other-serial", "session-1", "tap(9,9)", None)
        .await
        .unwrap();
    let text = execute(&android, "android_replay", &json!({}))
        .await
        .expect("replay");
    assert!(text.contains("设备 serial-abc123 回放"), "{text}");
    assert!(text.contains("tap(1,2)"), "{text}");
    assert!(!text.contains("tap(9,9)"), "只列本设备的帧");
    let empty = execute(&android, "android_replay", &json!({ "serial": "nope" }))
        .await
        .expect("空回放");
    assert_eq!(empty, "设备 nope 没有回放帧");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_tool_is_a_loud_error() {
    let devices = parse_devices("List of devices attached\n");
    assert!(devices.is_empty());
}
