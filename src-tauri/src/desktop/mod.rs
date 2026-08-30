//! 沙箱桌面(Ubuntu 容器沙箱平台,E2B 式架构)— Rust 语义层。
//!
//! 设计:`docs/superpowers/specs/2026-08-28-desktop-automation-design.md`。
//! 编排全部经 sidecar 现有 Docker 适配器(M0 补齐的方法),目标连接 =
//! 设置页「沙箱平台」选择(settings 表 `desktop.platform_asset_id`),
//! 未选择时默认本机 Docker(docker.connect 空参,client.FromEnv 兜底)。
//!
//! 安全模型(§5):
//! - 任务级授权:`desktop_create_sandbox` 成功即建立 session → sandbox 授权
//!   (60 分钟),授权期内写操作自动放行——授权存在性/过期/实例匹配由本模块
//!   在执行点强制(审批层只决定 create/exec 是否弹卡);
//! - 用户接管(前端 `desktop_ui_open_live_window` takeover=true)期间写操作一律拒绝,
//!   接管不撤销授权;
//! - 每次写操作前自动截屏留档(sandbox_replay_frames),支持回放;
//! - `desktop_type` 的文本不进审计(审计摘要在 events.rs 只记长度)。

pub mod recipe;

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use sqlx::{Row, SqlitePool};
use tauri::Manager;

use crate::harness::HostBridgeState;

/// 本模块处理的 AI 工具清单(harness/tools.rs 分发用)。
/// `desktop_request_user_action` 不在这里——它经 FORWARDED_TOOLS 转发前端
/// (横幅与「已完成」按钮是纯 UI 状态)。
pub const DESKTOP_TOOLS: &[&str] = &[
    // 管理(软确认档)
    "desktop_list_templates",
    "desktop_build_template",
    "desktop_create_sandbox",
    "desktop_sandbox_status",
    "desktop_pause_sandbox",
    "desktop_resume_sandbox",
    "desktop_destroy_sandbox",
    "desktop_commit_sandbox",
    "desktop_sandbox_replay",
    // 感知(授权内放行)
    "desktop_screenshot",
    "desktop_list_windows",
    "desktop_get_foreground_window",
    // 操作(授权内放行,接管互斥)
    "desktop_focus_window",
    "desktop_click",
    "desktop_double_click",
    "desktop_move_mouse",
    "desktop_scroll",
    "desktop_drag",
    "desktop_type",
    "desktop_press_key",
    // 万能钥匙(恒确认档)
    "desktop_exec",
    // 人机协作:请求用户人工介入(横幅经桥事件广播,「已完成」经
    // desktop_user_action_reply 命令应答——不走 dsh://tool-exec 泛化转发)
    "desktop_request_user_action",
];

/// 设置表 key:沙箱平台 Docker 连接(资产 id);空 = 本机。
const PLATFORM_SETTING_KEY: &str = "desktop.platform_asset_id";
/// 任务授权时长(秒),超时后写操作重新要求创建沙箱。
const AUTHZ_TTL_SECS: i64 = 60 * 60;

/// 授权条目:create_sandbox 建立,到期/销毁/撤销即失效。
#[derive(Debug, Clone)]
struct Authz {
    sandbox_id: String,
    expires_at: i64,
}

#[derive(Default)]
struct DesktopState {
    /// 平台连接缓存:platform key(资产 id 或 "local")→ sidecar connId。
    conn_cache: HashMap<String, String>,
    /// session_id → 任务级授权。
    authz: HashMap<String, Authz>,
    /// 用户接管中的容器 id 集合(写操作互斥)。
    takeovers: HashSet<String>,
    /// requestId → 「请求用户人工介入」等待应答通道(desktop_request_user_action)。
    user_actions: HashMap<String, tokio::sync::oneshot::Sender<bool>>,
}

/// 沙箱桌面管理器(经 `app.manage` 注入;桥路径经 `bridge.app().state` 访问)。
pub struct DesktopManager {
    state: tokio::sync::Mutex<DesktopState>,
}

impl DesktopManager {
    pub fn new() -> Self {
        Self {
            state: tokio::sync::Mutex::new(DesktopState::default()),
        }
    }

    /// 前端接管开关(commands/desktop.rs):active=true 进入接管。
    pub async fn set_takeover(&self, container_id: &str, active: bool) {
        let mut state = self.state.lock().await;
        if active {
            state.takeovers.insert(container_id.to_string());
        } else {
            state.takeovers.remove(container_id);
        }
    }

    /// 「请求用户人工介入」应答(commands/desktop.rs):返回 false 表示 requestId 未知/已过期。
    pub async fn resolve_user_action(&self, request_id: &str, done: bool) -> bool {
        if let Some(sender) = self.state.lock().await.user_actions.remove(request_id) {
            let _ = sender.send(done);
            true
        } else {
            false
        }
    }

    async fn is_takeover(&self, container_id: &str) -> bool {
        self.state.lock().await.takeovers.contains(container_id)
    }

    async fn grant(&self, session_id: &str, sandbox_id: &str) {
        let expires_at = chrono::Utc::now().timestamp() + AUTHZ_TTL_SECS;
        self.state.lock().await.authz.insert(
            session_id.to_string(),
            Authz {
                sandbox_id: sandbox_id.to_string(),
                expires_at,
            },
        );
    }

    async fn revoke_sandbox(&self, sandbox_id: &str) {
        self.state
            .lock()
            .await
            .authz
            .retain(|_, a| a.sandbox_id != sandbox_id);
    }

