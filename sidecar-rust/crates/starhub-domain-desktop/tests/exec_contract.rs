//! Desktop 工具体契约测试:内存存储 + 假 sidecar,不碰真 Docker。
//!
//! 覆盖三类契约:① 结果文本(模型可读);② 安全语义(任务授权 / 接管互斥);
//! ③ xdotool 命令拼装(注入防护:文本过 sh_quote、键名过白名单)。

use serde_json::{json, Value};
use std::sync::Mutex;

use starhub_domain_desktop::exec::{execute, DESKTOP_TOOLS};
use starhub_domain_desktop::keys::map_key;
use starhub_domain_desktop::manager::DesktopManager;
use starhub_domain_desktop::recipe;
use starhub_domain_desktop::store::{
    InstanceRow, InstanceStore, ReplayFrame, RunningInstance, SandboxTemplate,
};
use starhub_domain_desktop::{
    AssetConfigSource, BoxFuture, CacheDir, Desktop, EventBroadcast, SettingsStore, SidecarCaller,
};

// ---------- 假 seam:内存存储 / 假 sidecar / 空设置 ----------

#[derive(Default)]
struct FakeStore {
    instances: Mutex<Vec<InstanceRow>>,
    templates: Mutex<Vec<SandboxTemplate>>,
    frames: Mutex<Vec<(String, String, Option<String>)>>,
    seeded: Mutex<bool>,
}

impl InstanceStore for FakeStore {
    fn load_instance<'a>(
        &'a self,
        sandbox_id: &'a str,
    ) -> BoxFuture<'a, Result<InstanceRow, String>> {
        let found = self
            .instances
            .lock()
            .unwrap()
            .iter()
            .find(|i| i.id == sandbox_id)
            .cloned();
        Box::pin(async move { found.ok_or_else(|| format!("沙箱实例不存在: {sandbox_id}")) })
    }

    fn mark_instance(&self, sandbox_id: &str, status: &str) -> BoxFuture<'_, Result<(), String>> {
        let mut instances = self.instances.lock().unwrap();
        if let Some(instance) = instances.iter_mut().find(|i| i.id == sandbox_id) {
            instance.status = status.to_string();
        }
        Box::pin(async move { Ok(()) })
    }

    fn insert_instance(
        &self,
        instance: &InstanceRow,
        _template_id: &str,
        _session_id: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.instances.lock().unwrap().push(instance.clone());
        Box::pin(async move { Ok(()) })
    }

    fn list_running(&self) -> BoxFuture<'_, Result<Vec<RunningInstance>, String>> {
        let rows: Vec<RunningInstance> = self
            .instances
            .lock()
            .unwrap()
            .iter()
            .filter(|i| i.status != "destroyed")
            .map(|i| RunningInstance {
                id: i.id.clone(),
                status: i.status.clone(),
                novnc_port: i.novnc_port,
                task: i.task.clone(),
            })
            .collect();
        Box::pin(async move { Ok(rows) })
    }

    fn list_templates(&self) -> BoxFuture<'_, Result<Vec<SandboxTemplate>, String>> {
        let rows = self.templates.lock().unwrap().clone();
        Box::pin(async move { Ok(rows) })
    }

    fn seed_default_template(&self) -> BoxFuture<'_, Result<(), String>> {
        let mut seeded = self.seeded.lock().unwrap();
        if !*seeded {
            self.templates.lock().unwrap().push(SandboxTemplate {
                id: "tpl-default".to_string(),
                name: "ubuntu-desktop".to_string(),
                recipe: recipe::DEFAULT_RECIPE_TOML.to_string(),
                image_tag: None,
                created_at: 1_700_000_000,
            });
            *seeded = true;
        }
        Box::pin(async move { Ok(()) })
    }

    fn load_template<'a>(
        &'a self,
        template: &'a str,
    ) -> BoxFuture<'a, Result<SandboxTemplate, String>> {
        let found = self
            .templates
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.name == template || t.id == template)
            .cloned();
        Box::pin(async move {
            found.ok_or_else(|| format!("模板不存在: {template}(先 desktop_list_templates 查看)"))
        })
    }

    fn set_template_image(
        &self,
        template_id: &str,
        image_tag: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        if let Some(template) = self
            .templates
            .lock()
            .unwrap()
            .iter_mut()
            .find(|t| t.id == template_id)
        {
            template.image_tag = Some(image_tag.to_string());
        }
        Box::pin(async move { Ok(()) })
    }

    fn insert_template(
        &self,
        name: &str,
        recipe: &str,
        image_tag: &str,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.templates.lock().unwrap().push(SandboxTemplate {
            id: format!("tpl-{name}"),
            name: name.to_string(),
            recipe: recipe.to_string(),
            image_tag: Some(image_tag.to_string()),
            created_at: 1_700_000_000,
        });
        Box::pin(async move { Ok(()) })
    }

    fn insert_frame(
        &self,
        sandbox_id: &str,
        action: &str,
        shot_path: Option<&str>,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.frames.lock().unwrap().push((
            sandbox_id.to_string(),
            action.to_string(),
            shot_path.map(str::to_string),
        ));
        Box::pin(async move { Ok(()) })
    }

    fn list_frames(
        &self,
        sandbox_id: &str,
        limit: i64,
    ) -> BoxFuture<'_, Result<Vec<ReplayFrame>, String>> {
        let rows: Vec<ReplayFrame> = self
            .frames
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _, _)| id == sandbox_id)
            .take(limit as usize)
            .map(|(_, action, shot)| ReplayFrame {
                action: action.clone(),
                shot_path: shot.clone(),
                created_at: 1_700_000_100,
            })
            .collect();
        Box::pin(async move { Ok(rows) })
    }

    fn count_frames(&self, sandbox_id: &str) -> BoxFuture<'_, Result<i64, String>> {
        let count = self
            .frames
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _, _)| id == sandbox_id)
            .count() as i64;
        Box::pin(async move { Ok(count) })
    }
}

