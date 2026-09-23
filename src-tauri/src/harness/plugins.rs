//! dsh 用户插件的加载面(AI 内核替换支线 B,方案 8.3 第 4 条「用户自行引入」)。
//!
//! v0.123.1 起安装/启停/卸载/市场目录的命令面移除:插件管理改由 dsh 壳内
//! 首页「插件」面板(原生 Loader 体系)承担,两边插件 store 不同——本模块只
//! 继续加载历史上装进 app_data_dir/plugins 的用户插件(registry.json 仍是
//! 事实源),并负责 spawn 前的 peer junction 与包装配置生成。
//!
//! 目录布局(app_data_dir 下,解析模式同 `crate::db`):
//! ```text
//! <app_data_dir>/
//! ├── dsh-cordis.generated.yml   # spawn 前整体重写的包装配置(见下)
//! └── plugins/
//!     ├── cordis.yml             # 用户插件 entry 清单(本模块独占生成,请勿手改)
//!     ├── registry.json          # 来源/版本/启停/许可元数据
//!     ├── node_modules/@deepseek-ai/{cordis,cosmokit,schemastery}  # → runtime 的 junction
//!     │   # (dev 指向 vendor/<pkg>;prod 闭包指向 node_modules/@deepseek-ai/<pkg>)
//!     └── <id>/                  # 每个插件一个目录,含 package.json(dsh.bundle manifest)
//! ```
//!
//! 加载机制(调研结论,见实施任务清单支线 B;DSH 0.1.6 适配,2026-09-20):
//! - app-boot 的 boot() 会把 vendored Include 注册为内建插件 `cordis:include`,
//!   因此任何位置的配置都能直接引用它,无需模块解析;
//! - Include 会把子树 baseUrl 重设为被包含文件所在目录,所以主组合里的裸包名
//!   (`@deepseek-ai/dsh-*`)仍在 vendor 仓库内解析,用户插件的 `./<id>/...`
//!   相对路径在 plugins/ 目录内解析;
//! - **Include 是 tree carrier(EntryGroup.key),其 config 保持 literal,`!!js`
//!   不会在 path 字段求值**——因此不能用 env 注入路径,改为本模块在每次 spawn
//!   前生成包装配置 `dsh-cordis.generated.yml`(一条 `- insert:` 包着的
//!   cordis:include entry:plugins/cordis.yml,带 `initial: []` 容忍文件缺失)。
//! - 0.1.6 起内嵌 runtime 经 `dsh --profile sdk --patch <主组合> --patch <包装配置>`
//!   启动:主组合(`examples/starhub-agent/cordis.yml`)直接作为 patch 覆盖层传入
//!   (patch 语义:裸 `- id:` 行整段替换 bundle 已有行的 config,`- insert:` 追加
//!   新行),故包装配置只剩用户插件一条 include;patch 层里匹配不到已有行的裸 id
//!   只会 warn 跳过,不会插入。
//!
//! 安全决策(加载侧):
//! - 生成的 yml 一律单引号转义,entry 只允许字面量,禁止 `!!js`;
//! - registry 的 id 经 charset 校验([a-z0-9-_]),目录越界写入无从谈起。
//!
//! 坏插件自救:web/runtime 启动失败时 `disable_user_plugins` 禁用全部已启用
//! 的用户插件(幂等),用户可在 dsh 壳内首页「插件」面板重新启用原生插件。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// peer 依赖 junction:第三方 dsh 插件普遍 `import '@deepseek-ai/cordis'`,
/// ESM 从 plugins/ 向上找不到 runtime 的 node_modules,需为这三个包建立
/// 指向 runtime 对应目录的链接(dev:vendor/<pkg>;prod 闭包:
/// node_modules/@deepseek-ai/<pkg>,目录名即包名后缀)。
const PEER_PACKAGE_DIRS: [&str; 3] = ["cordis", "cosmokit", "schemastery"];

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("路径解析失败: {0}")]
    PathResolve(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
}

