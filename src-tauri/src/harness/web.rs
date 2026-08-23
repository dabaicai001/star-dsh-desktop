//! dsh web GUI 组合的长驻管理器(主壳融合 P1,与 HarnessManager 并列)。
//!
//! 把 `vendor/deepseek-harness/examples/starhub-web/boot.mjs` 的逻辑移植到 Rust:
//! 1. 物化 `$DSH_HOME/profiles/web/`(默认 `<app_data_dir>/dsh-web-home`,
//!    可用 STARHUB_DSH_WEB_HOME 覆盖)——拷 profile package.json,并把
//!    cordis.patch.yml 的 webserver 端口改写为实际选定端口;
//! 2. 为本地包(client-nav / host-static)在 `$DSH_HOME/profiles/node_modules`
//!    下补 junction(healProfilesModuleFallback 不会链接依赖闭包之外的本地包);
//! 3. spawn 便携 Node + `apps/cli/lib/bin.js web`,kill_on_drop 随应用退出回收
//!    (与 HarnessManager / SidecarManager 同一约定)。
//!
//! 端口:正式(release)实例默认 3085,开发(debug)实例默认 3185 —— 与本机
//! 常驻正式实例的 3085 隔离;占用则递增重试(上限 +10);实际端口写回状态,经
//! `dsh_web_url` command 暴露。就绪探测:轮询 GET / 直到 200(超时 30s)。
//! P4a 起 dsh web 是唯一主壳(旧外壳与 STARHUB_DSH_WEB=0 逃生门已退役)。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tauri::Manager;
use thiserror::Error;
use tokio::process::{Child, Command};

use super::{IncomingFrame, OutboundFrame};
use super::plugins;
use super::{handle_inbound_request, HarnessPaths, HostBridgeState};
use std::sync::Arc;
use tokio::sync::mpsc;

/// dsh web 默认端口(与 examples/starhub-web/cordis.patch.yml 的 webserver
/// 模板一致;实际端口由 rewrite_patch_port 写回)。开发(debug)实例用 3185 起,
/// 与「本机常驻正式实例的 3085」隔离;正式(release)实例保持 3085(历史默认)。
#[cfg(debug_assertions)]
pub const DEFAULT_PORT: u16 = 3185;
/// 正式(release)实例默认端口:3085(历史默认,升级不变)。
#[cfg(not(debug_assertions))]
pub const DEFAULT_PORT: u16 = 3085;
/// 端口递增重试上限:`DEFAULT_PORT..=DEFAULT_PORT + MAX_PORT_OFFSET`。
const MAX_PORT_OFFSET: u16 = 10;
/// 就绪探测总超时。
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// 就绪探测间隔。
const READY_INTERVAL: Duration = Duration::from_millis(300);
/// starhub-web 组合在 vendor 内的相对路径。
const EXAMPLE_REL: &str = "examples/starhub-web";
/// dsh CLI bin 相对 vendor 根的路径。
const CLI_BIN_REL: &str = "apps/cli/lib/bin.js";
/// 需要补 junction 的本地包(packages/starhub/ 下的目录名)。
/// tool-context 自 v0.71 起被 examples/starhub-web/cordis.patch.yml 引用;
/// 2026-08-18 起壳内会话可调 starhub 工具,starhub-tools / approval-bridge /
/// session-registry / domain-events / live-context 一并入列;
/// 2026-08-21 起 memory-context 入列(pre-step 长期记忆注入);
/// 2026-08-22 起 commit-message 入列(分支胶囊「AI 生成提交信息」的
/// host 侧 one-shot LLM HTTP 端点);
/// 2026-08-22 起 memory-sink 入列(agent/turn-stopping 自动沉淀;与
/// package-dsh-runtime.ts 的 WEB_LOCAL_PACKAGE_DIRS 对齐,漏列即安装包
/// 启动 ERR_MODULE_NOT_FOUND —— v0.92.2 事故)。
const LOCAL_PACKAGES: [&str; 11] = [
    "client-nav",
    "host-static",
    "tool-context",
    "tools",
    "approval-bridge",
    "session-registry",
    "domain-events",
    "live-context",
    "memory-context",
    "memory-sink",
    "commit-message",
];

