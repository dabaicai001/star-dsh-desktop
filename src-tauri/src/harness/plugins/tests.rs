//! plugins.rs 单测:manifest 校验 / cordis.yml 生成 / 市场 README 解析 /
//! Zip Slip 防护 / install→list→set_enabled→uninstall 链路。
//! 全部在临时目录内运行,不依赖 Tauri AppHandle。

use super::*;

/// 造一个唯一临时根目录,返回 (app_data, vendor_root)。
fn test_roots(tag: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "starhub-plugin-test-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let app_data = root.join("app-data");
    let vendor_root = root.join("vendor/deepseek-harness");
    // 假 vendor 布局:peer 包各带一个声明包名的 package.json
    for pkg in PEER_PACKAGE_DIRS {
        let dir = vendor_root.join("vendor").join(pkg);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.json"),
            format!("{{\"name\": \"@deepseek-ai/{pkg}\"}}"),
        )
        .unwrap();
    }
    (app_data, vendor_root)
}

/// 在指定目录写一个最小零依赖插件包。
fn write_minimal_plugin(dir: &Path, name: &str) {
    fs::create_dir_all(dir.join("lib")).unwrap();
    fs::write(
        dir.join("package.json"),
        format!(
            r#"{{"name": "{name}", "version": "1.2.3", "description": "测试插件",
                "license": "MIT", "main": "lib/index.js",
                "dsh": {{"bundle": {{"patch": "./cordis.patch.yml"}}}}}}"#
        ),
    )
    .unwrap();
    fs::write(dir.join("lib/index.js"), "export default {}\n").unwrap();
}

#[test]
fn sanitize_id_cases() {
    assert_eq!(
        sanitize_id("@deepseek-ai/dsh-tool-foo").as_deref(),
        Some("dsh-tool-foo")
    );
    assert_eq!(sanitize_id("My Plugin!").as_deref(), Some("my-plugin"));
    assert_eq!(sanitize_id("dsh_thing").as_deref(), Some("dsh_thing"));
    assert_eq!(sanitize_id("---").as_deref(), None);
    assert_eq!(sanitize_id("").as_deref(), None);
}

