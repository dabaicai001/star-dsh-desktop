//! `android_*` 方法面执行体(20 个工具,从 `src-tauri/src/android/mod.rs` 平移;
//! 结果文本逐字保持——模型可读文本是契约)。
//!
//! 与 Tauri 版的差异只有注入点:`app.state` / `crate::db` / 直播窗口全部换成
//! [`Android`](crate::Android) 上下文里的 seam。

use serde_json::Value;

use crate::adb::resolve_adb;
use crate::keys::{
    arg_num, arg_str, escape_input_text, is_ascii_input, map_keycode, parse_devices,
    parse_ui_nodes, parse_wm_size, scroll_swipe, sh_quote, valid_host, valid_package,
    valid_push_dir, valid_serial,
};
use crate::manager::AUTHZ_TTL_SECS;
use crate::{AdbDevice, Android};

/// 本模块处理的 AI 工具清单。
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
    "android_ui_tree",
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

/// 执行上下文:adb 路径 + 授权设备。
struct DeviceCtx {
    adb: String,
    serial: String,
    resolution: (i64, i64),
}

async fn device_ctx(android: &Android<'_>, args: &Value) -> Result<DeviceCtx, String> {
    let serial_arg = args.get("serial").and_then(Value::as_str);
    if let Some(serial) = serial_arg {
        if !serial.is_empty() && !valid_serial(serial) {
            return Err(format!("设备 serial 非法: {serial:?}"));
        }
    }
    let authz = android
        .manager
        .require_authz(android.session_id, serial_arg)
        .await?;
    let adb = resolve_adb(android.manager, android.settings).await?;
    Ok(DeviceCtx {
        adb,
        serial: authz.serial,
        resolution: authz.resolution,
    })
}

