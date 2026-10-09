# StarHub 去 Tauri 化迁移立项设计(DSH desktop + 全插件化)

> 本文档记录「舍弃 Tauri 桌面壳,StarHub 能力整体迁到 DeepSeek Harness desktop
> (Electron)之上、以插件/sidecar 形态交付」的目标架构、组件设计、施工顺序与风险。
>
> 状态:立项(等评审)。关联:本设计建立在 `DSH升级适配清单-v0.2.1-alpha1.md`
> (上游 dsh-v0.2.1-alpha.1 同步)之上。

## 〇、决策基线(2026-10-08 已拍板)

| 岔路口 | 决策 | 直接后果 |
|---|---|---|
| 窗口类交互(直播/接管/授权) | **全部面板化** | 零 vendor 改动;直播帧走 WebSocket 推入 dsh GUI 面板 |
| Rust 侧范围 | **全部抽取为 sidecar** | browser/ssh/sftp/android/desktop 域逻辑与测试全保留 |
| Vendor 关系 | **坚持零 vendor 改动** | `vendor/deepseek-harness` 一个字节不改;窗口能力不等上游,自己面板化 |

## 一、目标架构

```
DeepSeek Harness desktop(上游 Electron 壳,零改动)
└── dsh Host(Node 进程,$DSH_HOME/profiles/desktop)
    ├── starhub-bridge(新,TS 外部插件)
    │     ├── spawn + JSON-RPC: starhub-sidecar-go    ← 现 Go sidecar,零改动
    │     │     (db/redis/clickhouse/mssql/es/kafka/backup)
    │     ├── spawn + JSON-RPC: starhub-sidecar-rust  ← 新,src-tauri 域逻辑抽取
    │     │     (ssh/sftp/android/desktop;browser 引擎不搬,dsh 原生承接)
    │     ├── 工具注册:defineTool → 模型可用的 starhub_* 工具族
    │     ├── 路由注册:webServer.register + registerUpgrade(直播/接管帧通道)
    │     └── UI 动作桥:open.asset / focus.tool / bind.asset → 插件事件 + slots
    ├── 9 个 starhub 插件(8 个近原样,client-nav 的 Tauri 桥改指 bridge)
    ├── 工作台面板(client-nav 现有 shell.overlay/main 槽,iframe 先行)
    └── 直播/接管面板(client-nav 的 keyed main 槽;帧源只有 Android 真机)

消亡:src-tauri 的 harness/(7320 行,Electron Host 取代)、246 个 tauri::command
     层(平移为 sidecar JSON-RPC 方法面)、Tauri 打包/ACL/窗口/更新栈。
保留:Go sidecar(零改动)、Rust 域逻辑(Tauri 无关部分 ~85-90%)及其单测、
      9 插件、React 工作台(dist-starhub-react)。
```

## 二、为什么成立(三个已实证的机制)

1. **外部插件是 desktop 的一等公民**:`apps/desktop/scripts/smoke-runtime.ts`
   实证——profile 内安装外部插件 bundle(`dsh.bundle.patch: bundle.yml` +
   `dsh.profile.bundles` 挂载),插件可 `inject: [webServer, officeToPdf,
   skills]` 等 Host 服务。**我们的交付不需要动 app.asar,也不需要动壳**。
2. **插件可注册 HTTP 与 WebSocket upgrade 路由**:`packages/host/webserver`
   的 `webServer.register()` / `registerUpgrade()`——upgrade handler 自持协议
   握手与 socket,disposal 统一关闭。直播/接管的帧通道由此提供,零 vendor 改动。
3. **工具桥协议可原样迁移**:`starhub-tools` 现有契约是
   `starhub/tool.execute {sessionId, name, args}` over `sdk-transport`
   (JSON-RPC 文本进、模型可读文本出),approval 走 `tools/pre-execute` →
   `ctx.approval`。**应答方从「Tauri 主进程」换成「starhub-bridge → sidecar」,
   9 插件的 TS 侧协议一字不改。**

## 三、组件设计

### 3.1 starhub-sidecar-rust(新,Rust,仓库内新 crate 组)

- **抽取范围**(src-tauri/src 实测):

  | 模块 | 行数 | 引 tauri 文件 | 处置 |
  |---|---:|---|---|
  | browser/ | 4915 | 13/17 | **不搬引擎**(M3 定稿:dsh 原生提供 browser-use);只搬契约层(action/script/jev 已搬) |
  | ssh/ | 5178 | 2/7 | 会话/prompt/cwd/后台任务平移 |
  | sftp/ | 1694 | 1/4 | 传输平移 |
  | android/ | 2521 | 1/1 | adb 操作平移;scrcpy 通道改「帧出口」(见 §3.4) |
  | desktop/ | 1812 | 1/2 | 容器编排平移;直播/接管帧源**不做**(dsh 原生 computer-use 承接) |
  | commands/ | 6105 | 18/19 | **不平移文件,平移名录**:246 个命令 → JSON-RPC 方法面(args/结果 schema 沿用现有 serde 定义) |
  | harness/ | 7320 | 4/7 | **退役**(Electron Host 取代;有价值测试登记后退役) |
  | keyring/ db/ main.rs registry.rs mcp.rs | ~2400 | — | keyring→dsh credentials;db(资产注册)→ 见 §六数据迁移;mcp→ 上游原生 mcp-client(StarHub 0.121.9 已切换过一次) |