    /// 校验会话对目标沙箱的写授权;返回 sandbox_id。
    async fn require_authz(
        &self,
        session_id: &str,
        sandbox_arg: Option<&str>,
    ) -> Result<String, String> {
        let state = self.state.lock().await;
        let authz = state.authz.get(session_id).ok_or_else(|| {
            "当前会话没有沙箱授权:请先调用 desktop_create_sandbox 创建沙箱(会请求用户确认)"
                .to_string()
        })?;
        let now = chrono::Utc::now().timestamp();
        if authz.expires_at < now {
            return Err("沙箱授权已过期(60 分钟),请重新 desktop_create_sandbox".to_string());
        }
        if let Some(want) = sandbox_arg {
            if !want.is_empty() && want != authz.sandbox_id {
                return Err(format!(
                    "授权仅覆盖沙箱 {},不能操作 {want}",
                    authz.sandbox_id
                ));
            }
        }
        Ok(authz.sandbox_id.clone())
    }

    async fn cached_conn(&self, key: &str) -> Option<String> {
        self.state.lock().await.conn_cache.get(key).cloned()
    }

    async fn cache_conn(&self, key: &str, conn_id: &str) {
        self.state
            .lock()
            .await
            .conn_cache
            .insert(key.to_string(), conn_id.to_string());
    }

    async fn evict_conn(&self, key: &str) {
        self.state.lock().await.conn_cache.remove(key);
    }
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

/// UI 生命周期入口(沙箱 tab 的停止/恢复/销毁按钮):与 AI 工具路径同一份
/// sidecar 编排,但不经任务授权——这是用户自己的手,按钮点击即审批表达。
/// action ∈ destroy / pause / resume。
pub async fn ui_lifecycle(
    app: &tauri::AppHandle,
    sandbox_id: &str,
    action: &str,
) -> Result<String, String> {
    let bridge = app.state::<crate::harness::HarnessManager>().bridge();
    let manager = app.state::<DesktopManager>();
    let pool = crate::db::get_pool()?;
    let instance = load_instance(pool, sandbox_id).await?;
    if instance.status == "destroyed" {
        return Err(format!("沙箱 {sandbox_id} 已销毁"));
    }
    let (platform, conn_id) = platform_conn(&bridge, &manager, Some(&instance.platform)).await?;
    match action {
        "destroy" => destroy_sandbox(&bridge, &manager, &platform, &conn_id, pool, &instance).await,
        "pause" => {
            pause_resume(
                &bridge, &manager, &platform, &conn_id, pool, &instance, false,
            )
            .await
        }
        "resume" => {
            pause_resume(
                &bridge, &manager, &platform, &conn_id, pool, &instance, true,
            )
            .await
        }
        other => Err(format!("未知生命周期动作: {other}(destroy/pause/resume)")),
    }
}

// ============================================================
// 平台连接(设置选择器语义)
// ============================================================

/// 解析平台连接:显式给 key(实例落库时记录的 platform)则用其连接,
/// 否则读设置页选择(空 = 本机)。返回 (platform_key, connId)。
async fn platform_conn(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    key_override: Option<&str>,
) -> Result<(String, String), String> {
    let key = match key_override {
        Some(k) => k.to_string(),
        None => {
            let pool = crate::db::get_pool()?;
            let asset_id: Option<String> =
                sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
                    .bind(PLATFORM_SETTING_KEY)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("读取沙箱平台设置失败: {e}"))?
                    .filter(|v| !v.trim().is_empty());
            asset_id.unwrap_or_else(|| "local".to_string())
        }
    };
    if let Some(conn_id) = manager.cached_conn(&key).await {
        return Ok((key, conn_id));
    }

    let conn_id = if key == "local" {
        // 本机默认:空参 docker.connect,sidecar 端 client.FromEnv 按平台取默认 socket。
        crate::harness::sidecar_call(bridge, "docker.connect", serde_json::json!({}))
            .await?
            .get("connId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "docker.connect(本机)未返回 connId".to_string())?
    } else {
        let (asset_type, config) = crate::harness::load_asset_config(&key).await?;
        if asset_type != "docker" {
            return Err(format!(
                "沙箱平台连接 {key} 不是 Docker 资产({asset_type}),请到设置页重选"
            ));
        }
        crate::harness::connect_sidecar(bridge, "docker", &config).await?
    };
    manager.cache_conn(&key, &conn_id).await;
    Ok((key, conn_id))
}

/// sidecar 调用包装:失败时驱逐平台连接缓存(下次调用自动重连)。
async fn platform_call(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    key: &str,
    conn_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    platform_call_with_timeout(bridge, manager, key, conn_id, method, params, None).await
}

/// 自定义超时版 platform_call(模板构建/实例固化等长耗时 RPC;
/// None 走 sidecar 默认 120 秒)。
async fn platform_call_with_timeout(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    key: &str,
    conn_id: &str,
    method: &str,
    mut params: Value,
    timeout: Option<std::time::Duration>,
) -> Result<Value, String> {
    params["connId"] = Value::String(conn_id.to_string());
    let result = match timeout {
        Some(t) => crate::harness::sidecar_call_with_timeout(bridge, method, params, t).await,
        None => crate::harness::sidecar_call(bridge, method, params).await,
    };
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            manager.evict_conn(key).await;
            Err(error)
        }
    }
}

// ============================================================
// 实例存取(SQLite)
// ============================================================

struct InstanceRow {
    id: String,
    container_id: String,
    platform: String,
    novnc_port: i64,
    status: String,
    task: String,
}

async fn load_instance(pool: &SqlitePool, sandbox_id: &str) -> Result<InstanceRow, String> {
    let row = sqlx::query(
        "SELECT id, container_id, platform, novnc_port, status, task FROM sandbox_instances WHERE id = ?",
    )
    .bind(sandbox_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("读取沙箱实例失败: {e}"))?
    .ok_or_else(|| format!("沙箱实例不存在: {sandbox_id}"))?;
    Ok(InstanceRow {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        container_id: row.try_get("container_id").map_err(|e| e.to_string())?,
        platform: row.try_get("platform").map_err(|e| e.to_string())?,
        novnc_port: row.try_get("novnc_port").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
        task: row.try_get("task").map_err(|e| e.to_string())?,
    })
}

