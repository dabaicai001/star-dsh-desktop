//! Built-in methods plus the domain method surface.
//!
//! `ping` is the liveness probe the bridge uses after spawn;
//! `starhub_list_capabilities` is the model-facing capability text (the
//! contract constant from `starhub-contract`), while `starhub/capabilities`
//! reports the live registry inventory for bridge diagnostics.
//!
//! Domain modules (ssh/sftp, then db/redis/es/docker; browser/android/desktop
//! next) register through the runtime shim: their handlers are async, the
//! registry surface stays synchronous, so [`registry_with_domains`] wraps each
//! handler in `Runtime::block_on`. The stdio loop processes one request at a
//! time, so blocking the loop thread for the duration of a domain call
//! preserves request/response ordering without any extra synchronization.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::android_runtime::AndroidRuntime;
use crate::db_runtime::DbRuntime;
use crate::desktop_runtime::DesktopRuntime;
use crate::jsonrpc::RpcError;
use crate::registry::{MethodRegistry, SIDECAR_PROTOCOL_VERSION};
use crate::runtime::SshRuntime;

pub mod android;
pub mod browser;
pub mod db;
pub mod desktop;
pub mod ssh;
pub mod ui;
pub mod ui_browser;
pub mod ui_db;
pub mod ui_devices;
pub mod ui_host;
pub mod ui_live;
pub mod ui_settings;
pub mod ui_ssh;

/// Liveness probe.
pub fn ping(_params: &Value) -> Result<Value, RpcError> {
    Ok(json!({ "pong": true, "protocol": SIDECAR_PROTOCOL_VERSION }))
}

/// Registry inventory report (bridge diagnostics; not a model-facing tool).
pub fn capabilities(registry: &MethodRegistry) -> Result<Value, RpcError> {
    Ok(json!({
        "protocol": SIDECAR_PROTOCOL_VERSION,
        "methods": registry.method_names(),
    }))
}

/// `starhub_list_capabilities` tool result: the model-facing capability text.
///
/// The text is the StarHub × dsh contract (契约 §1) and lives in
/// `starhub-contract`, shared with the retired Tauri host so it cannot drift.
/// The live method inventory is a separate bridge-only method
/// (`starhub/capabilities`) consumed by `starhub_sidecar_status`.
pub fn list_capabilities(_params: &Value) -> Result<Value, RpcError> {
    Ok(json!({ "text": starhub_contract::capabilities_text() }))
}

/// Build the registry with the built-in methods.
///
/// The capability report reads the live registry through a weak self
/// reference; dispatch only runs while the caller holds the strong `Arc`,
/// so the upgrade cannot fail in practice.
pub fn registry_with_builtins() -> Arc<MethodRegistry> {
    Arc::new_cyclic(|weak| {
        let mut registry = MethodRegistry::new();
        registry.register("ping", ping);
        registry.register("starhub_list_capabilities", list_capabilities);
        let handle: Weak<MethodRegistry> = weak.clone();
        registry.register("starhub/capabilities", move |_params| {
            let registry = handle.upgrade().expect("registry alive during dispatch");
            capabilities(&registry)
        });
        registry
    })
}

/// 注册一个异步域方法:闭包在 stdio 线程上 `block_on` 到完成。
///
/// 域 handler 形如 `async fn(&Runtime, &Value) -> Result<Value, RpcError>`;
/// future 在闭包体内创建并当场消费,借用不越过调用,因此 registry 的同步
/// handler 面(`Fn(&Value) -> Result<Value, RpcError>`)无需任何特判。
macro_rules! register_async {
    ($registry:expr, $runtime:expr, $state:expr, $name:literal, $handler:path) => {
        $registry.register($name, {
            let runtime = Arc::clone(&$runtime);
            let state = Arc::clone(&$state);
            move |params: &Value| runtime.block_on($handler(&state, params))
        });
    };
}