- **形态**:单二进制 `starhub-sidecar-rust`,stdio JSON-RPC(与 Go sidecar 对称),
  方法名沿用现有命令名(`db_query`、`ssh_exec`、`browser_click` …),错误码
  沿用。进程模型:由 bridge 插件 spawn,崩溃重启由 bridge 负责(fail loud)。
- **帧出口**(直播/接管面板化的根):sidecar 内起本地 WS server(仅 127.0.0.1,
  一次性 token),推送 browser 截图流 / scrcpy H.264 重封装(fMP4 优先,
  MJPEG 降级)/ 沙箱桌面帧;接收人工操作事件(点击/滑动/按键)转工具调用下行。
  bridge 插件用 `webServer.registerUpgrade` 把该通道以带鉴权的 path 暴露给
  GUI;或备选:经 dsh client connection 的二进制 RPC 携带帧(桌面端 file://
  页面带 cookie 取证受限时的兜底,§七风险 R3)。

### 3.2 starhub-bridge(新,TS 外部插件,packages/starhub/bridge)

- 启动时按 Config(sidecar 可执行路径、spawn 参数)拉起两个 sidecar;
- 把 sidecar 方法面注册为 dsh 工具(`defineTool`,schema 从现有 serde 定义
  镜像为 JSON Schema——StarHub 已有工具 spec 同步机制,直接复用);
- 实现 `starhub/tool.execute` 兼容方法(应答方切换对 9 插件无感);
- `starhub/open.asset` / `focus.tool` / `bind.asset` 改为插件内 event +
  slots 注入(client-nav 已有槽位注册面,直接复用);
- 直播/接管面板的数据面:注册 upgrade 路由,把 sidecar 帧 WS 桥接给 GUI;
  会话/资产/领域事件的宿主推送(session-registry / domain-events /
  live-context 的 Rust 推送源)改由 bridge 经 SDK 通知转发。

### 3.3 9 个插件适配矩阵

| 插件 | 改动 |
|---|---|
| starhub-tools | 桥端点从 `sdk-transport`(Tauri stdio)→ bridge 的 sidecar transport;其余原样 |
| client-nav | Tauri 直调(asset-source / 截图 / 沙箱横幅)→ bridge 事件;直播/接管按钮 → 面板开关(slots) |
| approval-bridge | **原样**(ctx.approval / tools/pre-execute 不动) |
| host-static | **原样**(继续服务 dist-starhub-react) |
| session-registry / domain-events / live-context | **近原样**,推送源改 bridge |
| commit-message | **近原样**,endpoint 由 bridge 提供 |
| tool-context | **原样** |

### 3.4 直播/接管面板(client 插件)

- 一个 `starhub-live` client 插件包:`shell.overlay` 注册面板容器,
  canvas(WebGL/MJPEG)或 `<video>(fMP4)`;
- 输入:面板内手势 → bridge 工具调用下行(复用现有 browser_*/android_* 参数面);
- 「接管」语义保留:任务级授权期间,人工操作直接进 sidecar 输入通道,与模型
  操作互斥的语义从 Tauri 窗口层平移到面板层(单连接 token)。

> **2026-10-09 定稿修正**:帧源只有 **Android** 一个。browser 与沙箱桌面两个
> 帧源**不做**——上游 dsh 原生提供 browser-use / computer-use 及其可见面。
> 面板宿主也落在 client-nav(不为一个面板新开插件包,代价大于收益);
> `browser_*` 工具面保留方法名与参数契约,执行体答「归上游」。

### 3.5 工作台

- **M2 形态**:client-nav 现有 iframe 模式原样搬(host-static 服务
  `dist-starhub-react`,壳内同源 iframe);
