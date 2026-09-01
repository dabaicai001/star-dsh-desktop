//! dsh 用户插件管理(AI 内核替换支线 B,方案 8.3 第 4 条「用户自行引入」)。
//!
//! 目录布局(app_data_dir 下,解析模式同 `crate::db`):
//! ```text
//! <app_data_dir>/
//! ├── dsh-cordis.generated.yml   # spawn 前整体重写的包装配置(见下)
//! └── plugins/
//!     ├── cordis.yml             # 用户插件 entry 清单(本模块独占生成,请勿手改)
//!     ├── registry.json          # 来源/版本/启停/许可元数据
//!     ├── market-cache.json      # 插件市场目录缓存(带抓取时间)
//!     ├── node_modules/@deepseek-ai/{cordis,cosmokit,schemastery}  # → runtime 的 junction
//!     │   # (dev 指向 vendor/<pkg>;prod 闭包指向 node_modules/@deepseek-ai/<pkg>)
//!     └── <id>/                  # 每个插件一个目录,含 package.json(dsh.bundle manifest)
//! ```
//!
//! 加载机制(调研结论,见实施任务清单支线 B):
//! - app-boot 的 boot() 会把 vendored Include 注册为内建插件 `cordis:include`,
//!   因此任何位置的配置都能直接引用它,无需模块解析;
//! - Include 会把子树 baseUrl 重设为被包含文件所在目录,所以主组合里的裸包名
//!   (`@deepseek-ai/dsh-*`)仍在 vendor 仓库内解析,用户插件的 `./<id>/...`
//!   相对路径在 plugins/ 目录内解析;
//! - **Include 是 tree carrier(EntryGroup.key),其 config 保持 literal,`!!js`
//!   不会在 path 字段求值**——因此不能用 env 注入路径,改为本模块在每次 spawn
//!   前生成包装配置 `dsh-cordis.generated.yml`(两条 cordis:include entry:
//!   主组合 + plugins/cordis.yml,后者带 `initial: []` 容忍文件缺失)。
//!
//! 安全决策(首版):
//! - 仅支持**零依赖**插件:package.json `dependencies` 非空直接拒装;
//! - UI/皮肤类拒装:manifest 含 `dsh.client`,或包名分段命中 skin/theme/client/ui;
//! - 生成的 yml 一律单引号转义,entry 只允许字面量,禁止 `!!js`;
//! - zip 解包用 `enclosed_name()` 防 Zip Slip,并剥掉 `<repo>-<branch>/` 顶层目录;
//! - 新装插件默认关闭,启停/卸载改动需重启 runtime 生效(前端调 dsh_shutdown)。
//!
//! 坏插件自救:首版不做自动禁用——initialize 失败时前端错误提示引导用户到
//! 设置页禁用。
//! TODO(B-4 后续):记录「配置变更后首次 initialize 失败」,自动禁用最近变更的插件。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

/// 市场数据源(awesome-dsh-plugin 精选索引,CC0):README.zh.md 为目录本体,
/// data/npm-map.json 与 data/stars.json 以 GitHub URL 为 key 补充元数据。
const MARKET_REPO: &str = "awesome-dsh-plugin/awesome-dsh-plugin";
const MARKET_BRANCHES: [&str; 2] = ["main", "master"];
/// zip 下载体积上限,防止异常包打爆内存。
const MAX_ZIP_BYTES: usize = 64 * 1024 * 1024;
/// 市场请求超时。
const MARKET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

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
    #[error("插件清单校验失败: {0}")]
    Manifest(String),
    #[error("插件 {0} 已安装,如需重装请先卸载")]
    AlreadyInstalled(String),
    #[error("插件不存在: {0}")]
    NotFound(String),
    #[error("zip 包非法: {0}")]
    Zip(String),
    #[error("下载失败: {0}")]
    Download(String),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
}

/// 插件来源(用于管理页展示与重装)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    /// market / url / local-dir / local-zip
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

    fn market_cache_path(&self) -> PathBuf {
        self.plugins_dir().join("market-cache.json")
    }

    /// spawn 前生成的包装配置(主组合 + 用户插件两条 include entry)。
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

