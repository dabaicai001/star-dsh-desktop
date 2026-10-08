//! 沙箱桌面工具执行体(22 个 `desktop_*` 方法,从 `src-tauri/src/desktop/mod.rs`
//! 平移;结果文本逐字保持——模型可读文本是契约)。
//!
//! 与 Tauri 版的差异只有注入点:`bridge` / `app.state` / `crate::db` 全部换成
//! [`Desktop`](crate::Desktop) 上下文里的 trait 对象。安全语义(任务授权 /
//! 接管互斥 / 写前截屏)在执行点强制,与宿主无关。

use std::time::Duration;

use serde_json::{json, Value};

use crate::keys::{arg_str, coord, map_key, mouse_button, sh_quote, x11};
use crate::recipe;
use crate::store::InstanceRow;
use crate::{Desktop, DesktopManager};

/// 本模块处理的 AI 工具清单。
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
    // 人机协作:请求用户人工介入
    "desktop_request_user_action",
];

/// 设置表 key:沙箱平台 Docker 连接(资产 id);空 = 本机。
pub const PLATFORM_SETTING_KEY: &str = "desktop.platform_asset_id";

/// 平台连接(设置选择器语义)。
struct Platform {
    key: String,
    conn_id: String,
}

/// 解析平台连接:显式给 key(实例落库时记录的 platform)则用其连接,
/// 否则读设置页选择(空 = 本机)。返回 (platform_key, connId)。
async fn platform_conn(
    desktop: &Desktop<'_>,
    key_override: Option<&str>,
) -> Result<Platform, String> {
    let key = match key_override {
        Some(k) => k.to_string(),
        None => {
            let asset_id = desktop
                .settings
                .get(PLATFORM_SETTING_KEY)
                .await?
                .filter(|v| !v.trim().is_empty());
            asset_id.unwrap_or_else(|| "local".to_string())
        }
    };
    if let Some(conn_id) = desktop.manager.cached_conn(&key).await {
        return Ok(Platform { key, conn_id });
    }

    let conn_id = if key == "local" {
        // 本机默认:空参 docker.connect,sidecar 端 client.FromEnv 按平台取默认 socket。
        desktop
            .sidecar
            .call("docker.connect", json!({}))
            .await?
            .get("connId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "docker.connect(本机)未返回 connId".to_string())?
    } else {
        let (asset_type, config) = desktop.assets.load(&key).await?;
        if asset_type != "docker" {
            return Err(format!(
                "沙箱平台连接 {key} 不是 Docker 资产({asset_type}),请到设置页重选"
            ));
        }
        connect_docker(desktop, &config).await?
    };
    desktop.manager.cache_conn(&key, &conn_id).await;
    Ok(Platform { key, conn_id })
}

/// 按 Docker 资产配置建连(SSH 传输时解析 dockerSshAssetId 指向的 SSH 资产)。
async fn connect_docker(desktop: &Desktop<'_>, config: &Value) -> Result<String, String> {
    let transport = config
        .get("dockerTransport")
        .and_then(Value::as_str)
        .unwrap_or("");
    let transport = if transport.is_empty() {
        if config
            .get("remoteHost")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            "socket"
        } else {
            "tcp"
        }
    } else {
        transport
    };
    let params = match transport {
        "tcp" => json!({
            "transport": "tcp",
            "host": config.get("remoteHost").and_then(Value::as_str).unwrap_or(""),
        }),
        "socket" => {
            let socket_path = config
                .get("socketPath")
                .and_then(Value::as_str)
                .unwrap_or("");
            let socket_path = if socket_path.is_empty() {
                "/var/run/docker.sock".to_string()
            } else {
                socket_path.to_string()
            };
            json!({
                "transport": "socket",
                "host": if socket_path.contains("://") { socket_path } else { format!("unix://{socket_path}") },
            })
        }
        "ssh" => {
            // SSH 传输:资产配置经 AssetConfigSource 解析(含密钥),与
            // starhub-domain-db::docker_params 的 ssh 子对象契约一致。
            let ssh_asset_id = config
                .get("dockerSshAssetId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| "Docker SSH 传输需要配置 SSH 资产(dockerSshAssetId)".to_string())?
                .to_string();
            let (_asset_type, ssh_config) = desktop.assets.load(&ssh_asset_id).await?;
            let host = ssh_config.get("host").and_then(Value::as_str).unwrap_or("");
            let username = ssh_config
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("");
            if host.is_empty() || username.is_empty() {
                return Err(format!(
                    "Docker SSH 资产「{ssh_asset_id}」配置不完整(缺 host 或 username)"
                ));
            }
            let port = ssh_config.get("port").and_then(Value::as_u64).unwrap_or(22) as u16;
            let known_host_key = desktop
                .known_hosts
                .trusted_public_key(host, port)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    format!("Docker SSH 主机 {host} 尚未确认主机密钥,请先在 SSH 终端连接一次")
                })?;
            let password = ssh_config
                .get("password")
                .and_then(Value::as_str)
                .unwrap_or("");
            let private_key = ssh_config
                .get("privateKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            let passphrase = ssh_config
                .get("passphrase")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty());
            let jump_host = ssh_config
                .get("jumpHost")
                .and_then(Value::as_str)
                .unwrap_or("");
            let mut ssh = json!({
                "host": host,
                "port": port,
                "username": username,
                "password": password,
                "privateKey": private_key,
                "passphrase": passphrase,
                "knownHostKey": known_host_key,
            });
            if !jump_host.is_empty() {
                let jump_port = ssh_config
                    .get("jumpPort")
                    .and_then(Value::as_u64)
                    .unwrap_or(22) as u16;
                ssh["jumpHost"] = Value::String(jump_host.to_string());
                ssh["jumpPort"] = json!(jump_port);
                ssh["jumpUsername"] = Value::String(
                    ssh_config
                        .get("jumpUsername")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
                ssh["jumpPassword"] = Value::String(
                    ssh_config
                        .get("jumpPassword")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
                ssh["jumpPrivateKey"] = Value::String(
                    ssh_config
                        .get("jumpPrivateKey")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
                ssh["jumpPassphrase"] = Value::String(
                    ssh_config
                        .get("jumpPassphrase")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
                if let Some(jump_key) = desktop
                    .known_hosts
                    .trusted_public_key(jump_host, jump_port)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    ssh["jumpKnownHostKey"] = Value::String(jump_key);
                }
            }
            json!({
                "transport": "ssh",
                "host": config.get("remoteHost").and_then(Value::as_str).unwrap_or(""),
                "socketPath": config.get("socketPath").and_then(Value::as_str).unwrap_or(""),
                "ssh": ssh,
            })
        }
        other => return Err(format!("不支持的 dockerTransport: {other}")),
    };
    let result = desktop.sidecar.call("docker.connect", params).await?;
    result
        .get("connId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("docker.connect 未返回 connId: {result}"))
}

/// sidecar 调用包装:失败时驱逐平台连接缓存(下次调用自动重连)。
async fn platform_call(
    desktop: &Desktop<'_>,
    platform: &Platform,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    platform_call_with_timeout(desktop, platform, method, params, None).await
}

async fn platform_call_with_timeout(
    desktop: &Desktop<'_>,
    platform: &Platform,
    method: &str,
    mut params: Value,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    params["connId"] = Value::String(platform.conn_id.clone());
    let result = match timeout {
        Some(t) => desktop.sidecar.call_with_timeout(method, params, t).await,
        None => desktop.sidecar.call(method, params).await,
    };
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            desktop.manager.evict_conn(&platform.key).await;
            Err(error)
        }
    }
}

// ============================================================
// 箱内命令执行(xdotool / scrot 全家桶)
// ============================================================

async fn sandbox_exec(
    desktop: &Desktop<'_>,
    platform: &Platform,
    container_id: &str,
    script: &str,
    timeout_sec: i64,
) -> Result<(String, String, i64), String> {
    // RPC 层超时必须盖过 docker exec 自身的 timeoutSec(默认 RPC 只有 120 秒,
    // 装包/下载类长命令会在 RPC 层先超时);留 30 秒余量给输出回收。
    let result = platform_call_with_timeout(
        desktop,
        platform,
        "docker.exec",
        json!({
            "containerId": container_id,
            "command": ["sh", "-c", script],
            "timeoutSec": timeout_sec,
        }),
        Some(Duration::from_secs((timeout_sec.max(1) + 30) as u64)),
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

async fn xdotool(
    desktop: &Desktop<'_>,
    platform: &Platform,
    container_id: &str,
    args_line: &str,
) -> Result<String, String> {
    let (stdout, stderr, exit_code) = sandbox_exec(
        desktop,
        platform,
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

/// 实例绑定操作的上下文:实例 + 该实例落库时记录的平台连接。
/// 平台选择可能在实例创建后被用户改,沙箱操作必须打向实例自己的平台。
struct SandboxCtx {
    instance: InstanceRow,
    platform: Platform,
}

impl SandboxCtx {
    fn platform(&self) -> &Platform {
        &self.platform
    }
}

async fn sandbox_ctx(
    desktop: &Desktop<'_>,
    args: &Value,
    require_write_authz: bool,
) -> Result<SandboxCtx, String> {
    let sandbox_id = {
        let arg = args.get("sandboxId").and_then(Value::as_str);
        if require_write_authz {
            desktop
                .manager
                .require_authz(desktop.session_id, arg)
                .await?
        } else {
            match arg {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => {
                    desktop
                        .manager
                        .require_authz(desktop.session_id, None)
                        .await?
                }
            }
        }
    };
    let instance = desktop.store.load_instance(&sandbox_id).await?;
    if instance.status == "destroyed" {
        return Err(format!("沙箱 {sandbox_id} 已销毁"));
    }
    let platform = platform_conn(desktop, Some(&instance.platform)).await?;
    Ok(SandboxCtx { instance, platform })
}

// ============================================================
// 截图与回放
// ============================================================

/// 箱内 scrot → copyFromContainer → 落缓存目录 desktop-shots/。
async fn capture_screenshot(
    desktop: &Desktop<'_>,
    platform: &Platform,
    container_id: &str,
    sandbox_id: &str,
) -> Result<String, String> {
    let shot_name = "/tmp/starhub-shot.png";
    let (_out, stderr, exit_code) = sandbox_exec(
        desktop,
        platform,
        container_id,
        &x11(&format!("scrot -o -z {shot_name}")),
        30,
    )
    .await?;
    if exit_code != 0 {
        return Err(format!("沙箱内截图失败(exit {exit_code}): {stderr}"));
    }
    let file = platform_call(
        desktop,
        platform,
        "docker.copyFromContainer",
        json!({ "containerId": container_id, "srcPath": shot_name }),
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

    let dir = desktop.cache.dir("desktop-shots")?;
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
    desktop: &Desktop<'_>,
    dockerfile: &str,
    tag: &str,
    error: &str,
) -> Result<String, String> {
    let dir = desktop
        .cache
        .dir(&format!("desktop-build/{}", tag.replace(':', "_")))?;
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
    desktop: &Desktop<'_>,
    platform: &Platform,
    instance: &InstanceRow,
    action: &str,
) {
    let shot = capture_screenshot(desktop, platform, &instance.container_id, &instance.id).await;
    let (action_text, shot_path) = match &shot {
        Ok(path) => (action.to_string(), Some(path.clone())),
        Err(error) => {
            tracing::warn!("回放帧截图失败({}): {error}", instance.id);
            (format!("{action}(截屏失败)"), None)
        }
    };
    if let Err(e) = desktop
        .store
        .insert_frame(&instance.id, &action_text, shot_path.as_deref())
        .await
    {
        tracing::warn!("回放帧落库失败: {e}");
    }
}

async fn guard_takeover(manager: &DesktopManager, instance: &InstanceRow) -> Result<(), String> {
    if manager.is_takeover(&instance.container_id).await {
        return Err("用户正在接管沙箱操作,请稍后重试(接管不撤销授权)".to_string());
    }
    Ok(())
}

async fn xdotool_wrapped(
    desktop: &Desktop<'_>,
    platform: &Platform,
    instance: &InstanceRow,
    args_line: &str,
) -> Result<String, String> {
    xdotool(desktop, platform, &instance.container_id, args_line).await
}

// ============================================================
// 模板与生命周期
// ============================================================

async fn list_templates(desktop: &Desktop<'_>) -> Result<String, String> {
    desktop.store.seed_default_template().await?;
    let rows = desktop.store.list_templates().await?;
    let mut lines = vec!["模板名 | 镜像状态 | 创建时间".to_string()];
    for row in rows {
        let state = if row.image_tag.is_some() {
            "已构建"
        } else {
            "未构建"
        };
        lines.push(format!(
            "{} | {state} | {}",
            row.name,
            chrono::DateTime::from_timestamp(row.created_at, 0)
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default()
        ));
    }
    Ok(lines.join("\n"))
}

async fn build_template(
    desktop: &Desktop<'_>,
    platform: &Platform,
    args: &Value,
) -> Result<String, String> {
    let template = arg_str(args, "template")?;
    let record = desktop.store.load_template(template).await?;
    let recipe = recipe::parse_recipe(&record.recipe)?;
    let dockerfile = recipe::generate_dockerfile(&recipe);
    let tag = recipe::image_tag(&recipe);
    // 首次构建 5-15 分钟,远超 sidecar 默认 120 秒;给 30 分钟上限。
    // 超时降级:Dockerfile 落盘缓存目录,把手工 docker build 命令交给用户
    // (daemon 层缓存全局共享,手动完成后重调本工具即命中缓存秒过)。
    let result = match platform_call_with_timeout(
        desktop,
        platform,
        "docker.buildImage",
        json!({ "dockerfile": dockerfile, "tag": tag, "pullParent": true }),
        Some(Duration::from_secs(1800)),
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.contains("timed out") => {
            return manual_build_fallback(desktop, &dockerfile, &tag, &error);
        }
        Err(error) => return Err(error),
    };
    desktop.store.set_template_image(&record.id, &tag).await?;
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
    desktop: &Desktop<'_>,
    platform: &Platform,
    tag: &str,
) -> Result<bool, String> {
    let images = platform_call(
        desktop,
        platform,
        "docker.listImages",
        json!({ "all": false }),
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
    desktop: &Desktop<'_>,
    platform: &Platform,
) -> Result<(), String> {
    let result = platform_call(
        desktop,
        platform,
        "docker.createNetwork",
        json!({
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
    desktop: &Desktop<'_>,
    platform: &Platform,
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
    let record = desktop.store.load_template(template).await?;
    let recipe = recipe::parse_recipe(&record.recipe)?;
    let tag = recipe::image_tag(&recipe);

    if !ensure_image(desktop, platform, &tag).await? {
        return Err(format!(
            "模板 {template} 的镜像尚未构建:请先调用 desktop_build_template(template=\"{template}\")构建(首次约 5-15 分钟)"
        ));
    }

    let network_mode = match recipe.network.as_str() {
        "none" => "none".to_string(),
        "full" => "bridge".to_string(),
        _ => {
            ensure_restricted_network(desktop, platform).await?;
            recipe::RESTRICTED_NETWORK.to_string()
        }
    };

    let sandbox_id = uuid::Uuid::new_v4().to_string();
    let container_name = format!("starhub-sandbox-{}", &sandbox_id.replace('-', "")[..8]);
    let create = platform_call(
        desktop,
        platform,
        "docker.createContainer",
        json!({
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

    desktop
        .store
        .insert_instance(
            &InstanceRow {
                id: sandbox_id.clone(),
                container_id,
                platform: platform.key.clone(),
                novnc_port,
                status: "running".to_string(),
                task: task.clone(),
            },
            &record.id,
            desktop.session_id,
        )
        .await?;

    desktop.manager.grant(desktop.session_id, &sandbox_id).await;

    Ok(format!(
        "沙箱已创建并启动(任务授权 {ttl} 分钟内有效):\n\
         沙箱 id:{sandbox_id}\n\
         模板:{template} | 网络:{network}\n\
         noVNC 直播:http://127.0.0.1:{novnc_port}/vnc.html(用户可在沙箱 tab 围观/接管)\n\
         接下来用 desktop_screenshot 看屏幕,用 desktop_click/desktop_type 等操作;\
         遇到登录墙调用 desktop_request_user_action 请用户协助。",
        ttl = crate::manager::AUTHZ_TTL_SECS / 60,
        network = recipe.network,
    ))
}

async fn list_running_sandboxes(desktop: &Desktop<'_>) -> Result<String, String> {
    let rows = desktop.store.list_running().await?;
    if rows.is_empty() {
        return Ok("当前没有运行中的沙箱实例".to_string());
    }
    let mut lines = vec!["沙箱 id | 状态 | noVNC 端口 | 任务".to_string()];
    for row in rows {
        lines.push(format!(
            "{} | {} | {} | {}",
            row.id, row.status, row.novnc_port, row.task
        ));
    }
    Ok(lines.join("\n"))
}

async fn sandbox_status(desktop: &Desktop<'_>, ctx: &SandboxCtx) -> Result<String, String> {
    // 活性核对:容器不在则标记销毁
    let inspect = platform_call(
        desktop,
        ctx.platform(),
        "docker.inspectContainer",
        json!({ "containerId": ctx.instance.container_id }),
    )
    .await;
    if inspect.is_err() {
        desktop
            .store
            .mark_instance(&ctx.instance.id, "destroyed")
            .await?;
        return Err(format!(
            "沙箱 {} 的容器已不存在(已标记销毁)",
            ctx.instance.id
        ));
    }
    let takeover = desktop
        .manager
        .is_takeover(&ctx.instance.container_id)
        .await;
    Ok(format!(
        "沙箱 {}\n状态:{} | 接管:{}\nnoVNC:http://127.0.0.1:{}/vnc.html\n任务:{}",
        ctx.instance.id,
        ctx.instance.status,
        if takeover { "用户接管中" } else { "否" },
        ctx.instance.novnc_port,
        ctx.instance.task,
    ))
}

async fn pause_resume(
    desktop: &Desktop<'_>,
    ctx: &SandboxCtx,
    resume: bool,
) -> Result<String, String> {
    let method = if resume {
        "docker.unpauseContainer"
    } else {
        "docker.pauseContainer"
    };
    platform_call(
        desktop,
        ctx.platform(),
        method,
        json!({ "containerId": ctx.instance.container_id }),
    )
    .await?;
    desktop
        .store
        .mark_instance(&ctx.instance.id, if resume { "running" } else { "paused" })
        .await?;
    Ok(format!(
        "沙箱 {} 已{}",
        ctx.instance.id,
        if resume { "恢复" } else { "暂停" }
    ))
}

async fn destroy_sandbox(desktop: &Desktop<'_>, ctx: &SandboxCtx) -> Result<String, String> {
    let _ = platform_call(
        desktop,
        ctx.platform(),
        "docker.removeContainer",
        json!({ "containerId": ctx.instance.container_id, "force": true }),
    )
    .await;
    desktop
        .store
        .mark_instance(&ctx.instance.id, "destroyed")
        .await?;
    desktop.manager.revoke_sandbox(&ctx.instance.id).await;
    let frames = desktop.store.count_frames(&ctx.instance.id).await?;
    Ok(format!(
        "沙箱 {} 已销毁(回放帧 {frames} 条已归档,可 desktop_sandbox_replay 查看)",
        ctx.instance.id
    ))
}

/// 登录态沉淀:实例 commit → 新模板(base 指向固化镜像,install/provision 已烤入)。
async fn commit_sandbox(
    desktop: &Desktop<'_>,
    ctx: &SandboxCtx,
    args: &Value,
) -> Result<String, String> {
    let new_name = arg_str(args, "name")?;
    let reference = format!("starhub-sandbox-{new_name}:latest");
    // 大层固化可能超过 120 秒,给 10 分钟上限;超时降级为手工 docker commit 提示
    // (commit 可能已在 daemon 侧完成,提示用户核对镜像后由 AI 重试)。
    let result = match platform_call_with_timeout(
        desktop,
        ctx.platform(),
        "docker.commitContainer",
        json!({
            "containerId": ctx.instance.container_id,
            "reference": reference,
            "comment": format!("committed from sandbox {}", ctx.instance.id),
        }),
        Some(Duration::from_secs(600)),
    )
    .await
    {
        Ok(value) => value,
        Err(error) if error.contains("timed out") => {
            return Ok(format!(
                "固化超时(超过 10 分钟):{error}\n\ncommit 可能已在 Docker daemon 侧继续执行完成。请人工核对:\n  docker images | grep {reference}\n若镜像不存在,可手动执行:\n  docker commit {} {reference}\n完成后再次调用 desktop_commit_sandbox 即可。",
                ctx.instance.container_id,
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
    desktop
        .store
        .insert_template(&parsed.name, &new_recipe, &reference)
        .await?;

    Ok(format!(
        "已固化为新模板 {new_name}(镜像 {reference},{image_id})。\
         登录态/已装软件随镜像保存;下次 desktop_create_sandbox(template=\"{new_name}\") 直接使用。"
    ))
}

async fn sandbox_replay(desktop: &Desktop<'_>, args: &Value) -> Result<String, String> {
    let sandbox_id = arg_str(args, "sandboxId")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(50)
        .clamp(1, 500);
    let rows = desktop.store.list_frames(sandbox_id, limit).await?;
    if rows.is_empty() {
        return Ok(format!("沙箱 {sandbox_id} 没有回放帧"));
    }
    let mut lines = vec![format!("沙箱 {sandbox_id} 回放(帧 | 时间 | 截图):")];
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

/// 请求用户人工介入(扫码登录/输密码/短信验证等):广播横幅事件,等用户
/// 在直播 tab 点「已完成」;超时/窗口无人应答都收敛为可恢复的文本结果,
/// 模型可据此重试或改用其它方案。
async fn request_user_action(desktop: &Desktop<'_>, args: &Value) -> Result<String, String> {
    // 请求总是绑定当前授权沙箱(用户需要知道在哪个画面里操作)
    let sandbox_arg = args.get("sandboxId").and_then(Value::as_str);
    let sandbox_id = desktop
        .manager
        .require_authz(desktop.session_id, sandbox_arg)
        .await?;
    let instance = desktop.store.load_instance(&sandbox_id).await?;
    let message = arg_str(args, "message")?;
    let timeout_seconds = args
        .get("timeoutSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(300)
        .clamp(30, 1800);

    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = desktop.manager.register_user_action(&request_id).await;

    desktop
        .events
        .emit(
            "starhub://desktop-user-action",
            json!({
                "requestId": request_id,
                "sandboxId": instance.id,
                "containerId": instance.container_id,
                "novncPort": instance.novnc_port,
                "message": message,
                "timeoutSeconds": timeout_seconds,
            }),
        )
        .await;

    let outcome = tokio::time::timeout(Duration::from_secs(timeout_seconds as u64), rx).await;
    // 超时/发送端掉落都要把 pending 清掉(幂等:已应答时 remove 返回 None)
    desktop.manager.unregister_user_action(&request_id).await;

    match outcome {
        Ok(Ok(true)) => Ok("用户已完成请求的操作。请重新 desktop_screenshot 确认界面状态后继续。".to_string()),
        Ok(Ok(false)) => Ok("用户取消了该请求(无法完成)。请与用户确认原因或改用其它方案。".to_string()),
        Ok(Err(_)) => Ok("请求通道异常关闭(应用可能在重启),请重试。".to_string()),
        Err(_) => Ok(format!(
            "等待超时({timeout_seconds} 秒):用户未完成操作。可重新发起、加大 timeoutSeconds,或改用其它方案。"
        )),
    }
}

/// UI 生命周期入口(沙箱 tab 的停止/恢复/销毁按钮):与 AI 工具路径同一份
/// 编排,但**不经任务授权**——这是用户自己的手,按钮点击即审批表达。
/// action ∈ destroy / pause / resume。
pub async fn ui_lifecycle(
    desktop: &Desktop<'_>,
    sandbox_id: &str,
    action: &str,
) -> Result<String, String> {
    let instance = desktop.store.load_instance(sandbox_id).await?;
    if instance.status == "destroyed" {
        return Err(format!("沙箱 {sandbox_id} 已销毁"));
    }
    let platform = platform_conn(desktop, Some(&instance.platform)).await?;
    match action {
        "destroy" => destroy_sandbox(desktop, &SandboxCtx { instance, platform }).await,
        "pause" => pause_resume(desktop, &SandboxCtx { instance, platform }, false).await,
        "resume" => pause_resume(desktop, &SandboxCtx { instance, platform }, true).await,
        other => Err(format!("未知生命周期动作: {other}(destroy/pause/resume)")),
    }
}

/// 工具分发入口:返回模型可读文本。
pub async fn execute(desktop: &Desktop<'_>, name: &str, args: &Value) -> Result<String, String> {
    match name {
        "desktop_list_templates" => list_templates(desktop).await,
        "desktop_sandbox_replay" => sandbox_replay(desktop, args).await,
        "desktop_build_template" => {
            let platform = platform_conn(desktop, None).await?;
            build_template(desktop, &platform, args).await
        }
        "desktop_create_sandbox" => {
            let platform = platform_conn(desktop, None).await?;
            create_sandbox(desktop, &platform, args).await
        }
        "desktop_sandbox_status" => {
            // 无 sandboxId:列出全部未销毁实例,不要求授权
            if args.get("sandboxId").and_then(Value::as_str).is_none() {
                return list_running_sandboxes(desktop).await;
            }
            let ctx = sandbox_ctx(desktop, args, false).await?;
            sandbox_status(desktop, &ctx).await
        }
        "desktop_pause_sandbox" | "desktop_resume_sandbox" => {
            let ctx = sandbox_ctx(desktop, args, false).await?;
            pause_resume(desktop, &ctx, name == "desktop_resume_sandbox").await
        }
        "desktop_destroy_sandbox" => {
            let ctx = sandbox_ctx(desktop, args, false).await?;
            destroy_sandbox(desktop, &ctx).await
        }
        "desktop_commit_sandbox" => {
            let ctx = sandbox_ctx(desktop, args, false).await?;
            commit_sandbox(desktop, &ctx, args).await
        }
        "desktop_screenshot" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            let path = capture_screenshot(
                desktop,
                ctx.platform(),
                &ctx.instance.container_id,
                &ctx.instance.id,
            )
            .await?;
            Ok(format!(
                "已截取沙箱屏幕(PNG),保存于:{path}\n调用 read_image 读取该文件即可看到画面。"
            ))
        }
        "desktop_list_windows" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            let (stdout, stderr, exit_code) = sandbox_exec(
                desktop,
                ctx.platform(),
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
            let ctx = sandbox_ctx(desktop, args, true).await?;
            let (stdout, stderr, exit_code) = sandbox_exec(
                desktop,
                ctx.platform(),
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
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let window_id = arg_str(args, "windowId")?;
            record_frame(desktop, ctx.platform(), &ctx.instance, "focus_window").await;
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("windowactivate {}", sh_quote(window_id)),
            )
            .await?;
            Ok("已聚焦窗口".to_string())
        }
        "desktop_click" | "desktop_double_click" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let (x, y) = (coord(args, "x")?, coord(args, "y")?);
            let button = mouse_button(args.get("button").and_then(Value::as_str).unwrap_or(""))?;
            record_frame(
                desktop,
                ctx.platform(),
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
                desktop,
                ctx.platform(),
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
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let (x, y) = (coord(args, "x")?, coord(args, "y")?);
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("mousemove {x} {y}"),
            )
            .await?;
            Ok(format!("指针已移动到 ({x},{y})"))
        }
        "desktop_scroll" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
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
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("scroll({direction},{amount})"),
            )
            .await;
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("mousemove {x} {y} click --repeat {clicks} --delay 60 {button}"),
            )
            .await?;
            Ok(format!("已在 ({x},{y}) 向 {direction} 滚动 {clicks} 格"))
        }
        "desktop_drag" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let (x1, y1, x2, y2) = (
                coord(args, "fromX")?,
                coord(args, "fromY")?,
                coord(args, "toX")?,
                coord(args, "toY")?,
            );
            record_frame(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("drag({x1},{y1}→{x2},{y2})"),
            )
            .await;
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!(
                    "mousemove {x1} {y1} mousedown 1 mousemove --delay 300 {x2} {y2} mouseup 1"
                ),
            )
            .await?;
            Ok(format!("已拖拽 ({x1},{y1}) → ({x2},{y2})"))
        }
        "desktop_type" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let text = arg_str(args, "text")?;
            record_frame(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("type({} 字符)", text.chars().count()),
            )
            .await;
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("type --delay 20 -- {}", sh_quote(text)),
            )
            .await?;
            Ok(format!("已输入 {} 字符", text.chars().count()))
        }
        "desktop_press_key" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let key = map_key(arg_str(args, "key")?)?;
            record_frame(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("press_key({key})"),
            )
            .await;
            xdotool_wrapped(
                desktop,
                ctx.platform(),
                &ctx.instance,
                &format!("key {key}"),
            )
            .await?;
            Ok(format!("已按键 {key}"))
        }
        "desktop_exec" => {
            let ctx = sandbox_ctx(desktop, args, true).await?;
            guard_takeover(desktop.manager, &ctx.instance).await?;
            let command = arg_str(args, "command")?;
            let timeout = args
                .get("timeoutSec")
                .and_then(Value::as_i64)
                .unwrap_or(60)
                .clamp(1, 600);
            let (stdout, stderr, exit_code) = sandbox_exec(
                desktop,
                ctx.platform(),
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
        "desktop_request_user_action" => request_user_action(desktop, args).await,
        other => Err(format!("Unknown desktop tool: {other}")),
    }
}
