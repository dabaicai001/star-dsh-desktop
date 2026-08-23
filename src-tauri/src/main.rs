#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod db;
mod harness;
mod keyring;
mod mcp;
mod registry;
mod sftp;
mod sidecar;
mod ssh;

use commands::ssh::SshManager;
use sftp::transfer::TransferManager;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 程序化创建主窗口(声明式 app.windows 挂不上 on_download:WebView2 默认
/// 丢弃 webview 内下载,dsh GUI 的「会话日志导出」等 anchor 下载会静默失败。
/// 窗口属性与原 tauri.conf.json 声明逐项对齐;Requested 弹「另存为」对话框
/// 让用户选保存位置(webview 默认下载目录不可见,下载完找不到文件),
/// 取消对话框 = 中止下载;Finished 落日志)。
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("StarHub")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .fullscreen(false)
        .decorations(true)
        .transparent(false)
        .shadow(true)
        .background_color(tauri::window::Color(8, 13, 20, 255))
        .on_download(|webview, event| {
            use tauri_plugin_dialog::DialogExt;
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    let suggested = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    tracing::info!("下载请求: {url} (建议文件名 {suggested})");
                    let picked = webview
                        .app_handle()
                        .dialog()
                        .file()
                        .set_file_name(&suggested)
                        .blocking_save_file();
                    match picked.and_then(|p| p.into_path().ok()) {
                        Some(path) => {
                            *destination = path;
                            true
                        }
                        None => {
                            tracing::info!("下载已取消(用户关闭另存为): {url}");
                            false
                        }
                    }
                }
                tauri::webview::DownloadEvent::Finished { url, path, success } => {
                    tracing::info!("下载结束: {url} -> {path:?} success={success}");
                    true
                }
                // DownloadEvent 是 non_exhaustive,未来变体一律放行
                _ => true,
            }
        })
        .build()?;
    Ok(())
}

/// 初始化日志:stderr(开发)+ 文件(打包产物诊断)。
/// Windows GUI 子系统下 stderr 不可见,dsh web 启动失败只有落到文件才可查。
fn init_logging() {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    let log_dir = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".starhub")))
        .unwrap_or_else(std::env::temp_dir)
        .join("starhub");
    let _ = std::fs::create_dir_all(&log_dir);
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("starhub.log"))
    {
        Ok(file) => {
            tracing_subscriber::fmt()
                .with_writer(std::io::stderr.and(file))
                .init();
        }
        Err(_) => {
            tracing_subscriber::fmt::init();
        }
    }
}