/// 插件来源(registry 展示用;新记录只由内置注册产生,kind="builtin",
/// 旧安装记录的 market/url/local-dir/local-zip 仍按原样加载)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    /// builtin(内置)/ 历史安装记录的 market / url / local-dir / local-zip
    pub kind: String,
    /// 来源 URL 或本地路径
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// registry.json 中单个插件的记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    /// 目录名与 entry id([a-z0-9-_],由包名清洗而来)
    pub id: String,
    /// package.json 的 name(原始,可带 scope)
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub source: PluginSource,
    /// 入口文件(插件目录内相对路径,posix 风格,如 lib/index.js)
    pub entry: String,
    /// 启停状态,落在生成的 cordis.yml entry 的 disabled 字段
    pub enabled: bool,
    /// 浏览器端 UI 插件(manifest 声明 `dsh.client`;由 dsh web 进程加载,
    /// 经 profiles/node_modules junction 进 __DSH_BOOT__)
    #[serde(default, skip_serializing_if = "is_false")]
    pub dsh_client: bool,
    /// 内置插件(runtime 自带包,如 client-nav;不可卸载,来源 kind="builtin")
    #[serde(default, skip_serializing_if = "is_false")]
    pub builtin: bool,
    pub installed_at: String,
}

/// serde skip 谓词:false 时跳过字段(保持旧 registry 兼容,不写死缺省值)。
fn is_false(value: &bool) -> bool {
    !*value
}

/// registry.json 文件格式。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    #[serde(default)]
    plugins: Vec<PluginRecord>,
}

/// 插件目录路径集合(app_data_dir 解析模式照抄 `crate::db::init_database`)。
pub struct PluginPaths {
    app_data: PathBuf,
}

impl PluginPaths {
    pub fn resolve(app: &tauri::AppHandle) -> Result<Self, PluginError> {
        use tauri::Manager;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| PluginError::PathResolve(format!("app_data_dir 失败: {e}")))?;
        Ok(Self { app_data })
    }

    /// 测试与离线场景直接指定 app_data 目录。
    #[cfg(test)]
    pub fn at(app_data: PathBuf) -> Self {
        Self { app_data }
    }

    pub fn plugins_dir(&self) -> PathBuf {
        self.app_data.join("plugins")
    }

    fn registry_path(&self) -> PathBuf {
        self.plugins_dir().join("registry.json")
    }

    /// 用户插件 entry 清单(include 子树挂的就是它)。
    pub fn entries_path(&self) -> PathBuf {
        self.plugins_dir().join("cordis.yml")
    }

    /// spawn 前生成的包装配置(用户插件一条 include entry,见 render_user_plugins_wrapper_yml)。
    fn wrapper_path(&self) -> PathBuf {
        self.app_data.join("dsh-cordis.generated.yml")
    }

    /// 单个用户插件的安装目录。pub(crate):web.rs 的 UI 插件注入用它定位 junction 目标。
    pub(crate) fn plugin_dir(&self, id: &str) -> PathBuf {
        self.plugins_dir().join(id)
    }

    /// 确保基础布局存在:plugins/ 目录、空 entries 文件(include 的
    /// `initial: []` 也会兜底,这里先生成以保证内容是我们约定的形态)。
    /// pub(crate):web.rs 的 UI 插件注入测试会直接构造 PluginPaths。
    pub(crate) fn ensure_layout(&self) -> Result<(), PluginError> {
        fs::create_dir_all(self.plugins_dir())?;
        if !self.entries_path().exists() {
            fs::write(self.entries_path(), EMPTY_ENTRIES_YML)?;
        }
        Ok(())
    }
}

/// 空 entries 文件:include 要求顶层是数组。
const EMPTY_ENTRIES_YML: &str =
    "# 本文件由 StarHub 自动生成(dsh 用户插件清单),手动修改会在下次变更时被覆盖。\n[]\n";

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 把包名清洗为插件 id(目录名 / entry id):去 scope、小写、
/// 非法字符折成 `-`;charset 收紧到 [a-z0-9-_],从源头杜绝 yml 注入。
fn sanitize_id(name: &str) -> Option<String> {
    let base = name.rsplit('/').next().unwrap_or(name);
    let mut id = String::with_capacity(base.len());
    let mut last_dash = false;
    for ch in base.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            id.push(ch);
            last_dash = false;
        } else if !last_dash && !id.is_empty() {
            id.push('-');
            last_dash = true;
        }
    }
    let id = id.trim_end_matches('-').to_string();
    if id.is_empty()
        || id.len() > 64
        || !id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(id)
}