/// 假 sidecar:记录全部调用,按方法名回 canned 结果。
#[derive(Default)]
struct FakeSidecar {
    calls: Mutex<Vec<(String, Value)>>,
}

impl FakeSidecar {
    fn last_call(&self) -> (String, Value) {
        self.calls
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("at least one call")
    }
}

impl SidecarCaller for FakeSidecar {
    fn call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> BoxFuture<'_, Result<serde_json::Value, String>> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        let result = match method {
            "docker.connect" => json!({ "connId": "conn-1" }),
            "docker.listImages" => json!([{ "tags": ["starhub-sandbox-ubuntu-desktop:latest"] }]),
            "docker.createContainer" => json!({
                "id": "container-1",
                "ports": [{ "private": 6080, "public": 15900 }],
            }),
            "docker.exec" => json!({ "stdout": "ok-output", "stderr": "", "exitCode": 0 }),
            "docker.copyFromContainer" => json!({ "content": "" }),
            "docker.inspectContainer" => json!({ "Id": "container-1" }),
            "docker.buildImage" => json!({ "lines": ["step 1", "step 2"] }),
            "docker.commitContainer" => json!({ "imageId": "sha256:abc" }),
            _ => json!({}),
        };
        Box::pin(async move { Ok(result) })
    }

    fn call_with_timeout<'a>(
        &'a self,
        method: &'a str,
        params: serde_json::Value,
        _timeout: std::time::Duration,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        self.call(method, params)
    }
}

struct EmptySettings;

impl SettingsStore for EmptySettings {
    fn get(&self, _key: &str) -> BoxFuture<'_, Result<Option<String>, String>> {
        Box::pin(async move { Ok(None) })
    }
}

struct NoAssets;

impl AssetConfigSource for NoAssets {
    fn load(&self, asset_id: &str) -> BoxFuture<'_, Result<(String, serde_json::Value), String>> {
        let asset_id = asset_id.to_string();
        Box::pin(async move { Err(format!("资产不存在: {asset_id}")) })
    }
}

#[derive(Default)]
struct RecordingEvents {
    emitted: Mutex<Vec<(String, Value)>>,
}

impl EventBroadcast for RecordingEvents {
    fn emit(&self, event: &str, payload: serde_json::Value) -> BoxFuture<'_, ()> {
        self.emitted
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
        Box::pin(async move {})
    }
}

struct TempCache(std::path::PathBuf);

