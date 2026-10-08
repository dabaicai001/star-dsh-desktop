//! 沙箱桌面(Ubuntu 容器沙箱平台,E2B 式架构)— Tauri 侧适配层。
//!
//! 设计:`docs/superpowers/specs/2026-08-28-desktop-automation-design.md`。
//! 编排全部经 sidecar 现有 Docker 适配器(M0 补齐的方法),目标连接 =
//! 设置页「沙箱平台」选择(settings 表 `desktop.platform_asset_id`),
//! 未选择时默认本机 Docker(docker.connect 空参,client.FromEnv 兜底)。
//!
//! 安全模型(§5)——执行点强制,与宿主无关(已随执行体搬去 crate):
//! - 任务级授权:`desktop_create_sandbox` 成功即建立 session → sandbox 授权
//!   (60 分钟),授权期内写操作自动放行;
//! - 用户接管(前端 `desktop_ui_open_live_window` takeover=true)期间写操作一律拒绝,
//!   接管不撤销授权;
//! - 每次写操作前自动截屏留档(sandbox_replay_frames),支持回放;
//! - `desktop_type` 的文本不进审计(审计摘要在 events.rs 只记长度)。
//!
//! 去 Tauri 化 M1:执行体(22 个 `desktop_*` 工具)已平移到
//! `starhub-domain-desktop`;本模块只剩六个 seam 的 Tauri 实现 + UI 生命周期
//! 入口(用户自己的手,不经任务授权)。

/// 配方解析与 Dockerfile 生成(纯函数,已随执行体搬去 crate)。
pub use starhub_domain_desktop::recipe;

use serde_json::Value;
use sqlx::Row;
use tauri::Manager;

use starhub_domain_desktop::manager::DesktopManager as DomainDesktopManager;
use starhub_domain_desktop::store::{
    InstanceRow, InstanceStore, ReplayFrame, RunningInstance, SandboxTemplate,
};
use starhub_domain_desktop::{
    AssetConfigSource, BoxFuture, CacheDir, Desktop, EventBroadcast, SettingsStore, SidecarCaller,
};
use starhub_domain_ssh::events::{KnownHostsStore, StoreFuture};

use crate::harness::HostBridgeState;

pub use starhub_domain_desktop::exec::DESKTOP_TOOLS;

/// 本模块处理的 AI 工具清单(harness/tools.rs 分发用)。
/// `desktop_request_user_action` 不在这里——它经 FORWARDED_TOOLS 转发前端
/// (横幅与「已完成」按钮是纯 UI 状态)。

/// 沙箱桌面管理器(经 `app.manage` 注入;桥路径经 `bridge.app().state` 访问)。
pub type DesktopManager = DomainDesktopManager;

// ============================================================
// Tauri 侧 seam 实现
// ============================================================

/// SQLite 版沙箱存储(四张表:instances / templates / replay_frames / settings)。
struct SqliteInstanceStore;

impl SqliteInstanceStore {
    fn row_to_instance(row: &sqlx::sqlite::SqliteRow) -> Result<InstanceRow, String> {
        Ok(InstanceRow {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            container_id: row.try_get("container_id").map_err(|e| e.to_string())?,
            platform: row.try_get("platform").map_err(|e| e.to_string())?,
            novnc_port: row.try_get("novnc_port").map_err(|e| e.to_string())?,
            status: row.try_get("status").map_err(|e| e.to_string())?,
            task: row.try_get("task").map_err(|e| e.to_string())?,
        })
    }
}