async fn mark_instance(pool: &SqlitePool, sandbox_id: &str, status: &str) {
    let destroyed_at = if status == "destroyed" {
        Some(now_ts())
    } else {
        None
    };
    if let Err(e) = sqlx::query(
        "UPDATE sandbox_instances SET status = ?, destroyed_at = COALESCE(?, destroyed_at) WHERE id = ?",
    )
    .bind(status)
    .bind(destroyed_at)
    .bind(sandbox_id)
    .execute(pool)
    .await
    {
        tracing::warn!("更新沙箱实例状态失败({sandbox_id} → {status}): {e}");
    }
}

/// 目标沙箱解析:args.sandboxId 优先,否则用会话授权的沙箱。
async fn resolve_sandbox(
    pool: &SqlitePool,
    manager: &DesktopManager,
    session_id: &str,
    args: &Value,
    require_write_authz: bool,
) -> Result<(InstanceRow, String), String> {
    let sandbox_arg = args.get("sandboxId").and_then(Value::as_str);
    let sandbox_id = if require_write_authz {
        manager.require_authz(session_id, sandbox_arg).await?
    } else {
        match sandbox_arg {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => manager.require_authz(session_id, None).await?,
        }
    };
    let instance = load_instance(pool, &sandbox_id).await?;
    if instance.status == "destroyed" {
        return Err(format!("沙箱 {sandbox_id} 已销毁"));
    }
    Ok((instance, sandbox_id))
}

// ============================================================
// 箱内命令执行(xdotool / scrot 全家桶)
// ============================================================

/// shell 单引号转义。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

async fn sandbox_exec(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    container_id: &str,
    script: &str,
    timeout_sec: i64,
) -> Result<(String, String, i64), String> {
    // RPC 层超时必须盖过 docker exec 自身的 timeoutSec(默认 RPC 只有 120 秒,
    // 装包/下载类长命令会在 RPC 层先超时);留 30 秒余量给输出回收。
    let result = platform_call_with_timeout(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.exec",
        serde_json::json!({
            "containerId": container_id,
            "command": ["sh", "-c", script],
            "timeoutSec": timeout_sec,
        }),
        Some(std::time::Duration::from_secs((timeout_sec.max(1) + 30) as u64)),
    )
    .await?;
    let stdout = result
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let stderr = result
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let exit_code = result.get("exitCode").and_then(Value::as_i64).unwrap_or(0);
    Ok((stdout, stderr, exit_code))
}

/// X11 环境前缀(Xvfb 固定在 :0)。
fn x11(script: &str) -> String {
    format!("export DISPLAY=:0; {script}")
}

async fn xdotool(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    container_id: &str,
    args_line: &str,
) -> Result<String, String> {
    let (stdout, stderr, exit_code) = sandbox_exec(
        bridge,
        manager,
        platform,
        conn_id,
        container_id,
        &x11(&format!("xdotool {args_line}")),
        30,
    )
    .await?;
    if exit_code != 0 {
        return Err(format!(
            "xdotool {args_line} 失败(exit {exit_code}): {stderr}"
        ));
    }
    Ok(stdout)
}

/// 键名白名单映射:AI 友好名 → xdotool keysym;组合键按 + 拆分逐个校验。
fn map_key(key: &str) -> Result<String, String> {
    let parts: Vec<String> = key
        .split('+')
        .map(|part| {
            let lower = part.trim().to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" => Ok("ctrl".to_string()),
                "shift" => Ok("shift".to_string()),
                "alt" => Ok("alt".to_string()),
                "super" | "win" | "meta" => Ok("super".to_string()),
                "enter" | "return" => Ok("Return".to_string()),
                "tab" => Ok("Tab".to_string()),
                "esc" | "escape" => Ok("Escape".to_string()),
                "space" | "空格" => Ok("space".to_string()),
                "backspace" => Ok("BackSpace".to_string()),
                "delete" => Ok("Delete".to_string()),
                "home" => Ok("Home".to_string()),
                "end" => Ok("End".to_string()),
                "pageup" => Ok("Page_Up".to_string()),
                "pagedown" => Ok("Page_Down".to_string()),
                "up" | "arrowup" => Ok("Up".to_string()),
                "down" | "arrowdown" => Ok("Down".to_string()),
                "left" | "arrowleft" => Ok("Left".to_string()),
                "right" | "arrowright" => Ok("Right".to_string()),
                other
                    if other.len() == 1
                        && other
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_alphanumeric()) =>
                {
                    Ok(other.to_string())
                }
                other
                    if other.starts_with('f')
                        && other[1..].chars().all(|c| c.is_ascii_digit())
                        && (1..=24).contains(&other[1..].parse::<u32>().unwrap_or(0)) =>
                {
                    Ok(other.to_uppercase())
                }
                other => Err(format!("不支持的键名: {other:?}")),
            }
        })
        .collect::<Result<_, _>>()?;
    Ok(parts.join("+"))
}

fn mouse_button(button: &str) -> Result<&'static str, String> {
    match button {
        "" | "left" => Ok("1"),
        "middle" => Ok("2"),
        "right" => Ok("3"),
        other => Err(format!("不支持的鼠标键: {other:?}(left/middle/right)")),
    }
}

fn coord(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("缺少坐标参数 {key}"))
}

// ============================================================
// 截图与回放(M4)
// ============================================================