/// 由 `examples/starhub-web/cordis.patch.yml` 的 insert 块直接引用、但**不在**
/// dsh 安装闭包(INSTALL_ANCHOR = apps/cli/package.json 的依赖闭包)内的包。
/// dsh 的 `healProfilesModuleFallback` 只从该闭包 BFS 建链,闭包外的包它永不链接,
/// 因此这些包必须由本 Rust 侧从 `runtime_dir/node_modules/@deepseek-ai/<名>` 补
/// junction 到 `$DSH_HOME/profiles/node_modules`,否则 web profile 的裸 entry 经
/// Node parent-walk 在 profiles/node_modules 停步即 ERR_MODULE_NOT_FOUND、dsh web
/// 起不来。值取包名去 `@deepseek-ai/` 前缀后的子目录名(见 runtime 布局)。
const RUNTIME_HOSTED_PATCH_DEPS: [&str; 1] = ["sdk-jsonrpc-server"];

#[derive(Debug, Error)]
pub enum DshWebError {
    #[error("dsh web 路径解析失败: {0}")]
    PathResolve(String),
    #[error("dsh web 启动失败: {0}")]
    Spawn(String),
    #[error("dsh web 就绪探测超时({0}s),进程日志见 tracing")]
    ReadyTimeout(u64),
    #[error("dsh web 端口全部被占用({start}..={end})")]
    NoFreePort { start: u16, end: u16 },
    #[error("dsh web 未运行")]
    NotRunning,
}

/// 一次成功启动的运行态:URL / 子进程句柄。
struct DshWebHandle {
    url: String,
    child: Child,
}

/// 挂在 tauri State 上的 dsh web 单例管理器。
pub struct DshWebManager {
    handle: tokio::sync::Mutex<Option<DshWebHandle>>,
    /// 串行化 ensure_started,消除并发 spawn 的 TOCTOU
    start_lock: tokio::sync::Mutex<()>,
}

/// DSH_HOME 目录(`STARHUB_DSH_WEB_HOME` 覆盖优先,缺省 `<app_data_dir>/dsh-web-home`)。
/// 嵌入 runtime 的 `DSH_SETTINGS_PATH` 复用同一解析(harness::mod.rs
/// build_spawn_env),保证两端共享同一份 settings.yaml(权限 preset)。
pub fn dsh_home_dir(app: &tauri::AppHandle) -> Result<PathBuf, DshWebError> {
    match std::env::var("STARHUB_DSH_WEB_HOME") {
        Ok(dir) => Ok(PathBuf::from(dir)),
        Err(_) => app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("dsh-web-home"))
            .map_err(|e| DshWebError::PathResolve(format!("app_data_dir 失败: {e}"))),
    }
}

/// 在 base..=base+max_offset 里找第一个可绑定端口(开发实例的占位页占着
/// DEFAULT_PORT 时递增到下一空闲端口)。
fn find_free_port(base: u16, max_offset: u16) -> Option<u16> {
    (0..=max_offset).find_map(|offset| {
        let port = base.checked_add(offset)?;
        std::net::TcpListener::bind(("127.0.0.1", port))
            .ok()
            .map(|_| port)
    })
}