fn main() {
    init_logging();

    let sidecar_manager = sidecar::SidecarManager::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SshManager::new())
        .manage(sidecar_manager)
        .manage(harness::HarnessManager::new())
        .manage(harness::web::DshWebManager::new())
        // 联动 M1:会话附着注册表(ssh_attach/ssh_detach + live.snapshot 快照源)
        .manage(registry::SessionRegistry::new())
        // 主窗口销毁 = 应用退出:主动回收 dsh web 子进程(kill_on_drop 之外的确定性路径)
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                let app_handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    app_handle
                        .state::<harness::web::DshWebManager>()
                        .shutdown()
                        .await;
                });
            }
        })
        .setup(|app| {
            // dsh web 可在旧 dsh runtime 初始化前发起域工具调用；桥必须从启动起
            // 持有 AppHandle，避免 AI 通过已绑定 SSH 资产建链时落入无句柄分支。
            app.handle()
                .state::<harness::HarnessManager>()
                .bridge()
                .set_app(app.handle().clone());

            // 主窗口程序化创建(见 create_main_window);必须在 dsh web 启动
            // 之前建好,跳板页才能立刻开始轮询。
            create_main_window(app)?;

            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async {
                db::init_database(&app_handle).await?;
                let manager = app_handle.state::<sidecar::SidecarManager>();
                manager.start(&app_handle).await
            })
            .map_err(std::io::Error::other)?;

            // 初始化 TransferManager(需要 AppHandle 用于 emit 进度/状态事件)
            app.manage(TransferManager::new(app.handle().clone()));
            // 截图会话状态(区域模式底图缓存)
            app.manage(commands::screenshot::ScreenshotSession::default());

            // 主壳融合 P4a:dsh web GUI 是唯一主壳(旧外壳已退役,逃生门随之移除)。
            // 启动失败不致命——窗口停留在 shell-placeholder 跳板页轮询重试,错误落日志。
            {
                let app_handle = app.handle().clone();
                let started = tauri::async_runtime::block_on({
                    let app_handle = app_handle.clone();
                    async move {
                        let bridge = app_handle
                            .state::<harness::HarnessManager>()
                            .bridge();
                        app_handle
                            .state::<harness::web::DshWebManager>()
                            .ensure_started(&app_handle, bridge)
                            .await
                    }
                });
                match started {
                    // dev 流里 devUrl 的 3185 是占位等待页(真实服务在 3186+),
                    // 跳转由占位页轮询脚本完成;prod 由 shell-placeholder 跳板页
                    // 轮询 dsh_web_url 后 location.replace。Rust 不参与窗口导航
                    // (取舍见 docs/踩坑记录.md 第 20 节)。
                    Ok(url) => tracing::info!("dsh web 可用: {url}"),
                    Err(e) => tracing::error!("dsh web 启动失败: {e}"),
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::asset::get_assets,
            commands::asset::create_asset,
            commands::asset::update_asset,
            commands::asset::delete_asset,
            commands::asset::toggle_asset_favorite,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_connect_exec,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_write_binary,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_get_sessions,
            commands::ssh::ssh_exec,
            commands::ssh::ssh_exec_abort,
            commands::ssh::test_ssh_connection,
            commands::ssh::read_ssh_private_key_file,
            commands::ssh::ssh_kb_response,
            commands::ssh::ssh_hostkey_response,
            commands::ssh::ssh_get_trusted_host_key,
            commands::ssh::ssh_add_local_forward,
            commands::ssh::ssh_add_web_proxy_forward,
            commands::ssh::ssh_add_remote_forward,
            commands::ssh::ssh_remove_forward,
            commands::ssh::ssh_list_forwards,
            commands::ssh::ssh_start_web_gateway,
            commands::ssh::open_external_url,
            commands::ssh::ssh_stop_web_gateway,
            commands::ssh::ssh_web_gateway_port,
            commands::ssh::ssh_parse_config_file,
            commands::sftp::sftp_list,
            commands::sftp::sftp_home_dir,
            commands::sftp::sftp_read,
            commands::sftp::sftp_write,
            commands::sftp::sftp_stat,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_remove_file,
            commands::sftp::sftp_remove_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_rename,
            // 流式传输(走 TransferManager,带 progress / status 事件)
            commands::sftp::sftp_ensure_session,
            commands::sftp::sftp_start_upload,
            commands::sftp::sftp_start_download,
            commands::sftp::sftp_cancel_transfer,
            commands::sftp::sftp_pause_transfer,
            commands::sftp::sftp_resume_transfer,
            commands::sftp::sftp_list_transfers,
            commands::sftp::sftp_set_speed_limit,
            commands::sftp::sftp_retry_transfer,
            // 截图(区域截图 + 窗口截图)
            commands::screenshot::screenshot_list_monitors,
            commands::screenshot::screenshot_begin_region,
            commands::screenshot::screenshot_begin_window,
            commands::screenshot::screenshot_get_desktop,
            commands::screenshot::screenshot_list_windows,
            commands::screenshot::screenshot_capture_window,
            commands::screenshot::screenshot_finish,
            commands::screenshot::screenshot_cancel,
            // MySQL
            commands::db::db_mysql_connect,
            commands::db::db_mysql_test,
            commands::db::db_mysql_disconnect,
            commands::db::db_postgres_connect,
            commands::db::db_postgres_test,
            commands::db::db_postgres_disconnect,
            commands::db::db_mysql_list_databases,
            commands::db::db_mysql_list_tables,
            commands::db::db_mysql_list_columns,
            commands::db::db_mysql_list_indexes,
            commands::db::db_mysql_create_index,
            commands::db::db_mysql_drop_index,
            commands::db::db_mysql_execute,
            commands::db::db_mysql_explain,
            commands::db::db_mysql_get_table_ddl,
            commands::db::db_mysql_get_table_data,
            commands::db::db_mysql_drop_table,
            commands::db::db_mysql_truncate_table,
            commands::db::db_mysql_rename_table,
            commands::db::db_mysql_insert_row,
            commands::db::db_mysql_update_rows,
            commands::db::db_mysql_delete_rows,
            commands::db::db_mysql_export_data,
            commands::db::db_mysql_export_excel,
            commands::db::db_mysql_get_row_count,
            commands::db::db_mysql_get_table_meta,
            // Redis
            commands::db::db_redis_connect,
            commands::db::db_redis_test,
            commands::db::db_redis_disconnect,
            commands::db::db_redis_select,
            commands::db::db_redis_scan,
            commands::db::db_redis_get_value,
            commands::db::db_redis_del,
            commands::db::db_redis_rename,
            commands::db::db_redis_set,
            commands::db::db_redis_execute,
            commands::db::db_redis_info,
            commands::db::db_redis_db_size,
            commands::db::db_redis_slowlog_get,
            commands::db::db_redis_slowlog_reset,
            commands::db::db_redis_scan_all,
            commands::db::db_redis_bigkey_scan,
            commands::db::db_redis_memory_analysis,
            commands::db::db_redis_flush_db,
            commands::db::db_redis_subscribe,
            commands::db::db_redis_unsubscribe,
            // Elasticsearch
            commands::db::db_es_connect,
            commands::db::db_es_test,
            commands::db::db_es_disconnect,
            commands::db::db_es_cluster_health,
            commands::db::db_es_cluster_stats,
            commands::db::db_es_list_indices,
            commands::db::db_es_get_index_mapping,
            commands::db::db_es_get_index_settings,
            commands::db::db_es_create_index,
            commands::db::db_es_delete_index,
            commands::db::db_es_search,
            commands::db::db_es_count,
            commands::db::db_es_get_document,
            commands::db::db_es_index_document,
            commands::db::db_es_update_document,
            commands::db::db_es_delete_document,
            commands::db::db_es_bulk_index,
            commands::db::db_es_export_json,
            commands::db::db_es_scroll_search,
            // ClickHouse
            commands::db::db_clickhouse_connect,
            commands::db::db_clickhouse_test,
            commands::db::db_clickhouse_disconnect,
            commands::db::db_clickhouse_list_databases,
            commands::db::db_clickhouse_list_tables,
            commands::db::db_clickhouse_list_columns,
            commands::db::db_clickhouse_list_indexes,
            commands::db::db_clickhouse_create_index,
            commands::db::db_clickhouse_drop_index,
            commands::db::db_clickhouse_execute,
            commands::db::db_clickhouse_explain,
            commands::db::db_clickhouse_get_table_ddl,
            commands::db::db_clickhouse_get_table_data,
            commands::db::db_clickhouse_drop_table,
            commands::db::db_clickhouse_truncate_table,
            commands::db::db_clickhouse_rename_table,
            commands::db::db_clickhouse_insert_row,
            commands::db::db_clickhouse_update_rows,
            commands::db::db_clickhouse_delete_rows,
            commands::db::db_clickhouse_export_data,
            commands::db::db_clickhouse_export_excel,
            commands::db::db_clickhouse_get_row_count,
            commands::db::db_clickhouse_get_table_meta,
            commands::db::db_clickhouse_get_partitions,
            commands::db::db_clickhouse_get_merge_tree_info,
            commands::db::db_clickhouse_get_table_stats,
            // Backup / Restore
            commands::db::db_backup,
            commands::db::db_restore,
            commands::db::db_list_backups,
            // SQLite
            commands::db::db_sqlite_connect,
            commands::db::db_sqlite_test,
            commands::db::db_sqlite_disconnect,
            // MSSQL
            commands::db::db_mssql_connect,
            commands::db::db_mssql_test,
            commands::db::db_mssql_disconnect,
            // Docker
            commands::docker::docker_connect,
            commands::docker::docker_test,
            commands::docker::docker_disconnect,
            commands::docker::docker_list_containers,
            commands::docker::docker_inspect_container,
            commands::docker::docker_start_container,
            commands::docker::docker_stop_container,
            commands::docker::docker_restart_container,
            commands::docker::docker_remove_container,
            commands::docker::docker_container_logs,
            commands::docker::docker_container_stats,
            commands::docker::docker_list_images,
            commands::docker::docker_pull_image,
            commands::docker::docker_remove_image,
            commands::docker::docker_prune_images,
            commands::docker::docker_exec,
            commands::docker::docker_exec_session_start,
            commands::docker::docker_exec_session_read,
            commands::docker::docker_exec_session_write,
            commands::docker::docker_exec_session_resize,
            commands::docker::docker_exec_session_close,
            // Docker Compose
            commands::docker::docker_compose_up,
            commands::docker::docker_compose_down,
            commands::docker::docker_compose_ps,
            commands::docker::docker_compose_logs,
            commands::docker::docker_compose_config,
            commands::docker::docker_compose_list,
            commands::broker::broker_test,
            commands::broker::broker_overview,
            // File
            commands::file::open_file_external,
            // Local machine (AI #LOCAL workspace)
            commands::local::local_system_info,
            commands::local::local_shell_exec,
            commands::local::local_list_directory,
            commands::local::local_stat_path,
            commands::local::local_read_text_file,
            commands::local::local_write_text_file,
            commands::local::local_create_directory,
            commands::local::local_copy_file,
            commands::local::local_move_path,
            commands::local::local_remove_path,
            // AI(内核已迁移 dsh;此段只剩密钥与记忆持久化)
            commands::secret::set_ai_api_key,
            commands::secret::get_ai_api_key,
            commands::secret::delete_ai_api_key,
            commands::secret::set_ai_model_api_key,
            commands::secret::get_ai_model_api_key,
            commands::secret::delete_ai_model_api_key,
            commands::secret::set_mcp_server_secrets,
            commands::secret::get_mcp_server_secrets,
            commands::secret::delete_mcp_server_secrets,
            commands::mcp::mcp_list_tools,
            commands::mcp::mcp_call_tool,
            // Sidecar 通用 RPC
            commands::sidecar::sidecar_rpc,
            // dsh runtime(AI 内核替换):stdio JSON-RPC 桥 + cancel 杀进程兜底
            commands::harness::dsh_initialize,
            commands::harness::dsh_prompt,
            commands::harness::dsh_cancel,
            commands::harness::dsh_shutdown,
            // dsh 双向 request 桥应答(审批确认卡 / 域工具执行面板)+ 会话资产绑定
            commands::harness::dsh_approval_reply,
            commands::harness::dsh_tool_exec_reply,
            commands::harness::dsh_bind_session,
            // 联动:用户起源事件上报 + 面板「问 AI」入口(契约 §4)
            commands::harness::dsh_report_domain_event,
            commands::harness::starhub_ask_ai,
            // 联动 M1:session 附着 / 解除附着(契约 §4)
            commands::ssh::ssh_attach,
            commands::ssh::ssh_detach,
            // dsh web GUI 管理器(主壳融合 P1)
            commands::harness::dsh_web_url,
            // dsh 用户插件(支线 B):市场 / URL / 本地三入口 + 逐项启停
            commands::dsh_plugins::dsh_plugin_list,
            commands::dsh_plugins::dsh_plugin_install_local,
            commands::dsh_plugins::dsh_plugin_install_url,
            commands::dsh_plugins::dsh_plugin_set_enabled,
            commands::dsh_plugins::dsh_plugin_uninstall,
            commands::dsh_plugins::dsh_plugin_market_fetch,
            // 审计日志
            commands::audit::audit_log,
            commands::audit::audit_list,
            commands::audit::audit_clear,
            commands::audit::audit_stats,
            // 告警系统
            commands::alert::alert_create,
            commands::alert::alert_update,
            commands::alert::alert_delete,
            commands::alert::alert_list,
            commands::alert::alert_check,
            commands::alert::alert_test_webhook,
            // AI 记忆
            commands::ai_memory::ai_conv_upsert,
            commands::ai_memory::ai_conv_list,
            commands::ai_memory::ai_conv_get,
            commands::ai_memory::ai_conv_messages,
            commands::ai_memory::ai_conv_rename,
            commands::ai_memory::ai_conv_delete,
            commands::ai_memory::ai_msg_sync,
            commands::ai_memory::ai_msg_search,
            // AI 记忆:L1 热记忆
            commands::ai_memory::ai_memory_list,
            commands::ai_memory::ai_memory_cards,
            commands::ai_memory::ai_memory_add,
            commands::ai_memory::ai_memory_replace,
            commands::ai_memory::ai_memory_remove,
            commands::ai_memory::ai_memory_delete,
            commands::ai_memory::ai_memory_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