impl InstanceStore for SqliteInstanceStore {
    fn load_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
    ) -> BoxFuture<'a, Result<InstanceRow, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let row = sqlx::query(
                "SELECT id, container_id, platform, novnc_port, status, task FROM sandbox_instances WHERE id = ?",
            )
            .bind(sandbox_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读取沙箱实例失败: {e}"))?
            .ok_or_else(|| format!("沙箱实例不存在: {sandbox_id}"))?;
            Self::row_to_instance(&row)
        })
    }

    fn mark_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
        status: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let destroyed_at = (status == "destroyed").then(|| chrono::Utc::now().timestamp());
            sqlx::query(
                "UPDATE sandbox_instances SET status = ?, destroyed_at = COALESCE(?, destroyed_at) WHERE id = ?",
            )
            .bind(status)
            .bind(destroyed_at)
            .bind(sandbox_id)
            .execute(pool)
            .await
            .map_err(|e| format!("更新沙箱实例状态失败: {e}"))?;
            Ok(())
        })
    }

    fn insert_instance<'a>(
        &'a self,
        instance: &'a InstanceRow,
        template_id: &'a str,
        session_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query(
                "INSERT INTO sandbox_instances (id, template_id, container_id, platform, novnc_port, status, session_id, task) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)",
            )
            .bind(&instance.id)
            .bind(template_id)
            .bind(&instance.container_id)
            .bind(&instance.platform)
            .bind(instance.novnc_port)
            .bind(session_id)
            .bind(&instance.task)
            .execute(pool)
            .await
            .map_err(|e| format!("登记沙箱实例失败: {e}"))?;
            Ok(())
        })
    }

    fn list_running(&self) -> BoxFuture<'_, Result<Vec<RunningInstance>, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let rows = sqlx::query(
                "SELECT id, status, task, novnc_port FROM sandbox_instances WHERE status != 'destroyed' ORDER BY created_at DESC LIMIT 10",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| format!("列出沙箱失败: {e}"))?;
            rows.iter()
                .map(|row| {
                    Ok(RunningInstance {
                        id: row.try_get("id").map_err(|e| e.to_string())?,
                        status: row.try_get("status").map_err(|e| e.to_string())?,
                        novnc_port: row.try_get("novnc_port").map_err(|e| e.to_string())?,
                        task: row.try_get("task").map_err(|e| e.to_string())?,
                    })
                })
                .collect()
        })
    }

    fn list_templates(&self) -> BoxFuture<'_, Result<Vec<SandboxTemplate>, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let rows = sqlx::query(
                "SELECT id, name, recipe, image_tag, created_at FROM sandbox_templates ORDER BY created_at",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| format!("列出模板失败: {e}"))?;
            rows.iter()
                .map(|row| {
                    Ok(SandboxTemplate {
                        id: row.try_get("id").map_err(|e| e.to_string())?,
                        name: row.try_get("name").map_err(|e| e.to_string())?,
                        recipe: row.try_get("recipe").map_err(|e| e.to_string())?,
                        image_tag: row.try_get("image_tag").ok(),
                        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
                    })
                })
                .collect()
        })
    }

    fn seed_default_template(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
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
        })
    }

    fn load_template<'a>(
        &'a self,
        template: &'a str,
    ) -> BoxFuture<'a, Result<SandboxTemplate, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let row = sqlx::query(
                "SELECT id, name, recipe, image_tag, created_at FROM sandbox_templates WHERE name = ? OR id = ?",
            )
            .bind(template)
            .bind(template)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("读取模板失败: {e}"))?
            .ok_or_else(|| format!("模板不存在: {template}(先 desktop_list_templates 查看)"))?;
            Ok(SandboxTemplate {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                name: row.try_get("name").map_err(|e| e.to_string())?,
                recipe: row.try_get("recipe").map_err(|e| e.to_string())?,
                image_tag: row.try_get("image_tag").ok(),
                created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
            })
        })
    }

    fn set_template_image<'a>(
        &'a self,
        template_id: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query("UPDATE sandbox_templates SET image_tag = ? WHERE id = ?")
                .bind(image_tag)
                .bind(template_id)
                .execute(pool)
                .await
                .map_err(|e| format!("更新模板镜像标记失败: {e}"))?;
            Ok(())
        })
    }

    fn insert_template<'a>(
        &'a self,
        name: &'a str,
        recipe: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query("INSERT INTO sandbox_templates (id, name, recipe, image_tag) VALUES (?, ?, ?, ?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(name)
                .bind(recipe)
                .bind(image_tag)
                .execute(pool)
                .await
                .map_err(|e| format!("登记固化模板失败: {e}"))?;
            Ok(())
        })
    }

    fn insert_frame<'a>(
        &'a self,
        sandbox_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query(
                "INSERT INTO sandbox_replay_frames (sandbox_id, action, shot_path) VALUES (?, ?, ?)",
            )
            .bind(sandbox_id)
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
        sandbox_id: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let rows = sqlx::query(
                "SELECT action, shot_path, created_at FROM sandbox_replay_frames WHERE sandbox_id = ? ORDER BY id LIMIT ?",
            )
            .bind(sandbox_id)
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("读取回放帧失败: {e}"))?;
            rows.iter()
                .map(|row| {
                    Ok(ReplayFrame {
                        action: row.try_get("action").map_err(|e| e.to_string())?,
                        shot_path: row.try_get("shot_path").ok(),
                        created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
                    })
                })
                .collect()
        })
    }

    fn count_frames<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, Result<i64, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            sqlx::query_scalar("SELECT COUNT(*) FROM sandbox_replay_frames WHERE sandbox_id = ?")
                .bind(sandbox_id)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

/// settings 表版设置存储。
struct SqliteSettingsStore;

impl SettingsStore for SqliteSettingsStore {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let pool = crate::db::get_pool()?;
            let value: Option<String> =
                sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
                    .bind(key)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| format!("读取沙箱平台设置失败: {e}"))?;
            Ok(value.filter(|v| !v.trim().is_empty()))
        })
    }
}

/// 资产配置来源(SQLite assets + Keyring)。
struct SqliteAssetConfigSource;