/// 把 cordis.patch.yml 模板里 webserver 行的 `port: N` 改写为实际端口。
/// patch 会整段替换目标行 config,webserver 块在本文件中是唯一的 `port:` 持有者。
fn rewrite_patch_port(template: &str, port: u16) -> Result<String, DshWebError> {
    let mut in_webserver = false;
    let mut replaced = false;
    let mut out: Vec<String> = Vec::new();
    for line in template.lines() {
        if line.trim_start().starts_with("- id:") {
            in_webserver = line.contains("webserver");
        }
        if in_webserver && !replaced && line.trim_start().starts_with("port:") {
            let indent = &line[..line.len() - line.trim_start().len()];
            out.push(format!("{indent}port: {port}"));
            replaced = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !replaced {
        return Err(DshWebError::PathResolve(
            "cordis.patch.yml 模板缺少 webserver 端口行".into(),
        ));
    }
    Ok(out.join("\n"))
}

/// StarHub 独立 React 窗口 app dist(starhub-window 构建,base /starhub-react/)。
/// 与 embed dist 同理,这里经 STARHUB_WINDOW_DIST 显式钉死,避免 host-static
/// 的 repo-root 发现(沿模块位置向上找 vendor/deepseek-harness)在打包部署
/// (runtime 与仓库根分离)时失败、把 /starhub-react 降级成 404 处理。
/// `root`:dev 下为仓库根,prod 下为 resource_dir(两者都直接含 dist-starhub-react)。
fn resolve_starhub_window_dist(root: &Path) -> Result<PathBuf, DshWebError> {
    let dir = root.join("dist-starhub-react");
    if dir.join("index.html").exists() {
        return Ok(dir);
    }
    Err(DshWebError::PathResolve(format!(
        "未找到 StarHub React window dist(先构建 starhub-window): {}",
        dir.display()
    )))
}

impl DshWebManager {
    pub fn new() -> Self {
        Self {
            handle: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// 当前运行中的 dsh web URL(未运行返回错误)。
    pub async fn url(&self) -> Result<String, DshWebError> {
        let guard = self.handle.lock().await;
        match guard.as_ref() {
            Some(handle) => Ok(handle.url.clone()),
            None => Err(DshWebError::NotRunning),
        }
    }

    /// 启动(如未运行)并等待就绪,返回 `http://127.0.0.1:<port>`。
    /// 幂等:已在运行直接返回现有 URL。`bridge` 为共享宿主桥(与 HarnessManager 同一
    /// Arc):web 进程的 `starhub/tool.execute` 请求经它分发执行,当前会话绑定沿
    /// dsh_bind_session 语义共享,出站通知(registry.sync / domain.event)同时投给 web。
    pub async fn ensure_started(
        &self,
        app: &tauri::AppHandle,
        bridge: Arc<HostBridgeState>,
    ) -> Result<String, DshWebError> {
        let _start_guard = self.start_lock.lock().await;
        if let Some(handle) = self.handle.lock().await.as_ref() {
            return Ok(handle.url.clone());
        }
        let handle = self.spawn(app, bridge).await?;
        let url = handle.url.clone();
        *self.handle.lock().await = Some(handle);
        Ok(url)
    }

    async fn spawn(
        &self,
        app: &tauri::AppHandle,
        bridge: Arc<HostBridgeState>,
    ) -> Result<DshWebHandle, DshWebError> {
        use tauri::Manager;
        let paths = HarnessPaths::resolve_for_app(app)
            .map_err(|e| DshWebError::PathResolve(e.to_string()))?;
        let runtime_dir = paths.runtime_dir;
        // prod 的 React workbench dist 与本地包走 resource_dir;dev 走 runtime_dir 上两级的仓库根。
        let dist_root = if paths.is_packaged {
            app.path()
                .resource_dir()
                .map_err(|e| DshWebError::PathResolve(format!("resource_dir 失败: {e}")))?
        } else {
            runtime_dir
                .join("..")
                .join("..")
                .canonicalize()
                .map_err(|e| DshWebError::PathResolve(format!("仓库根解析失败: {e}")))?
        };
        let example_dir = runtime_dir.join(EXAMPLE_REL);
        let cli_bin = runtime_dir.join(CLI_BIN_REL);
        if !cli_bin.exists() {
            return Err(DshWebError::PathResolve(format!(
                "{} 缺失(先在 vendor 内跑 build:lib:host)",
                cli_bin.display()
            )));
        }

        // 1. DSH_HOME 与 profile 物化
        let dsh_home = dsh_home_dir(app)?;
        let profile_dir = dsh_home.join("profiles").join("web");
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| DshWebError::PathResolve(format!("创建 profile 目录失败: {e}")))?;
        std::fs::copy(
            example_dir.join("package.json"),
            profile_dir.join("package.json"),
        )
        .map_err(|e| DshWebError::PathResolve(format!("物化 profile package.json 失败: {e}")))?;

        // 2. 选端口并改写 patch
        let port = find_free_port(DEFAULT_PORT, MAX_PORT_OFFSET).ok_or(DshWebError::NoFreePort {
            start: DEFAULT_PORT,
            end: DEFAULT_PORT + MAX_PORT_OFFSET,
        })?;
        let patch_template = std::fs::read_to_string(example_dir.join("cordis.patch.yml"))
            .map_err(|e| {
                DshWebError::PathResolve(format!("读取 cordis.patch.yml 模板失败: {e}"))
            })?;
        std::fs::write(
            profile_dir.join("cordis.patch.yml"),
            rewrite_patch_port(&patch_template, port)?,
        )
        .map_err(|e| DshWebError::PathResolve(format!("物化 cordis.patch.yml 失败: {e}")))?;

        // 3. 本地包 junction(已存在则复用,目标本就固定指向 vendor)
        let node_modules_root = dsh_home.join("profiles").join("node_modules");
        let link_base = node_modules_root.join("@deepseek-ai");
        std::fs::create_dir_all(&link_base).map_err(|e| {
            DshWebError::PathResolve(format!("创建 profiles/node_modules 失败: {e}"))
        })?;
        for dir_name in LOCAL_PACKAGES {
            let link = link_base.join(format!("dsh-starhub-{dir_name}"));
            if link.exists() {
                continue;
            }
            let target = runtime_dir.join("packages").join("starhub").join(dir_name);
            // 旧部署的 runtime 可能还没有该包目录(如 v0.71 新增的 tool-context):
            // 跳过即可——healed profiles/node_modules 兜底会从安装闭包解析;
            // 两边都缺时由 loader 在启动时 fail-loud。
            if !target.exists() {
                tracing::warn!("本地包目录缺失,跳过 junction: {}", target.display());
                continue;
            }
            plugins::create_dir_link(&link, &target).map_err(|e| {
                DshWebError::PathResolve(format!(
                    "junction 创建失败({} → {}): {e}",
                    link.display(),
                    target.display()
                ))
            })?;
        }
        // 3.1 闭包外 patch 依赖 junction(sdk-jsonrpc-server 等):healProfilesModuleFallback
        // 只从 apps/cli 安装闭包建链,web profile patch 直接引用的闭包外包永不落地到
        // profiles/node_modules,裸 entry 解析即 ERR_MODULE_NOT_FOUND。这里同样从
        // runtime 安装树锚点建 junction(目标 realpath 在 runtime/node_modules,其依赖
        // 沿真实目录 parent-walk 自解析),使 prod 与全新 DSH_HOME 都能稳定启动。
        for dir_name in RUNTIME_HOSTED_PATCH_DEPS {
            let link = link_base.join(format!("dsh-{dir_name}"));
            if link.exists() {
                continue;
            }
            let target = runtime_dir
                .join("node_modules")
                .join("@deepseek-ai")
                .join(format!("dsh-{dir_name}"));
            if !target.exists() {
                tracing::warn!("闭包外 patch 依赖目录缺失,跳过 junction: {}", target.display());
                continue;
            }
            plugins::create_dir_link(&link, &target).map_err(|e| {
                DshWebError::PathResolve(format!(
                    "junction 创建失败({} → {}): {e}",
                    link.display(),
                    target.display()
                ))
            })?;
        }

        // 3.5 用户 UI 插件注入(dsh 插件体系打通):内置插件注册进 registry,
        // 启用中的 dsh.client 用户插件按包名 junction 进 profiles/node_modules
        // (dsh web 内核的 ClientModuleRegistry 依 entry 名 require.resolve
        // 包根并读 dsh.client 声明,把其 client bundle 扫进 __DSH_BOOT__),
        // 依赖同样 junction 到该锚点,并在 cordis.patch.yml 的 insert 块追加
        // entry 行(name 用完整包名)。
        let plugin_paths = plugins::PluginPaths::resolve(app)
            .map_err(|e| DshWebError::PathResolve(e.to_string()))?;
        plugins::ensure_builtin_plugins(&plugin_paths, &runtime_dir)
            .map_err(|e| DshWebError::PathResolve(format!("内置插件注册失败: {e}")))?;
        let mut patch_content = std::fs::read_to_string(profile_dir.join("cordis.patch.yml"))
            .map_err(|e| DshWebError::PathResolve(format!("读取 patch 失败: {e}")))?;
        sync_user_client_plugins(
            &plugin_paths,
            &node_modules_root,
            &runtime_dir,
            &mut patch_content,
        )?;
        std::fs::write(profile_dir.join("cordis.patch.yml"), patch_content)
            .map_err(|e| DshWebError::PathResolve(format!("写回 patch 失败: {e}")))?;

        // 4. spawn dsh web 组合
        // React 独立窗口 dist 显式钉死(host-static 的 repo-root 发现在打包部署下
        // 找不到仓库根,不设置会导致 /starhub-react 路由 404 —— 打开 ssh/db 连接页报
        // 「找不到 127.0.0.1 页」)。best-effort:未构建时只记日志,不影响 web 启动
        // (host-static 对 /starhub-react 缺 dist 本就有 404 兜底)。
        let starhub_window_dist = match resolve_starhub_window_dist(&dist_root) {
            Ok(dir) => dir,
            Err(error) => {
                tracing::warn!("{error}");
                PathBuf::new()
            }
        };
        // 与 HarnessRuntime::spawn 一致:入口用相对路径 + current_dir,避免 Windows
        // 下绝对路径(盘符 + 反斜杠)经命令行传给 node 后被截断成盘符(如 "E:")。
        let mut cmd = Command::new(&paths.node_path);
        cmd.arg(CLI_BIN_REL)
            .arg("web")
            .current_dir(&runtime_dir)
            // 2026-08-18:stdin/stdout 接入共享 JSON-RPC 桥,让壳内(web)会话能经
            // sdk-jsonrpc-server 反向调 starhub_* 工具(走 Rust 主进程执行);之前的
            // Stdio::null() 会让 web 的 sdk-transport 进程内解析失败。
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("DSH_HOME", &dsh_home)
            .env("DSH_TELEMETRY_DISABLED", "1");
        if !starhub_window_dist.as_os_str().is_empty() {
            cmd.env("STARHUB_WINDOW_DIST", &starhub_window_dist);
        }
        // 仅透传真实环境 key,不再注入占位 key(与 boot.mjs 一致)。
        // 否则 dsh 会把 key 判定为「由启动环境提供」(source=env,只读),
        // 首次进入不弹 key 引导、Models 页也锁死无法输入。
        if let Ok(key) = std::env::var("DEEPSEEK_API_KEY") {
            if !key.trim().is_empty() {
                cmd.env("DEEPSEEK_API_KEY", key);
            }
        }
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        tracing::info!(
            "spawn dsh web: node={} bin={} cwd={}",
            paths.node_path.display(),
            cli_bin.display(),
            runtime_dir.display()
        );
        let mut child = cmd.spawn().map_err(|e| {
            DshWebError::Spawn(format!(
                "{} {}: {e}",
                paths.node_path.display(),
                cli_bin.display()
            ))
        })?;
        let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = child.start_kill();
                return Err(DshWebError::Spawn("web 子进程管道获取失败".into()));
            }
        };
        // 与 HarnessRuntime 同款 stdio JSON-RPC 桥:读 web 进程 stdout 帧,
        // 入站 request(starhub/tool.execute 等)经共享 handle_inbound_request 分发并回写
        // 响应帧到 web 的 stdin;web 关停/退出(stdout EOF)时自动摘除 web_notify 出站,
        // 避免向已关闭的 stdin 写报 EPIPE。
        let bridge = bridge.clone();
        let (notify_tx, notify_rx) = mpsc::unbounded_channel::<OutboundFrame>();
        let notify_sink = notify_tx.clone();
        let clear_web_notify = bridge.set_web_notify(bridge.clone(), Arc::new(move |method, params| {
            let _ = notify_sink.send(OutboundFrame {
                request_id: None,
                payload: format!(
                    "{{\"jsonrpc\":\"2.0\",\"method\":{},\"params\":{}}}",
                    serde_json::to_string(&method).unwrap_or_else(|_| "\"\"".to_string()),
                    params,
                ),
            });
        }));
        tokio::spawn(web_read_loop(stdout, bridge, notify_tx, clear_web_notify));
        tokio::spawn(web_write_loop(stdin, notify_rx));
        tokio::spawn(drain_lines("stderr", stderr));

        // 5. 就绪探测:轮询 GET / 直到 200
        let url = format!("http://127.0.0.1:{port}");
        let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
        let client = reqwest::Client::new();
        loop {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => break,
                _ => {
                    if tokio::time::Instant::now() >= deadline {
                        let _ = child.start_kill();
                        return Err(DshWebError::ReadyTimeout(READY_TIMEOUT.as_secs()));
                    }
                    tokio::time::sleep(READY_INTERVAL).await;
                }
            }
        }

        tracing::info!("dsh web 就绪: {url}(DSH_HOME={})", dsh_home.display());
        Ok(DshWebHandle { url, child })
    }

    /// 关停并清空单例(应用退出路径;kill_on_drop 已覆盖崩溃路径)。
    pub async fn shutdown(&self) {
        if let Some(mut handle) = self.handle.lock().await.take() {
            let _ = handle.child.start_kill();
        }
    }
}

