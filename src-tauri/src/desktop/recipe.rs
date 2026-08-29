//! 沙箱模板配方(`*.starhub-sandbox.toml`)解析与 Dockerfile 生成。
//!
//! 配方是声明式的:基础镜像 + apt 包层 + provision 脚本层 + 资源/网络/分辨率。
//! 桌面基础层(Xfce + Xvfb + x11vnc + noVNC + xdotool + scrot)固定内置,
//! 配方只追加业务软件层——对应 E2B 的模板语义(见设计文档 §3.2)。
//!
//! 本模块全部为纯函数,单测覆盖;不触碰 Docker / 数据库。

use serde::Deserialize;

/// 沙箱模板配方(TOML 反序列化)。
#[derive(Debug, Clone, Deserialize)]
pub struct SandboxRecipe {
    /// 模板名(小写字母/数字/中划线,用于镜像 tag 与容器名前缀)。
    pub name: String,
    /// 基础镜像,默认 ubuntu:24.04;登录态固化后的模板指向 commit 产物。
    #[serde(default = "default_base")]
    pub base: String,
    #[serde(default = "default_memory")]
    pub memory_mb: i64,
    #[serde(default = "default_cpus")]
    pub cpus: f64,
    /// none | restricted | full
    #[serde(default = "default_network")]
    pub network: String,
    #[serde(default = "default_resolution")]
    pub resolution: String,
    /// 追加安装的 apt 包(业务软件层)。
    #[serde(default)]
    pub install: Vec<String>,
    /// 任意装机脚本行(每行一条 RUN;禁止换行,防 Dockerfile 注入)。
    #[serde(default)]
    pub provision: Vec<String>,
    /// 只读根文件系统(默认关:Xfce 全家桶对只读根兼容性未验证,先保守)。
    #[serde(default)]
    pub readonly_rootfs: bool,
}

fn default_base() -> String {
    "ubuntu:24.04".to_string()
}
fn default_memory() -> i64 {
    2048
}
fn default_cpus() -> f64 {
    2.0
}
fn default_network() -> String {
    "restricted".to_string()
}
fn default_resolution() -> String {
    "1920x1080".to_string()
}

/// 内置默认模板(首次使用自动落库):能开终端与文本编辑器的最小桌面。
/// 注意 Ubuntu 24.04 的 firefox/chromium deb 是 snap 过渡包,容器里装不了,
/// 需要浏览器时在 install 里用 epiphany-browser 或按踩坑记录走 Mozilla PPA。
pub const DEFAULT_RECIPE_TOML: &str = r#"name = "ubuntu-desktop"
base = "ubuntu:24.04"
memory_mb = 2048
cpus = 2.0
network = "restricted"
resolution = "1920x1080"
install = ["mousepad"]
provision = []
"#;

/// 沙箱实例对外服务的容器端口(noVNC/websockify)。
pub const NOVNC_CONTAINER_PORT: i64 = 6080;

/// 解析并校验配方。
pub fn parse_recipe(toml_text: &str) -> Result<SandboxRecipe, String> {
    let recipe: SandboxRecipe =
        toml::from_str(toml_text).map_err(|e| format!("配方 TOML 解析失败: {e}"))?;
    validate_recipe(&recipe)?;
    Ok(recipe)
}

fn validate_recipe(recipe: &SandboxRecipe) -> Result<(), String> {
    if recipe.name.is_empty()
        || recipe.name.len() > 40
        || !recipe
            .name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "模板名 illegal: {:?}(只允许小写字母/数字/中划线,≤40 字符)",
            recipe.name
        ));
    }
    if recipe.base.trim().is_empty() || recipe.base.chars().any(char::is_whitespace) {
        return Err("base 镜像名为空或含空白字符".to_string());
    }
    if !(1..=65536).contains(&recipe.memory_mb) {
        return Err(format!("memory_mb 越界: {}", recipe.memory_mb));
    }
    if !(0.25..=32.0).contains(&recipe.cpus) {
        return Err(format!("cpus 越界: {}", recipe.cpus));
    }
    match recipe.network.as_str() {
        "none" | "restricted" | "full" => {}
        other => return Err(format!("network 只能是 none/restricted/full,实际: {other}")),
    }
    validate_resolution(&recipe.resolution)?;
    for pkg in &recipe.install {
        if pkg.is_empty()
            || pkg.len() > 64
            || !pkg
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+._:-".contains(c))
        {
            return Err(format!("apt 包名 illegal: {pkg:?}"));
        }
    }
    for line in &recipe.provision {
        if line.trim().is_empty() || line.contains('\n') || line.contains('\r') {
            return Err("provision 行不能为空且禁止换行(防 Dockerfile 注入)".to_string());
        }
    }
    Ok(())
}

