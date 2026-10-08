//! sidecar 的沙箱持久化:JSON 文件实现 [`InstanceStore`](starhub_domain_desktop::InstanceStore)。
//!
//! 设计 §六 数据迁移:Tauri SQLite(sandbox_instances / sandbox_templates /
//! sandbox_replay_frames)→ sidecar 自有存储。字段 camelCase 与 SQL 列对齐,
//! R7 的一次性导入即 `SELECT → JSON` 直排。写穿透(每次变更整体落盘):
//! 沙箱实例/模板/回放帧都是低频小数据,不值得引入 SQLite 依赖。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use starhub_domain_desktop::store::{
    InstanceRow, InstanceStore, ReplayFrame, RunningInstance, SandboxTemplate,
};
use starhub_domain_desktop::BoxFuture;

/// 文件承载的沙箱文档(三张表一个文件)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDocument {
    #[serde(default)]
    pub instances: Vec<InstanceRow>,
    #[serde(default)]
    pub templates: Vec<SandboxTemplate>,
    /// 回放帧:(sandbox_id, action, shot_path, created_at)。
    #[serde(default)]
    pub frames: Vec<FrameRecord>,
}

/// 回放帧记录(带 sandbox_id,便于按实例过滤)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRecord {
    pub sandbox_id: String,
    pub action: String,
    pub shot_path: Option<String>,
    pub created_at: i64,
}

/// JSON 文件版沙箱存储。
pub struct FileInstanceStore {
    path: PathBuf,
    /// 进程内缓存:避免每次工具调用都读盘;写穿透保持一致。
    cache: Mutex<Option<SandboxDocument>>,
}

impl FileInstanceStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            cache: Mutex::new(None),
        }
    }

    /// 按环境变量解析路径:`STARHUB_SANDBOX_FILE`,缺省 `<cwd>/starhub-sandbox.json`。
    pub fn from_env() -> Self {
        let path = std::env::var("STARHUB_SANDBOX_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("starhub-sandbox.json"));
        Self::new(path)
    }

    /// 存储文件路径(诊断信息用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> anyhow::Result<SandboxDocument> {
        let mut cache = self.cache.lock().unwrap();
        if let Some(document) = cache.as_ref() {
            return Ok(document.clone());
        }
        let document = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                anyhow::anyhow!("沙箱文件解析失败({}): {error}", self.path.display())
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                SandboxDocument::default()
            }
            Err(error) => {
                return Err(anyhow::anyhow!(
                    "沙箱文件读取失败({}): {error}",
                    self.path.display()
                ))
            }
        };
        *cache = Some(document.clone());
        Ok(document)
    }

    fn persist(&self, document: &SandboxDocument) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    anyhow::anyhow!("沙箱目录创建失败({}): {error}", parent.display())
                })?;
            }
        }
        let text = serde_json::to_string_pretty(document)
            .map_err(|error| anyhow::anyhow!("沙箱文件序列化失败: {error}"))?;
        std::fs::write(&self.path, text).map_err(|error| {
            anyhow::anyhow!("沙箱文件写入失败({}): {error}", self.path.display())
        })?;
        *self.cache.lock().unwrap() = Some(document.clone());
        Ok(())
    }

    /// 读-改-写:在持锁状态下变更文档并落盘。
    fn update<T>(
        &self,
        mutate: impl FnOnce(&mut SandboxDocument) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut document = self.load()?;
        let outcome = mutate(&mut document)?;
        self.persist(&document)?;
        Ok(outcome)
    }
}

