# 插件体系打通方案:StarHub 插件 = dsh 插件

> 状态:方案稿(用户决策:插件 tab 管理的插件就是 dsh 插件,插件市场就是 dsh 的
> 市场,用户要从市场快速安装——包括 UI 类插件)
> 关联:`docs/重构方案-B-壳内React插件化.md`、
> `src-tauri/src/harness/plugins.rs`、`src-tauri/src/harness/web.rs`

---

## 1. 现状:两条平行线

| | 用户插件(Rust `plugins.rs`) | StarHub 壳内插件(`packages/starhub/*`) |
|---|---|---|
| 类型 | cordis **运行时**插件(模型工具类) | `dsh.client` 浏览器端 UI 插件(client-nav 等)+ 运行时插件(tools) |
| 安装 | 市场/URL/本地,装进 `plugins/<id>/` | 随应用编译发布,vendor junction 进 `profiles/node_modules` |
| 限制 | `dependencies` 非空拒装;**`dsh.client` 声明拒装**;包名含 UI 词拒装;市场分类过滤 UI/主题/皮肤/客户端/娱乐 | 无 |
| 生效 | `plugins/cordis.yml` include 进 dsh runtime,重启 runtime 生效 | dsh web 进程浏览器端,`ClientModuleRegistry` 扫描 `dsh.client` 包自动加载 |

**割裂点**:StarHub 自己的能力面(壳内 React 插件)恰恰是 UI 类,而用户插件体系
把 UI 类挡在门外——市场上即使有 UI 插件也装不上、看不到。

## 2. 目标形态(用户决策)

1. **插件 tab 管理的插件 = dsh 插件**,同一个 registry、同一套安装/启停/卸载;
2. **插件市场 = dsh 的插件市场**(awesome-dsh-plugin 索引),UI 类也收录展示;
3. **可从市场一键快速安装**,包括 UI 类(`dsh.client`)插件——装完重启后,插件
   的浏览器端代码经 dsh web 内核自动加载进壳(和 client-nav 同类机制)。

## 3. 打通方案(全部改动在 StarHub 自身代码,不改 dsh 内核)

### 3.1 关键机制确认(已验证)

dsh web 内核的 `ClientModuleRegistry`(`packages/client/modules`)以
`ctx.baseUrl`(= `$DSH_HOME/profiles/web`,config tree 目录)为锚点做
`require.resolve` 扫描:任何带 `dsh.client` 声明的包,只要能在该锚点解析到
(即 junction 进 `$DSH_HOME/profiles/node_modules/@deepseek-ai/`),就会被:
- 写入 `window.__DSH_BOOT__` 的 bundle 列表(rev 哈希);
- 经 `/plugins/<pkg>/client.js` 由 webserver 服务;
- 浏览器端 ModuleLoader 加载并 `apply()`。

**因此 UI 用户插件只需在 spawn dsh web 前 junction 进 profiles/node_modules,
dsh 内核零改动即可加载**——与现有 `web.rs` 为 client-nav/host-static/
tool-context 补 junction 的机制完全同构(`LOCAL_PACKAGES`)。

### 3.2 Rust 侧(`src-tauri/`)