/// 箱内 scrot → copyFromContainer → 落应用缓存目录 desktop-shots/。
async fn capture_screenshot(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    container_id: &str,
    sandbox_id: &str,
) -> Result<String, String> {
    let shot_name = "/tmp/starhub-shot.png";
    let (_out, stderr, exit_code) = sandbox_exec(
        bridge,
        manager,
        platform,
        conn_id,
        container_id,
        &x11(&format!("scrot -o -z {shot_name}")),
        30,
    )
    .await?;
    if exit_code != 0 {
        return Err(format!("沙箱内截图失败(exit {exit_code}): {stderr}"));
    }
    let file = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.copyFromContainer",
        serde_json::json!({ "containerId": container_id, "srcPath": shot_name }),
    )
    .await?;
    let content_b64 = file
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "copyFromContainer 未返回 content".to_string())?;
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_b64)
        .map_err(|e| format!("截图 base64 解码失败: {e}"))?;

    let app = bridge.app().ok_or_else(|| "应用句柄未就绪".to_string())?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用: {e}"))?
        .join("desktop-shots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    let path = dir.join(format!(
        "{sandbox_id}-{}.png",
        chrono::Local::now().format("%Y%m%d-%H%M%S-%3f")
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
    Ok(path.display().to_string())
}

/// 模板构建超时降级:Dockerfile 落盘缓存目录,返回手工构建指引。
/// daemon 层缓存全局共享——用户手动 `docker build` 完成后,AI 再次调用
/// desktop_build_template 会命中全部层缓存,秒级完成并回写模板镜像标记。
fn manual_build_fallback(
    bridge: &HostBridgeState,
    dockerfile: &str,
    tag: &str,
    error: &str,
) -> Result<String, String> {
    let app = bridge.app().ok_or_else(|| "应用句柄未就绪".to_string())?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用: {e}"))?
        .join("desktop-build")
        .join(tag.replace(':', "_"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建构建目录失败: {e}"))?;
    let dockerfile_path = dir.join("Dockerfile");
    std::fs::write(&dockerfile_path, dockerfile)
        .map_err(|e| format!("写入 Dockerfile 失败: {e}"))?;
    Ok(format!(
        "构建超时(超过 30 分钟):{error}\n\n\
         通常是拉取基础镜像/安装软件包的网络太慢。Dockerfile 已落盘,可请用户在本机终端手动构建:\n  \
         docker build -t {tag} \"{}\"\n\
         构建完成后再次调用 desktop_build_template(会命中层缓存,秒级完成并登记镜像标记),或直接 desktop_create_sandbox 使用该模板。",
        dir.display(),
    ))
}

/// 写操作前的自动截屏留档(回放帧);失败只记日志不阻断操作。
async fn record_frame(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    instance: &InstanceRow,
    action: &str,
) {
    let shot = capture_screenshot(
        bridge,
        manager,
        platform,
        conn_id,
        &instance.container_id,
        &instance.id,
    )
    .await;
    if let Ok(pool) = crate::db::get_pool() {
        let (action_text, shot_path) = match &shot {
            Ok(path) => (action.to_string(), Some(path.clone())),
            Err(error) => {
                tracing::warn!("回放帧截图失败({}): {error}", instance.id);
                (format!("{action}(截屏失败)"), None)
            }
        };
        if let Err(e) = sqlx::query(
            "INSERT INTO sandbox_replay_frames (sandbox_id, action, shot_path) VALUES (?, ?, ?)",
        )
        .bind(&instance.id)
        .bind(action_text)
        .bind(shot_path)
        .execute(pool)
        .await
        {
            tracing::warn!("回放帧落库失败: {e}");
        }
    }
}

// ============================================================
// 工具执行(桥入口)
// ============================================================

/// 实例绑定操作的上下文:实例 + 该实例落库时记录的平台连接。
/// 平台选择可能在实例创建后被用户改,沙箱操作必须打向实例自己的平台。
struct SandboxCtx {
    instance: InstanceRow,
    platform: String,
    conn_id: String,
}

async fn sandbox_ctx(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    pool: &SqlitePool,
    session_id: &str,
    args: &Value,
    require_write_authz: bool,
) -> Result<SandboxCtx, String> {
    let (instance, _) =
        resolve_sandbox(pool, manager, session_id, args, require_write_authz).await?;
    let (platform, conn_id) = platform_conn(bridge, manager, Some(&instance.platform)).await?;
    Ok(SandboxCtx {
        instance,
        platform,
        conn_id,
    })
}

/// harness 桥入口:desktop_* 工具在此分发执行,返回模型可读文本。
pub async fn execute_from_bridge(
    bridge: &HostBridgeState,
    session_id: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    let app = bridge
        .app()
        .ok_or_else(|| "应用句柄未就绪(启动序列未完成)".to_string())?;
    let manager = app.state::<DesktopManager>();
    let pool = crate::db::get_pool()?;

    match name {
        "desktop_list_templates" => list_templates(pool).await,
        "desktop_sandbox_replay" => sandbox_replay(pool, args).await,
        "desktop_build_template" => {
            let (platform, conn_id) = platform_conn(bridge, &manager, None).await?;
            build_template(bridge, &manager, &platform, &conn_id, pool, args).await
        }
        "desktop_create_sandbox" => {
            let (platform, conn_id) = platform_conn(bridge, &manager, None).await?;
            create_sandbox(
                bridge, &manager, &platform, &conn_id, pool, session_id, args,
            )
            .await
        }
        "desktop_sandbox_status" => {
            // 无 sandboxId:列出全部未销毁实例,不要求授权
            if args.get("sandboxId").and_then(Value::as_str).is_none() {
                return list_running_sandboxes(pool).await;
            }
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, false).await?;
            sandbox_status(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                pool,
                &ctx.instance,
            )
            .await
        }
        "desktop_pause_sandbox" | "desktop_resume_sandbox" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, false).await?;
            pause_resume(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                pool,
                &ctx.instance,
                name == "desktop_resume_sandbox",
            )
            .await
        }
        "desktop_destroy_sandbox" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, false).await?;
            destroy_sandbox(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                pool,
                &ctx.instance,
            )
            .await
        }
        "desktop_commit_sandbox" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, false).await?;
            commit_sandbox(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                pool,
                &ctx.instance,
                args,
            )
            .await
        }
        "desktop_screenshot" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            let path = capture_screenshot(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance.container_id,
                &ctx.instance.id,
            )
            .await?;
            Ok(format!(
                "已截取沙箱屏幕(PNG),保存于:{path}\n调用 read_image 读取该文件即可看到画面。"
            ))
        }
        "desktop_list_windows" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            let (stdout, stderr, exit_code) = sandbox_exec(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance.container_id,
                &x11("wmctrl -l -G"),
                30,
            )
            .await?;
            if exit_code != 0 {
                return Err(format!("列出窗口失败(exit {exit_code}): {stderr}"));
            }
            Ok(format!("窗口列表(id | 几何 | 标题):\n{stdout}"))
        }
        "desktop_get_foreground_window" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            let (stdout, stderr, exit_code) = sandbox_exec(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance.container_id,
                &x11("xdotool getactivewindow getwindowname && xdotool getactivewindow"),
                30,
            )
            .await?;
            if exit_code != 0 {
                return Err(format!("查询前台窗口失败(exit {exit_code}): {stderr}"));
            }
            Ok(format!("前台窗口:{stdout}"))
        }
        "desktop_focus_window" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let window_id = arg_str(args, "windowId")?;
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                "focus_window",
            )
            .await;
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("windowactivate {}", sh_quote(window_id)),
            )
            .await?;
            Ok("已聚焦窗口".to_string())
        }
        "desktop_click" | "desktop_double_click" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let (x, y) = (coord(args, "x")?, coord(args, "y")?);
            let button = mouse_button(args.get("button").and_then(Value::as_str).unwrap_or(""))?;
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("click({x},{y})"),
            )
            .await;
            let repeat = if name == "desktop_double_click" {
                "click --repeat 2 --delay 80"
            } else {
                "click"
            };
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("mousemove {x} {y} {repeat} {button}"),
            )
            .await?;
            Ok(format!(
                "已在 ({x},{y}) {}击",
                if name == "desktop_double_click" {
                    "双"
                } else {
                    "单"
                }
            ))
        }
        "desktop_move_mouse" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let (x, y) = (coord(args, "x")?, coord(args, "y")?);
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("mousemove {x} {y}"),
            )
            .await?;
            Ok(format!("指针已移动到 ({x},{y})"))
        }
        "desktop_scroll" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let (x, y) = (coord(args, "x")?, coord(args, "y")?);
            let direction = args
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("down");
            let amount = args
                .get("amount")
                .and_then(Value::as_i64)
                .unwrap_or(600)
                .max(0);
            let button = match direction {
                "up" => "4",
                "down" => "5",
                "left" => "6",
                "right" => "7",
                other => return Err(format!("不支持的滚动方向: {other:?}(up/down/left/right)")),
            };
            let clicks = (amount / 120).clamp(1, 50);
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("scroll({direction},{amount})"),
            )
            .await;
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("mousemove {x} {y} click --repeat {clicks} --delay 60 {button}"),
            )
            .await?;
            Ok(format!("已在 ({x},{y}) 向 {direction} 滚动 {clicks} 格"))
        }
        "desktop_drag" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let (x1, y1, x2, y2) = (
                coord(args, "fromX")?,
                coord(args, "fromY")?,
                coord(args, "toX")?,
                coord(args, "toY")?,
            );
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("drag({x1},{y1}→{x2},{y2})"),
            )
            .await;
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!(
                    "mousemove {x1} {y1} mousedown 1 mousemove --delay 300 {x2} {y2} mouseup 1"
                ),
            )
            .await?;
            Ok(format!("已拖拽 ({x1},{y1}) → ({x2},{y2})"))
        }
        "desktop_type" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let text = arg_str(args, "text")?;
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("type({} 字符)", text.chars().count()),
            )
            .await;
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("type --delay 20 -- {}", sh_quote(text)),
            )
            .await?;
            Ok(format!("已输入 {} 字符", text.chars().count()))
        }
        "desktop_press_key" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let key = map_key(arg_str(args, "key")?)?;
            record_frame(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("press_key({key})"),
            )
            .await;
            xdotool_wrapped(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance,
                &format!("key {key}"),
            )
            .await?;
            Ok(format!("已按键 {key}"))
        }
        "desktop_exec" => {
            let ctx = sandbox_ctx(bridge, &manager, pool, session_id, args, true).await?;
            guard_takeover(&manager, &ctx.instance).await?;
            let command = arg_str(args, "command")?;
            let timeout = args
                .get("timeoutSec")
                .and_then(Value::as_i64)
                .unwrap_or(60)
                .clamp(1, 600);
            let (stdout, stderr, exit_code) = sandbox_exec(
                bridge,
                &manager,
                &ctx.platform,
                &ctx.conn_id,
                &ctx.instance.container_id,
                command,
                timeout,
            )
            .await?;
            Ok([
                stdout,
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("[stderr]\n{stderr}")
                },
                if exit_code > 0 {
                    format!("[exit {exit_code}]")
                } else {
                    String::new()
                },
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
        }
        "desktop_request_user_action" => {
            request_user_action(bridge, &manager, pool, session_id, args).await
        }
        other => Err(format!("Unknown desktop tool: {other}")),
    }
}

