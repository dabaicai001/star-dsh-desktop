//! 沙箱实例 / 模板 / 回放帧的持久化 seam。
//!
//! Tauri 壳实现为 SQLite(`sandbox_instances` / `sandbox_templates` /
//! `sandbox_replay_frames`),sidecar 实现为 JSON 文件。字段名与 SQL 列
//! camelCase 对齐,§六 的一次性导入即 `SELECT → JSON` 直排。

use serde::{Deserialize, Serialize};

use crate::BoxFuture;

/// 沙箱实例行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRow {
    pub id: String,
    pub container_id: String,
    pub platform: String,
    pub novnc_port: i64,
    pub status: String,
    pub task: String,
}

/// 模板行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxTemplate {
    pub id: String,
    pub name: String,
    /// 配方 TOML 原文。
    pub recipe: String,
    /// 已构建镜像 tag;None = 未构建。
    pub image_tag: Option<String>,
    pub created_at: i64,
}

/// 回放帧行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFrame {
    pub action: String,
    pub shot_path: Option<String>,
    pub created_at: i64,
}

/// 运行中实例的摘要行(`desktop_sandbox_status` 无参时的清单)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInstance {
    pub id: String,
    pub status: String,
    pub novnc_port: i64,
    pub task: String,
}

/// 沙箱持久化 seam。
///
/// 方法带 `'a` 生命周期参数(与 [`starhub_domain_ssh::events::KnownHostsStore`]
/// 同一手法):入参借用的生命周期即返回 future 的生命周期,impl 侧先同步算完
/// (guard 不跨 await)再包 `Box::pin(async move { … })`。
pub trait InstanceStore: Send + Sync {
    fn load_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
    ) -> BoxFuture<'a, Result<InstanceRow, String>>;

    /// 更新实例状态;`destroyed` 时由实现方补 destroyed_at。
    fn mark_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
        status: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 登记新实例(create_sandbox 落库)。
    fn insert_instance<'a>(
        &'a self,
        instance: &'a InstanceRow,
        template_id: &'a str,
        session_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 未销毁实例清单(倒序,上限 10)。
    fn list_running(&self) -> BoxFuture<'_, Result<Vec<RunningInstance>, String>>;

    /// 模板清单(按创建时间)。
    fn list_templates(&self) -> BoxFuture<'_, Result<Vec<SandboxTemplate>, String>>;

    /// 表为空时播种内置默认模板(幂等)。
    fn seed_default_template(&self) -> BoxFuture<'_, Result<(), String>>;

    /// 按名或 id 读模板。
    fn load_template<'a>(
        &'a self,
        template: &'a str,
    ) -> BoxFuture<'a, Result<SandboxTemplate, String>>;

    /// 回写模板的镜像 tag(构建完成)。
    fn set_template_image<'a>(
        &'a self,
        template_id: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 登记固化产物为新模板。
    fn insert_template<'a>(
        &'a self,
        name: &'a str,
        recipe: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 追加一条回放帧。
    fn insert_frame<'a>(
        &'a self,
        sandbox_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>>;

    /// 回放帧清单(正序,上限 limit)。
    fn list_frames<'a>(
        &'a self,
        sandbox_id: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>>;

    /// 回放帧条数(销毁时的归档提示)。
    fn count_frames<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, Result<i64, String>>;
}
