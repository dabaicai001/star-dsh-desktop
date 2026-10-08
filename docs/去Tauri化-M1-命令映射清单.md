# 去 Tauri 化 M1:命令名录 → JSON-RPC 方法面映射清单

> 配套 `docs/StarHub去Tauri化-迁移立项设计.md` 的 M1 施工底册。
> 事实来源:模型面工具表 = `vendor/deepseek-harness/packages/starhub/tools/src/index.ts`
> 的 `BRIDGED_TOOLS`(81)+ 5 个全局工具 = **86**(Excel 24 工具已随能力删除,
> 原 110);Rust 分发面 = `src-tauri/src/harness/tools.rs::dispatch_tool`
> (去 Tauri 化后由 sidecar 方法面承接)。

## 一、协议规格(与 dsh-sdk-protocol 的 `JsonRpcLineTransport` 逐字节对齐)

- 帧:**换行分帧(`\n`)的 JSON-RPC 2.0**,UTF-8,stdio;
- 请求 `{"jsonrpc":"2.0","id":<string|number>,"method":<name>,"params":{...}}`;
  应答 `{"jsonrpc":"2.0","id":<同 id>,"result":...}` 或 `{"jsonrpc":"2.0","id":<同 id>,"error":{"code":..,"message":"..","data":..}}`;
- 通知 `{"jsonrpc":"2.0","method":<name>,"params":{...>}`(无 id,不等应答;sidecar → bridge 的方向用于领域事件/进度推送);
- 畸形行:忽略(不杀进程);
- 错误码:未注册方法 `-32601`;handler 失败 `-32603`(message 透传);参数形状错误 `-32602`;
- 兼容层:bridge 实现 `starhub/tool.execute {sessionId,name,args}` → 内部转为 `method=name, params=args`,**9 插件的 TS 侧零改动**。

## 二、进程布局

单二进制 `starhub-sidecar-rust`(与 `starhub-sidecar-go` 对称),方法按域分模块注册:

| 方法域 | 源模块(src-tauri/src) | 现状执行点 | 迁移动作 |
|---|---|---|---|
| `ssh_*` / `sftp_*` | `ssh/`(5178)+ `sftp/`(1694)+ `harness/domain.rs` 内 SSH/SFTP 分支 | `SshManager`(russh)进程内 | 平移(去 `tauri::Manager` 取 state 的耦合,改显式传参) |
| `db_query` / `redis_exec` / `es_*` / `docker_*` | `harness/domain.rs` 中部分支 + `sidecar.rs`(398,Go sidecar stdio 客户端) | `SidecarManager` → Go sidecar | 平移(客户端已在 Rust 侧,直接搬) |
| `browser_*`(16) | `browser/`(4915) | `BrowserManager` 进程内(无痕窗口+eval 通道) | 域逻辑平移;窗口/直播面重写为「帧服务 + 工具」 |
| `desktop_*`(22) | `desktop/`(1812) | sidecar Docker 适配器编排 | 平移 |
| `android_*`(20) | `android/`(2521) | adb 直连;scrcpy 通道 | 操作平移;scrcpy → 帧出口 |
| ~~`excel_*`(24)~~ | — | — | **已删除**(M1 第 7 步):工作簿视图不存在,转发通道是死代码 |
| 全局 5 | `harness/tools.rs`(list_capabilities 静态)+ `registry.rs`(会话注册表) | Rust 进程内 | list_capabilities/list_assets 平移到 sidecar;bind/open/focus 的窗口动作改 bridge 插件事件 |

## 三、86 工具映射表(方法名 = 工具名,一对一)

### SSH / SFTP(8,进程内执行,平移)

| 工具 | sidecar 方法 | 说明 |
|---|---|---|
| ssh_exec | `ssh_exec` | 命令执行;exec_id 注册 inflight,停止生成可中断 |
| ssh_exec_background | `ssh_exec_background` | 后台任务 |
| ssh_wait_task | `ssh_wait_task` | 任务等待 |
| ssh_session_status | `ssh_session_status` | 会话状态 |
| sftp_list / sftp_stat / sftp_upload / sftp_download | 同名 | 复用 SSH 会话通道 |