impl CacheDir for TempCache {
    fn dir(&self, sub: &str) -> Result<std::path::PathBuf, String> {
        Ok(self.0.join(sub))
    }
}

/// 装配一套完整可用的上下文(内存存储 + 假 sidecar)。
fn desktop_in_temp(label: &str) -> (Desktop<'static>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("starhub-desktop-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store: &'static mut dyn InstanceStore = Box::leak(Box::new(FakeStore::default()));
    let sidecar: &'static mut dyn SidecarCaller = Box::leak(Box::new(FakeSidecar::default()));
    let settings: &'static mut dyn SettingsStore = Box::leak(Box::new(EmptySettings));
    let assets: &'static mut dyn AssetConfigSource = Box::leak(Box::new(NoAssets));
    let events: &'static mut dyn EventBroadcast = Box::leak(Box::new(RecordingEvents::default()));
    let cache: &'static mut dyn CacheDir = Box::leak(Box::new(TempCache(dir.clone())));
    let manager: &'static mut DesktopManager = Box::leak(Box::new(DesktopManager::new()));
    let known_hosts: &'static mut dyn starhub_domain_ssh::events::KnownHostsStore = Box::leak(
        Box::new(starhub_domain_ssh::events::MemoryKnownHostsStore::default()),
    );
    let desktop = Desktop {
        manager,
        sidecar,
        store,
        settings,
        assets,
        events,
        cache,
        known_hosts,
        session_id: "session-1",
    };
    (desktop, dir)
}

/// 造一个已授权实例(绕过真实 Docker 创建,直接落库 + grant)。
async fn seed_authorized_instance(desktop: &Desktop<'_>) -> String {
    let id = "box-1".to_string();
    desktop
        .store
        .insert_instance(
            &InstanceRow {
                id: id.clone(),
                container_id: "container-1".to_string(),
                platform: "local".to_string(),
                novnc_port: 15900,
                status: "running".to_string(),
                task: "test".to_string(),
                created_at: 0,
            },
            "tpl-default",
            desktop.session_id,
        )
        .await
        .expect("insert instance");
    desktop.manager.grant(desktop.session_id, &id).await;
    id
}

/// 测试辅助:从 `&dyn Seam` 还原具体替身(Box::leak 出来的 'static 引用)。
fn as_fake_sidecar(sidecar: &dyn SidecarCaller) -> &FakeSidecar {
    unsafe { &*(sidecar as *const dyn SidecarCaller as *const FakeSidecar) }
}

fn as_fake_store(store: &dyn InstanceStore) -> &FakeStore {
    unsafe { &*(store as *const dyn InstanceStore as *const FakeStore) }
}

fn as_recording_events(events: &dyn EventBroadcast) -> &RecordingEvents {
    unsafe { &*(events as *const dyn EventBroadcast as *const RecordingEvents) }
}

// ---------- 工具清单 ----------

#[test]
fn desktop_tools_inventory_matches_the_bridged_table() {
    assert_eq!(DESKTOP_TOOLS.len(), 22, "22 个 desktop_* 工具");
    assert!(DESKTOP_TOOLS.contains(&"desktop_create_sandbox"));
    assert!(DESKTOP_TOOLS.contains(&"desktop_exec"));
    assert!(DESKTOP_TOOLS.contains(&"desktop_request_user_action"));
}

// ---------- 模板清单 / 实例清单(无 Docker 依赖) ----------