/// 批量注册同一运行时的异步域方法(UI 面 B 组:方法多、形态完全一致)。
macro_rules! register_async_all {
    ($registry:expr, $runtime:expr, $state:expr, $( $name:literal => $handler:path ),+ $(,)?) => {
        $(
            register_async!($registry, $runtime, $state, $name, $handler);
        )+
    };
}

/// Build the registry with the built-ins plus every registered domain method.
///
/// `runtime` drives the async domain handlers; `ssh` owns the SSH/SFTP session
/// state, `db` the Go sidecar client, `desktop` the sandbox-desktop state and
/// `android` the device state. `browser` is a unit placeholder: its engine
/// lands with M3, so the handlers take no runtime state. Keeping them behind
/// `Arc` lets the registered closures stay `'static + Send + Sync`.
///
/// `sink` and `bridge_state` complete the non-tool bridge surface
/// (`starhub/open.asset`, `starhub/focus.tool`, `starhub/live.snapshot`), so
/// the method inventory covers the whole protocol. `ui_state` carries the
/// UI-plane settings stores (audit log, alert rules) behind the `ui.*` methods.
/// `live_state` is the M3 live/takeover frame export (frame hub + WS server)
/// behind the `ui.live_*` methods and `starhub/live.endpoint`.
#[allow(clippy::too_many_arguments)]
pub fn registry_with_domains(
    runtime: Arc<Runtime>,
    ssh: Arc<SshRuntime>,
    db: Arc<DbRuntime>,
    desktop: Arc<DesktopRuntime>,
    android: Arc<AndroidRuntime>,
    _browser: Arc<()>,
    sink: Arc<dyn starhub_domain_ssh::events::EventSink>,
    bridge_state: Arc<crate::bridge::BridgeState>,
    ui_state: Arc<crate::ui_runtime::UiRuntime>,
    live_state: Arc<crate::live_runtime::LiveRuntime>,
) -> Arc<MethodRegistry> {
    Arc::new_cyclic(|weak| {
        let mut registry = MethodRegistry::new();
        registry.register("ping", ping);
        registry.register("starhub_list_capabilities", list_capabilities);
        let handle: Weak<MethodRegistry> = weak.clone();
        registry.register("starhub/capabilities", move |_params| {
            let registry = handle.upgrade().expect("registry alive during dispatch");
            capabilities(&registry)
        });

        // 全局:资产清单(依赖资产存储;模型发现资产 id 的入口)
        {
            let ssh = Arc::clone(&ssh);
            registry.register("starhub_list_assets", move |params| {
                let type_filter = params
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let text = ssh
                    .assets()
                    .list_assets_text(type_filter.as_deref())
                    .map_err(RpcError::internal)?;
                Ok(json!({ "text": text }))
            });
        }

        // 全局:会话 → 资产绑定(bind_asset_context)。open_connection /
        // focus_terminal 的窗口动作在新架构里是 bridge 插件事件,不占方法面。
        {
            let ssh = Arc::clone(&ssh);
            registry.register("bind_asset_context", move |params| {
                let asset_id = params
                    .get("assetId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| RpcError::invalid_params("bind_asset_context 缺少 assetId"))?
                    .to_string();
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| RpcError::invalid_params("bind_asset_context 缺少 sessionId"))?
                    .to_string();
                let asset_type = ssh
                    .assets()
                    .get(&asset_id)
                    .map_err(RpcError::internal)?
                    .asset_type;
                ssh.bind_session(&session_id, &asset_type, &asset_id);
                Ok(json!({ "ok": true, "action": "bound" }))
            });
        }

        // UI 面(M2):工作台命令 `ui.<tauriCommand>`。A 组资产 CRUD——
        // 存储就是上面的 AssetStore,只是换成工作台的 snake_case 线形状。
        {
            let assets = Arc::clone(ssh.assets());
            registry.register("ui.get_assets", {
                let assets = Arc::clone(&assets);
                move |params| crate::methods::ui::get_assets(&assets, params)
            });
            registry.register("ui.create_asset", {
                let assets = Arc::clone(&assets);
                move |params| crate::methods::ui::upsert_asset(&assets, params)
            });
            registry.register("ui.update_asset", {
                let assets = Arc::clone(&assets);
                move |params| crate::methods::ui::upsert_asset(&assets, params)
            });
            registry.register("ui.delete_asset", {
                let assets = Arc::clone(&assets);
                move |params| crate::methods::ui::delete_asset(&assets, params)
            });
        }

        // UI 面 B 组(交互会话):工作台持有 connId,命令形状与返回形状以
        // Tauri command 为契约(`src-tauri/src/commands/{ssh,sftp}.rs`)。
        register_async_all!(
            registry,
            runtime,
            ssh,
            "ui.ssh_connect" => crate::methods::ui_ssh::ssh_connect,
            "ui.ssh_write" => crate::methods::ui_ssh::ssh_write,
            "ui.ssh_write_binary" => crate::methods::ui_ssh::ssh_write_binary,
            "ui.ssh_resize" => crate::methods::ui_ssh::ssh_resize,
            "ui.ssh_disconnect" => crate::methods::ui_ssh::ssh_disconnect,
            "ui.ssh_get_sessions" => crate::methods::ui_ssh::ssh_get_sessions,
            "ui.ssh_exec" => crate::methods::ui_ssh::ssh_exec,
            "ui.ssh_kb_response" => crate::methods::ui_ssh::ssh_kb_response,
            "ui.ssh_hostkey_response" => crate::methods::ui_ssh::ssh_hostkey_response,
            "ui.ssh_bastion_response" => crate::methods::ui_ssh::ssh_bastion_response,
            "ui.ssh_get_trusted_host_key" => crate::methods::ui_ssh::ssh_get_trusted_host_key,
            "ui.test_ssh_connection" => crate::methods::ui_ssh::test_ssh_connection,
            "ui.sftp_ensure_session" => crate::methods::ui_ssh::sftp_ensure_session,
            "ui.sftp_home_dir" => crate::methods::ui_ssh::sftp_home_dir,
            "ui.sftp_list" => crate::methods::ui_ssh::sftp_list,
            "ui.sftp_stat" => crate::methods::ui_ssh::sftp_stat,
            "ui.sftp_mkdir" => crate::methods::ui_ssh::sftp_mkdir,
            "ui.sftp_remove" => crate::methods::ui_ssh::sftp_remove,
            "ui.sftp_rename" => crate::methods::ui_ssh::sftp_rename,
            "ui.sftp_start_upload" => crate::methods::ui_ssh::sftp_start_upload,
            "ui.sftp_start_download" => crate::methods::ui_ssh::sftp_start_download,
            "ui.sftp_pause_transfer" => crate::methods::ui_ssh::sftp_pause_transfer,
            "ui.sftp_resume_transfer" => crate::methods::ui_ssh::sftp_resume_transfer,
            "ui.sftp_cancel_transfer" => crate::methods::ui_ssh::sftp_cancel_transfer,
            "ui.sftp_retry_transfer" => crate::methods::ui_ssh::sftp_retry_transfer,
            "ui.sftp_set_speed_limit" => crate::methods::ui_ssh::sftp_set_speed_limit,
            "ui.sftp_clear_transfers" => crate::methods::ui_ssh::sftp_clear_transfers,
            "ui.sftp_list_transfers" => crate::methods::ui_ssh::sftp_list_transfers,
            "ui.sftp_reveal_local" => crate::methods::ui_ssh::sftp_reveal_local,
        );
        // 窗口类动作:网页访问面板随 M3 面板化落地,本批显式降级(无状态,同步即可)。
        registry.register("ui.ssh_open_web_window", |params| {
            crate::methods::ui_ssh::ssh_open_web_window(params)
        });

        // UI 面 C 组(数据面连接):Tauri 版本就是 `sidecar.call(rpc, params)` 的薄
        // 封装,搬进 sidecar 后少一次进程间往返;命令表即映射契约(零逐命令漂移)。
        for spec in crate::methods::ui_db::COMMANDS {
            let runtime = Arc::clone(&runtime);
            let db = Arc::clone(&db);
            registry.register(spec.command, move |params| {
                runtime.block_on(crate::methods::ui_db::forward(&db, spec, params))
            });
        }

        // UI 面 D 组第一批(设置页):审计 + 告警。Tauri 版是 SQLite 表,sidecar
        // 换自有 JSON 存储;字段/缺省/排序/文案逐字保持(工作台接口是 snake_case)。
        {
            let ui = Arc::clone(&ui_state);
            registry.register("ui.audit_list", move |params| {
                crate::methods::ui_settings::audit_list(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.audit_clear", move |params| {
                crate::methods::ui_settings::audit_clear(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.audit_stats", move |params| {
                crate::methods::ui_settings::audit_stats(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.alert_create", move |params| {
                crate::methods::ui_settings::alert_create(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.alert_update", move |params| {
                crate::methods::ui_settings::alert_update(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.alert_delete", move |params| {
                crate::methods::ui_settings::alert_delete(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.alert_list", move |params| {
                crate::methods::ui_settings::alert_list(&ui, params)
            });
            let ui = Arc::clone(&ui_state);
            registry.register("ui.alert_test_webhook", move |params| {
                crate::methods::ui_settings::alert_test_webhook(&ui, params)
            });
        }

        // UI 面 D 组第二批(Android 设备设置 + 沙箱桌面 UI):存储/管理器多已在
        // sidecar,这里只补 ui.* 包装;两个窗口类动作显式降级(M3 面板)。
        // 每条注册一个块:块作用域即闭包捕获的边界,变量名可重复。
        {
            let android = Arc::clone(&android);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.android_ui_get_config", move |_params| {
                runtime.block_on(crate::methods::ui_devices::android_get_config(&android))
            });
        }
        {
            let android = Arc::clone(&android);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.android_ui_set_adb_path", move |params| {
                runtime.block_on(crate::methods::ui_devices::android_set_adb_path(
                    &android, params,
                ))
            });
        }
        {
            let android = Arc::clone(&android);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.android_ui_list_devices", move |_params| {
                runtime.block_on(crate::methods::ui_devices::android_list_devices(&android))
            });
        }
        {
            let live = Arc::clone(&live_state);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.android_ui_open_live", move |params| {
                runtime.block_on(crate::methods::ui_devices::android_open_live(&live, params))
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_overview", move |_params| {
                crate::methods::ui_devices::desktop_overview(&desktop)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_set_platform", move |params| {
                crate::methods::ui_devices::desktop_set_platform(&desktop, params)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_upsert_template", move |params| {
                crate::methods::ui_devices::desktop_upsert_template(&desktop, params)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_delete_template", move |params| {
                crate::methods::ui_devices::desktop_delete_template(&desktop, params)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_replay_frames", move |params| {
                crate::methods::ui_devices::desktop_replay_frames(&desktop, params)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.desktop_ui_lifecycle", move |params| {
                runtime.block_on(crate::methods::ui_devices::desktop_lifecycle(
                    &desktop, params,
                ))
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            registry.register("ui.desktop_ui_open_live_window", move |params| {
                crate::methods::ui_devices::desktop_open_live_window(&desktop, params)
            });
        }
        {
            let desktop = Arc::clone(&desktop);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.desktop_user_action_reply", move |params| {
                runtime.block_on(crate::methods::ui_devices::desktop_user_action_reply(
                    &desktop, params,
                ))
            });
        }

        // UI 面 D 组第三批:AI 浏览器设置 + AI 模型密钥(设置存储 / 密钥存储),
        // 以及归 Electron 壳 / M3 的宿主持有能力(本机 shell 实做,其余降级)。
        // 每条注册一个块:块作用域即闭包捕获的边界,变量名可重复。
        {
            let ui = Arc::clone(&ui_state);
            registry.register("ui.browser_get_engine", move |_params| {
                crate::methods::ui_browser::browser_get_engine(&ui)
            });
        }
        {
            let ui = Arc::clone(&ui_state);
            registry.register("ui.browser_set_engine", move |params| {
                crate::methods::ui_browser::browser_set_engine(&ui, params)
            });
        }
        {
            let ui = Arc::clone(&ui_state);
            registry.register("ui.browser_get_jev_config", move |_params| {
                crate::methods::ui_browser::browser_get_jev_config(&ui)
            });
        }
        {
            let ui = Arc::clone(&ui_state);
            registry.register("ui.browser_set_jev_config", move |params| {
                crate::methods::ui_browser::browser_set_jev_config(&ui, params)
            });
        }
        {
            let ssh = Arc::clone(&ssh);
            registry.register("ui.get_ai_model_api_key", move |params| {
                crate::methods::ui_browser::get_ai_model_api_key(ssh.assets(), params)
            });
        }
        {
            let ssh = Arc::clone(&ssh);
            registry.register("ui.set_ai_model_api_key", move |params| {
                crate::methods::ui_browser::set_ai_model_api_key(ssh.assets(), params)
            });
        }
        {
            let ssh = Arc::clone(&ssh);
            registry.register("ui.delete_ai_model_api_key", move |params| {
                crate::methods::ui_browser::delete_ai_model_api_key(ssh.assets(), params)
            });
        }
        {
            let runtime = Arc::clone(&runtime);
            registry.register("ui.local_shell_exec", move |params| {
                runtime.block_on(crate::methods::ui_host::local_shell_exec(params))
            });
        }
        registry.register("ui.screenshot_begin_region", |params| {
            crate::methods::ui_host::screenshot_begin_region(params)
        });
        registry.register("ui.plugin:dialog|open", |params| {
            crate::methods::ui_host::plugin_dialog_open(params)
        });
        registry.register("ui.plugin:app|version", |params| {
            crate::methods::ui_host::plugin_app_version(params)
        });

        // UI 面 M3:直播/接管面板的通道管理。帧与输入走 WS(见 starhub-live),
        // 这里只开关通道与发令牌;两个窗口类降级动作(`android_ui_open_live` /
        // `desktop_ui_open_live_window`)随本批真正落地(Android)或保持降级。
        {
            let live = Arc::clone(&live_state);
            let runtime = Arc::clone(&runtime);
            registry.register("ui.live_open", move |params| {
                runtime.block_on(crate::methods::ui_live::live_open(&live, params))
            });
        }
        {
            let live = Arc::clone(&live_state);
            registry.register("ui.live_token", move |params| {
                crate::methods::ui_live::live_token(&live, params)
            });
        }
        {
            let live = Arc::clone(&live_state);
            registry.register("ui.live_status", move |params| {
                crate::methods::ui_live::live_status(&live, params)
            });
        }
        {
            let live = Arc::clone(&live_state);
            registry.register("ui.live_close", move |params| {
                crate::methods::ui_live::live_close(&live, params)
            });
        }
        {
            let live = Arc::clone(&live_state);
            registry.register("ui.live_list", move |_params| {
                crate::methods::ui_live::live_list(&live, _params)
            });
        }

        // SSH / SFTP 域:8 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_exec",
            crate::methods::ssh::ssh_exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_exec_background",
            crate::methods::ssh::ssh_exec_background_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_wait_task",
            crate::methods::ssh::ssh_wait_task_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "ssh_session_status",
            crate::methods::ssh::ssh_session_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_list",
            crate::methods::ssh::sftp_list_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_stat",
            crate::methods::ssh::sftp_stat_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_upload",
            crate::methods::ssh::sftp_upload_method
        );
        register_async!(
            &mut registry,
            runtime,
            ssh,
            "sftp_download",
            crate::methods::ssh::sftp_download_method
        );

        // DB / Redis / ES / Docker 域:15 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            db,
            "db_query",
            crate::methods::db::db_query_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "redis_exec",
            crate::methods::db::redis_exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_list_indices",
            crate::methods::db::es_list_indices_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_cluster_health",
            crate::methods::db::es_cluster_health_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_get_mapping",
            crate::methods::db::es_get_mapping_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_search",
            crate::methods::db::es_search_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_get_document",
            crate::methods::db::es_get_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_count",
            crate::methods::db::es_count_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_index_document",
            crate::methods::db::es_index_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_delete_document",
            crate::methods::db::es_delete_document_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "es_delete_index",
            crate::methods::db::es_delete_index_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_list_containers",
            crate::methods::db::docker_list_containers_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_logs",
            crate::methods::db::docker_logs_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_inspect",
            crate::methods::db::docker_inspect_method
        );
        register_async!(
            &mut registry,
            runtime,
            db,
            "docker_exec",
            crate::methods::db::docker_exec_method
        );

        // Desktop 域:22 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_list_templates",
            crate::methods::desktop::list_templates_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_build_template",
            crate::methods::desktop::build_template_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_create_sandbox",
            crate::methods::desktop::create_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_sandbox_status",
            crate::methods::desktop::sandbox_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_pause_sandbox",
            crate::methods::desktop::pause_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_resume_sandbox",
            crate::methods::desktop::resume_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_destroy_sandbox",
            crate::methods::desktop::destroy_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_commit_sandbox",
            crate::methods::desktop::commit_sandbox_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_sandbox_replay",
            crate::methods::desktop::sandbox_replay_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_screenshot",
            crate::methods::desktop::screenshot_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_list_windows",
            crate::methods::desktop::list_windows_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_get_foreground_window",
            crate::methods::desktop::get_foreground_window_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_focus_window",
            crate::methods::desktop::focus_window_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_click",
            crate::methods::desktop::click_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_double_click",
            crate::methods::desktop::double_click_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_move_mouse",
            crate::methods::desktop::move_mouse_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_scroll",
            crate::methods::desktop::scroll_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_drag",
            crate::methods::desktop::drag_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_type",
            crate::methods::desktop::type_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_press_key",
            crate::methods::desktop::press_key_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_exec",
            crate::methods::desktop::exec_method
        );
        register_async!(
            &mut registry,
            runtime,
            desktop,
            "desktop_request_user_action",
            crate::methods::desktop::request_user_action_method
        );

        // Android 域:20 个方法,方法名 = 工具名
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_list_devices",
            crate::methods::android::list_devices_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_connect",
            crate::methods::android::connect_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_disconnect",
            crate::methods::android::disconnect_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_device_status",
            crate::methods::android::device_status_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_replay",
            crate::methods::android::replay_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_wireless",
            crate::methods::android::wireless_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_screenshot",
            crate::methods::android::screenshot_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_current_app",
            crate::methods::android::current_app_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_ui_tree",
            crate::methods::android::ui_tree_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_tap",
            crate::methods::android::tap_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_double_tap",
            crate::methods::android::double_tap_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_swipe",
            crate::methods::android::swipe_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_scroll",
            crate::methods::android::scroll_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_type",
            crate::methods::android::type_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_press_key",
            crate::methods::android::press_key_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_launch_app",
            crate::methods::android::launch_app_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_open_live",
            crate::methods::android::open_live_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_pull",
            crate::methods::android::pull_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_push",
            crate::methods::android::push_method
        );
        register_async!(
            &mut registry,
            runtime,
            android,
            "android_exec",
            crate::methods::android::exec_method
        );

        // Browser 域:16 个方法。引擎层(无头 CDP / 截图 / 直播帧)随 M3 面板化
        // 落地;M1 先固定方法面与参数契约(软错误由 crate 的 parse_action 产出)。
        let browser_unit = Arc::new(());
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_open",
            crate::methods::browser::open_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_navigate",
            crate::methods::browser::navigate_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_back",
            crate::methods::browser::back_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_forward",
            crate::methods::browser::forward_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_reload",
            crate::methods::browser::reload_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_state",
            crate::methods::browser::state_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_extract",
            crate::methods::browser::extract_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_click",
            crate::methods::browser::click_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_type",
            crate::methods::browser::type_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_press_key",
            crate::methods::browser::press_key_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_select_option",
            crate::methods::browser::select_option_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_scroll",
            crate::methods::browser::scroll_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_screenshot",
            crate::methods::browser::screenshot_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_eval",
            crate::methods::browser::eval_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_decide",
            crate::methods::browser::decide_method
        );
        register_async!(
            &mut registry,
            runtime,
            browser_unit,
            "browser_auto",
            crate::methods::browser::auto_method
        );

        // 桥命令(非工具方法,契约 §2.2):联动 UI 动作 + 活性快照。
        // 对端是 starhub-bridge 插件;进注册表让方法面清单覆盖完整协议。
        for (method, require_tool) in [
            (crate::bridge::OPEN_ASSET_METHOD, false),
            (crate::bridge::FOCUS_TOOL_METHOD, true),
        ] {
            let ssh = Arc::clone(&ssh);
            let sink = Arc::clone(&sink);
            registry.register(method, move |params| {
                crate::bridge::open_or_focus(&ssh, &sink, method, params, require_tool)
            });
        }
        {
            let runtime = Arc::clone(&runtime);
            let ssh = Arc::clone(&ssh);
            let sink = Arc::clone(&sink);
            let bridge_state = Arc::clone(&bridge_state);
            registry.register(crate::bridge::LIVE_SNAPSHOT_METHOD, move |_params| {
                Ok(runtime.block_on(crate::bridge::live_snapshot(
                    &ssh,
                    &sink,
                    &bridge_state,
                    ssh.transfers(),
                )))
            });
        }
        {
            let live = Arc::clone(&live_state);
            registry.register(crate::bridge::LIVE_ENDPOINT_METHOD, move |_params| {
                crate::methods::ui_live::live_endpoint(&live, _params)
            });
        }

        registry
    })
}