### DB / Redis / ES / Docker(15,经 Go sidecar,客户端平移)

| 工具 | sidecar 方法 | 下游 |
|---|---|---|
| db_query | `db_query` | Go sidecar(资产连接参数从 assets 表 + Keyring 合并的机制随资产存储迁移,见设计 §六) |
| redis_exec | `redis_exec` | Go sidecar |
| es_list_indices / es_cluster_health / es_get_mapping / es_search / es_get_document / es_count / es_index_document / es_delete_document / es_delete_index(9) | 同名 | Go sidecar |
| docker_list_containers / docker_logs / docker_inspect / docker_exec(4) | 同名 | Go sidecar |

### 浏览器(16,域逻辑平移 + 帧服务)

browser_open / navigate / back / forward / reload / state / extract / click / type / press_key / select_option / scroll / screenshot / eval / decide / auto —— 方法同名;
`browser_screenshot`/`browser_auto`/`browser_decide` 的「人看」面改由 sidecar 帧出口(§3.4 of 设计文档)供给直播面板;
Jev 决策链路(`decide.rs::decide_struct`)纯逻辑,原样平移。

### 沙箱桌面(22,编排平移)

desktop_list_templates / build_template / create_sandbox / sandbox_status / pause / resume / destroy / commit / sandbox_replay / screenshot / list_windows / get_foreground_window / focus_window / click / double_click / move_mouse / scroll / drag / type / press_key / exec / request_user_action —— 方法同名;
窗口枚举/focus 等窗口面操作降级为「帧出口 + 输入通道」(桌面容器内无真窗口,列表类工具返回容器/VNC 面)。

### Android(20,操作平移 + scrcpy 帧出口)

android_list_devices / connect / disconnect / device_status / replay / wireless / screenshot / current_app / ui_tree / tap / double_tap / swipe / scroll / type / press_key / launch_app / open_live / pull / push / exec —— 方法同名;
`open_live` 从「开 Tauri 直播窗口」改为「注册直播会话,bridge 的 upgrade 路由推帧」。

### Excel(24,**已删除**)

excel_get_context / write_range / fill_formula / read_range / set_headers / find_replace / add_sheet / remove_sheet / rename_sheet / switch_sheet / style_header / auto_filter / write_cell / insert_rows / delete_rows / insert_cols / delete_cols / sort / filter / clear_filter / freeze / remove_duplicates / dedup_to_sheet / save。
M1 第 7 步随能力整体删除(工具定义、`dsh://tool-exec` 转发通道、Go Excel 适配器、excel 资产类型):React 工作台没有工作簿视图,转发过去只会 180s 超时,工具面与转发通道本就是死代码。模型面工具 110 → 86。

### 全局(5)

| 工具 | sidecar 方法 | 说明 |
|---|---|---|
| starhub_list_capabilities | `starhub_list_capabilities` | 静态内容(工具名录,`starhub-contract::capabilities_text`),平移 |
| starhub_list_assets | `starhub_list_assets` | 资产表查询;依赖资产存储(设计 §六) |
| bind_asset_context | `bind_asset_context` | 会话绑定(桥方法 `starhub/bind.asset` → 该方法) |
| open_connection | `open_connection` | 窗口动作 → bridge 插件事件(工作台面板打开连接) |
| focus_terminal | `focus_terminal` | 同上 |

## 四、分发替换图

```
今天:  dsh 工具 → starhub-tools.callHost → sdk-transport(stdio)
       → src-tauri harness::execute_bridge_request → dispatch_tool
       ├─ IN_PROCESS(23)       → domain.rs(SshManager / SidecarManager→Go)
       ├─ BROWSER_TOOLS(16)    → browser::
       ├─ DESKTOP_TOOLS(22)    → desktop::
       ├─ ANDROID_TOOLS(20)    → android::
       └─ 全局(5)              → tools.rs / registry.rs / db::
       (每次成功后 on_ai_tool_success:审计 + 领域事件 + recentExecs)

之后:  dsh 工具 → starhub-tools.callHost → sdk-transport(bridge provide)
       → starhub-bridge(外部插件)
          ├─ starhub/tool.execute 兼容层 → method=name 直调 sidecar-rust
          ├─ starhub/bind.asset / open.asset / focus.tool / live.snapshot
          └─ 领域事件 / registry.sync / recentExecs → sidecar 通知出口
       → starhub-sidecar-rust(stdio JSON-RPC,方法面 = 上表 + 4 个桥命令)
          ├─ ssh/sftp 域逻辑(russh)
          ├─ db/redis/es/docker → starhub-sidecar-go(零改动)
          ├─ browser/android/desktop 域逻辑 + 帧出口(WS)
          └─ 注册表/能力表
```