#[test]
fn validate_manifest_accepts_zero_dep_plugin() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    let dir = root.join("ok");
    write_minimal_plugin(&dir, "dsh-tool-demo");
    let manifest = validate_plugin_dir(&dir).expect("零依赖插件应通过校验");
    assert_eq!(manifest.id, "dsh-tool-demo");
    assert_eq!(manifest.version, "1.2.3");
    assert_eq!(manifest.entry, "lib/index.js");
    assert_eq!(manifest.license.as_deref(), Some("MIT"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_accepts_dependencies() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    let dir = root.join("with-deps");
    write_minimal_plugin(&dir, "dsh-tool-deps");
    // 覆写 package.json:带 dependencies(打通后允许,依赖分层解析)
    fs::write(
        dir.join("package.json"),
        r#"{"name": "dsh-tool-deps", "main": "lib/index.js",
            "dependencies": {"@deepseek-ai/dsh-client-runtime": "workspace:^", "lodash": "^4.0.0"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#,
    )
    .unwrap();
    let manifest = validate_plugin_dir(&dir).expect("带依赖的插件应通过校验");
    assert!(!manifest.dsh_client);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_accepts_client_and_ui_names() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    // dsh.client 字段 → 标记为 UI 插件,不拒装
    let dir = root.join("client-field");
    write_minimal_plugin(&dir, "dsh-something");
    fs::write(
        dir.join("package.json"),
        r#"{"name": "dsh-something", "main": "lib/index.js",
            "dsh": {"bundle": {"patch": "./p.yml"}, "client": {"entry": "./ui.js"}}}"#,
    )
    .unwrap();
    let manifest = validate_plugin_dir(&dir).expect("dsh.client 应通过校验");
    assert!(manifest.dsh_client, "应标记为 UI 插件");
    // 包名含 ui 词:通过校验(不拒装)
    let dir2 = root.join("skin-name");
    write_minimal_plugin(&dir2, "dsh-skin-maid");
    let manifest2 = validate_plugin_dir(&dir2).expect("skin 包名应通过校验");
    assert!(!manifest2.dsh_client);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validate_manifest_requires_bundle_field_and_entry() {
    let root = std::env::temp_dir().join(format!("starhub-pv-{}", uuid::Uuid::new_v4()));
    // 缺 dsh.bundle
    let dir = root.join("no-bundle");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("package.json"), r#"{"name": "plain-lib"}"#).unwrap();
    let error = validate_plugin_dir(&dir).expect_err("缺 dsh.bundle 应被拒绝");
    assert!(error.to_string().contains("dsh.bundle"), "{error}");
    // 入口文件不存在
    let dir2 = root.join("no-entry");
    fs::create_dir_all(&dir2).unwrap();
    fs::write(
        dir2.join("package.json"),
        r#"{"name": "dsh-no-entry", "main": "lib/missing.js",
            "dsh": {"bundle": {"patch": "./p.yml"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir2).expect_err("入口缺失应被拒绝");
    assert!(error.to_string().contains("入口文件不存在"), "{error}");
    // 入口路径穿越
    let dir3 = root.join("evil-entry");
    fs::create_dir_all(&dir3).unwrap();
    fs::write(
        dir3.join("package.json"),
        r#"{"name": "dsh-evil", "main": "../outside.js",
            "dsh": {"bundle": {"patch": "./p.yml"}}}"#,
    )
    .unwrap();
    let error = validate_plugin_dir(&dir3).expect_err("路径穿越入口应被拒绝");
    assert!(error.to_string().contains("入口文件路径非法"), "{error}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn render_entries_yml_quotes_and_empty() {
    assert!(render_entries_yml(&[]).contains("[]"));
    let record = PluginRecord {
        id: "dsh-tool-demo".into(),
        name: "dsh-tool-demo".into(),
        version: "1.0.0".into(),
        description: None,
        license: None,
        source: PluginSource {
            kind: "local-dir".into(),
            location: None,
        },
        entry: "lib/index.js".into(),
        enabled: true,
        dsh_client: false,
        builtin: false,
        installed_at: "2026-08-14T00:00:00Z".into(),
    };
    let yml = render_entries_yml(std::slice::from_ref(&record));
    assert!(
        yml.contains(
            "- id: 'dsh-tool-demo'\n  name: './dsh-tool-demo/lib/index.js'\n  disabled: false\n"
        ),
        "生成的 yml 不符预期:\n{yml}"
    );
    // 禁用态
    let disabled_yml = render_entries_yml(&[PluginRecord {
        enabled: false,
        ..record.clone()
    }]);
    assert!(disabled_yml.contains("disabled: true"));
    // 转义:单引号双写,且任何值都不会以 !!js 标签形态出现
    assert_eq!(yaml_single_quoted("it's"), "'it''s'");
    assert!(!render_entries_yml(&[]).contains("!!js"));
}

#[test]
fn parse_market_readme_categories_and_filter() {
    let sample = r#"# awesome-dsh-plugin

## 分类

### 工具与能力

- [foo/dsh-tool-alpha](https://github.com/foo/dsh-tool-alpha) — Alpha 工具
- [bar/dsh-tool-beta](https://github.com/bar/dsh-tool-beta) - Beta 工具
- [not-a-repo](https://example.com/elsewhere) — 非 GitHub 链接,丢弃

### UI 增强 / 主题

- [someone/dsh-skin-x](https://github.com/someone/dsh-skin-x) — 皮肤,打通后收录

### 模型与 Provider

- [baz/dsh-polyglot](https://github.com/baz/dsh-polyglot) — 多 provider
"#;
    let mut categories = parse_market_readme(sample);
    assert_eq!(categories.len(), 3, "UI 分类打通后应收录: {categories:?}");
    assert_eq!(categories[0].name, "工具与能力");
    assert_eq!(categories[0].plugins.len(), 2, "非 GitHub 链接应被丢弃");
    assert_eq!(categories[0].plugins[0].name, "foo/dsh-tool-alpha");
    assert_eq!(categories[0].plugins[0].description, "Alpha 工具");
    assert_eq!(categories[1].name, "UI 增强 / 主题");
    assert_eq!(categories[1].plugins[0].name, "someone/dsh-skin-x");
    assert_eq!(categories[2].plugins[0].name, "baz/dsh-polyglot");

    // join npm-map / stars(以 GitHub URL 为 key)
    let npm_map = serde_json::json!({"https://github.com/foo/dsh-tool-alpha": "dsh-tool-alpha"});
    let stars = serde_json::json!({"https://github.com/foo/dsh-tool-alpha": 42});
    join_market_data(&mut categories, &[npm_map, stars]);
    assert_eq!(
        categories[0].plugins[0].npm.as_deref(),
        Some("dsh-tool-alpha")
    );
    assert_eq!(categories[0].plugins[0].stars, Some(42));
    assert_eq!(categories[0].plugins[1].stars, None);
}

/// 构造一个内存 zip:entries 为 (路径, 内容)。
fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, content) in entries {
        writer.start_file(name, options).unwrap();
        use std::io::Write;
        writer.write_all(content.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

const ZIP_MANIFEST: &str = r#"{"name": "dsh-tool-zip", "version": "0.1.0", "main": "lib/index.js",
    "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#;

#[test]
fn zip_install_strips_top_level_dir() {
    let (app_data, vendor_root) = test_roots("zip");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let bytes = build_zip(&[
        ("dsh-tool-zip-main/package.json", ZIP_MANIFEST),
        ("dsh-tool-zip-main/lib/index.js", "export default {}\n"),
    ]);
    let record = install_zip_bytes(
        &paths,
        &bytes,
        PluginSource {
            kind: "url".into(),
            location: Some("https://github.com/x/dsh-tool-zip".into()),
        },
        &vendor_root,
    )
    .expect("正常 zip 应安装成功");
    assert_eq!(record.id, "dsh-tool-zip");
    // 顶层 <repo>-<branch>/ 已剥掉
    assert!(paths
        .plugin_dir("dsh-tool-zip")
        .join("package.json")
        .exists());
    assert!(paths
        .plugin_dir("dsh-tool-zip")
        .join("lib/index.js")
        .exists());
    // peer junction 已建立
    assert!(
        paths
            .plugins_dir()
            .join("node_modules/@deepseek-ai/cordis")
            .exists(),
        "peer junction 应存在"
    );
    // 新装默认关闭
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: true"), "{yml}");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn zip_install_rejects_zip_slip() {
    let (app_data, vendor_root) = test_roots("slip");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let bytes = build_zip(&[
        ("pkg/package.json", ZIP_MANIFEST),
        ("pkg/../evil.txt", "pwned"),
    ]);
    let error = install_zip_bytes(
        &paths,
        &bytes,
        PluginSource {
            kind: "local-zip".into(),
            location: None,
        },
        &vendor_root,
    )
    .expect_err("Zip Slip 应被拒绝");
    assert!(error.to_string().contains("Zip Slip"), "{error}");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn install_list_enable_uninstall_chain() {
    let (app_data, vendor_root) = test_roots("chain");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();

    // 本地目录导入
    let src = app_data.parent().unwrap().join("src-plugin");
    write_minimal_plugin(&src, "dsh-tool-chain");
    let record = install_local_dir(&paths, &src, &vendor_root).expect("安装本地目录");
    assert!(!record.enabled, "新装默认关闭");

    // list
    let listed = list_plugins(&paths).unwrap();
    let array = listed.as_array().unwrap();
    assert_eq!(array.len(), 1);
    assert_eq!(array[0]["id"], "dsh-tool-chain");
    assert_eq!(array[0]["missing"], false);

    // 重复安装拒绝
    let error = install_local_dir(&paths, &src, &vendor_root).expect_err("重复安装应拒绝");
    assert!(matches!(error, PluginError::AlreadyInstalled(_)));

    // 启停 → yml 内容联动
    set_enabled(&paths, "dsh-tool-chain", true).unwrap();
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: false"), "{yml}");
    set_enabled(&paths, "dsh-tool-chain", false).unwrap();
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("disabled: true"), "{yml}");
    // registry 持久化
    let registry = load_registry(&paths).unwrap();
    assert_eq!(registry.plugins.len(), 1);
    assert_eq!(registry.plugins[0].source.kind, "local-dir");

    // 卸载:目录与记录都消失,entries 回到空数组
    uninstall(&paths, "dsh-tool-chain").unwrap();
    assert!(!paths.plugin_dir("dsh-tool-chain").exists());
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("[]"), "{yml}");
    let error = uninstall(&paths, "dsh-tool-chain").expect_err("重复卸载应报不存在");
    assert!(matches!(error, PluginError::NotFound(_)));
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn github_url_parsing() {
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar"),
        Some(("foo".into(), "bar".into(), None))
    );
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar/tree/dev"),
        Some(("foo".into(), "bar".into(), Some("dev".into())))
    );
    assert_eq!(
        parse_github_repo_url("https://github.com/foo/bar.git/"),
        Some(("foo".into(), "bar".into(), None))
    );
    assert_eq!(parse_github_repo_url("https://example.com/x.zip"), None);
}

#[test]
fn file_url_and_wrapper_rendering() {
    // Windows 盘符 + 空格 + 非 ASCII:反斜杠转正斜杠、空格与汉字 percent-encode
    let url = path_to_file_url(Path::new(r"C:\Users\测试 User\AppData\plugins\cordis.yml"));
    assert_eq!(
        url,
        "file:///C:/Users/%E6%B5%8B%E8%AF%95%20User/AppData/plugins/cordis.yml"
    );
    let url = path_to_file_url(Path::new("/home/u/plugins/cordis.yml"));
    assert_eq!(url, "file:///home/u/plugins/cordis.yml");

    let wrapper = render_wrapper_yml(
        Path::new(r"E:\repo\vendor\deepseek-harness\examples\starhub-agent\cordis.yml"),
        Path::new(r"C:\App Data\plugins\cordis.yml"),
    );
    assert!(wrapper.contains("name: cordis:include"), "{wrapper}");
    assert!(
        wrapper.contains(
            "path: 'file:///E:/repo/vendor/deepseek-harness/examples/starhub-agent/cordis.yml'"
        ),
        "{wrapper}"
    );
    assert!(
        wrapper.contains("path: 'file:///C:/App%20Data/plugins/cordis.yml'"),
        "{wrapper}"
    );
    assert!(wrapper.contains("initial: []"), "{wrapper}");
}

#[test]
fn install_resolves_vendor_dependencies_via_junction() {
    let (app_data, vendor_root) = test_roots("deps");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    // 假 vendor 里放一个 @deepseek-ai 依赖包(packages/client/runtime 形态)
    let dep_dir = vendor_root.join("packages").join("client").join("runtime");
    fs::create_dir_all(&dep_dir).unwrap();
    fs::write(
        dep_dir.join("package.json"),
        r#"{"name": "@deepseek-ai/dsh-client-runtime"}"#,
    )
    .unwrap();

    let src = app_data.parent().unwrap().join("src-deps");
    write_minimal_plugin(&src, "dsh-tool-deps");
    fs::write(
        src.join("package.json"),
        r#"{"name": "dsh-tool-deps", "main": "lib/index.js",
            "dependencies": {"@deepseek-ai/dsh-client-runtime": "workspace:^"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#,
    )
    .unwrap();
    let record = install_local_dir(&paths, &src, &vendor_root).expect("安装带依赖插件");
    assert_eq!(record.id, "dsh-tool-deps");
    assert!(
        paths
            .plugins_dir()
            .join("node_modules/@deepseek-ai/dsh-client-runtime")
            .exists(),
        "vendor 依赖应经 junction 提供"
    );
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

/// 打包布局(prod 闭包):无 vendor/ 源码树,peer 包与 @deepseek-ai 依赖
/// 都从 node_modules/@deepseek-ai/ 直接命中(v0.101.x 前打包版装插件必报错)。
#[test]
fn install_works_against_packaged_runtime_layout() {
    let root = std::env::temp_dir().join(format!(
        "starhub-plugin-test-packaged-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let app_data = root.join("app-data");
    let runtime_root = root.join("dsh-runtime");
    // 假 prod 闭包:peer 包与依赖包只在 node_modules/@deepseek-ai/ 下
    for pkg in PEER_PACKAGE_DIRS {
        let dir = runtime_root.join("node_modules/@deepseek-ai").join(pkg);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("package.json"),
            format!("{{\"name\": \"@deepseek-ai/{pkg}\"}}"),
        )
        .unwrap();
    }
    let dep_dir = runtime_root.join("node_modules/@deepseek-ai/dsh-client-runtime");
    fs::create_dir_all(&dep_dir).unwrap();
    fs::write(
        dep_dir.join("package.json"),
        r#"{"name": "@deepseek-ai/dsh-client-runtime"}"#,
    )
    .unwrap();

    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let src = root.join("src-plugin");
    write_minimal_plugin(&src, "dsh-tool-packaged");
    fs::write(
        src.join("package.json"),
        r#"{"name": "dsh-tool-packaged", "main": "lib/index.js",
            "dependencies": {"@deepseek-ai/dsh-client-runtime": "workspace:^"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}}}"#,
    )
    .unwrap();

    let record = install_local_dir(&paths, &src, &runtime_root).expect("打包布局应可安装");
    assert_eq!(record.id, "dsh-tool-packaged");
    let nm = paths.plugins_dir().join("node_modules/@deepseek-ai");
    assert!(nm.join("cordis").exists(), "peer junction 应来自 prod 闭包");
    assert!(
        nm.join("dsh-client-runtime").exists(),
        "@deepseek-ai 依赖应直接命中闭包"
    );
    let _ = fs::remove_dir_all(&root);
}

/// 两种布局都定位不到任何 peer 包时,ensure_peer_links 必须报错(fail-loud)。
#[test]
fn ensure_peer_links_fails_when_no_layout_matches() {
    let root = std::env::temp_dir().join(format!(
        "starhub-plugin-test-nopeer-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let plugins_dir = root.join("plugins");
    let runtime_root = root.join("empty-runtime");
    fs::create_dir_all(&runtime_root).unwrap();
    let error = ensure_peer_links(&plugins_dir, &runtime_root).expect_err("应报错");
    assert!(
        matches!(error, PluginError::PathResolve(_)),
        "应为 PathResolve: {error}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn install_client_plugin_marks_dsh_client() {
    let (app_data, vendor_root) = test_roots("client");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let src = app_data.parent().unwrap().join("src-ui");
    write_minimal_plugin(&src, "dsh-ui-panel");
    fs::write(
        src.join("package.json"),
        r#"{"name": "dsh-ui-panel", "main": "lib/index.js",
            "dsh": {"bundle": {"patch": "./p.yml"}, "client": {"entry": "./ui.js"}}}"#,
    )
    .unwrap();
    let record = install_local_dir(&paths, &src, &vendor_root).expect("UI 插件应可安装");
    assert!(record.dsh_client, "registry 应记录 dshClient 标志");
    assert!(!record.builtin);
    // list 透出 dshClient 字段
    let listed = list_plugins(&paths).unwrap();
    assert_eq!(listed[0]["dshClient"], true);
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn builtin_plugin_cannot_disable_or_uninstall() {
    let (app_data, _vendor_root) = test_roots("builtin");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let mut registry = load_registry(&paths).unwrap();
    registry.plugins.push(PluginRecord {
        id: "dsh-starhub-client-nav".into(),
        name: "@deepseek-ai/dsh-starhub-client-nav".into(),
        version: "0.0.1".into(),
        description: Some("壳导航".into()),
        license: None,
        source: PluginSource {
            kind: "builtin".into(),
            location: None,
        },
        entry: "lib/index.js".into(),
        enabled: true,
        dsh_client: true,
        builtin: true,
        installed_at: now_rfc3339(),
    });
    save_registry(&paths, &registry).unwrap();

    let error = set_enabled(&paths, "dsh-starhub-client-nav", false).expect_err("内置不可禁用");
    assert!(error.to_string().contains("内置插件"), "{error}");
    let error = uninstall(&paths, "dsh-starhub-client-nav").expect_err("内置不可卸载");
    assert!(error.to_string().contains("内置插件"), "{error}");
    // 内置插件不标 missing(list 只看非 builtin)
    let listed = list_plugins(&paths).unwrap();
    assert_eq!(listed[0]["missing"], false);
    // 内置插件不进 runtime entries yml(web 侧由 LOCAL_PACKAGES junction 提供)
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("[]"), "内置插件不应出现在 entries yml: {yml}");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn ensure_builtin_plugins_seeds_registry_idempotently() {
    let (app_data, vendor_root) = test_roots("builtin-seed");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    // 假内置包(client-nav 带 dsh.client;tools 纯运行时)
    for (dir, name, client) in [
        ("client-nav", "@deepseek-ai/dsh-starhub-client-nav", true),
        ("tools", "@deepseek-ai/dsh-starhub-tools", false),
    ] {
        let pkg = vendor_root.join("packages").join("starhub").join(dir);
        fs::create_dir_all(pkg.join("lib")).unwrap();
        let mut manifest =
            format!(r#"{{"name": "{name}", "version": "0.0.1", "main": "lib/index.js""#);
        if client {
            manifest.push_str(r#", "dsh": {"client": {"platform": "web"}}"#);
        }
        manifest.push('}');
        fs::write(pkg.join("package.json"), manifest).unwrap();
        fs::write(pkg.join("lib/index.js"), "export default {}\n").unwrap();
    }
    ensure_builtin_plugins(&paths, &vendor_root).unwrap();
    let listed = list_plugins(&paths).unwrap();
    let array = listed.as_array().unwrap();
    assert_eq!(array.len(), 2);
    let client_nav = array
        .iter()
        .find(|v| v["id"] == "dsh-starhub-client-nav")
        .expect("client-nav 内置记录");
    assert_eq!(client_nav["builtin"], true);
    assert_eq!(client_nav["dshClient"], true);
    assert_eq!(client_nav["missing"], false);
    assert_eq!(client_nav["enabled"], true);
    let tools = array
        .iter()
        .find(|v| v["id"] == "dsh-starhub-tools")
        .expect("tools 内置记录");
    // dshClient=false 被 skip_serializing_if 跳过,索引得 Null
    assert_eq!(tools["dshClient"], serde_json::Value::Null);
    // 幂等:重复调用不重复登记
    ensure_builtin_plugins(&paths, &vendor_root).unwrap();
    assert_eq!(list_plugins(&paths).unwrap().as_array().unwrap().len(), 2);
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn user_client_plugins_filters_enabled_client_only() {
    let (app_data, vendor_root) = test_roots("user-client");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let src = app_data.parent().unwrap().join("src-ui");
    write_minimal_plugin(&src, "dsh-ui-a");
    fs::write(
        src.join("package.json"),
        r#"{"name": "dsh-ui-a", "main": "lib/index.js",
            "dsh": {"bundle": {"patch": "./p.yml"}, "client": {"entry": "./ui.js"}}}"#,
    )
    .unwrap();
    install_local_dir(&paths, &src, &vendor_root).unwrap();
    // 未启用 → 不返回
    assert!(user_client_plugins(&paths).unwrap().is_empty());
    set_enabled(&paths, "dsh-ui-a", true).unwrap();
    let clients = user_client_plugins(&paths).unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].id, "dsh-ui-a");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}