// ============================== manifest 校验 ==============================

/// 通过校验的插件清单(从 package.json 提取)。
#[derive(Debug)]
struct ValidatedManifest {
    id: String,
    name: String,
    version: String,
    description: Option<String>,
    license: Option<String>,
    entry: String,
    /// manifest 是否声明 `dsh.client`(浏览器端 UI 插件)
    dsh_client: bool,
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

/// 从 package.json 解析入口文件:exports["."] 的 import/default > module > main
/// > 缺省 lib/index.js;必须落在插件目录内且文件存在。
fn resolve_entry(manifest: &serde_json::Value, dir: &Path) -> Result<String, PluginError> {
    let candidate: Option<String> = (|| {
        let exports_dot = manifest.get("exports")?.get(".")?;
        match exports_dot {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Object(map) => map
                .get("import")
                .or_else(|| map.get("default"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
            _ => None,
        }
    })()
    .or_else(|| manifest.get("module")?.as_str().map(str::to_string))
    .or_else(|| manifest.get("main")?.as_str().map(str::to_string));
    let raw = candidate.unwrap_or_else(|| "lib/index.js".to_string());
    // 归一化为 posix 相对路径并校验:禁止绝对路径 / `..` / 盘符
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized.trim_start_matches("./");
    let rel = Path::new(trimmed);
    if rel.is_absolute()
        || trimmed.is_empty()
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(PluginError::Manifest(format!(
            "入口文件路径非法(必须在插件目录内): {raw}"
        )));
    }
    if !dir.join(rel).exists() {
        return Err(PluginError::Manifest(format!(
            "入口文件不存在: {trimmed}(首版要求插件自带构建产物,不负责构建)"
        )));
    }
    Ok(trimmed.to_string())
}

/// 校验插件目录:package.json + `dsh.bundle` manifest + 零依赖 + 非 UI 类 + 入口存在。
fn validate_plugin_dir(dir: &Path) -> Result<ValidatedManifest, PluginError> {
    let manifest_path = dir.join("package.json");
    let content = fs::read_to_string(&manifest_path).map_err(|e| {
        PluginError::Manifest(format!(
            "缺少 package.json({}): {e}",
            manifest_path.display()
        ))
    })?;
    let manifest: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| PluginError::Manifest(format!("package.json 解析失败: {e}")))?;

    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PluginError::Manifest("package.json 缺少 name 字段".into()))?
        .to_string();
    let id = sanitize_id(&name)
        .ok_or_else(|| PluginError::Manifest(format!("包名无法清洗为合法插件 id: {name}")))?;

    // 必须是 dsh 包:存在 dsh.bundle 字段(awesome-dsh-plugin 收录约定)
    let dsh = manifest.get("dsh");
    if dsh.and_then(|d| d.get("bundle")).is_none() {
        return Err(PluginError::Manifest(
            "缺少 dsh.bundle 字段,不是可安装的 dsh 插件包".into(),
        ));
    }
    // UI 类插件(dsh.client)合法:插件体系与 dsh 打通后,浏览器端插件
    // 由 dsh web 进程加载(web.rs 会 junction 进 profiles/node_modules)。
    let dsh_client = dsh.and_then(|d| d.get("client")).is_some();
    // 依赖不再构成安装障碍:分层解析见 resolve_plugin_dependencies。

    let entry = resolve_entry(&manifest, dir)?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let description = manifest
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let license = match manifest.get("license") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Object(map)) => {
            map.get("type").and_then(|v| v.as_str()).map(str::to_string)
        }
        _ => None,
    };
    Ok(ValidatedManifest {
        id,
        name,
        version,
        description,
        license,
        entry,
        dsh_client,
    })
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
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("mklink /J 退出码: {status}")))
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
/// 返回未解析的依赖清单(供调用方告警;不阻塞安装)。
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