/// 子进程 stdout/stderr 排空到 tracing(dsh 日志量较大,一律 info 级)。
async fn drain_lines(tag: &'static str, io: impl tokio::io::AsyncRead + Unpin) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(io).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!("dsh web {tag}: {}", line.trim());
    }
}

/// web 进程 stdout 的 JSON-RPC 读循环:逐行解析帧,入站 request(method + id,
/// 无 result/error,即 shell 会话经 sdk-jsonrpc-server 反调 host 的工具执行)由
/// 共享 `handle_inbound_request` 分发,响应帧经 outbound 通道回写 web 的 stdin;
/// 通知/响应帧忽略(通知无对外下游,响应本进程不发起请求)。stdout EOF(web 退出)
/// 时摘除 web_notify 出站,防止后续向已关闭 stdin 写报 EPIPE。
async fn web_read_loop(
    stdout: tokio::process::ChildStdout,
    bridge: Arc<HostBridgeState>,
    outbound: mpsc::UnboundedSender<OutboundFrame>,
    clear_notify: impl Fn() + Send + 'static,
) {
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut line: Vec<u8> = Vec::new();
    loop {
        let chunk = match reader.fill_buf().await {
            Ok(chunk) => chunk,
            Err(_) => break,
        };
        if chunk.is_empty() {
            break; // EOF:web 进程退出
        }
        match chunk.iter().position(|byte| *byte == b'\n') {
            Some(pos) => {
                line.extend_from_slice(&chunk[..pos]);
                reader.consume(pos + 1);
                if let Ok(frame) = serde_json::from_slice::<IncomingFrame>(&line) {
                    if let (Some(id), Some(method)) = (frame.id.as_ref(), frame.method.as_ref()) {
                        if frame.result.is_none() && frame.error.is_none() {
                            let params = frame.params.unwrap_or(serde_json::Value::Null);
                            let bridge = bridge.clone();
                            let outbound = outbound.clone();
                            let id = id.clone();
                            let method = method.clone();
                            tokio::spawn(async move {
                                let payload = match handle_inbound_request(&method, params, bridge).await {
                                    Ok(result) => serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                                    Err(super::InboundError::MethodNotFound(message)) => serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "error": { "code": -32601, "message": message },
                                    }),
                                    Err(super::InboundError::Failed(message)) => serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": id,
                                        "error": { "code": -32603, "message": message },
                                    }),
                                };
                                let _ = outbound.send(OutboundFrame {
                                    request_id: None,
                                    payload: payload.to_string(),
                                });
                            });
                        }
                    }
                }
                line.clear();
            }
            None => {
                line.extend_from_slice(chunk);
                let consumed = chunk.len();
                reader.consume(consumed);
            }
        }
    }
    clear_notify();
}