## 五、语义保持清单(迁移验收点)

| 语义 | 今天在哪 | 之后在哪 |
|---|---|---|
| 只读自动放行/风险 ask 审批 | approval-bridge(tools/pre-execute → ctx.approval) | **不变**(TS 侧) |
| 停止生成真正中断在途命令 | `bridge.drain()` + InflightAbort(exec_id) | sidecar 侧保留 exec_id 注册表;bridge 的停止信号经通知 `starhub/exec.abort` 下行 |
| MFA 堡垒机首次验证卡片 | android/ssh 连接流程(Tauri 窗口) | 改为 bridge 事件 → dsh GUI 确认面(ctx.approval / 面板) |
| 任务级授权(desktop/android)与接管互斥 | 模块执行点强制 | sidecar 执行点保持;授权/接管的 UI 面面板化 |
| AI 工具审计(白名单参数) | harness/tools.rs audit_ai_tool | bridge 落审计(会话日志 `approval/asked` 同源机制或 sidecar 自有) |
| 领域事件(starhub://domain-event)+ recentExecs | harness/events.rs | bridge 经 SDK 通知转发(session-registry/domain-events 无感) |
| 结果文本格式(模型可读) | 前端 dshToolExecutor.ts / domain.rs 对齐 | sidecar 原样产出(文本格式是契约,不许漂移) |

## 六、M1 施工顺序(本清单配套)

1. ✅ `sidecar-rust/` workspace + JSON-RPC 骨架 + `ping`/`starhub_list_capabilities` 两个方法 + 协议单测(**已完成**:15 单测 + 6 集成测试,真实二进制 stdio 会话;`npm run sidecar-rust:test`);
2. ✅ `packages/starhub/bridge` 插件骨架:spawn sidecar、`JsonRpcLineTransport` 复用、注册 `starhub_sidecar_status` 工具、健康探针 fail loud、dispose 收进程(**已完成**:6 测试;vendor host 聚合 tsc + `packages/starhub` vitest 63 spec/1020 例全绿);
3. ✅ **SSH/SFTP 域抽取(已完成,唯一事实源确立)**:
   - `starhub-domain-ssh` crate 从 `src-tauri/src/{ssh,sftp}` 整树搬迁
     (10 文件 ~10.8k 行),Tauri 耦合收敛为两个 seam——`EventSink`
     (20 处 emit,调用点一词之改)与 `KnownHostsStore`(原 SQLite
     known_hosts,trait 化);crate **63 单测全绿**;
   - `src-tauri` 改依赖 crate:`src/ssh`、`src/sftp` 变为再导出 shim,
     新增 `src/ssh/adapters.rs`(TauriEventSink + SqliteKnownHostsStore,
     SQL 原样平移),SshManager 携带 `Arc<dyn KnownHostsStore>`,
     connect/open_shell/exec_via_bastion_pty 的 app_handle 改传
     tauri_sink;旧 9 文件已删;**cargo test 169 passed / 0 failed**
     (与 crate 63 例合计 232,零丢失);事件名/载荷/SQL 逐字保持;
   - 追加:SshManager / connect_session / ssh_exec_core /
     ssh_exec_abort_core 与 `ssh_config_from_asset` 纯映射也搬进 crate
     (Tauri 侧只留 `#[tauri::command]` 薄封装 + `pub use` 再导出),
     域 crate 71 单测、src-tauri 167 passed(169 − 2 随迁),合计 238 零丢失;
4. ✅ **sidecar 注册 8 个 ssh/sftp 方法(已完成)**:
   - `assets.rs` 资产存储(assets.json + `SecretStore` seam:内存/文件两实现,
     原生 Keyring 随 §六 credentials 迁移补齐);错误文案与 SQLite 版逐字一致;
   - `known_hosts_store.rs` TOFU 主机密钥 JSON 存储(字段与 SQLite 表对齐,
     §六/R7 一次性导入即 `SELECT → JSON` 直排);
   - `runtime.rs` 域运行时(ensure_ssh_session / 连接级失败重连一次 /
     后台任务命令拼装 / 长 sleep 软引导 / SFTP 惰性通道 / 传输终态汇总),
     结果文本格式逐字保持;`bindings.rs` + `session_registry.rs` 平移
     会话绑定与附着视图;
   - 异步域方法经 `register_async!`(`Runtime::block_on`)注册,registry
     同步 handler 面不变;`starhub_list_assets` / `bind_asset_context` 同批落地;
   - 域事件出口:NotificationSink 把 `ssh:data` / `ssh:exec-done` /
     `sftp://transfer-*` 转成 `starhub/domain-event` 通知,排队后在对应
     请求的响应之前刷盘(因果顺序);`starhub/exec.abort` 通知按 exec_id
     中断在途命令(停止生成);
   - **验证**:workspace 133 例全绿(71 域 + 48 库 + 14 集成);src-tauri 167 不变;
   - **端到端(真 SSH,非 mock)**:`test-sftp/exec_server.py`(password 认证
     + exec + SFTP 子系统,宿主机密钥复用)+ `test-sftp/verify_sidecar_ssh.py`
     实跑全过——ssh_exec 真连真执行、sftp_list 列出远端文件、状态机迁移、
     abort 确认、`ssh:exec-done` 通知都在真实二进制上验过;
5. ✅ **DB/Redis/ES/Docker 域平移(已完成)**:
   - 新 crate `starhub-domain-db`:`go_sidecar.rs`(Go sidecar stdio 客户端,
     从 `src-tauri/src/sidecar` 整文件平移;启动命令解析改为
     「显式覆盖 → `STARHUB_GO_SIDECAR` → current_exe 相对查找」——M1 架构里
     Rust sidecar 才是 Go sidecar 的父进程,惰性启动)+ `executors.rs`
     (15 个执行器 + 结果文本契约 + `check_tool_asset_type`);
   - `db_runtime.rs` + `methods/db.rs`:15 个方法注册(资产解析三岔口:
     就绪 / 软错误引导 / 硬错误);方法面总数 12 → **27**;
   - 集成测试:DB 方法面 roundtrip(真二进制 → 注册表 → block_on → GoSidecar
     → 假 Go sidecar fixture),断言模型可读文本;
   - `src-tauri` 改依赖 crate:`src/sidecar/mod.rs` 变再导出 shim,
     `harness/domain.rs` 1448 → 409 行(只剩 Tauri 装配:SqliteAssetSource /
     BridgeExecTracker / app state 取用 / 四个 DB 薄封装);
   - 同时把 SSH/SFTP 执行体收敛到 `starhub-domain-ssh::tools`
     (AssetSource / ExecTracker / ToolContext 三个注入点),消除 sidecar 与
     src-tauri 两份同名拷贝——**两个宿主现在共用同一份执行体**;
   - **验证**:workspace 166 例全绿(db 17 + ssh 80 + sidecar 53 + 集成 16);
     src-tauri 152 passed(原 167,15 例随执行体搬迁到 crate,零丢失);
     端到端 verify_sidecar_ssh.py 8/8(能力表 27 方法);
6. ✅ **desktop / android / browser 三域平移(已完成,方法面 85)**:
   - `starhub-domain-desktop`(22 方法):recipe(配方/Dockerfile)+ keys
     (键名白名单/sh_quote)+ manager(任务授权/接管互斥)+ store seam +
     exec(22 工具体);src-tauri 侧 1694 → 460 行(只剩直播/UI 入口与六个
     seam 的 SQLite/app 实现);
   - `starhub-domain-android`(20 方法):keys(白名单/uiautomator 解析/
     PNG CRLF 修复)+ manager(授权)+ adb seam(路径显式传入,测试替身可
     完整记录调用)+ store(回放帧)+ exec(20 工具体);src-tauri 侧
     2646 → 1531 行(只剩 scrcpy 直播窗口面);
   - `starhub-domain-browser`(16 方法,契约层):action(parse_action +
     BrowserAction)+ script(HELPERS_JS 逐字 + wrap_eval + normalize_url
     去 tauri::Url 依赖);引擎层(无头 CDP/截图/直播帧)明确留给 M3
     面板化,M1 先固定方法面与参数契约;
   - sidecar 方法面 12 → **85**;workspace 249 例全绿;
     src-tauri 137 → 120 passed(17 例随契约层搬到 crate,零丢失);
 7. ✅ **Excel 能力删除 + bridge 兼容层 + 9 插件适配(已完成)**:
    - **Excel 全线删除**(用户决定,不再「转发改道」):24 个 `excel_*` 模型
      工具、Tauri 的 `dsh://tool-exec` / `dsh_tool_exec_reply` 转发通道、
      Go sidecar 的 Excel 适配器(`file.excel.*` 20 个 RPC +
      MySQL/ClickHouse `exportExcel`)、excel 资产类型(SQLite CHECK 收窄 +
      删历史行)、DB 工作台「导出 Excel」按钮、`#Excel` 模块作用域一并删除;
      理由:React 工作台没有工作簿视图,转发过去只会 180s 超时——工具面与
      转发通道本就是死代码。模型面工具 110 → **86**(81 域工具 + 5 全局/UI);
    - `starhub-contract` crate:领域事件 schema + 模型可读能力文本从
      `src-tauri/src/harness/{events,tools}.rs` 平移,两个宿主共用同一份
      (src-tauri 的 events.rs 变再导出 shim);
    - sidecar 补桥命令面:`starhub/open.asset` / `starhub/focus.tool` /
      `starhub/live.snapshot`(注册表快照 + 传输 + recentExecs + 任务轨迹),
      `starhub/capabilities`(方法面清单,与工具 `starhub_list_capabilities`
      的静态文本分开);域工具成功后回写 AI 起源领域事件
      (`starhub/domain.event`)+ recentExecs(契约 §1/M4);
    - **事件因果顺序修正**:通知改在「本条请求处理完、响应写出之前」刷盘
      (旧实现在下一条入站帧时才刷,对端看到的是「果在因前」);
    - bridge 插件兼容层:`sdk-transport` / `sdk-notifications` 两个宿主私有
      服务改由 bridge provide(与 sdk-jsonrpc-server 在 Tauri 组合里同名,
      二选一,重复提供 fail loud),`starhub/tool.execute {sessionId,name,args}`
      → `method=name, params=args` 直调 sidecar(`{text}` 信封拆封为模型文本),
      `starhub/bind.asset` → `bind_asset_context`;9 插件 TS 侧零改动;
    - bridge 工作台 API:`POST /starhub/api/invoke`(命令 → sidecar 方法)+
      `GET /starhub/api/events`(SSE,事件名原样透传)——React 工作台脱离
      Tauri IPC 的调用/事件面(M2 搬入的座席);
    - live-context 的 transport 改为每次 pre-step 现取(bridge 的 apply 是
      异步的,provide 晚于插件 apply,读一次会永久丢掉快照段);
    - 验证:workspace **267 例全绿**(contract 7 + sidecar lib 69 + 集成 26
      + 四域 crate);src-tauri 110 passed(6 例随契约层搬到 crate、4 例随
      Excel 转发通道删除,零丢失);vendor `packages/starhub` vitest 全绿
      (bridge 32 + client-nav 912 + 其余 108);Go `go build/vet/test` 全过;
 8. ⬜ dsh web 全工具验收(不等 Electron):起 `dsh --profile web` +
    starhub-bridge(不挂 sdk-jsonrpc-server),用真 sidecar 二进制跑通
    「工具调用 → 兼容层 → sidecar → 模型文本」全链路。