/// 请求用户人工介入(扫码登录/输密码/短信验证等):广播横幅事件,等用户
/// 在直播 tab 点「已完成」;超时/窗口无人应答都收敛为可恢复的文本结果,
/// 模型可据此重试或改用其它方案。
async fn request_user_action(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    pool: &SqlitePool,
    session_id: &str,
    args: &Value,
) -> Result<String, String> {
    // 请求总是绑定当前授权沙箱(用户需要知道在哪个画面里操作)
    let (instance, _) = resolve_sandbox(pool, manager, session_id, args, true).await?;
    let message = arg_str(args, "message")?;
    let timeout_seconds = args
        .get("timeoutSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(300)
        .clamp(30, 1800);

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    manager
        .state
        .lock()
        .await
        .user_actions
        .insert(request_id.clone(), tx);

    bridge
        .emit(
            "starhub://desktop-user-action",
            serde_json::json!({
                "requestId": request_id,
                "sandboxId": instance.id,
                "containerId": instance.container_id,
                "novncPort": instance.novnc_port,
                "message": message,
                "timeoutSeconds": timeout_seconds,
            }),
        )
        .await;

    let outcome =
        tokio::time::timeout(std::time::Duration::from_secs(timeout_seconds as u64), rx).await;
    // 超时/发送端掉落都要把 pending 清掉(幂等:已应答时 remove 返回 None)
    manager.state.lock().await.user_actions.remove(&request_id);

    match outcome {
        Ok(Ok(true)) => Ok("用户已完成请求的操作。请重新 desktop_screenshot 确认界面状态后继续。".to_string()),
        Ok(Ok(false)) => Ok("用户取消了该请求(无法完成)。请与用户确认原因或改用其它方案。".to_string()),
        Ok(Err(_)) => Ok("请求通道异常关闭(应用可能在重启),请重试。".to_string()),
        Err(_) => Ok(format!(
            "等待超时({timeout_seconds} 秒):用户未完成操作。可重新发起、加大 timeoutSeconds,或改用其它方案。"
        )),
    }
}

async fn guard_takeover(manager: &DesktopManager, instance: &InstanceRow) -> Result<(), String> {
    if manager.is_takeover(&instance.container_id).await {
        return Err("用户正在接管沙箱操作,请稍后重试(接管不撤销授权)".to_string());
    }
    Ok(())
}

async fn xdotool_wrapped(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    instance: &InstanceRow,
    args_line: &str,
) -> Result<String, String> {
    xdotool(
        bridge,
        manager,
        platform,
        conn_id,
        &instance.container_id,
        args_line,
    )
    .await
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}

// ============================================================
// 模板与生命周期
// ============================================================

/// 模板表为空时播种内置默认模板。
async fn seed_default_template(pool: &SqlitePool) -> Result<(), String> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sandbox_templates")
        .fetch_one(pool)
        .await
        .map_err(|e| format!("统计模板失败: {e}"))?;
    if count == 0 {
        sqlx::query("INSERT INTO sandbox_templates (id, name, recipe) VALUES (?, ?, ?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind("ubuntu-desktop")
            .bind(recipe::DEFAULT_RECIPE_TOML)
            .execute(pool)
            .await
            .map_err(|e| format!("播种默认模板失败: {e}"))?;
    }
    Ok(())
}

async fn list_templates(pool: &SqlitePool) -> Result<String, String> {
    seed_default_template(pool).await?;
    let rows = sqlx::query(
        "SELECT name, image_tag, created_at FROM sandbox_templates ORDER BY created_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("列出模板失败: {e}"))?;
    let mut lines = vec!["模板名 | 镜像状态 | 创建时间".to_string()];
    for row in rows {
        let name: String = row.try_get("name").map_err(|e| e.to_string())?;
        let image_tag: Option<String> = row.try_get("image_tag").map_err(|e| e.to_string())?;
        let created: i64 = row.try_get("created_at").map_err(|e| e.to_string())?;
        let state = if image_tag.is_some() {
            "已构建"
        } else {
            "未构建"
        };
        lines.push(format!(
            "{name} | {state} | {}",
            chrono::DateTime::from_timestamp(created, 0)
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default()
        ));
    }
    Ok(lines.join("\n"))
}

async fn load_recipe(
    pool: &SqlitePool,
    template: &str,
) -> Result<(String, recipe::SandboxRecipe), String> {
    let row = sqlx::query("SELECT id, recipe FROM sandbox_templates WHERE name = ? OR id = ?")
        .bind(template)
        .bind(template)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("读取模板失败: {e}"))?
        .ok_or_else(|| format!("模板不存在: {template}(先 desktop_list_templates 查看)"))?;
    let id: String = row.try_get("id").map_err(|e| e.to_string())?;
    let toml_text: String = row.try_get("recipe").map_err(|e| e.to_string())?;
    Ok((id, recipe::parse_recipe(&toml_text)?))
}

async fn build_template(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    args: &Value,
) -> Result<String, String> {
    let template = arg_str(args, "template")?;
    let (template_id, recipe) = load_recipe(pool, template).await?;
    let dockerfile = recipe::generate_dockerfile(&recipe);
    let tag = recipe::image_tag(&recipe);
    // 首次构建 5-15 分钟,远超 sidecar 默认 120 秒;给 30 分钟上限。
    // 超时降级:Dockerfile 落盘缓存目录,把手工 docker build 命令交给用户
    // (daemon 层缓存全局共享,手动完成后重调本工具即命中缓存秒过)。
    let result = match platform_call_with_timeout(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.buildImage",
        serde_json::json!({ "dockerfile": dockerfile, "tag": tag, "pullParent": true }),
        Some(std::time::Duration::from_secs(1800)),
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.contains("timed out") => {
            return manual_build_fallback(bridge, &dockerfile, &tag, &error);
        }
        Err(error) => return Err(error),
    };
    sqlx::query("UPDATE sandbox_templates SET image_tag = ? WHERE id = ?")
        .bind(&tag)
        .bind(&template_id)
        .execute(pool)
        .await
        .map_err(|e| format!("更新模板镜像标记失败: {e}"))?;
    let lines = result
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tail = lines
        .iter()
        .filter_map(Value::as_str)
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Ok(format!(
        "模板 {template} 构建完成,镜像 {tag}。\n构建输出尾部:\n{tail}"
    ))
}

async fn ensure_image(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    tag: &str,
) -> Result<bool, String> {
    let images = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.listImages",
        serde_json::json!({ "all": false }),
    )
    .await?;
    let found = images
        .as_array()
        .map(|list| {
            list.iter().any(|img| {
                img.get("tags")
                    .and_then(Value::as_array)
                    .map(|tags| tags.iter().any(|t| t.as_str() == Some(tag)))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    Ok(found)
}

async fn ensure_restricted_network(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
) -> Result<(), String> {
    let result = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.createNetwork",
        serde_json::json!({
            "name": recipe::RESTRICTED_NETWORK,
            "internal": false,
            "labels": { "starhub.sandbox": "true" },
        }),
    )
    .await;
    match result {
        Ok(_) => Ok(()),
        // 已存在不算错误(竞态/复用)。
        Err(e) if e.contains("exist") => Ok(()),
        Err(e) => Err(e),
    }
}

async fn create_sandbox(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    session_id: &str,
    args: &Value,
) -> Result<String, String> {
    let template = args
        .get("template")
        .and_then(Value::as_str)
        .unwrap_or("ubuntu-desktop");
    let task = args
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (template_id, recipe) = load_recipe(pool, template).await?;
    let tag = recipe::image_tag(&recipe);

    if !ensure_image(bridge, manager, platform, conn_id, &tag).await? {
        return Err(format!(
            "模板 {template} 的镜像尚未构建:请先调用 desktop_build_template(template=\"{template}\")构建(首次约 5-15 分钟)"
        ));
    }

    let network_mode = match recipe.network.as_str() {
        "none" => "none".to_string(),
        "full" => "bridge".to_string(),
        _ => {
            ensure_restricted_network(bridge, manager, platform, conn_id).await?;
            recipe::RESTRICTED_NETWORK.to_string()
        }
    };

    let sandbox_id = uuid::Uuid::new_v4().to_string();
    let container_name = format!("starhub-sandbox-{}", &sandbox_id.replace('-', "")[..8]);
    let create = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.createContainer",
        serde_json::json!({
            "name": container_name,
            "image": tag,
            "env": [format!("RESOLUTION={}", recipe.resolution)],
            "labels": {
                "starhub.sandbox": "true",
                "starhub.sandbox.id": sandbox_id,
                "starhub.sandbox.template": recipe.name,
            },
            "ports": [{ "containerPort": recipe::NOVNC_CONTAINER_PORT, "hostPort": 0 }],
            "memoryMb": recipe.memory_mb,
            "cpuCores": recipe.cpus,
            "capDrop": ["ALL"],
            "securityOpt": ["no-new-privileges"],
            "readonlyRootfs": recipe.readonly_rootfs,
            "networkMode": network_mode,
            "start": true,
        }),
    )
    .await?;
    let container_id = create
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "createContainer 未返回 id".to_string())?
        .to_string();
    let novnc_port = create
        .get("ports")
        .and_then(Value::as_array)
        .and_then(|ports| {
            ports.iter().find_map(|p| {
                (p.get("private").and_then(Value::as_i64) == Some(recipe::NOVNC_CONTAINER_PORT))
                    .then(|| p.get("public").and_then(Value::as_i64).unwrap_or(0))
            })
        })
        .unwrap_or(0);

    sqlx::query(
        "INSERT INTO sandbox_instances (id, template_id, container_id, platform, novnc_port, status, session_id, task) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(&sandbox_id)
    .bind(&template_id)
    .bind(&container_id)
    .bind(platform)
    .bind(novnc_port)
    .bind(session_id)
    .bind(&task)
    .execute(pool)
    .await
    .map_err(|e| format!("登记沙箱实例失败: {e}"))?;

    manager.grant(session_id, &sandbox_id).await;

    Ok(format!(
        "沙箱已创建并启动(任务授权 {ttl} 分钟内有效):\n\
         沙箱 id:{sandbox_id}\n\
         模板:{template} | 网络:{network}\n\
         noVNC 直播:http://127.0.0.1:{novnc_port}/vnc.html(用户可在沙箱 tab 围观/接管)\n\
         接下来用 desktop_screenshot 看屏幕,用 desktop_click/desktop_type 等操作;\
         遇到登录墙调用 desktop_request_user_action 请用户协助。",
        ttl = AUTHZ_TTL_SECS / 60,
        network = recipe.network,
    ))
}

async fn list_running_sandboxes(pool: &SqlitePool) -> Result<String, String> {
    let rows = sqlx::query(
        "SELECT id, status, task, novnc_port FROM sandbox_instances WHERE status != 'destroyed' ORDER BY created_at DESC LIMIT 10",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("列出沙箱失败: {e}"))?;
    if rows.is_empty() {
        return Ok("当前没有运行中的沙箱实例".to_string());
    }
    let mut lines = vec!["沙箱 id | 状态 | noVNC 端口 | 任务".to_string()];
    for row in rows {
        lines.push(format!(
            "{} | {} | {} | {}",
            row.try_get::<String, _>("id").map_err(|e| e.to_string())?,
            row.try_get::<String, _>("status")
                .map_err(|e| e.to_string())?,
            row.try_get::<i64, _>("novnc_port")
                .map_err(|e| e.to_string())?,
            row.try_get::<String, _>("task")
                .map_err(|e| e.to_string())?,
        ));
    }
    Ok(lines.join("\n"))
}

async fn sandbox_status(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    instance: &InstanceRow,
) -> Result<String, String> {
    // 活性核对:容器不在则标记销毁
    let inspect = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.inspectContainer",
        serde_json::json!({ "containerId": instance.container_id }),
    )
    .await;
    if inspect.is_err() {
        mark_instance(pool, &instance.id, "destroyed").await;
        return Err(format!("沙箱 {} 的容器已不存在(已标记销毁)", instance.id));
    }
    let takeover = manager.is_takeover(&instance.container_id).await;
    Ok(format!(
        "沙箱 {}\n状态:{} | 接管:{}\nnoVNC:http://127.0.0.1:{}/vnc.html\n任务:{}",
        instance.id,
        instance.status,
        if takeover { "用户接管中" } else { "否" },
        instance.novnc_port,
        instance.task,
    ))
}

async fn pause_resume(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    instance: &InstanceRow,
    resume: bool,
) -> Result<String, String> {
    let method = if resume {
        "docker.unpauseContainer"
    } else {
        "docker.pauseContainer"
    };
    platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        method,
        serde_json::json!({ "containerId": instance.container_id }),
    )
    .await?;
    mark_instance(
        pool,
        &instance.id,
        if resume { "running" } else { "paused" },
    )
    .await;
    Ok(format!(
        "沙箱 {} 已{}",
        instance.id,
        if resume { "恢复" } else { "暂停" }
    ))
}