/// 把 outbound 帧逐行写入 web 进程 stdin;通道关闭(没有更多帧)即结束。
async fn web_write_loop(
    mut stdin: tokio::process::ChildStdin,
    mut outbound: mpsc::UnboundedReceiver<OutboundFrame>,
) {
    use tokio::io::AsyncWriteExt;
    while let Some(frame) = outbound.recv().await {
        if stdin.write_all(frame.payload.as_bytes()).await.is_err() {
            break;
        }
        if stdin.write_all(b"\n").await.is_err() {
            break;
        }
        if stdin.flush().await.is_err() {
            break;
        }
    }
}

/// YAML 单引号标量转义(`'` 双写)。id 已过 [a-z0-9-_] charset 校验,
/// entry 已过 Normal 组件校验;这里仍防御性转义,保证任何输入不破坏 yml。
fn yaml_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 同步用户 UI 插件到 dsh web 组合:
/// 1. 清理失效 junction(指向 plugins/ 但不在当前启用集的,深度 ≤2 递归);
/// 2. 为启用中的 dsh.client 用户插件按包名建 junction
///    (profiles/node_modules/<pkgname>,带 scope 则多级),并解析其依赖
///    到同一锚点(web 进程的解析起点);
/// 3. 在 patch 的 insert 块末尾追加 entry 行(name 用完整包名,与本地包同形)。
fn sync_user_client_plugins(
    plugin_paths: &plugins::PluginPaths,
    node_modules_root: &Path,
    vendor_root: &Path,
    patch: &mut String,
) -> Result<(), DshWebError> {
    let enabled = plugins::user_client_plugins(plugin_paths)
        .map_err(|e| DshWebError::PathResolve(e.to_string()))?;

    // 1. 陈旧清理:junction 指向 app_data/plugins 且不在当前启用插件集 → 移除
    let plugins_root = plugin_paths.plugins_dir();
    let enabled_ids: std::collections::HashSet<String> =
        enabled.iter().map(|p| p.id.clone()).collect();
    let mut stale: Vec<PathBuf> = Vec::new();
    collect_stale_links(
        node_modules_root,
        &plugins_root,
        &enabled_ids,
        &mut stale,
        0,
    );
    for path in stale {
        tracing::info!("移除失效的用户 UI 插件 junction: {}", path.display());
        // Windows 目录 junction 用 rmdir 语义移除;Unix 目录 symlink 必须用
        // unlink(remove_dir 对 symlink 报 ENOTDIR,静默吞掉会让链接残留,
        // 禁用后 junction 仍留在 profiles/node_modules)。
        #[cfg(target_os = "windows")]
        let result = fs::remove_dir(&path);
        #[cfg(not(target_os = "windows"))]
        let result = fs::remove_file(&path);
        if let Err(error) = result {
            tracing::warn!(
                "移除失效的用户 UI 插件 junction 失败({}): {error}",
                path.display()
            );
        }
    }

    // 2/3. 建 junction(按包名,带 scope 多级)+ 依赖解析 + 追加 patch entry
    for record in &enabled {
        // 包名路径化:scope 展开为子目录(profiles/node_modules/@scope/name)
        let rel = plugin_link_rel(&record.name);
        let link = node_modules_root.join(&rel);
        if !link.exists() {
            let target = plugin_paths.plugin_dir(&record.id);
            if let Some(parent) = link.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    DshWebError::PathResolve(format!("创建插件 junction 父目录失败: {e}"))
                })?;
            }
            if let Err(error) = plugins::create_dir_link(&link, &target) {
                // 诊断:junction 失败时捕获 cmd stderr(定位权限/路径问题)
                #[cfg(target_os = "windows")]
                let diag = {
                    use std::os::windows::process::CommandExt;
                    /// CREATE_NO_WINDOW:诊断 spawn 同样不弹可见控制台窗口。
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let mut cmd = std::process::Command::new("cmd");
                    cmd.args(["/C", "mklink", "/J"])
                        .arg(&link)
                        .arg(&target)
                        .creation_flags(CREATE_NO_WINDOW);
                    cmd.output()
                };
                #[cfg(not(target_os = "windows"))]
                let diag = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&link)
                    .arg(&target)
                    .output();
                match diag {
                    Ok(out) => {
                        tracing::error!(
                            "用户 UI 插件 junction 失败({} → {}): {error}\nstderr: {}\nstdout: {}",
                            link.display(),
                            target.display(),
                            String::from_utf8_lossy(&out.stderr),
                            String::from_utf8_lossy(&out.stdout),
                        );
                    }
                    Err(e) => {
                        tracing::error!("用户 UI 插件 junction 诊断失败: {e}");
                    }
                }
                return Err(DshWebError::PathResolve(format!(
                    "用户 UI 插件 junction 失败({} → {}): {error}",
                    link.display(),
                    target.display()
                )));
            }
            tracing::info!(
                "用户 UI 插件注入 dsh web: {} → {}",
                link.display(),
                target.display()
            );
            // 依赖 junction 到 web 进程解析锚点(与运行时 plugins/node_modules 同策略)
            if let Err(error) =
                plugins::resolve_plugin_dependencies_into(&target, vendor_root, node_modules_root)
            {
                tracing::warn!("用户 UI 插件依赖解析失败(可忽略): {error}");
            }
        }
        patch.push_str(&format!(
            "    - id: {}\n      name: {}\n",
            yaml_single_quoted(&record.id),
            yaml_single_quoted(&record.name),
        ));
    }
    Ok(())
}