/// 依赖解析到 runtime 组合的 plugins/node_modules(运行时插件的解析锚点)。
fn resolve_plugin_dependencies(
    plugin_dir: &Path,
    vendor_root: &Path,
) -> Result<Vec<String>, PluginError> {
    let link_base = plugin_dir
        .parent()
        .unwrap_or_else(|| Path::new("plugins"))
        .join("node_modules");
    resolve_plugin_dependencies_into(plugin_dir, vendor_root, &link_base)
}

// ============================== 内置插件 ==============================

/// 内置插件:StarHub 自带、随应用发布(packages/starhub/ 下的本地包)。
/// registry 里可见、默认启用、不可卸载;目录在 runtime_dir/packages/starhub/<dir>。
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

// ============================== 安装 / 启停 / 卸载 ==============================

/// 已安装插件列表(registry 事实源;目录缺失的条目标 missing,交由前端提示;
/// 内置插件目录在 vendor,不做 missing 标记)。
pub fn list_plugins(paths: &PluginPaths) -> Result<serde_json::Value, PluginError> {
    paths.ensure_layout()?;
    let registry = load_registry(paths)?;
    let plugins: Vec<serde_json::Value> = registry
        .plugins
        .iter()
        .map(|record| {
            let mut value = serde_json::to_value(record).unwrap_or(serde_json::Value::Null);
            if let serde_json::Value::Object(ref mut map) = value {
                map.insert(
                    "missing".into(),
                    serde_json::Value::Bool(
                        !record.builtin && !paths.plugin_dir(&record.id).is_dir(),
                    ),
                );
            }
            value
        })
        .collect();
    Ok(serde_json::Value::Array(plugins))
}