/// Convenience: build a multi-thread tokio runtime for the stdio loop.
pub fn build_runtime() -> Result<Runtime, String> {
    Runtime::new().map_err(|error| format!("tokio runtime 创建失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::InboundFrame;

    #[test]
    fn ping_reports_protocol() {
        let registry = registry_with_builtins();
        let frame =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(result["pong"], true);
        assert_eq!(result["protocol"], SIDECAR_PROTOCOL_VERSION);
    }

    #[test]
    fn capabilities_reports_the_live_method_table() {
        let registry = registry_with_builtins();
        let frame =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":2,"method":"starhub/capabilities"}"#)
                .expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(
            result["methods"],
            serde_json::json!(["ping", "starhub/capabilities", "starhub_list_capabilities"])
        );
    }

    #[test]
    fn list_capabilities_returns_the_contract_text() {
        let registry = registry_with_builtins();
        let frame =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":3,"method":"starhub_list_capabilities"}"#)
                .expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        let text = result["text"].as_str().expect("text");
        assert_eq!(text, starhub_contract::capabilities_text());
        // 模型可读文本:单行紧凑 JSON(serde_json 键序),与旧前端逐字一致
        assert!(
            text.starts_with(r#"{"android":["Android 实体机(adb)""#),
            "{text}"
        );
        assert!(text.contains(r#""ssh":["终端","主机仪表盘""#), "{text}");
    }
}