/// 包名 → node_modules 相对路径(@scope/name → @scope/name;name → name)。
/// 只保留前两段,防御异常包名。
fn plugin_link_rel(name: &str) -> PathBuf {
    let mut rel = PathBuf::new();
    for (index, segment) in name.split('/').enumerate() {
        if index > 2 || segment.is_empty() {
            break;
        }
        rel.push(segment);
    }
    rel
}

/// 递归(深度 ≤2)收集指向 plugins/ 且不在启用插件集(按插件 id)的 junction。
fn collect_stale_links(
    dir: &Path,
    plugins_root: &Path,
    enabled_ids: &std::collections::HashSet<String>,
    out: &mut Vec<PathBuf>,
    depth: usize,
) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && !path.is_symlink() && depth < 2 {
            // 普通目录(scope 层或真实包目录):继续递归
            collect_stale_links(&path, plugins_root, enabled_ids, out, depth + 1);
            continue;
        }
        if !path.is_symlink() {
            continue;
        }
        // junction 目标形态:plugins/<id>(首层子目录)
        let target = fs::canonicalize(&path).ok();
        let target_name = target
            .as_ref()
            .and_then(|t| t.file_name())
            .and_then(|n| n.to_str())
            .map(str::to_string);
        let points_to_plugins = target
            .as_ref()
            .zip(fs::canonicalize(plugins_root).ok())
            .is_some_and(|(target, root)| target.parent() == Some(root.as_path()));
        let stale = points_to_plugins
            && !target_name
                .as_ref()
                .is_some_and(|id| enabled_ids.contains(id));
        if stale {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_patch_port_only_touches_webserver_block() {
        let template = "# comment with port: 9999\n\
                        - id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3185\n\n\
                        - insert:\n    - id: client-nav\n      name: '@x'\n";
        let out = rewrite_patch_port(template, 3187).unwrap();
        assert!(out.contains("    port: 3187"), "改写结果: {out}");
        assert!(out.contains("port: 9999"), "注释里的 port 不应被动: {out}");
        assert!(!out.contains("port: 3185"), "旧端口应被替换: {out}");
    }

    #[test]
    fn rewrite_patch_port_missing_webserver_fails() {
        let template = "- id: other\n  config:\n    port: 1\n";
        assert!(rewrite_patch_port(template, 3185).is_err());
    }

    /// 动态基准端口:让 OS 分一个空闲端口后立刻释放,作为测试的 base。
    fn ephemeral_base() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn find_free_port_skips_occupied() {
        let base = ephemeral_base();
        let blocker =
            std::net::TcpListener::bind(("127.0.0.1", base)).expect("测试前提:基准端口可占用");
        let port = find_free_port(base, MAX_PORT_OFFSET).expect("应有可用端口");
        assert!(port > base, "基准端口被占时应递增,得到 {port}");
        // base 可能处于 OS 临时端口高位区间,用 u32 做上限比较避免 u16 溢出。
        assert!(u32::from(port) <= u32::from(base) + u32::from(MAX_PORT_OFFSET));
        drop(blocker);
    }

    #[test]
    fn find_free_port_base_first_when_free() {
        let base = ephemeral_base();
        // base 刚释放,正常应直接命中;被别的进程瞬时抢走则递增,两种结果都合法
        let port = find_free_port(base, MAX_PORT_OFFSET).expect("应有可用端口");
        assert!(
            u32::from(port) <= u32::from(base) + u32::from(MAX_PORT_OFFSET) && port >= base,
            "端口应落在 [base, base+offset],得到 {port}(base={base})"
        );
    }

    /// 用户 UI 插件注入:建 junction、追加 patch entry、清理失效 junction。
    #[test]
    fn sync_user_client_plugins_injects_and_cleans() {
        use super::plugins::{self, PluginPaths};
        use std::fs;
        let root = std::env::temp_dir().join(format!(
            "starhub-web-sync-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let app_data = root.join("app-data");
        let vendor_root = root.join("vendor/deepseek-harness");
        // 假 vendor peer 布局(install_local_dir 会建 peer junction)
        for pkg in ["cordis", "cosmokit", "schemastery"] {
            let dir = vendor_root.join("vendor").join(pkg);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("package.json"),
                format!("{{\"name\": \"@deepseek-ai/{pkg}\"}}"),
            )
            .unwrap();
        }
        let paths = PluginPaths::at(app_data.clone());
        paths.ensure_layout().unwrap();

        // 安装两个 UI 插件:一个启用、一个禁用
        let write_ui_plugin = |dir: &Path, name: &str| {
            fs::create_dir_all(dir.join("lib")).unwrap();
            fs::write(
                dir.join("package.json"),
                format!(
                    r#"{{"name": "{name}", "main": "lib/index.js",
                        "dsh": {{"bundle": {{"patch": "./p.yml"}}, "client": {{"entry": "./ui.js"}}}}}}"#
                ),
            )
            .unwrap();
            fs::write(dir.join("lib/index.js"), "export default {}\n").unwrap();
        };
        let src_a = root.join("src-ui-a");
        write_ui_plugin(&src_a, "dsh-ui-a");
        let src_b = root.join("src-ui-b");
        write_ui_plugin(&src_b, "dsh-ui-b");
        plugins::install_local_dir(&paths, &src_a, &vendor_root).unwrap();
        plugins::install_local_dir(&paths, &src_b, &vendor_root).unwrap();
        plugins::set_enabled(&paths, "dsh-ui-a", true).unwrap();

        let node_modules_root = root.join("profiles").join("node_modules");
        fs::create_dir_all(&node_modules_root).unwrap();
        let mut patch = String::from("- insert:\n    - id: client-nav\n      name: '@x'\n");
        sync_user_client_plugins(&paths, &node_modules_root, &vendor_root, &mut patch).unwrap();

        // 启用的插件:按包名 junction 建立 + patch 行(完整包名)+ 依赖解析到同锚点
        assert!(
            node_modules_root.join("dsh-ui-a").exists(),
            "启用插件应按包名 junction"
        );
        assert!(
            !node_modules_root.join("dsh-ui-b").exists(),
            "禁用插件不应 junction"
        );
        assert!(
            patch.contains("    - id: 'dsh-ui-a'\n      name: 'dsh-ui-a'"),
            "patch 应追加 entry 行(完整包名):\n{patch}"
        );

        // 禁用后再次同步 → junction 清理
        plugins::set_enabled(&paths, "dsh-ui-a", false).unwrap();
        let mut patch2 = String::from("- insert:\n");
        sync_user_client_plugins(&paths, &node_modules_root, &vendor_root, &mut patch2).unwrap();
        assert!(
            !node_modules_root.join("dsh-ui-a").exists(),
            "禁用后 junction 应清理"
        );
        assert!(!patch2.contains("dsh-ui-a"), "禁用后 patch 不再追加");
        let _ = fs::remove_dir_all(&root);
    }
}