// ============================== cordis.yml 生成 ==============================

/// YAML 单引号标量转义(`'` 双写)。id/entry 已过 charset 校验,
/// 这里仍防御性转义,保证任何输入都不会破坏 yml 结构或引入 `!!js` 标签。
fn yaml_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// 由 registry 整体重写 plugins/cordis.yml(本模块独占该文件)。
/// entry 只有 id/name/disabled 三个字面量字段,name 用相对路径 `./<id>/<entry>`,
/// 由 include 子树在 plugins/ 目录内解析。
fn render_entries_yml(records: &[PluginRecord]) -> String {
    let mut out = String::from(
        "# 本文件由 StarHub 自动生成(dsh 用户插件清单),手动修改会在下次变更时被覆盖。\n",
    );
    if records.is_empty() {
        out.push_str("[]\n");
        return out;
    }
    for record in records {
        out.push_str(&format!(
            "- id: {}\n  name: {}\n  disabled: {}\n",
            yaml_single_quoted(&record.id),
            yaml_single_quoted(&format!("./{}/{}", record.id, record.entry)),
            if record.enabled { "false" } else { "true" },
        ));
    }
    out
}

fn load_registry(paths: &PluginPaths) -> Result<Registry, PluginError> {
    let file = paths.registry_path();
    if !file.exists() {
        return Ok(Registry::default());
    }
    let content = fs::read_to_string(&file)?;
    Ok(serde_json::from_str(&content)?)
}

fn save_registry(paths: &PluginPaths, registry: &Registry) -> Result<(), PluginError> {
    fs::create_dir_all(paths.plugins_dir())?;
    fs::write(
        paths.registry_path(),
        serde_json::to_string_pretty(registry)?,
    )?;
    // registry 与 entries 清单保持同事务语义:先落 registry 再重写 yml。
    // 内置插件不进 entries yml(runtime 组合只加载用户插件;内置的 web 侧
    // 插件由 web.rs 的 LOCAL_PACKAGES junction + cordis.patch.yml 提供,
    // host-static 等依赖 web 进程的 webServer,进 runtime 组合会 fail-loud)。
    let user_records: Vec<PluginRecord> = registry
        .plugins
        .iter()
        .filter(|p| !p.builtin)
        .cloned()
        .collect();
    fs::write(paths.entries_path(), render_entries_yml(&user_records))?;
    Ok(())
}

// ============================== peer junction ==============================