#[tokio::test]
async fn list_templates_seeds_the_default_recipe() {
    let (desktop, dir) = desktop_in_temp("templates");
    let text = execute(&desktop, "desktop_list_templates", &json!({}))
        .await
        .expect("list templates");
    assert!(text.contains("模板名 | 镜像状态 | 创建时间"), "{text}");
    assert!(text.contains("ubuntu-desktop | 未构建"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn sandbox_status_without_id_lists_instances() {
    let (desktop, dir) = desktop_in_temp("status-list");
    let text = execute(&desktop, "desktop_sandbox_status", &json!({}))
        .await
        .expect("list running");
    assert_eq!(text, "当前没有运行中的沙箱实例");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- 授权语义 ----------

#[tokio::test]
async fn write_tools_require_task_authorization() {
    let (desktop, dir) = desktop_in_temp("authz");
    // 未创建沙箱:写操作必须被授权闸拦下(且不触 Docker)
    let err = execute(
        &desktop,
        "desktop_screenshot",
        &json!({ "sandboxId": "box-1" }),
    )
    .await
    .expect_err("无授权");
    assert!(err.contains("没有沙箱授权"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn unknown_tool_is_a_loud_error() {
    let (desktop, dir) = desktop_in_temp("unknown");
    let err = execute(&desktop, "desktop_nope", &json!({}))
        .await
        .expect_err("unknown tool");
    assert_eq!(err, "Unknown desktop tool: desktop_nope");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- 创建 → 授权 → 操作 全链(假 Docker) ----------

#[tokio::test]
async fn screenshot_after_authorization_returns_the_cache_path() {
    let (desktop, dir) = desktop_in_temp("screenshot");
    seed_authorized_instance(&desktop).await;
    let text = execute(&desktop, "desktop_screenshot", &json!({}))
        .await
        .expect("screenshot");
    assert!(text.contains("已截取沙箱屏幕(PNG)"), "{text}");
    assert!(text.contains("box-1-"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn click_builds_the_expected_xdotool_command_and_records_a_frame() {
    let (desktop, dir) = desktop_in_temp("click");
    seed_authorized_instance(&desktop).await;
    let text = execute(
        &desktop,
        "desktop_click",
        &json!({ "x": 100, "y": 200, "button": "right" }),
    )
    .await
    .expect("click");
    assert_eq!(text, "已在 (100,200) 单击");

    // 假 sidecar 收到的最后一条调用应是 docker.exec,脚本里含预期 xdotool 命令
    let (method, params) = as_fake_sidecar(desktop.sidecar).last_call();
    assert_eq!(method, "docker.exec");
    let script = params["command"][2].as_str().unwrap();
    assert!(
        script.starts_with("export DISPLAY=:0; xdotool "),
        "{script}"
    );
    assert!(script.contains("mousemove 100 200 click 3"), "{script}");

    // 回放帧已落库(写操作留档)
    let frames = as_fake_store(desktop.store).frames.lock().unwrap().clone();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].1, "click(100,200)");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn double_click_uses_repeat_two() {
    let (desktop, dir) = desktop_in_temp("dblclick");
    seed_authorized_instance(&desktop).await;
    let text = execute(&desktop, "desktop_double_click", &json!({ "x": 1, "y": 2 }))
        .await
        .expect("double click");
    assert_eq!(text, "已在 (1,2) 双击");
    let (_method, params) = as_fake_sidecar(desktop.sidecar).last_call();
    let script = params["command"][2].as_str().unwrap();
    assert!(script.contains("click --repeat 2 --delay 80"), "{script}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn type_escapes_the_text_through_sh_quote() {
    let (desktop, dir) = desktop_in_temp("type");
    seed_authorized_instance(&desktop).await;
    let text = execute(&desktop, "desktop_type", &json!({ "text": "it's a test" }))
        .await
        .expect("type");
    assert_eq!(text, "已输入 11 字符");
    let (_method, params) = as_fake_sidecar(desktop.sidecar).last_call();
    let script = params["command"][2].as_str().unwrap();
    assert!(
        script.contains("type --delay 20 -- 'it'\\''s a test'"),
        "{script}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn press_key_maps_friendly_names() {
    let (desktop, dir) = desktop_in_temp("key");
    seed_authorized_instance(&desktop).await;
    let text = execute(&desktop, "desktop_press_key", &json!({ "key": "ctrl+s" }))
        .await
        .expect("press key");
    assert_eq!(text, "已按键 ctrl+s");
    let (_method, params) = as_fake_sidecar(desktop.sidecar).last_call();
    let script = params["command"][2].as_str().unwrap();
    assert!(script.contains("xdotool key ctrl+s"), "{script}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn exec_runs_the_command_and_formats_stderr_and_exit() {
    let (desktop, dir) = desktop_in_temp("exec");
    seed_authorized_instance(&desktop).await;
    let text = execute(
        &desktop,
        "desktop_exec",
        &json!({ "command": "echo hi", "timeoutSec": 5 }),
    )
    .await
    .expect("exec");
    assert_eq!(text, "ok-output");
    let (method, params) = as_fake_sidecar(desktop.sidecar).last_call();
    assert_eq!(method, "docker.exec");
    assert_eq!(params["timeoutSec"], 5);
    assert_eq!(params["command"][0], "sh");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn takeover_blocks_write_operations() {
    let (desktop, dir) = desktop_in_temp("takeover");
    seed_authorized_instance(&desktop).await;
    desktop.manager.set_takeover("container-1", true).await;
    let err = execute(&desktop, "desktop_move_mouse", &json!({ "x": 1, "y": 2 }))
        .await
        .expect_err("接管中");
    assert!(err.contains("用户正在接管"), "{err}");
    // 解除接管后放行
    desktop.manager.set_takeover("container-1", false).await;
    let text = execute(&desktop, "desktop_move_mouse", &json!({ "x": 1, "y": 2 }))
        .await
        .expect("move after takeover off");
    assert_eq!(text, "指针已移动到 (1,2)");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn destroy_marks_the_instance_and_revokes_authorization() {
    let (desktop, dir) = desktop_in_temp("destroy");
    let id = seed_authorized_instance(&desktop).await;
    let text = execute(&desktop, "desktop_destroy_sandbox", &json!({}))
        .await
        .expect("destroy");
    assert!(text.contains("已销毁"), "{text}");
    assert!(text.contains("回放帧 0 条"), "{text}");
    // 撤销后写操作再次需要授权
    let err = execute(&desktop, "desktop_screenshot", &json!({}))
        .await
        .expect_err("授权已撤销");
    assert!(err.contains("没有沙箱授权"), "{err}");
    // 状态查询:实例已标记销毁
    let err = execute(
        &desktop,
        "desktop_sandbox_status",
        &json!({ "sandboxId": id }),
    )
    .await
    .expect_err("已销毁");
    assert!(err.contains("已销毁"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn create_sandbox_grants_task_authorization() {
    let (desktop, dir) = desktop_in_temp("create");
    // 先列一次模板:播种内置默认配方(与真实使用顺序一致)
    execute(&desktop, "desktop_list_templates", &json!({}))
        .await
        .expect("seed templates");
    let text = execute(
        &desktop,
        "desktop_create_sandbox",
        &json!({ "template": "ubuntu-desktop", "task": "回归测试" }),
    )
    .await
    .expect("create sandbox");
    assert!(text.contains("沙箱已创建并启动"), "{text}");
    assert!(text.contains("http://127.0.0.1:15900/vnc.html"), "{text}");
    // 授权即刻生效:后续写操作不再被拦
    let sandbox_id = text
        .lines()
        .find(|line| line.trim_start().starts_with("沙箱 id:"))
        .and_then(|line| line.rsplit(':').next())
        .map(str::trim)
        .expect("sandbox id line")
        .to_string();
    let status = execute(
        &desktop,
        "desktop_sandbox_status",
        &json!({ "sandboxId": sandbox_id }),
    )
    .await
    .expect("status after create");
    assert!(status.contains("接管:否"), "{status}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn request_user_action_broadcasts_and_resolves() {
    let (desktop, dir) = desktop_in_temp("user-action");
    seed_authorized_instance(&desktop).await;
    let answerer = tokio::spawn(async move {
        // 等横幅广播出来,再以「已完成」应答(guard 不跨 await)
        for _ in 0..100 {
            let request_id = {
                let events = as_recording_events(desktop.events).emitted.lock().unwrap();
                events
                    .first()
                    .and_then(|(_, payload)| payload["requestId"].as_str())
                    .map(str::to_string)
            };
            if let Some(request_id) = request_id {
                if desktop.manager.resolve_user_action(&request_id, true).await {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("banner never broadcast");
    });
    let text = execute(
        &desktop,
        "desktop_request_user_action",
        &json!({ "message": "请扫码登录" }),
    )
    .await
    .expect("user action");
    assert!(text.contains("用户已完成请求的操作"), "{text}");
    answerer.await.expect("answerer task");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- 纯函数(随执行体搬迁的契约) ----------

#[test]
fn map_key_rejects_injection_attempts() {
    assert!(map_key("a;rm -rf /").is_err());
    assert!(map_key("$(reboot)").is_err());
    assert_eq!(map_key("ctrl+shift+s").unwrap(), "ctrl+shift+s");
}