impl AssetConfigSource for SqliteAssetConfigSource {
    fn load<'a>(
        &'a self,
        asset_id: &'a str,
    ) -> BoxFuture<'a, Result<(String, serde_json::Value), String>> {
        Box::pin(async move { crate::harness::load_asset_config(asset_id).await })
    }
}

/// 应用缓存目录(screenshot / Dockerfile 落盘)。
struct AppCacheDir<'a>(&'a tauri::AppHandle);

impl CacheDir for AppCacheDir<'_> {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String> {
        let base = self
            .0
            .path()
            .app_cache_dir()
            .map_err(|e| format!("缓存目录不可用: {e}"))?;
        Ok(base.join(sub))
    }
}

/// 桥事件广播(「请求用户人工介入」横幅)。
struct BridgeEventBroadcast<'a> {
    bridge: &'a HostBridgeState,
}

impl EventBroadcast for BridgeEventBroadcast<'_> {
    fn emit<'a>(&'a self, event: &'a str, payload: serde_json::Value) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.bridge.emit(event, payload).await })
    }
}

/// SQLite 版 TOFU 主机密钥存储(Docker over SSH 复用)。
///
/// 直接转发到 `ssh::adapters::SqliteKnownHostsStore`(seam 实现的再导出,
/// 行为零改动)。
struct SqliteKnownHosts;

impl KnownHostsStore for SqliteKnownHosts {
    fn is_known<'a>(
        &self,
        host: &'a str,
        port: u16,
        fingerprint: &'a str,
    ) -> StoreFuture<'a, anyhow::Result<bool>> {
        Box::pin(async move {
            crate::ssh::adapters::SqliteKnownHostsStore
                .is_known(host, port, fingerprint)
                .await
        })
    }

    fn add_host<'a>(
        &self,
        host: &'a str,
        port: u16,
        key_type: &'a str,
        fingerprint: &'a str,
        public_key: &'a str,
    ) -> StoreFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            crate::ssh::adapters::SqliteKnownHostsStore
                .add_host(host, port, key_type, fingerprint, public_key)
                .await
        })
    }

    fn trusted_public_key<'a>(
        &self,
        host: &'a str,
        port: u16,
    ) -> StoreFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            crate::ssh::adapters::SqliteKnownHostsStore
                .trusted_public_key(host, port)
                .await
        })
    }
}

// ============================================================
// 装配与入口
// ============================================================

/// app state 里的 Go sidecar 客户端。
struct SqliteSidecarCaller<'a> {
    app: &'a tauri::AppHandle,
}

impl SidecarCaller for SqliteSidecarCaller<'_> {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async move {
            let sidecar = self.app.state::<crate::sidecar::SidecarManager>();
            sidecar.call(method, params).await
        })
    }

    fn call_with_timeout<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
        timeout: std::time::Duration,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(async move {
            let sidecar = self.app.state::<crate::sidecar::SidecarManager>();
            sidecar.call_with_timeout(method, params, timeout).await
        })
    }
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
    let manager = app.state::<DomainDesktopManager>();
    // seam 实例必须是本作用域的局部值(借用随 context 一起活着)
    let sidecar = SqliteSidecarCaller { app: &app };
    let store = SqliteInstanceStore;
    let settings = SqliteSettingsStore;
    let assets = SqliteAssetConfigSource;
    let events = BridgeEventBroadcast { bridge };
    let cache = AppCacheDir(&app);
    let known_hosts = SqliteKnownHosts;
    let context = Desktop {
        manager: &manager,
        sidecar: &sidecar,
        store: &store,
        settings: &settings,
        assets: &assets,
        events: &events,
        cache: &cache,
        known_hosts: &known_hosts,
        session_id,
    };
    starhub_domain_desktop::execute(&context, name, args).await
}

/// UI 生命周期入口(沙箱 tab 的停止/恢复/销毁按钮):与 AI 工具路径同一份
/// 编排,但不经任务授权——这是用户自己的手,按钮点击即审批表达。
/// action ∈ destroy / pause / resume。
pub async fn ui_lifecycle(
    app: &tauri::AppHandle,
    sandbox_id: &str,
    action: &str,
) -> Result<String, String> {
    let bridge = app.state::<crate::harness::HarnessManager>().bridge();
    let manager = app.state::<DomainDesktopManager>();
    let sidecar = SqliteSidecarCaller { app };
    let store = SqliteInstanceStore;
    let settings = SqliteSettingsStore;
    let assets = SqliteAssetConfigSource;
    let events = BridgeEventBroadcast { bridge: &bridge };
    let cache = AppCacheDir(app);
    let known_hosts = SqliteKnownHosts;
    let context = Desktop {
        manager: &manager,
        sidecar: &sidecar,
        store: &store,
        settings: &settings,
        assets: &assets,
        events: &events,
        cache: &cache,
        known_hosts: &known_hosts,
        session_id: "ui",
    };
    starhub_domain_desktop::ui_lifecycle(&context, sandbox_id, action).await
}
