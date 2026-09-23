//! plugins.rs 单测:manifest id 清洗 / cordis.yml 生成 / 包装配置渲染 /
//! peer junction 与依赖 junction(两种布局)/ registry 与启停状态机 /
//! 内置插件注册幂等 / 坏插件自救禁用。
//! 全部在临时目录内运行,不依赖 Tauri AppHandle。
//! v0.123.1 起安装/启停/卸载/市场命令面移除(插件管理转 dsh 原生「插件」
//! 面板),原 install→list→set_enabled→uninstall 链路与市场解析用例删除,
//! 改为直接构造 registry 覆盖保留的加载面行为。

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
fn render_entries_yml_quotes_and_empty() {
    assert!(render_entries_yml(&[]).contains("[]"));
    let record = PluginRecord {
        id: "dsh-tool-demo".into(),
        name: "dsh-tool-demo".into(),
        version: "1.0.0".into(),
        description: None,
        license: None,
        source: PluginSource {
            kind: "url".into(),
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
fn file_url_and_wrapper_rendering() {
    // Windows 盘符 + 空格 + 非 ASCII:反斜杠转正斜杠、空格与汉字 percent-encode
    let url = path_to_file_url(Path::new(r"C:\Users\测试 User\AppData\plugins\cordis.yml"));
    assert_eq!(
        url,
        "file:///C:/Users/%E6%B5%8B%E8%AF%95%20User/AppData/plugins/cordis.yml"
    );
    let url = path_to_file_url(Path::new("/home/u/plugins/cordis.yml"));
    assert_eq!(url, "file:///home/u/plugins/cordis.yml");

    // DSH 0.1.6 适配:包装配置只剩用户插件一条 include entry,且必须是
    // `- insert:` 块(patch 层里裸 id 匹配不到已有行只会 warn 跳过,不会插入)。
    let wrapper = render_user_plugins_wrapper_yml(Path::new(r"C:\App Data\plugins\cordis.yml"));
    assert!(wrapper.contains("name: cordis:include"), "{wrapper}");
    assert!(wrapper.contains("- insert:"), "{wrapper}");
    assert!(wrapper.contains("id: starhub-user-plugins"), "{wrapper}");
    assert!(
        wrapper.contains("path: 'file:///C:/App%20Data/plugins/cordis.yml'"),
        "{wrapper}"
    );
    assert!(wrapper.contains("initial: []"), "{wrapper}");
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

/// dev 布局:插件依赖的 @deepseek-ai 包经 find_vendor_package 在
/// packages/*/* 里按包名命中,junction 进指定 link_base。
#[test]
fn dependency_resolution_junctions_vendor_package() {
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
    let link_base = paths.plugins_dir().join("node_modules");
    let unresolved =
        resolve_plugin_dependencies_into(&src, &vendor_root, &link_base).expect("依赖解析");
    assert!(unresolved.is_empty(), "应全部解析: {unresolved:?}");
    assert!(
        link_base.join("@deepseek-ai/dsh-client-runtime").exists(),
        "vendor 依赖应经 junction 提供"
    );
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

/// 打包布局(prod 闭包):无 vendor/ 源码树,peer 包与 @deepseek-ai 依赖
/// 都从 node_modules/@deepseek-ai/ 直接命中(v0.101.x 前打包版必报错)。
#[test]
fn dependency_resolution_hits_packaged_runtime_layout() {
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
    let link_base = paths.plugins_dir().join("node_modules");
    // peer junction 同样从 prod 闭包定位(与加载期 ensure_peer_links 同策略)
    ensure_peer_links(&paths.plugins_dir(), &runtime_root).expect("peer 链接应建成");
    let unresolved =
        resolve_plugin_dependencies_into(&src, &runtime_root, &link_base).expect("依赖解析");
    assert!(unresolved.is_empty(), "应全部解析: {unresolved:?}");
    let nm = paths.plugins_dir().join("node_modules/@deepseek-ai");
    assert!(nm.join("cordis").exists(), "peer junction 应来自 prod 闭包");
    assert!(
        nm.join("dsh-client-runtime").exists(),
        "@deepseek-ai 依赖应直接命中闭包"
    );
    let _ = fs::remove_dir_all(&root);
}

/// 内置插件只进 registry,不进 runtime entries yml(web 侧由
/// LOCAL_PACKAGES junction 提供)。
#[test]
fn builtin_plugins_stay_out_of_entries_yml() {
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
    let yml = fs::read_to_string(paths.entries_path()).unwrap();
    assert!(yml.contains("[]"), "内置插件不应出现在 entries yml: {yml}");
    // registry 侧持久化,可再读回
    let reloaded = load_registry(&paths).unwrap();
    assert_eq!(reloaded.plugins.len(), 1);
    assert!(reloaded.plugins[0].builtin);
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
    let registry = load_registry(&paths).unwrap();
    assert_eq!(registry.plugins.len(), 2);
    let client_nav = registry
        .plugins
        .iter()
        .find(|p| p.id == "dsh-starhub-client-nav")
        .expect("client-nav 内置记录");
    assert!(client_nav.builtin);
    assert!(client_nav.dsh_client);
    assert!(client_nav.enabled);
    let tools = registry
        .plugins
        .iter()
        .find(|p| p.id == "dsh-starhub-tools")
        .expect("tools 内置记录");
    assert!(!tools.dsh_client);
    // 幂等:重复调用不重复登记
    ensure_builtin_plugins(&paths, &vendor_root).unwrap();
    assert_eq!(load_registry(&paths).unwrap().plugins.len(), 2);
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn user_client_plugins_filters_enabled_client_only() {
    let (app_data, _vendor_root) = test_roots("user-client");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    let src = app_data.parent().unwrap().join("src-ui");
    write_minimal_plugin(&src, "dsh-ui-a");
    // 直接构造 registry:一条启用的 UI 插件 + 一条禁用的普通插件
    let mut registry = load_registry(&paths).unwrap();
    for (id, enabled, dsh_client) in [("dsh-ui-a", true, true), ("dsh-tool-a", false, false)] {
        registry.plugins.push(PluginRecord {
            id: id.into(),
            name: format!("{id}-name"),
            version: "1.0.0".into(),
            description: None,
            license: None,
            source: PluginSource {
                kind: "url".into(),
                location: None,
            },
            entry: "lib/index.js".into(),
            enabled,
            dsh_client,
            builtin: false,
            installed_at: now_rfc3339(),
        });
    }
    save_registry(&paths, &registry).unwrap();

    let clients = user_client_plugins(&paths).unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].id, "dsh-ui-a");
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}

#[test]
fn disable_user_plugins_only_disables_enabled_non_builtin() {
    let (app_data, _vendor_root) = test_roots("bad-plugin");
    let paths = PluginPaths::at(app_data.clone());
    paths.ensure_layout().unwrap();
    // 两个用户插件:一个启用、一个已禁用 → 只禁用启用者;内置不动
    let mut registry = load_registry(&paths).unwrap();
    for (id, enabled, builtin) in [
        ("dsh-bad-a", true, false),
        ("dsh-bad-b", false, false),
        ("dsh-starhub-client-nav", true, true),
    ] {
        registry.plugins.push(PluginRecord {
            id: id.into(),
            name: format!("{id}-name"),
            version: "1.0.0".into(),
            description: None,
            license: None,
            source: PluginSource {
                kind: "builtin".into(),
                location: None,
            },
            entry: "lib/index.js".into(),
            enabled,
            dsh_client: false,
            builtin,
            installed_at: now_rfc3339(),
        });
    }
    save_registry(&paths, &registry).unwrap();

    let disabled = disable_user_plugins(&paths).unwrap();
    assert_eq!(disabled, vec!["dsh-bad-a".to_string()]);
    // registry 中 dsh-bad-a 已禁用,dsh-bad-b 保持禁用,内置保持启用
    let registry = load_registry(&paths).unwrap();
    let get = |id: &str| registry.plugins.iter().find(|p| p.id == id).unwrap();
    assert!(!get("dsh-bad-a").enabled);
    assert!(!get("dsh-bad-b").enabled);
    assert!(get("dsh-starhub-client-nav").enabled);
    // 幂等:再次调用不再产生新禁用
    assert!(disable_user_plugins(&paths).unwrap().is_empty());
    let _ = fs::remove_dir_all(app_data.parent().unwrap());
}