- **M3+ 可选**:按 DSH client 插件规范(packages/client/* 槽位纪律)把高频
  面板(结果网格、连接管理)原生化为 slots 组件,iframe 逐步退役。

## 四、退役清单

| 资产 | 处置 |
|---|---|
| src-tauri/src/harness/(7320 行)+ 其测试 | 退役;启动链/桥接测试登记后删除 |
| 246 个 tauri::command | 平移为 sidecar JSON-RPC 方法面(一对一映射,登记清单) |
| Tauri capabilities/ACL、窗口栈、托盘、自更新、bundling | 退役( Electron 壳/electron-builder 取代) |
| Rust 域单测(browser/ssh/sftp/… 中 Tauri 无关部分) | **保留**,随 sidecar crate 迁移 |
| StarHub Tauri 侧 CI(release.yml 的 tauri:build 链) | 切为「上游 installer + StarHub provisioning」链 |

## 五、发布与打包(不动 vendor 的前提下)

1. **上游 installer 原样分发**(electron-builder 的品牌/签名/更新是上游的;
   接受「shell 与 dsh 永远同版本」——每次上游 DSH 发版即我们的基线发版)。
2. **StarHub provisioning**:首次启动(或安装后置脚本)把 ①我们的插件
   bundles ②两个 sidecar 二进制 落盘,并按 desktop 支持的外部插件机制写入
   `$DSH_HOME/profiles/desktop`(`node_modules/<bundle>` + `dsh.profile.bundles`)。
   这是上游 smoke 脚本同款路径,有实证。
3. sidecar 路径经 bridge 的 Config 注入(部署变化项走 cordis.yml Config,
   遵守上游「No hardcoded tunables」规约)。

## 六、数据迁移(易漏项,单列)

| 现在 | 之后 |
|---|---|
| 资产注册表/连接配置:Tauri SQLite(src-tauri/src/db) | sidecar 自有存储(Go/Rust 侧配置文件或 SQLite),或 dsh storage 服务 |
| 密钥:Keyring(src-tauri/src/keyring) | dsh credentials 服务(上游原生) |
| 会话数据:$DSH_HOME(已共享) | **不变** |
| 设置:既有 dsh settings | 不变;StarHub 面设置随插件 Config 走 settings |

## 七、风险登记

| # | 风险 | 缓解 |
|---|---|---|
| R1 | browser 13/17 文件 Tauri 耦合,抽取最重 | **已消解**:引擎不搬(M3 定稿,dsh 原生 browser-use 承接),只搬契约层 |
| R2 | scrcpy H.264 → 浏览器播放的延迟/画质损耗 | fMP4 over WS 优先;MJPEG 兜底;实测门槛(交互延迟 ≤ 现窗口方案 1.5×) |
| R3 | 桌面端 file:// 页面取 Host 路由的凭据受限(cookie 不随 file://) | 首选 connection 二进制 RPC 载帧;或 upgrade 路由带一次性 token(query 参数,握手后即弃) |
| R4 | 246 命令 → JSON-RPC 方法面的 schema/错误码平移遗漏 | 一对一映射清单 + 契约测试(每个命令一个 roundtrip 用例) |
| R5 | 上游 desktop 演进与外部插件兼容性(peer 版本门) | 插件 peer 钉 `@deepseek-ai/dsh` 精确版本;上游发版即我们的兼容矩阵回归 |
| R6 | sidecar spawn 的跨平台路径/权限 | Config 化 + 三平台 smoke(复用上游 primary-runtime 的锁定模式) |
| R7 | 用户数据迁移的完整性(资产/连接/密钥) | 一次性导入工具 + 双跑期校验(旧 SQLite 导出 vs 新存储逐条比对) |

## 八、里程碑(每阶段独立验收、可回退)

- **M1 工具面**:sidecar-rust 抽取(ssh/sftp/android/desktop;browser 只搬契约层)+
  bridge 插件 + starhub-tools 改桥 → **dsh web 上 starhub_* 工具全绿**
  (不等 Electron;契约测试 + 221→N 域单测平移)。
- **M2 壳切换前夜**:9 插件适配 + 工作台 iframe 搬入 → **dsh desktop dev
  壳内全功能可用**(窗口类除外)。
- **M3 面板化**:starhub-live 直播/接管面板(Android 一个帧源)→
  延迟/画质实测过门槛。**browser 与沙箱桌面两个帧源不做**——上游 dsh 原生
  提供 browser-use / computer-use 及其可见面,StarHub 重复造一份只会双轨维护
  (2026-10-09 定稿)。
- **M4 发布链**:provisioning + electron-builder 打包 smoke + 退役
  src-tauri + CI 切换。

## 九、验收总纲

1. 工具面:dsh web + dsh desktop 双壳,`starhub_*` 工具逐个契约测试通过;
2. 插件:9 插件 vitest(现 69 spec/1088 例平移)+ bridge 协议单测全绿;
3. Rust:sidecar crate 域单测(原 Tauri 无关部分)ssh/sftp/android/desktop
   全绿,零 tauri 依赖(cargo tree 无 tauri crate);
4. 面板:Android 帧源延迟/画质实测记录;
5. 退役:src-tauri 删除后 CI 全绿(发布链已切)。