/// 按布局定位 peer 包目录:dev 在 `<runtime>/vendor/<dir>`(vendor 仓库树),
/// prod 闭包在 `<runtime>/node_modules/@deepseek-ai/<dir>`(pnpm deploy 物化,
/// 目录名即包名后缀)。
fn peer_package_dir(vendor_root: &Path, dir_name: &str) -> Option<PathBuf> {
    for candidate in [
        vendor_root.join("vendor").join(dir_name),
        vendor_root
            .join("node_modules")
            .join("@deepseek-ai")
            .join(dir_name),
    ] {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

/// 在 `<plugins>/node_modules/@deepseek-ai/` 下为 cordis / cosmokit / schemastery
/// 建指向 runtime 对应目录的链接(Windows 用 `mklink /J` 目录 junction,不需要
/// 管理员;失败回退整目录复制)。已存在(链接或目录)则跳过。
/// 三个 peer 一个都定位不到时报错(dev/prod 两种布局均缺失才是真异常)。
fn ensure_peer_links(plugins_dir: &Path, vendor_root: &Path) -> Result<(), PluginError> {
    let link_base = plugins_dir.join("node_modules").join("@deepseek-ai");
    let mut resolved = 0usize;
    for dir_name in PEER_PACKAGE_DIRS {
        let Some(target) = peer_package_dir(vendor_root, dir_name) else {
            continue;
        };
        resolved += 1;
        // 包名以目标 package.json 为准(防御上游改名),取最后一段作链接名
        let package_json = target.join("package.json");
        let package_name = fs::read_to_string(&package_json)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .and_then(|v| v.get("name")?.as_str().map(str::to_string))
            .unwrap_or_else(|| format!("@deepseek-ai/{dir_name}"));
        let link_name = package_name.rsplit('/').next().unwrap_or(dir_name);
        let link = link_base.join(link_name);
        if link.exists() {
            continue;
        }
        fs::create_dir_all(&link_base)?;
        if let Err(error) = create_dir_link(&link, &target) {
            tracing::warn!(
                "dsh 插件 peer 链接创建失败({} → {}),回退整目录复制: {error}",
                link.display(),
                target.display()
            );
            copy_dir_all(&target, &link, true).map_err(|e| {
                PluginError::PathResolve(format!(
                    "peer 依赖复制失败({} → {}): {e}",
                    target.display(),
                    link.display()
                ))
            })?;
        }
    }
    if resolved == 0 {
        return Err(PluginError::PathResolve(format!(
            "peer 依赖目录缺失(vendor/<pkg> 与 node_modules/@deepseek-ai/<pkg> 均未找到): {}",
            vendor_root.display()
        )));
    }
    Ok(())
}

/// Windows 用目录 junction(cmd mklink /J,免管理员);Unix 用 symlink。
/// pub(crate):harness/web.rs 的 dsh web 管理器为本地包补 junction 时复用。
#[cfg(target_os = "windows")]
pub(crate) fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    /// CREATE_NO_WINDOW:GUI 进程下 mklink 不弹可见控制台窗口。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 分隔符必须规范成 `\`:混合分隔符路径(如 Rust `join("../vendor/x")` 的产物
    // `a\b/../vendor/x`)里的 `/vendor` 会被 mklink 当成开关参数,报「无效名称」。
    // 注意不能加引号:Rust 的 argv 转义会把引号写成 `\"` 字面量传给 cmd,反而坏。
    let normalized = |value: &Path| -> String { value.to_string_lossy().replace('/', "\\") };
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(normalized(link))
        .arg(normalized(target))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = [
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim(),
        ]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
        Err(std::io::Error::other(format!(
            "mklink /J 退出码 {} ({detail})",
            output.status.code().map_or_else(|| "signal".to_string(), |code| code.to_string())
        )))
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn create_dir_link(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// 递归复制目录;目标已存在则先清空。`skip_node_modules` 仅用于 vendor peer
/// 包回退复制(vendor 包自身依赖留在 vendor 树内解析,复制会造成双份模块实例)。
fn copy_dir_all(src: &Path, dst: &Path, skip_node_modules: bool) -> std::io::Result<()> {
    if dst.exists() {
        fs::remove_dir_all(dst)?;
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if file_type.is_dir() {
            if skip_node_modules && entry.file_name() == "node_modules" {
                continue;
            }
            copy_dir_all(&entry.path(), &target, skip_node_modules)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ============================== 依赖分层解析 ==============================

/// 在 runtime 树内按包名定位一个 `@deepseek-ai/<name>` 包目录。
/// prod 闭包(hoisted node_modules,deploy 物化)按包名直接命中,免全树扫描;
/// dev 布局遍历 packages/*/* 与 vendor/* 的 package.json name 字段匹配;
/// vendor 树几百个包,单次安装线性扫描开销可接受(毫秒级)。
fn find_vendor_package(vendor_root: &Path, spec: &str) -> Option<PathBuf> {
    let direct = vendor_root.join("node_modules").join(spec);
    if direct.is_dir() {
        return Some(direct);
    }
    let mut found = None;
    for base in ["packages", "vendor"] {
        let base_dir = vendor_root.join(base);
        let Ok(entries) = fs::read_dir(&base_dir) else {
            continue;
        };
        for group in entries.flatten() {
            if !group.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(pkgs) = fs::read_dir(group.path()) else {
                continue;
            };
            for pkg in pkgs.flatten() {
                let pkg_dir = pkg.path();
                if !pkg.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let manifest_path = pkg_dir.join("package.json");
                let Ok(content) = fs::read_to_string(&manifest_path) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
                    continue;
                };
                if value.get("name").and_then(|n| n.as_str()) == Some(spec) {
                    found = Some(pkg_dir);
                }
            }
        }
        if found.is_some() {
            break;
        }
    }
    found
}

/// 为插件目录解析 `dependencies`(含 peerDependencies)到指定 node_modules 根:
/// - `@deepseek-ai/*`:定位 vendor 树内同名包 → junction(与 peer junction 同机制);
/// - 第三方:尽力从 vendor/node_modules 解析(junction);解析不到仅告警——
///   插件自带构建产物时第三方已被内联进 bundle,node 半缺失依赖由运行时 fail-loud。
/// 返回未解析的依赖清单(供调用方告警)。
/// pub(crate):web.rs 的用户 UI 插件注入用同一逻辑把依赖 junction 进
/// profiles/node_modules(web 进程的解析锚点)。
pub(crate) fn resolve_plugin_dependencies_into(
    plugin_dir: &Path,
    vendor_root: &Path,
    link_base: &Path,
) -> Result<Vec<String>, PluginError> {
    let manifest_path = plugin_dir.join("package.json");
    let content = fs::read_to_string(&manifest_path)?;
    let manifest: serde_json::Value = serde_json::from_str(&content)?;
    let mut specs: Vec<String> = Vec::new();
    for field in ["dependencies", "peerDependencies"] {
        if let Some(deps) = manifest.get(field).and_then(|d| d.as_object()) {
            specs.extend(deps.keys().cloned());
        }
    }
    specs.sort();
    specs.dedup();

    let mut unresolved: Vec<String> = Vec::new();
    for spec in specs {
        // 已解析过(peer junction 或此前依赖)则跳过
        let link = link_base.join(&spec);
        if link.exists() {
            continue;
        }
        let target = if spec.starts_with("@deepseek-ai/") {
            find_vendor_package(vendor_root, &spec)
        } else {
            let in_vendor_nm = vendor_root.join("node_modules").join(&spec);
            in_vendor_nm.is_dir().then_some(in_vendor_nm)
        };
        match target {
            Some(target) => {
                fs::create_dir_all(&link_base)?;
                if let Err(error) = create_dir_link(&link, &target) {
                    tracing::warn!(
                        "dsh 插件依赖 junction 失败({} → {}),回退整目录复制: {error}",
                        link.display(),
                        target.display()
                    );
                    copy_dir_all(&target, &link, true)?;
                }
            }
            None => unresolved.push(spec),
        }
    }
    Ok(unresolved)
}

// ============================== 内置插件 ==============================

/// 内置插件:StarHub 自带、随应用发布(packages/starhub/ 下的本地包)。
/// registry 里可见、默认启用;目录在 runtime_dir/packages/starhub/<dir>。
pub const BUILTIN_PLUGIN_DIRS: [&str; 4] = ["client-nav", "host-static", "tool-context", "tools"];

/// 把内置插件幂等注册进 registry(缺则补,已有跳过)。
/// `runtime_dir` 为 vendor 根(内置包目录所在);builtin 记录 entry/dsh_client
/// 均从各包 package.json 读取。
pub fn ensure_builtin_plugins(paths: &PluginPaths, runtime_dir: &Path) -> Result<(), PluginError> {
    let mut registry = load_registry(paths)?;
    let mut changed = false;
    for dir_name in BUILTIN_PLUGIN_DIRS {
        let pkg_dir = runtime_dir.join("packages").join("starhub").join(dir_name);
        let manifest_path = pkg_dir.join("package.json");
        let Ok(content) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let name = manifest
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(dir_name)
            .to_string();
        if registry.plugins.iter().any(|p| p.builtin && p.name == name) {
            continue;
        }
        let id = sanitize_id(&name).unwrap_or_else(|| dir_name.to_string());
        let entry = manifest
            .get("main")
            .and_then(|v| v.as_str())
            .unwrap_or("lib/index.js")
            .to_string();
        let dsh_client = manifest.get("dsh").and_then(|d| d.get("client")).is_some();
        let version = manifest
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("0.0.0")
            .to_string();
        let description = manifest
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        registry.plugins.push(PluginRecord {
            id,
            name,
            version,
            description,
            license: None,
            source: PluginSource {
                kind: "builtin".into(),
                location: None,
            },
            entry,
            enabled: true,
            dsh_client,
            builtin: true,
            installed_at: now_rfc3339(),
        });
        changed = true;
    }
    if changed {
        save_registry(paths, &registry)?;
    }
    Ok(())
}

/// 当前应注入 dsh web 进程的用户 UI 插件(启用、声明 dsh.client、非内置)。
/// 内置 client 插件(client-nav)已由 web.rs 的 LOCAL_PACKAGES junction 提供。
pub fn user_client_plugins(paths: &PluginPaths) -> Result<Vec<PluginRecord>, PluginError> {
    let registry = load_registry(paths)?;
    Ok(registry
        .plugins
        .into_iter()
        .filter(|p| p.enabled && p.dsh_client && !p.builtin)
        .collect())
}

/// 坏插件自救:web/runtime 启动失败时禁用全部已启用的用户插件。
/// 仅禁用非内置且已启用的条目(已禁用/内置的不动),写回 registry 并重写
/// entries yml;返回被禁用的插件 id 列表(供诊断日志)。被禁用的插件保留
/// 目录与注册表记录,用户可在设置页重新启用——这是「坏插件导致启动整体
/// 失败」的自动恢复路径(B-4 TODO:配置变更后首次启动失败自动禁用最近变更
/// 插件,这里按「禁用全部注入中的用户插件」稳妥实现)。幂等:无已启用用户
/// 插件时返回空列表。
pub fn disable_user_plugins(paths: &PluginPaths) -> Result<Vec<String>, PluginError> {
    let mut registry = load_registry(paths)?;
    let mut disabled: Vec<String> = Vec::new();
    for record in registry.plugins.iter_mut() {
        if record.builtin || !record.enabled {
            continue;
        }
        record.enabled = false;
        disabled.push(record.id.clone());
    }
    if !disabled.is_empty() {
        save_registry(paths, &registry)?;
    }
    Ok(disabled)
}
// ============================== spawn 前准备(包装配置) ==============================

/// 把本机路径转成 file:/// URL:反斜杠转正斜杠,Windows 盘符补前导 `/`,
/// 保留字以外的字符(空格、非 ASCII、`'`、`#` 等)按 UTF-8 percent-encode。
/// Node 侧 `new URL(path, baseUrl)` + `fileURLToPath` 会解码还原。
fn path_to_file_url(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let with_lead = if raw.starts_with('/') {
        raw
    } else {
        format!("/{raw}")
    };
    let mut out = String::from("file://");
    for byte in with_lead.bytes() {
        let safe = byte.is_ascii_alphanumeric() || b"-._~/:+@".contains(&byte);
        if safe {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 生成用户插件包装配置:一条 `- insert:` 包着的 cordis:include entry
/// (app-boot 注册的内建插件,任何位置的配置都可引用,无需模块解析)。
/// 用户插件 entry 挂 plugins/cordis.yml,`initial: []` 容忍文件缺失。
/// DSH 0.1.6 适配(2026-09-20):主组合改由调用方直接作为 `--patch` 传入,
/// 本文件只剩用户插件一条;include 是 tree carrier、path 保持 literal,
/// 故文件 URL 由 Rust 侧直接写入生成文件。
/// pub(crate):harness/mod.rs 的端到端测试直接渲染 wrapper 验证启动链路。
pub(crate) fn render_user_plugins_wrapper_yml(entries_file: &Path) -> String {
    format!(
        "# 本文件由 StarHub 在启动 dsh runtime 前自动生成,请勿手改(每次启动重写)。\n\
         # 机制说明见 src-tauri/src/harness/plugins.rs 模块注释。\n\
         - insert:\n\
         \x20   - id: starhub-user-plugins\n\
         \x20     name: cordis:include\n\
         \x20     config:\n\
         \x20       path: {}\n\
         \x20       initial: []\n",
        yaml_single_quoted(&path_to_file_url(entries_file)),
    )
}

/// spawn 前准备:确保插件目录布局与默认 entries 文件存在,尽力建立 peer
/// junction(失败仅告警——只在已装插件需要加载时才致命),为内嵌 runtime 的
/// sdk profile 补 starhub 本地包 junction,生成用户插件包装配置并返回其路径,
/// 供 HarnessRuntime::spawn 作为 `--patch` 之一传入。
/// DSH 0.1.6 适配(2026-09-20):主组合不再经 include 包装,由调用方直接以
/// `--patch` 传入;本包装配置只承载用户插件一条 include entry。
pub fn prepare_runtime_config(
    app: &tauri::AppHandle,
    runtime_dir: &Path,
) -> Result<PathBuf, PluginError> {
    let paths = PluginPaths::resolve(app)?;
    paths.ensure_layout()?;
    if let Err(error) = ensure_peer_links(&paths.plugins_dir(), runtime_dir) {
        tracing::warn!("dsh 插件 peer 链接建立失败(已装插件可能无法加载): {error}");
    }
    // 内嵌 runtime 的 sdk profile 从 apps/cli 闭包 heal profiles/sdk/node_modules,
    // starhub 本地包不在闭包内;与 web profile 同理补 junction(DSH 0.1.6 适配:
    // 旧 jsonrpc-demo 直启外部配置时裸包名在 vendor 树解析,改 --profile sdk 后
    // 解析根变成 <agent_home>/profiles/sdk,必须在此建链)。
    let agent_home = crate::harness::web::dsh_agent_home_dir(app)
        .map_err(|e| PluginError::PathResolve(e.to_string()))?;
    ensure_runtime_local_package_links(&agent_home, runtime_dir)?;
    let wrapper = paths.wrapper_path();
    fs::write(
        &wrapper,
        render_user_plugins_wrapper_yml(&paths.entries_path()),
    )?;
    Ok(wrapper)
}

/// 为内嵌 runtime(sdk profile)的 DSH_HOME 补 starhub 本地包 junction。
/// dsh 的 `healProfilesModuleFallback` 只从 INSTALL_ANCHOR(apps/cli 依赖闭包)
/// BFS 建链,`packages/starhub/*` 不在闭包内,裸 entry 解析即
/// ERR_MODULE_NOT_FOUND——web profile 由 web.rs 建链,sdk profile 在此建链,
/// 复用同一份 LOCAL_PACKAGES 清单与 junction 漂移校验(ensure_dir_link_fresh)。
/// RUNTIME_HOSTED_PATCH_DEPS(闭包外、但被 profile patch 直接引用的包,如
/// tool-session-query)同理从 runtime 安装树建链:闭包 BFS 永不链接它们。
pub(crate) fn ensure_runtime_local_package_links(
    dsh_home: &Path,
    runtime_dir: &Path,
) -> Result<(), PluginError> {
    let link_base = dsh_home.join("profiles").join("node_modules").join("@deepseek-ai");
    fs::create_dir_all(&link_base)?;
    for dir_name in crate::harness::web::LOCAL_PACKAGES {
        let link = link_base.join(format!("dsh-starhub-{dir_name}"));
        let target = runtime_dir.join("packages").join("starhub").join(dir_name);
        // 旧部署的 runtime 可能还没有该包目录:跳过即可,healed
        // profiles/node_modules 兜底会从安装闭包解析;两边都缺时由 loader
        // 在启动时 fail-loud。
        if !target.exists() {
            tracing::warn!("本地包目录缺失,跳过 junction: {}", target.display());
            continue;
        }
        crate::harness::web::ensure_dir_link_fresh(&link, &target)
            .map_err(|e| PluginError::PathResolve(e.to_string()))?;
    }
    for dir_name in crate::harness::web::RUNTIME_HOSTED_PATCH_DEPS {
        let link = link_base.join(format!("dsh-{dir_name}"));
        let target = runtime_dir
            .join("node_modules")
            .join("@deepseek-ai")
            .join(format!("dsh-{dir_name}"));
        if !target.exists() {
            tracing::warn!("闭包外 patch 依赖目录缺失,跳过 junction: {}", target.display());
            continue;
        }
        crate::harness::web::ensure_dir_link_fresh(&link, &target)
            .map_err(|e| PluginError::PathResolve(e.to_string()))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests;