/// 输入文本:ASCII 走 input text;非 ASCII 走 ADBKeyBoard 广播,
/// 未装时返回安装引导(§7.2)。
async fn type_text(
    android: &Android<'_>,
    adb: &str,
    serial: &str,
    text: &str,
) -> Result<String, String> {
    if is_ascii_input(text) {
        android
            .adb
            .shell(
                adb,
                serial,
                &format!("input text {}", sh_quote(&escape_input_text(text))),
                30,
            )
            .await?;
        return Ok(format!("已输入 {} 字符", text.chars().count()));
    }
    let pm = android
        .adb
        .shell(adb, serial, "pm path com.android.adbkeyboard", 15)
        .await
        .unwrap_or_default();
    if !pm.contains("package:") {
        return Err("输入含非 ASCII 字符(如中文),需要设备已安装 ADBKeyBoard:\n\
              1. 下载 https://github.com/senzhk/ADBKeyBoard 的 APK;\n\
              2. 用 android_exec 执行 adb install(会请求用户确认);\n\
              3. 在设备 设置 → 系统 → 语言与输入法 → 虚拟键盘 中启用 ADBKeyBoard(用户操作)。"
            .to_string());
    }
    android
        .adb
        .shell(
            adb,
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

/// exec-out screencap → PNG 字节(含 CRLF 修复)。
async fn capture_png(android: &Android<'_>, adb: &str, serial: &str) -> Result<Vec<u8>, String> {
    let (stdout, stderr, code) = android
        .adb
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
    crate::keys::ensure_png(stdout)
}

/// 截图落缓存目录 android-shots/,返回文件路径 + 截图真实物理分辨率
/// (PNG IHDR 直读,任意机型/横竖屏都准确)。
async fn capture_screenshot(
    android: &Android<'_>,
    adb: &str,
    serial: &str,
) -> Result<(String, (i64, i64)), String> {
    let bytes = capture_png(android, adb, serial).await?;
    let dims = crate::keys::png_dimensions(&bytes)
        .ok_or_else(|| "截图 PNG 头解析失败(无法确定物理分辨率)".to_string())?;
    let dir = android.cache.dir("android-shots")?;
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
async fn record_frame(android: &Android<'_>, adb: &str, serial: &str, action: &str) {
    let shot = capture_screenshot(android, adb, serial)
        .await
        .map(|(path, _dims)| path);
    let (action_text, shot_path) = match &shot {
        Ok(path) => (action.to_string(), Some(path.clone())),
        Err(error) => {
            tracing::warn!("Android 回放帧截图失败({serial}): {error}");
            (format!("{action}(截屏失败)"), None)
        }
    };
    if let Err(e) = android
        .frames
        .insert_frame(
            serial,
            android.session_id,
            &action_text,
            shot_path.as_deref(),
        )
        .await
    {
        tracing::warn!("Android 回放帧落库失败: {e}");
    }
}

/// 直播接管中(AI 写操作互斥;不撤销授权)。
///
/// 宿主注入的判定:Tauri 查 live 注册表;sidecar 侧由直播面板的接管状态经
/// 桥命令下发(与 desktop 同姿势)。
async fn guard_takeover(android: &Android<'_>, serial: &str) -> Result<(), String> {
    if android.is_takeover(serial) {
        return Err("用户正在直播窗口中接管设备操作,请稍后重试(接管不撤销授权)".to_string());
    }
    Ok(())
}

/// 工具分发入口:返回模型可读文本。
pub async fn execute(android: &Android<'_>, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "android_list_devices" => {
            let adb = resolve_adb(android.manager, android.settings).await?;
            let (stdout, _, _) = android
                .adb
                .raw(&adb, None, &["devices".to_string(), "-l".to_string()], 15)
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
            let adb = resolve_adb(android.manager, android.settings).await?;
            let serial_arg = args.get("serial").and_then(Value::as_str).unwrap_or("");
            if !serial_arg.is_empty() && !valid_serial(serial_arg) {
                return Err(format!("设备 serial 非法: {serial_arg:?}"));
            }
            let (stdout, _, _) = android
                .adb
                .raw(&adb, None, &["devices".to_string(), "-l".to_string()], 15)
                .await?;
            let devices = parse_devices(&String::from_utf8_lossy(&stdout));
            let ready: Vec<&AdbDevice> = devices.iter().filter(|d| d.state == "device").collect();
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
                return Err(
                    "没有就绪(状态 device)的设备:请检查 USB 调试授权后用 android_list_devices 复核"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "发现 {} 台就绪设备,请显式指定 serial:{}",
                    ready.len(),
                    ready
                        .iter()
                        .map(|d| format!("\n- {}", d.serial))
                        .collect::<String>()
                ));
            };

            // 探测型号 / Android 版本 / 分辨率(一次 shell 减少往返)
            let probe = android
                .adb
                .shell(
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

            android
                .manager
                .grant(android.session_id, &serial, resolution)
                .await;
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
            android.manager.revoke(android.session_id).await;
            Ok("已撤销本会话的设备授权(不改动设备本身;直播窗口如开着会继续播放)".to_string())
        }
        "android_wireless" => {
            let host = arg_str(args, "host")?;
            if !valid_host(host) {
                return Err(format!("主机地址非法: {host:?}(应为 IP 或主机名)"));
            }
            let adb = resolve_adb(android.manager, android.settings).await?;
            let mut outputs: Vec<String> = Vec::new();
            let pair_port = args.get("pairPort").and_then(Value::as_i64);
            let connect_port = args.get("connectPort").and_then(Value::as_i64);
            if let Some(port) = pair_port {
                let code = arg_str(args, "code")?;
                if !(100000..=999999).contains(&code.parse::<i64>().unwrap_or(0)) {
                    return Err(
                        "配对码应为手机「无线调试 → 使用配对码配对」页显示的 6 位数字".to_string(),
                    );
                }
                let (stdout, stderr, exit) = android
                    .adb
                    .raw(
                        &adb,
                        None,
                        &[
                            "pair".to_string(),
                            format!("{host}:{port}"),
                            code.to_string(),
                        ],
                        60,
                    )
                    .await?;
                outputs.push(format!(
                    "配对:{}{}",
                    String::from_utf8_lossy(&stdout).trim(),
                    if exit == 0 {
                        String::new()
                    } else {
                        format!("(exit {exit}) {stderr}")
                    }
                ));
            }
            if let Some(port) = connect_port {
                let (stdout, stderr, exit) = android
                    .adb
                    .raw(
                        &adb,
                        None,
                        &["connect".to_string(), format!("{host}:{port}")],
                        30,
                    )
                    .await?;
                outputs.push(format!(
                    "连接:{}{}",
                    String::from_utf8_lossy(&stdout).trim(),
                    if exit == 0 {
                        String::new()
                    } else {
                        format!("(exit {exit}) {stderr}")
                    }
                ));
            }
            if outputs.is_empty() {
                return Err("android_wireless 需要 pairPort(+code)或 connectPort 参数".to_string());
            }
            Ok(format!(
                "{}\n配对码只能由用户在手机上读取,AI 不要猜测;完成后用 android_list_devices 复核。",
                outputs.join("\n")
            ))
        }
        "android_device_status" => {
            let ctx = device_ctx(android, args).await?;
            let out = android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    "getprop ro.product.model; getprop ro.build.version.release; wm size; dumpsys window | grep -m 1 mCurrentFocus; dumpsys battery | grep -m 1 'level'",
                    25,
                )
                .await?;
            Ok(format!("设备 {} 状态:\n{}", ctx.serial, out.trim()))
        }
        "android_replay" => {
            let serial = match args.get("serial").and_then(Value::as_str) {
                Some(s) if !s.is_empty() => {
                    if !valid_serial(s) {
                        return Err(format!("设备 serial 非法: {s:?}"));
                    }
                    s.to_string()
                }
                _ => {
                    android
                        .manager
                        .require_authz(android.session_id, None)
                        .await?
                        .serial
                }
            };
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(50)
                .clamp(1, 500);
            let rows = android.frames.list_frames(&serial, limit).await?;
            if rows.is_empty() {
                return Ok(format!("设备 {serial} 没有回放帧"));
            }
            let mut lines = vec![format!("设备 {serial} 回放(帧 | 时间 | 截图):")];
            for (index, row) in rows.iter().enumerate() {
                let time = chrono::DateTime::from_timestamp(row.created_at, 0)
                    .map(|t| t.format("%H:%M:%S").to_string())
                    .unwrap_or_default();
                lines.push(format!(
                    "#{} {} | {} | {}",
                    index + 1,
                    row.action,
                    time,
                    row.shot_path
                        .clone()
                        .unwrap_or_else(|| "(无截图)".to_string())
                ));
            }
            Ok(lines.join("\n"))
        }
        "android_screenshot" => {
            let ctx = device_ctx(android, args).await?;
            let (path, dims) = capture_screenshot(android, &ctx.adb, &ctx.serial).await?;
            Ok(format!(
                "已截取设备屏幕(PNG),保存于:{path}\n分辨率:{w}x{h}(设备物理像素,坐标契约以此为准)。调用 read_image 读取该文件即可看到画面。",
                w = dims.0,
                h = dims.1,
            ))
        }
        "android_current_app" => {
            let ctx = device_ctx(android, args).await?;
            let out = android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'",
                    20,
                )
                .await?;
            Ok(format!("当前焦点:{out}"))
        }
        "android_ui_tree" => {
            let ctx = device_ctx(android, args).await?;
            let dump = android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    "mkdir -p /data/local/tmp/starhub && \
                     uiautomator dump /data/local/tmp/starhub/ui-dump.xml > /dev/null && \
                     base64 /data/local/tmp/starhub/ui-dump.xml",
                    30,
                )
                .await?;
            use base64::Engine;
            let b64: String = dump.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&b64)
                .map_err(|e| format!("界面树 base64 解码失败: {e}"))?;
            let xml = String::from_utf8(bytes).map_err(|e| format!("界面树不是 UTF-8: {e}"))?;
            let nodes = parse_ui_nodes(&xml);
            if nodes.is_empty() {
                return Ok(
                    "当前界面没有可读的无障碍节点(锁屏/FLAG_SECURE 安全页/自绘画面)。改用 android_screenshot + read_image 读图估算坐标。"
                        .to_string(),
                );
            }
            let max = args
                .get("maxNodes")
                .and_then(Value::as_i64)
                .unwrap_or(200)
                .clamp(1, 500) as usize;
            let mut lines = vec![format!(
                "设备 {} 界面节点({} 个可交互/有文字;中心坐标 = 设备物理像素,可直接传给 android_tap):",
                ctx.serial,
                nodes.len()
            )];
            for node in nodes.iter().take(max) {
                let (cx, cy) = node.center();
                let mut parts = vec![format!("({cx},{cy})")];
                parts.push(
                    if node.clickable {
                        "[可点]"
                    } else {
                        "[文字]"
                    }
                    .to_string(),
                );
                if !node.text.is_empty() {
                    parts.push(format!(
                        "\"{}\"",
                        node.text.chars().take(60).collect::<String>()
                    ));
                }
                if !node.desc.is_empty() {
                    parts.push(format!(
                        "desc:{}",
                        node.desc.chars().take(60).collect::<String>()
                    ));
                }
                if !node.resource_id.is_empty() {
                    parts.push(format!("id:{}", node.resource_id));
                }
                parts.push(node.class.clone());
                lines.push(parts.join(" "));
            }
            if nodes.len() > max {
                lines.push(format!(
                    "…(共 {} 个,已截断到 {max};调大 maxNodes 再看)",
                    nodes.len()
                ));
            }
            Ok(lines.join("\n"))
        }
        "android_tap" | "android_double_tap" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let (x, y) = (arg_num(args, "x")?, arg_num(args, "y")?);
            record_frame(android, &ctx.adb, &ctx.serial, &format!("tap({x},{y})")).await;
            let script = if name == "android_double_tap" {
                format!("input tap {x} {y}; sleep 0.12; input tap {x} {y}")
            } else {
                format!("input tap {x} {y}")
            };
            android
                .adb
                .shell(&ctx.adb, &ctx.serial, &script, 15)
                .await?;
            Ok(format!(
                "已在 ({x},{y}) {}击",
                if name == "android_double_tap" {
                    "双"
                } else {
                    "单"
                }
            ))
        }
        "android_swipe" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
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
                android,
                &ctx.adb,
                &ctx.serial,
                &format!("swipe({x1},{y1}→{x2},{y2})"),
            )
            .await;
            android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    &format!("input swipe {x1} {y1} {x2} {y2} {ms}"),
                    20,
                )
                .await?;
            Ok(format!("已滑动 ({x1},{y1}) → ({x2},{y2})({ms}ms)"))
        }
        "android_scroll" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let (w, h) = ctx.resolution;
            let x = args.get("x").and_then(Value::as_i64).unwrap_or(w / 2);
            let y = args.get("y").and_then(Value::as_i64).unwrap_or(h / 2);
            let direction = args
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("down");
            let amount = args.get("amount").and_then(Value::as_i64).unwrap_or(600);
            let (x1, y1, x2, y2) = scroll_swipe(x, y, direction, amount, (w, h))?;
            record_frame(
                android,
                &ctx.adb,
                &ctx.serial,
                &format!("scroll({direction},{amount})"),
            )
            .await;
            android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    &format!("input swipe {x1} {y1} {x2} {y2} 250"),
                    20,
                )
                .await?;
            Ok(format!("已在 ({x},{y}) 向 {direction} 滚动 {amount} 像素"))
        }
        "android_type" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let text = arg_str(args, "text")?;
            record_frame(
                android,
                &ctx.adb,
                &ctx.serial,
                &format!("type({} 字符)", text.chars().count()),
            )
            .await;
            type_text(android, &ctx.adb, &ctx.serial, text).await
        }
        "android_press_key" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let code = map_keycode(arg_str(args, "key")?)?;
            record_frame(
                android,
                &ctx.adb,
                &ctx.serial,
                &format!("press_key({code})"),
            )
            .await;
            android
                .adb
                .shell(&ctx.adb, &ctx.serial, &format!("input keyevent {code}"), 15)
                .await?;
            Ok(format!("已按键 {code}"))
        }
        "android_launch_app" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let package = arg_str(args, "package")?;
            if !valid_package(package) {
                return Err(format!("包名非法: {package:?}"));
            }
            record_frame(
                android,
                &ctx.adb,
                &ctx.serial,
                &format!("launch_app({package})"),
            )
            .await;
            let out = android
                .adb
                .shell(
                    &ctx.adb,
                    &ctx.serial,
                    &format!(
                        "monkey -p {} -c android.intent.category.LAUNCHER 1",
                        sh_quote(package)
                    ),
                    25,
                )
                .await?;
            if out.contains("No activities found") {
                return Err(format!("包 {package} 没有可启动的 Activity(未安装?)"));
            }
            Ok(format!("已启动 {package}(用 android_screenshot 确认界面)"))
        }
        "android_open_live" => {
            let ctx = device_ctx(android, args).await?;
            let serial = ctx.serial.clone();
            android.live.open(&serial, ctx.resolution).await?;
            Ok(format!(
                "直播面板已打开(设备 {serial})。scrcpy 通道就绪后自动切换 H.264 实时画面,否则截图轮询兜底;面板内勾选「接管」后用户可亲手操作,期间你的写操作会被拒绝。"
            ))
        }
        "android_pull" => {
            let ctx = device_ctx(android, args).await?;
            let remote = arg_str(args, "remotePath")?;
            if !remote.starts_with('/') || remote.contains("..") || remote.len() > 512 {
                return Err(format!(
                    "远端路径非法: {remote:?}(须为设备绝对路径,不含 ..)"
                ));
            }
            let local_dir = arg_str(args, "localDir")?;
            let local = std::path::Path::new(local_dir);
            if !local.is_dir() {
                return Err(format!("本机目录不存在: {local_dir}"));
            }
            let (stdout, stderr, code) = android
                .adb
                .raw(
                    &ctx.adb,
                    Some(&ctx.serial),
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
            let ctx = device_ctx(android, args).await?;
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
                let (stdout, stderr, code) = android
                    .adb
                    .raw(
                        &ctx.adb,
                        Some(&ctx.serial),
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
            Ok(format!(
                "已推送 {} 个文件到 {remote_dir}:\n{}",
                results.len(),
                results.join("\n")
            ))
        }
        "android_exec" => {
            let ctx = device_ctx(android, args).await?;
            guard_takeover(android, &ctx.serial).await?;
            let command = arg_str(args, "command")?;
            let timeout = args
                .get("timeoutSec")
                .and_then(Value::as_i64)
                .unwrap_or(60)
                .clamp(1, 600) as u64;
            let (stdout, stderr, code) = android
                .adb
                .raw(
                    &ctx.adb,
                    Some(&ctx.serial),
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