fn validate_resolution(resolution: &str) -> Result<(), String> {
    let (w, h) = resolution
        .split_once('x')
        .ok_or_else(|| format!("分辨率格式应为 <宽>x<高>: {resolution}"))?;
    let w: u32 = w
        .parse()
        .map_err(|_| format!("分辨率宽度非法: {resolution}"))?;
    let h: u32 = h
        .parse()
        .map_err(|_| format!("分辨率高度非法: {resolution}"))?;
    if !(640..=7680).contains(&w) || !(480..=4320).contains(&h) {
        return Err(format!("分辨率越界: {resolution}"));
    }
    Ok(())
}

/// 模板对应的镜像 tag。
pub fn image_tag(recipe: &SandboxRecipe) -> String {
    format!("starhub-sandbox-{}:latest", recipe.name)
}

/// restricted 档的自定义隔离网络名(固定,便于复用与清理)。
pub const RESTRICTED_NETWORK: &str = "starhub-sandbox-restricted";

/// 生成模板 Dockerfile:固定桌面基础层 + 配方的 install/provision 追加层。
pub fn generate_dockerfile(recipe: &SandboxRecipe) -> String {
    let mut dockerfile = format!(
        "FROM {base}\n\
         ENV DEBIAN_FRONTEND=noninteractive DISPLAY=:0 HOME=/root\n\
         RUN apt-get update && apt-get install -y --no-install-recommends \\\n\
         \x20   xfce4 xfce4-terminal xvfb x11vnc novnc websockify xdotool scrot wmctrl dbus-x11 \\\n\
         \x20   fonts-noto-cjk locales ca-certificates curl \\\n\
         \x20   && locale-gen en_US.UTF-8 zh_CN.UTF-8 \\\n\
         \x20   && rm -rf /var/lib/apt/lists/*\n",
        base = recipe.base
    );
    if !recipe.install.is_empty() {
        dockerfile.push_str(&format!(
            "RUN apt-get update && apt-get install -y --no-install-recommends {} && rm -rf /var/lib/apt/lists/*\n",
            recipe.install.join(" ")
        ));
    }
    for line in &recipe.provision {
        dockerfile.push_str(&format!("RUN {line}\n"));
    }
    dockerfile.push_str(&format!(
        "ENV RESOLUTION={resolution}\n\
         EXPOSE {port}\n\
         CMD [\"sh\", \"-c\", \"Xvfb :0 -screen 0 ${{RESOLUTION}}x24 -nolisten tcp & sleep 1; startxfce4 & sleep 2; x11vnc -display :0 -forever -shared -nopw -localhost & exec websockify --web /usr/share/novnc 0.0.0.0:{port} localhost:5900\"]\n",
        resolution = recipe.resolution,
        port = NOVNC_CONTAINER_PORT
    ));
    dockerfile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_recipe_parses() {
        let recipe = parse_recipe(DEFAULT_RECIPE_TOML).expect("default recipe");
        assert_eq!(recipe.name, "ubuntu-desktop");
        assert_eq!(recipe.network, "restricted");
        assert_eq!(recipe.resolution, "1920x1080");
        assert_eq!(recipe.install, vec!["mousepad".to_string()]);
    }

    #[test]
    fn rejects_bad_names_and_networks() {
        assert!(parse_recipe("name = \"Bad_Name\"").is_err());
        assert!(parse_recipe("name = \"ok\"\nnetwork = \"host\"").is_err());
        assert!(parse_recipe("name = \"ok\"\nresolution = \"100x100\"").is_err());
        assert!(parse_recipe("name = \"ok\"\ninstall = [\"firefox; rm -rf /\"]").is_err());
        assert!(parse_recipe("name = \"ok\"\nprovision = [\"a\\nb\"]").is_err());
    }

    #[test]
    fn dockerfile_contains_desktop_stack_and_layers() {
        let recipe = parse_recipe(
            "name = \"ops\"\ninstall = [\"dbeaver-ce\"]\nprovision = [\"echo hi > /root/marker\"]",
        )
        .expect("recipe");
        let dockerfile = generate_dockerfile(&recipe);
        assert!(dockerfile.contains("FROM ubuntu:24.04"));
        assert!(dockerfile.contains("xvfb x11vnc novnc websockify xdotool scrot"));
        assert!(dockerfile.contains("apt-get install -y --no-install-recommends dbeaver-ce"));
        assert!(dockerfile.contains("RUN echo hi > /root/marker"));
        assert!(dockerfile.contains("ENV RESOLUTION=1920x1080"));
        assert!(dockerfile.contains("EXPOSE 6080"));
        assert!(dockerfile.contains("websockify --web /usr/share/novnc"));
        assert_eq!(image_tag(&recipe), "starhub-sandbox-ops:latest");
    }
}