/// 落盘已校验的插件:复制/移入 plugins/<id>/,登记 registry(默认关闭),重写 yml。
/// `vendor_root` 用于建立 peer junction;解析不到 vendor 时安装必须报错而非静默。
fn finalize_install(
    paths: &PluginPaths,
    staged: &Path,
    source: PluginSource,
    vendor_root: &Path,
) -> Result<PluginRecord, PluginError> {
    let manifest = validate_plugin_dir(staged)?;
    let mut registry = load_registry(paths)?;
    if registry.plugins.iter().any(|p| p.id == manifest.id) {
        return Err(PluginError::AlreadyInstalled(manifest.id));
    }
    // 自我复制防护:源目录就是目标插件目录(用户把已装目录又导入一次)
    let target = paths.plugin_dir(&manifest.id);
    if target.exists()
        && staged
            .canonicalize()
            .ok()
            .zip(target.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
    {
        return Err(PluginError::AlreadyInstalled(manifest.id));
    }
    ensure_peer_links(&paths.plugins_dir(), vendor_root)?;

    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    copy_dir_all(staged, &target, false)?;

    // 依赖分层解析(@deepseek-ai/* junction 到 vendor;第三方尽力解析)。
    // 未解析依赖不阻塞安装:UI 插件 bundle 自带产物,node 半缺失由运行时提示。
    if let Err(error) = resolve_plugin_dependencies(&target, vendor_root) {
        tracing::warn!("dsh 插件依赖解析失败(可忽略,运行时按 fail-loud 提示): {error}");
    }

    let record = PluginRecord {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        license: manifest.license,
        source,
        entry: manifest.entry,
        // 新装默认关闭:首次启用由前端弹风险提示
        enabled: false,
        dsh_client: manifest.dsh_client,
        builtin: false,
        installed_at: now_rfc3339(),
    };
    registry.plugins.push(record.clone());
    save_registry(paths, &registry)?;
    Ok(record)
}

/// 本地目录导入:原样校验后复制进插件目录。
pub fn install_local_dir(
    paths: &PluginPaths,
    src_dir: &Path,
    vendor_root: &Path,
) -> Result<PluginRecord, PluginError> {
    if !src_dir.is_dir() {
        return Err(PluginError::Manifest(format!(
            "不是目录: {}",
            src_dir.display()
        )));
    }
    finalize_install(
        paths,
        src_dir,
        PluginSource {
            kind: "local-dir".into(),
            location: Some(src_dir.to_string_lossy().into_owned()),
        },
        vendor_root,
    )
}

/// zip 包安装:解到 plugins/.staging-<uuid>/(同卷,之后可整目录移动语义复制),
/// 剥掉 GitHub codeload 的 `<repo>-<branch>/` 顶层目录,逐条做 Zip Slip 校验。
pub fn install_zip_bytes(
    paths: &PluginPaths,
    bytes: &[u8],
    source: PluginSource,
    vendor_root: &Path,
) -> Result<PluginRecord, PluginError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| PluginError::Zip(format!("无法读取 zip: {e}")))?;

    // 顶层目录剥离:所有条目共享同一个第一层组件时视为打包壳
    let mut top_component: Option<String> = None;
    let mut uniform_top = true;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|e| PluginError::Zip(format!("读取 zip 条目失败: {e}")))?;
        let enclosed = file.enclosed_name().ok_or_else(|| {
            PluginError::Zip(format!("zip 包含非法路径(Zip Slip): {}", file.name()))
        })?;
        let first = enclosed
            .components()
            .next()
            .and_then(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .ok_or_else(|| PluginError::Zip(format!("zip 条目路径非法: {}", file.name())))?;
        match &top_component {
            None => top_component = Some(first),
            Some(existing) if *existing == first => {}
            Some(_) => {
                uniform_top = false;
                break;
            }
        }
    }
    let strip_prefix = if uniform_top { top_component } else { None };

    let staging = paths
        .plugins_dir()
        .join(format!(".staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging)?;
    let result = (|| -> Result<(), PluginError> {
        for index in 0..archive.len() {
            let mut file = archive
                .by_index(index)
                .map_err(|e| PluginError::Zip(format!("读取 zip 条目失败: {e}")))?;
            let mut enclosed = file.enclosed_name().ok_or_else(|| {
                PluginError::Zip(format!("zip 包含非法路径(Zip Slip): {}", file.name()))
            })?;
            if let Some(prefix) = &strip_prefix {
                enclosed = enclosed
                    .strip_prefix(prefix)
                    .map_err(|_| PluginError::Zip(format!("条目不在顶层目录内: {}", file.name())))?
                    .to_path_buf();
            }
            // enclosed_name 会把 "pkg/../evil" 归一化为留在根内的形式,
            // 但剥掉顶层目录后 ".." 可能重新露头——剥离后必须再次校验
            // 只剩 Normal 组件,否则 staging.join("..") 会逃逸出解包目录
            if enclosed
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            {
                return Err(PluginError::Zip(format!(
                    "zip 包含非法路径(Zip Slip 路径穿越): {}",
                    file.name()
                )));
            }
            if enclosed.as_os_str().is_empty() {
                continue;
            }
            let target = staging.join(&enclosed);
            if file.is_dir() {
                fs::create_dir_all(&target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut out = fs::File::create(&target)?;
            std::io::copy(&mut file, &mut out)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let result = finalize_install(paths, &staging, source, vendor_root);
    let _ = fs::remove_dir_all(&staging);
    result
}

/// 本地 zip 文件导入。
pub fn install_local_zip(
    paths: &PluginPaths,
    zip_path: &Path,
    vendor_root: &Path,
) -> Result<PluginRecord, PluginError> {
    let bytes = fs::read(zip_path)?;
    install_zip_bytes(
        paths,
        &bytes,
        PluginSource {
            kind: "local-zip".into(),
            location: Some(zip_path.to_string_lossy().into_owned()),
        },
        vendor_root,
    )
}

/// 解析 GitHub 仓库 URL(可带 /tree/<branch>、尾斜杠、.git 后缀),
/// 返回 (owner, repo, 可选分支);非 GitHub 仓库地址返回 None(按直接 zip URL 处理)。
fn parse_github_repo_url(url: &str) -> Option<(String, String, Option<String>)> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    let branch = if parts.len() >= 4 && parts[2] == "tree" {
        Some(parts[3].to_string())
    } else {
        None
    };
    Some((parts[0].to_string(), parts[1].to_string(), branch))
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, PluginError> {
    use futures::StreamExt;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| PluginError::Download(format!("{url}: {e}")))?;
    if !response.status().is_success() {
        return Err(PluginError::Download(format!(
            "{url}: HTTP {}",
            response.status()
        )));
    }
    if let Some(len) = response.content_length() {
        if len as usize > MAX_ZIP_BYTES {
            return Err(PluginError::Download(format!(
                "{url}: 包体超过 64MB 上限({len} 字节)"
            )));
        }
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| PluginError::Download(format!("{url}: {e}")))?;
        if bytes.len() + chunk.len() > MAX_ZIP_BYTES {
            return Err(PluginError::Download(format!("{url}: 包体超过 64MB 上限")));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn http_client() -> Result<reqwest::Client, PluginError> {
    reqwest::Client::builder()
        .user_agent(concat!("starhub/", env!("CARGO_PKG_VERSION")))
        .timeout(MARKET_TIMEOUT)
        .build()
        .map_err(|e| PluginError::Download(format!("创建 HTTP 客户端失败: {e}")))
}

/// URL 安装:GitHub 仓库地址 → codeload zip(分支顺序:指定 > main > master);
/// 其余 http(s) 地址按 zip 直链下载。
pub async fn install_from_url(
    paths: &PluginPaths,
    url: &str,
    vendor_root: &Path,
) -> Result<PluginRecord, PluginError> {
    let url = url.trim();
    let client = http_client()?;
    let mut candidates: Vec<String> = Vec::new();
    match parse_github_repo_url(url) {
        Some((owner, repo, branch)) => {
            let mut branches: Vec<String> = Vec::new();
            if let Some(branch) = branch {
                branches.push(branch);
            }
            for fallback in ["main", "master"] {
                if !branches.iter().any(|b| b == fallback) {
                    branches.push(fallback.to_string());
                }
            }
            for branch in branches {
                candidates.push(format!(
                    "https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{branch}"
                ));
            }
        }
        None => {
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err(PluginError::Download(format!(
                    "无法识别的插件地址(支持 GitHub 仓库 URL 或 zip 直链): {url}"
                )));
            }
            candidates.push(url.to_string());
        }
    }

    let mut last_error = String::new();
    for (index, candidate) in candidates.iter().enumerate() {
        match download_bytes(&client, candidate).await {
            Ok(bytes) => {
                return install_zip_bytes(
                    paths,
                    &bytes,
                    PluginSource {
                        kind: "url".into(),
                        location: Some(url.to_string()),
                    },
                    vendor_root,
                );
            }
            Err(error) => {
                // 仅 GitHub 多分支候选时继续尝试下一个;直链或最后一个候选失败即报错
                last_error = error.to_string();
                if index + 1 == candidates.len() {
                    return Err(error);
                }
            }
        }
    }
    Err(PluginError::Download(last_error))
}

/// 逐项启停:更新 registry 并重写 entries yml(需重启 runtime 生效)。
/// 内置插件(壳依赖,如 client-nav)不可禁用,禁用会导致壳功能缺失。
pub fn set_enabled(paths: &PluginPaths, id: &str, enabled: bool) -> Result<(), PluginError> {
    let mut registry = load_registry(paths)?;
    let record = registry
        .plugins
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
    if record.builtin {
        return Err(PluginError::Manifest(format!(
            "内置插件 {id} 不可启停(壳依赖,随应用发布)"
        )));
    }
    record.enabled = enabled;
    save_registry(paths, &registry)
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

/// 卸载:移除目录 + registry 记录并重写 yml(需重启 runtime 生效)。
/// 内置插件不可卸载。
pub fn uninstall(paths: &PluginPaths, id: &str) -> Result<(), PluginError> {
    let mut registry = load_registry(paths)?;    if registry.plugins.iter().any(|p| p.id == id && p.builtin) {
        return Err(PluginError::Manifest(format!(
            "内置插件 {id} 不可卸载(壳依赖,随应用发布)"
        )));
    }
    let before = registry.plugins.len();
    registry.plugins.retain(|p| p.id != id);
    if registry.plugins.len() == before {
        return Err(PluginError::NotFound(id.to_string()));
    }
    let dir = paths.plugin_dir(id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    save_registry(paths, &registry)
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

/// 生成包装配置:两条 `cordis:include` entry(app-boot 注册的内建插件,
/// 任何位置的配置都可引用,无需模块解析)。主组合 entry 的 path 指向 vendor
/// 内的 starhub-agent/cordis.yml,其内部裸包名仍在 vendor 树解析;用户插件
/// entry 挂 plugins/cordis.yml,`initial: []` 容忍文件缺失。
/// pub(crate):harness/mod.rs 的端到端测试直接渲染 wrapper 验证启动链路。
pub(crate) fn render_wrapper_yml(main_config: &Path, entries_file: &Path) -> String {
    format!(
        "# 本文件由 StarHub 在启动 dsh runtime 前自动生成,请勿手改(每次启动重写)。\n\
         # 机制说明见 src-tauri/src/harness/plugins.rs 模块注释。\n\
         - id: starhub-core\n\
         \x20 name: cordis:include\n\
         \x20 config:\n\
         \x20   path: {}\n\
         - id: starhub-user-plugins\n\
         \x20 name: cordis:include\n\
         \x20 config:\n\
         \x20   path: {}\n\
         \x20   initial: []\n",
        yaml_single_quoted(&path_to_file_url(main_config)),
        yaml_single_quoted(&path_to_file_url(entries_file)),
    )
}

/// spawn 前准备:确保插件目录布局与默认 entries 文件存在,尽力建立 peer
/// junction(失败仅告警——只在已装插件需要加载时才致命),生成包装配置并返回
/// 其路径,供 HarnessRuntime::spawn 作为 config_path。
pub fn prepare_runtime_config(
    app: &tauri::AppHandle,
    runtime_dir: &Path,
) -> Result<PathBuf, PluginError> {
    let paths = PluginPaths::resolve(app)?;
    paths.ensure_layout()?;
    if let Err(error) = ensure_peer_links(&paths.plugins_dir(), runtime_dir) {
        tracing::warn!("dsh 插件 peer 链接建立失败(已装插件可能无法加载): {error}");
    }
    let wrapper = paths.wrapper_path();
    let main_config = runtime_dir.join(super::runtime_config_rel(runtime_dir));
    fs::write(
        &wrapper,
        render_wrapper_yml(&main_config, &paths.entries_path()),
    )?;
    Ok(wrapper)
}

// ============================== 插件市场 ==============================

/// 市场条目(owner/repo 形式)。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    /// owner/repo
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stars: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCategory {
    pub name: String,
    pub plugins: Vec<MarketPlugin>,
}

/// 市场目录(缓存到 market-cache.json;stale=true 表示本次抓取失败回退缓存)。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCatalog {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub categories: Vec<MarketCategory>,
}

/// 市场分类过滤:插件体系与 dsh 打通后不再剔除 UI/主题/皮肤类(它们与
/// 运行时插件一样是可安装的 dsh 插件)。仅剔除明显与 dsh 插件无关的
/// 「客户端」聚合项(如桌面客户端汇总目录),避免误导性条目。
fn is_ui_category(name: &str) -> bool {
    let lower = name.to_lowercase();
    name.contains("客户端")
        || lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|seg| matches!(seg, "clients" | "desktop" | "tui"))
}

/// 解析 awesome markdown 列表:`### 分类` 开分类,
/// `- [owner/repo](url) — 描述` 为条目(描述分隔符支持 — / - / –)。
fn parse_market_readme(content: &str) -> Vec<MarketCategory> {
    let mut categories: Vec<MarketCategory> = Vec::new();
    let mut current: Option<usize> = None;
    for line in content.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix("### ") {
            let name = name.trim().to_string();
            if is_ui_category(&name) {
                current = None;
                continue;
            }
            categories.push(MarketCategory {
                name,
                plugins: Vec::new(),
            });
            current = Some(categories.len() - 1);
            continue;
        }
        if line.starts_with("## ") {
            current = None;
            continue;
        }
        let Some(index) = current else { continue };
        let Some(rest) = line.strip_prefix("- [") else {
            continue;
        };
        let Some(close) = rest.find("](") else {
            continue;
        };
        let name = &rest[..close];
        let after = &rest[close + 2..];
        let Some(paren) = after.find(')') else {
            continue;
        };
        let url = after[..paren].trim().to_string();
        if !url.starts_with("https://github.com/") {
            continue;
        }
        let description = after[paren + 1..]
            .trim()
            .trim_start_matches(['—', '–', '-'])
            .trim()
            .to_string();
        categories[index].plugins.push(MarketPlugin {
            name: name.to_string(),
            url,
            description,
            stars: None,
            npm: None,
        });
    }
    categories.retain(|c| !c.plugins.is_empty());
    categories
}

/// join data/npm-map.json 与 data/stars.json(均以 GitHub URL 为 key)。
fn join_market_data(categories: &mut [MarketCategory], data_files: &[serde_json::Value]) {
    let (npm_map, stars) = match data_files {
        [npm_map, stars] => (npm_map, stars),
        _ => return,
    };
    for category in categories.iter_mut() {
        for plugin in &mut category.plugins {
            if let Some(npm) = npm_map.get(&plugin.url).and_then(|v| v.as_str()) {
                plugin.npm = Some(npm.to_string());
            }
            if let Some(stars) = stars.get(&plugin.url).and_then(|v| v.as_u64()) {
                plugin.stars = Some(stars);
            }
        }
    }
}

fn read_market_cache(paths: &PluginPaths) -> Option<MarketCatalog> {
    let content = fs::read_to_string(paths.market_cache_path()).ok()?;
    serde_json::from_str(&content).ok()
}

/// 拉取市场目录:任何失败都降级——有缓存回缓存(标 stale),无缓存返回空目录,
/// 不向调用方报错(数据源是社区 CC0 索引,不可用时插件页应表现为空而非故障)。
pub async fn fetch_market(paths: &PluginPaths, force_refresh: bool) -> MarketCatalog {
    paths.ensure_layout().ok();
    if !force_refresh {
        if let Some(cached) = read_market_cache(paths) {
            return cached;
        }
    }
    match fetch_market_remote().await {
        Some(mut catalog) => {
            catalog.fetched_at = Some(now_rfc3339());
            if let Ok(content) = serde_json::to_string_pretty(&catalog) {
                let _ = fs::write(paths.market_cache_path(), content);
            }
            catalog
        }
        None => match read_market_cache(paths) {
            Some(mut cached) => {
                cached.stale = true;
                cached
            }
            None => MarketCatalog::default(),
        },
    }
}

async fn fetch_market_remote() -> Option<MarketCatalog> {
    let client = http_client().ok()?;
    for branch in MARKET_BRANCHES {
        let base = format!("https://raw.githubusercontent.com/{MARKET_REPO}/{branch}");
        let readme_url = format!("{base}/README.zh.md");
        let readme = match download_bytes(&client, &readme_url).await {
            Ok(bytes) => String::from_utf8(bytes).ok()?,
            Err(_) => continue, // 404 等:尝试下一分支
        };
        let mut categories = parse_market_readme(&readme);
        let mut data_files: Vec<serde_json::Value> = Vec::new();
        for data_name in ["data/npm-map.json", "data/stars.json"] {
            let url = format!("{base}/{data_name}");
            match download_bytes(&client, &url).await {
                Ok(bytes) => data_files
                    .push(serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)),
                Err(_) => data_files.push(serde_json::Value::Null),
            }
        }
        join_market_data(&mut categories, &data_files);
        return Some(MarketCatalog {
            fetched_at: None,
            stale: false,
            categories,
        });
    }
    None
}

#[cfg(test)]
mod tests;
