# 去 Tauri 化 M1:命令名录 → JSON-RPC 方法面映射清单

> 配套 `docs/StarHub去Tauri化-迁移立项设计.md` 的 M1 施工底册。
> 事实来源:模型面工具表 = `vendor/deepseek-harness/packages/starhub/tools/src/index.ts`
> 的 `BRIDGED_TOOLS`(105)+ 5 个全局工具 = **110**;Rust 分发面 =
> `src-tauri/src/harness/tools.rs::dispatch_tool`。

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
| `excel_*`(24) | — | **前端面板**(Univer 工作簿状态) | **不迁 Rust**:工作簿留在 React 工作台(新架构里是 dsh GUI 内的 client 插件/iframe),bridge 的转发目标从 Tauri webview 改为工作台面板通道 |
| 全局 5 | `harness/tools.rs`(list_capabilities 静态)+ `registry.rs`(会话注册表) | Rust 进程内 | list_capabilities/list_assets 平移到 sidecar;bind/open/focus 的窗口动作改插件事件 |

## 三、110 工具映射表(方法名 = 工具名,一对一)

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

### Excel(24,**留前端**,方法名登记但不进 sidecar)

excel_get_context / write_range / fill_formula / read_range / set_headers / find_replace / add_sheet / remove_sheet / rename_sheet / switch_sheet / style_header / auto_filter / write_cell / insert_rows / delete_rows / insert_cols / delete_cols / sort / filter / clear_filter / freeze / remove_duplicates / dedup_to_sheet / save。
去向后:bridge 的 `starhub/tool.execute` 对 excel_* 转发到**工作台面板**(dsh GUI 内 React 应用,Univer 工作簿状态仍在),转发机制从「Tauri webview 事件」改为「bridge ↔ 工作台插件的 GUI 通道」(slots/store 或 connection RPC,二选一,在 M2 定)。

### 全局(5)

| 工具 | sidecar 方法 | 说明 |
|---|---|---|
| starhub_list_capabilities | `starhub_list_capabilities` | 静态内容(工具名录),平移 |
| starhub_list_assets | `starhub_list_assets` | 资产表查询;依赖资产存储(设计 §六) |
| bind_asset_context | `bind_asset_context` | 会话注册表 attach,平移 registry.rs(289 行纯逻辑) |
| open_connection | `open_connection` | 窗口动作 → 改为 bridge 插件事件(工作台面板打开连接) |
| focus_terminal | `focus_terminal` | 同上 |

## 四、分发替换图

```
今天:  dsh 工具 → starhub-tools.callHost → sdk-transport(stdio)
       → src-tauri harness::execute_bridge_request → dispatch_tool
       ├─ FORWARDED(excel 24)  → dsh://tool-exec 事件 → 前端 webview
       ├─ IN_PROCESS(23)       → domain.rs(SshManager / SidecarManager→Go)
       ├─ BROWSER_TOOLS(16)    → browser::
       ├─ DESKTOP_TOOLS(22)    → desktop::
       ├─ ANDROID_TOOLS(20)    → android::
       └─ 全局(5)              → tools.rs / registry.rs / db::
       (每次成功后 on_ai_tool_success:审计 + 领域事件 + recentExecs)

之后:  dsh 工具 → starhub-tools.callHost → sdk-transport(stdio,协议不变)
       → starhub-bridge(外部插件)
          ├─ starhub/tool.execute 兼容层 → method=name 直调 sidecar-rust
          ├─ excel_* → 工作台面板通道(新)
          └─ 审计/领域事件/recentExecs → bridge 内实现(会话日志 + SDK 通知)
       → starhub-sidecar-rust(stdio JSON-RPC,方法面 = 上表)
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
5. ⬜ 其余域按「DB/Redis/ES/Docker → desktop → android → browser」顺序平移
   (DB/Redis/ES/Docker 的 Go sidecar 客户端已在 Rust 侧,平移最直);
6. ⬜ excel 转发改道 + 9 插件适配(client-nav 的 Tauri 桥调用);
7. ⬜ dsh web 全工具验收(不等 Electron)。