impl InstanceStore for FileInstanceStore {
    fn load_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
    ) -> BoxFuture<'a, Result<InstanceRow, String>> {
        let outcome = (|| {
            let document = self.load().map_err(|e| e.to_string())?;
            document
                .instances
                .into_iter()
                .find(|i| i.id == sandbox_id)
                .ok_or_else(|| format!("沙箱实例不存在: {sandbox_id}"))
        })();
        Box::pin(async move { outcome })
    }

    fn mark_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
        status: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = self
            .update(|document| {
                if let Some(instance) = document.instances.iter_mut().find(|i| i.id == sandbox_id) {
                    instance.status = status.to_string();
                }
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn insert_instance<'a>(
        &'a self,
        instance: &'a InstanceRow,
        _template_id: &'a str,
        _session_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = self
            .update(|document| {
                document.instances.push(instance.clone());
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn list_running(&self) -> BoxFuture<'_, Result<Vec<RunningInstance>, String>> {
        let outcome = self.load().map_err(|e| e.to_string()).map(|document| {
            document
                .instances
                .into_iter()
                .filter(|i| i.status != "destroyed")
                .rev()
                .take(10)
                .map(|i| RunningInstance {
                    id: i.id,
                    status: i.status,
                    novnc_port: i.novnc_port,
                    task: i.task,
                })
                .collect()
        });
        Box::pin(async move { outcome })
    }

    fn list_templates(&self) -> BoxFuture<'_, Result<Vec<SandboxTemplate>, String>> {
        let outcome = self.load().map_err(|e| e.to_string()).map(|d| d.templates);
        Box::pin(async move { outcome })
    }

    fn seed_default_template(&self) -> BoxFuture<'_, Result<(), String>> {
        let outcome = self
            .update(|document| {
                if document.templates.is_empty() {
                    document.templates.push(SandboxTemplate {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "ubuntu-desktop".to_string(),
                        recipe: starhub_domain_desktop::recipe::DEFAULT_RECIPE_TOML.to_string(),
                        image_tag: None,
                        created_at: chrono::Utc::now().timestamp(),
                    });
                }
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn load_template<'a>(
        &'a self,
        template: &'a str,
    ) -> BoxFuture<'a, Result<SandboxTemplate, String>> {
        let outcome = (|| {
            let document = self.load().map_err(|e| e.to_string())?;
            document
                .templates
                .into_iter()
                .find(|t| t.name == template || t.id == template)
                .ok_or_else(|| format!("模板不存在: {template}(先 desktop_list_templates 查看)"))
        })();
        Box::pin(async move { outcome })
    }

    fn set_template_image<'a>(
        &'a self,
        template_id: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = self
            .update(|document| {
                if let Some(template) = document.templates.iter_mut().find(|t| t.id == template_id)
                {
                    template.image_tag = Some(image_tag.to_string());
                }
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn insert_template<'a>(
        &'a self,
        name: &'a str,
        recipe: &'a str,
        image_tag: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = self
            .update(|document| {
                document.templates.push(SandboxTemplate {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.to_string(),
                    recipe: recipe.to_string(),
                    image_tag: Some(image_tag.to_string()),
                    created_at: chrono::Utc::now().timestamp(),
                });
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn insert_frame<'a>(
        &'a self,
        sandbox_id: &'a str,
        action: &'a str,
        shot_path: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        let outcome = self
            .update(|document| {
                document.frames.push(FrameRecord {
                    sandbox_id: sandbox_id.to_string(),
                    action: action.to_string(),
                    shot_path: shot_path.map(str::to_string),
                    created_at: chrono::Utc::now().timestamp(),
                });
                Ok(())
            })
            .map_err(|e| e.to_string());
        Box::pin(async move { outcome })
    }

    fn list_frames<'a>(
        &'a self,
        sandbox_id: &'a str,
        limit: i64,
    ) -> BoxFuture<'a, Result<Vec<ReplayFrame>, String>> {
        let outcome = self.load().map_err(|e| e.to_string()).map(|document| {
            document
                .frames
                .into_iter()
                .filter(|f| f.sandbox_id == sandbox_id)
                .take(limit.max(0) as usize)
                .map(|f| ReplayFrame {
                    action: f.action,
                    shot_path: f.shot_path,
                    created_at: f.created_at,
                })
                .collect()
        });
        Box::pin(async move { outcome })
    }

    fn count_frames<'a>(&'a self, sandbox_id: &'a str) -> BoxFuture<'a, Result<i64, String>> {
        let outcome = self.load().map_err(|e| e.to_string()).map(|document| {
            document
                .frames
                .iter()
                .filter(|f| f.sandbox_id == sandbox_id)
                .count() as i64
        });
        Box::pin(async move { outcome })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in_temp(label: &str) -> (FileInstanceStore, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("starhub-sandbox-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sandbox.json");
        (FileInstanceStore::new(&path), dir)
    }

    fn instance(id: &str) -> InstanceRow {
        InstanceRow {
            id: id.to_string(),
            container_id: format!("container-{id}"),
            platform: "local".to_string(),
            novnc_port: 15900,
            status: "running".to_string(),
            task: "test".to_string(),
        }
    }

    #[tokio::test]
    async fn roundtrips_instances_templates_and_frames() {
        let (store, dir) = store_in_temp("roundtrip");
        store.seed_default_template().await.unwrap();
        store
            .insert_instance(&instance("box-1"), "tpl", "s1")
            .await
            .unwrap();
        store
            .insert_frame("box-1", "click(1,2)", Some("/tmp/shot.png"))
            .await
            .unwrap();

        assert_eq!(
            store.load_instance("box-1").await.unwrap().container_id,
            "container-box-1"
        );
        assert_eq!(store.list_running().await.unwrap().len(), 1);
        assert_eq!(
            store.list_templates().await.unwrap()[0].name,
            "ubuntu-desktop"
        );
        assert_eq!(store.list_frames("box-1", 10).await.unwrap().len(), 1);
        assert_eq!(store.count_frames("box-1").await.unwrap(), 1);

        // 落盘后可被新实例读回(持久化 = 重启后沙箱仍可管)
        let reopened = FileInstanceStore::new(store.path());
        assert_eq!(reopened.load_instance("box-1").await.unwrap().task, "test");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mark_and_destroy_update_status() {
        let (store, dir) = store_in_temp("status");
        store
            .insert_instance(&instance("box-1"), "tpl", "s1")
            .await
            .unwrap();
        store.mark_instance("box-1", "paused").await.unwrap();
        assert_eq!(store.load_instance("box-1").await.unwrap().status, "paused");
        store.mark_instance("box-1", "destroyed").await.unwrap();
        assert!(
            store.list_running().await.unwrap().is_empty(),
            "销毁后不再列出"
        );
        let err = store.load_instance("ghost").await.unwrap_err();
        assert_eq!(err, "沙箱实例不存在: ghost");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_file_is_an_empty_store_and_seeding_is_idempotent() {
        let dir =
            std::env::temp_dir().join(format!("starhub-sandbox-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = FileInstanceStore::new(dir.join("sandbox.json"));
        assert!(store.list_running().await.unwrap().is_empty());
        store.seed_default_template().await.unwrap();
        store.seed_default_template().await.unwrap();
        assert_eq!(store.list_templates().await.unwrap().len(), 1, "播种幂等");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