| 改动点 | 内容 |
|---|---|
| `harness/plugins.rs` 校验 | 放开 `dsh.client` 拒装;放开包名 UI 词启发式拒装(仅保留市场分类提示);`dependencies` 非空仍拒装(插件须自带构建产物,首版不负责构建/依赖安装),peerDependencies 允许;`ValidatedManifest`/`PluginRecord` 增加 `dsh_client: bool` |
| `harness/plugins.rs` peer junction | 按已装插件的 `peerDependencies` 扩展 junction 集合(现有 cordis/cosmokit/schemastery 之外,补 `@deepseek-ai/dsh-client-*` 等 web 进程需要的包——目标仍指向 vendor) |
| `harness/web.rs` | spawn dsh web 前扫描 registry:`enabled && dsh_client` 的插件 junction 到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/<id>`(与 LOCAL_PACKAGES 同一函数);禁用/卸载时移除 junction,并提示重启 GUI 生效 |
| 市场 | `is_ui_category` 放开:UI/主题/皮肤类也收录展示(娱乐/客户端类可保留过滤);安装侧不再拒 UI |
| `commands/dsh_plugins.rs` | `list` 透出 `dshClient` 标志(前端展示类型徽标) |

### 3.3 前端(`client-nav` 插件 tab)

- 已装列表与市场条目展示插件类型徽标(运行时 / UI);
- UI 插件风险提示文案区分(前端代码注入 vs 运行时命令);
- 安装按钮对 UI 插件同样可用。

### 3.4 生效语义

- 运行时插件:维持现状(`plugins/cordis.yml` → dsh runtime,重启 runtime 生效);
- UI 插件:安装/启用后需要**重启 GUI(dsh web 进程)**,junction 注入后
  ClientModuleRegistry 才会在 boot 时扫描到;卸载/禁用同理。

## 4. 边界与取舍(开工前确认)

- **UI 插件依赖约束**:保持「自带构建产物 + 仅 peer 依赖」。带 `dependencies`
  的插件仍拒装(完整 node_modules 安装/解析是二期工作)。
- **内置插件纳入 tab(可选 B)**:把 client-nav/host-static/tool-context/tools
  注册为 registry 的「内置」记录(来源 `builtin`,默认启用,不可卸载),插件
  tab 里可见、可查看——与用户插件共用管理面。本期默认不做,标记为后续。
- 不做:运行时插件热插拔(维持重启生效)。

## 5. 验证

- Rust 单元测试(`plugins.rs` tests):UI 插件校验通过、registry 记录 dsh_client、
  市场解析含 UI 分类、junction 集合按 peer 扩展;
- `web.rs` 相关测试:启用/禁用 UI 插件对 junction 的增删;
- 前端插件 tab 测试:类型徽标、UI 风险提示;
- 手工验证:3086 测试实例安装一个带 `dsh.client` 的本地插件 → 重启 GUI →
  `__DSH_BOOT__` 出现该包、页面渲染其注册内容。

## 6. 实现记录(v0.75.0)

已落地:

1. **校验放开**:`validate_plugin_dir` 不再拒装 `dsh.client`(记录 `dsh_client`
   标志)与包名含 UI 词;`dependencies` 非空不再拒装,改为安装时分层解析
   (`resolve_plugin_dependencies_into`:`@deepseek-ai/*` 经 vendor junction,
   第三方尽力从 vendor/node_modules 解析,未解析仅告警)。
2. **registry 扩展**:`PluginRecord` 增加 `dshClient` / `builtin` 字段
   (false 时 skip 序列化,旧数据兼容);`list` 附 missing 标记时内置插件跳过。
3. **内置插件**:`ensure_builtin_plugins` 幂等注册 client-nav / host-static /
   tool-context / tools 为 `builtin` 记录(来源 kind="builtin",默认启用);
   内置插件不可启停/卸载(`set_enabled`/`uninstall` 拒绝),且**不进**
   `plugins/cordis.yml`(runtime 组合只挂用户插件;web 侧由 web.rs 的
   LOCAL_PACKAGES junction + patch 提供,host-static 依赖 web 进程的
   webServer,进 runtime 组合会 fail-loud)。
4. **web 加载链**:`web.rs` spawn 前调用 `sync_user_client_plugins`——启用中的
   `dsh_client` 用户插件按包名 junction 到 `profiles/node_modules/<pkgname>`
   (带 scope 多级),依赖同样 junction 到该锚点,并在 `cordis.patch.yml` 的
   insert 块追加 `name: '<pkgname>'` entry 行;失效 junction 递归清理
   (指向 plugins/ 且不在启用集)。dsh 内核 `ClientModuleRegistry` 零改动即可
   扫描加载(实测:自建最小 `dsh.client` 插件注入后进入 `__DSH_BOOT__`,
   bundle 200)。
5. **插件包约束(dsh 生态约定)**:package.json 需含 `dsh.bundle`、
   `exports["."]`(node 半入口,loader 要求)、`exports["./client"]`
   (client bundle,dsh 内核按此定位)、`exports["./package.json"]`
   (内核 `require.resolve(pkg/package.json)` 需要,实测缺失时解析被拒)。
6. **市场**:`is_ui_category` 只过滤「客户端」聚合类,UI/主题/皮肤类收录。
7. **前端插件 tab**:卡片显示「UI」/「内置」徽标;内置插件启停/卸载按钮禁用;
   UI 插件风险提示文案区分(浏览器端 UI 注入 vs 本机代码执行)。

生效语义:运行时插件维持现状(runtime 重启生效);**UI 插件安装/启停/卸载后
需重启 GUI(dsh web 进程)**,junction 与 patch 在下次 spawn 时重建。

## 7. 文档与版本

- 本方案随实施更新;完成时按 AGENTS.md 升版(minor)+ CHANGELOG + commit。