async fn destroy_sandbox(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    instance: &InstanceRow,
) -> Result<String, String> {
    let _ = platform_call(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.removeContainer",
        serde_json::json!({ "containerId": instance.container_id, "force": true }),
    )
    .await;
    mark_instance(pool, &instance.id, "destroyed").await;
    manager.revoke_sandbox(&instance.id).await;
    let frames: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sandbox_replay_frames WHERE sandbox_id = ?")
            .bind(&instance.id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    Ok(format!(
        "沙箱 {} 已销毁(回放帧 {frames} 条已归档,可 desktop_sandbox_replay 查看)",
        instance.id
    ))
}

/// 登录态沉淀:实例 commit → 新模板(base 指向固化镜像,install/provision 已烤入)。
async fn commit_sandbox(
    bridge: &HostBridgeState,
    manager: &DesktopManager,
    platform: &str,
    conn_id: &str,
    pool: &SqlitePool,
    instance: &InstanceRow,
    args: &Value,
) -> Result<String, String> {
    let new_name = arg_str(args, "name")?;
    let reference = format!("starhub-sandbox-{new_name}:latest");
    // 大层固化可能超过 120 秒,给 10 分钟上限;超时降级为手工 docker commit 提示
    // (commit 可能已在 daemon 侧完成,提示用户核对镜像后由 AI 重试)。
    let result = match platform_call_with_timeout(
        bridge,
        manager,
        platform,
        conn_id,
        "docker.commitContainer",
        serde_json::json!({
            "containerId": instance.container_id,
            "reference": reference,
            "comment": format!("committed from sandbox {}", instance.id),
        }),
        Some(std::time::Duration::from_secs(600)),
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.contains("timed out") => {
            return Ok(format!(
                "固化超时(超过 10 分钟):{error}\n\ncommit 可能已在 Docker daemon 侧继续执行完成。请人工核对:\n  docker images | grep {reference}\n若镜像不存在,可手动执行:\n  docker commit {} {reference}\n完成后再次调用 desktop_commit_sandbox 即可。",
                instance.container_id,
            ));
        }
        Err(error) => return Err(error),
    };
    let image_id = result
        .get("imageId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    // 新模板:base 指向固化镜像,软件层已在镜像里,install/provision 清空。
    let new_recipe = format!(
        "name = \"{new_name}\"\nbase = \"{reference}\"\nnetwork = \"restricted\"\ninstall = []\nprovision = []\n"
    );
    let parsed = recipe::parse_recipe(&new_recipe)?;
    sqlx::query("INSERT INTO sandbox_templates (id, name, recipe, image_tag) VALUES (?, ?, ?, ?)")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&parsed.name)
        .bind(&new_recipe)
        .bind(&reference)
        .execute(pool)
        .await
        .map_err(|e| format!("登记固化模板失败: {e}"))?;

    Ok(format!(
        "已固化为新模板 {new_name}(镜像 {reference},{image_id})。\
         登录态/已装软件随镜像保存;下次 desktop_create_sandbox(template=\"{new_name}\") 直接使用。"
    ))
}

async fn sandbox_replay(pool: &SqlitePool, args: &Value) -> Result<String, String> {
    let sandbox_id = arg_str(args, "sandboxId")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 500);
    let rows = sqlx::query(
        "SELECT action, shot_path, created_at FROM sandbox_replay_frames WHERE sandbox_id = ? ORDER BY id LIMIT ?",
    )
    .bind(sandbox_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("读取回放帧失败: {e}"))?;
    if rows.is_empty() {
        return Ok(format!("沙箱 {sandbox_id} 没有回放帧"));
    }
    let mut lines = vec![format!("沙箱 {sandbox_id} 回放(帧 | 时间 | 截图):")];
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sh_quote_escapes_single_quotes() {
        assert_eq!(sh_quote("hello"), "'hello'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn map_key_accepts_common_and_combos() {
        assert_eq!(map_key("Enter").unwrap(), "Return");
        assert_eq!(map_key("ctrl+s").unwrap(), "ctrl+s");
        assert_eq!(map_key("Ctrl+Shift+S").unwrap(), "ctrl+shift+s");
        assert_eq!(map_key("ArrowUp").unwrap(), "Up");
        assert_eq!(map_key("F5").unwrap(), "F5");
        assert!(map_key("a;rm -rf /").is_err());
        assert!(map_key("$(reboot)").is_err());
    }

    #[test]
    fn mouse_button_mapping() {
        assert_eq!(mouse_button("").unwrap(), "1");
        assert_eq!(mouse_button("right").unwrap(), "3");
        assert!(mouse_button("x1").is_err());
    }

    #[test]
    fn coord_requires_numbers() {
        assert_eq!(coord(&json!({"x": 42}), "x").unwrap(), 42);
        assert!(coord(&json!({}), "x").is_err());
    }
}
