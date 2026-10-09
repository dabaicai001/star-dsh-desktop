# 去 Tauri 化 M2:工作台命令面 → sidecar UI 方法面映射清单

> 配套 `docs/StarHub去Tauri化-迁移立项设计.md` §八 M2「壳切换前夜」与
> `docs/去Tauri化-M1-命令映射清单.md`(M1 已完成:模型面工具 86 个 + 桥命令 4 个)。
> M2 目标:**9 插件适配 + 工作台 iframe 搬入 → dsh desktop dev 壳内全功能可用
> (窗口类除外)**。

## 一、形态确认(先钉死,别再问)

StarHub **不是新桌面项目**,是上游 DSH Electron 桌面壳的**外部插件集**:

| 资产 | 归属 | 落地方式 |
|---|---|---|
| `vendor/deepseek-harness/apps/desktop`(`@deepseek-ai/dsh-desktop`) | 上游 Electron 壳(「for a bundled dsh runtime and **external plugins**」) | 原样用,零改动 |
| `apps/desktop-host`(`@deepseek-ai/dsh-desktop-host`) | 上游私有 Node 宿主进程 | 由 Electron spawn,跑 `desktop` profile,把 web app URL 回给壳 |
| `packages/starhub/*`(9 插件 + bridge) | **StarHub 插件** | 写进 project 的 `dsh.profile.bundles` / `cordis.patch.yml` insert 行,由 desktop-host 的 Loader 加载 |
| `dist-starhub-react/`(React 工作台) | **StarHub 前端资产** | `starhub-host-static` 以 `/starhub-react/` 前缀托管;壳内同源 iframe |
| `starhub-sidecar-rust` / `starhub-sidecar-go` | **StarHub 子进程** | bridge 插件 spawn,路径经 bridge 的 `sidecarCommand` Config 注入 |
| `src-tauri/`(Tauri 壳) | 退役中 | M4 删除;`apps/starhub-window` 只是工作台的 Vite 构建入口,不是 App |

结论:桌面端只有一个 Electron 壳(上游的),StarHub 的全部能力以「插件 + sidecar
子进程 + 静态资产」三件套进入。**不做自己的桌面项目、不加第二个 Electron 壳、
不留 Tauri 混合态。**

## 二、两个方法面(命名即边界)

M1 建立了**模型面**(方法名 = 模型工具名,结果 `{text}`)。M2 需要第二个面——
**UI 面**:React 工作台的前端命令,与模型工具同名不同参(最典型:
`sftp_list` 工具吃 `(assetId, path)`,工作台命令吃 `(id=sessionId, path)`),
必须分开注册:

| 面 | 命名 | 对端 | 结果 |
|---|---|---|---|
| 模型面(已有) | `ssh_exec` / `db_query` / … | 模型(经 `starhub/tool.execute`) | `{ text }` |
| UI 面(M2 新增) | `ui.<tauriCommand>` | 工作台(经 `POST /starhub/api/invoke`) | 命令原样返回值 |

`ui.` 前缀由 bridge 的 invoke 端点统一加(cmd → `ui.<cmd>`),因此:

- 工作台 113 个调用点**一字不改**(`tauriInvoke('get_assets')` → 同名单号
  `ui.get_assets`);
- 两个面不可能互相踩(`ui.sftp_list` vs `sftp_list`);
- bridge 无需逐命令映射表,不存在漂移。

## 三、工作台命令清单(113 个,实测枚举)

按「谁来实现」分四组。**A 组已可用**,B/C 组是 M2 主体,D 组走 dsh 宿主能力。

| 组 | 命令 | 落点 | 状态 |
|---|---|---|---|
| A. sidecar 已有存储/会话,加 `ui.*` 包装即可 | `get_assets` / `create_asset` / `update_asset` / `delete_asset` | sidecar `AssetStore`(assets.json + 密钥存储) | ✅ 本批落地 |
| B. 交互会话面(工作台持有 connId/sessionId) | `ssh_connect` / `ssh_write` / `ssh_write_binary` / `ssh_resize` / `ssh_disconnect` / `ssh_get_sessions` / `ssh_get_trusted_host_key` / `ssh_kb_response` / `ssh_hostkey_response` / `ssh_bastion_response` / `ssh_open_web_window` / `test_ssh_connection`;`sftp_ensure_session` / `sftp_home_dir` / `sftp_list` / `sftp_stat` / `sftp_mkdir` / `sftp_remove` / `sftp_rename` / `sftp_start_upload` / `sftp_start_download` / `sftp_pause_transfer` / `sftp_resume_transfer` / `sftp_cancel_transfer` / `sftp_retry_transfer` / `sftp_set_speed_limit` / `sftp_clear_transfers` / `sftp_list_transfers` / `sftp_reveal_local` | sidecar `SshManager` + `TransferManager`(会话实体已在 sidecar 手里) | ⬜ M2 第二步 |
| C. 数据面连接(connId 生命周期) | `db_mysql_execute` / `db_mysql_list_columns` / `db_redis_*`(13)/ `db_es_*`(9)/ `docker_connect` / `docker_test` / `docker_disconnect` / `docker_list_containers` / `docker_list_images` / `docker_inspect_container` / `docker_container_logs` / `docker_container_stats` / `docker_start|stop|restart|remove_container` / `docker_pull_image` / `docker_remove_image` / `docker_prune_images` / `docker_exec*`(5)/ `broker_test` / `broker_overview` / `db_mysql_export_data` 等 | sidecar 的 Go sidecar 客户端(连接池在 Go 侧,connId 已是跨进程概念) | ⬜ M2 第三步 |
| D. 设置/审计/告警/本机/对话框 | `audit_list` / `audit_clear` / `audit_stats` / `alert_*`(5)/ `android_ui_*`(4)/ `desktop_ui_*`(7)/ `desktop_user_action_reply` / `browser_get_engine` / `browser_set_engine` / `browser_get_jev_config` / `browser_set_jev_config` / `get_ai_model_api_key` / `set_ai_model_api_key` / `delete_ai_model_api_key` / `local_shell_exec` / `screenshot_begin_region` / `get_ai_model_api_key` | 设置/审计/告警走 sidecar 自有 JSON 存储(与资产同套路);`local_shell_exec` 与 `screenshot_*` 是**宿主持有能力**,在 dsh 桌面端应由上游 shell/fs 工具或 M3 帧服务承担,不做 sidecar 平移 | ⬜ M2 第四步(D 组其余) |

事件面(工作台 `tauriListen` 的 14 个名字)已由 M1 的通知出口覆盖:
`ssh:data:<id>` / `ssh:close:<id>` / `ssh:exec-done` / `ssh:kb-interactive*` /
`ssh:bastion-*` / `ssh:hostkey-confirm:<id>` / `ssh:mfa-connected:<id>` /
`sftp://transfer-status` / `sftp://transfer-progress` / `starhub://open-asset` /
`starhub://ask-ai` / `starhub://desktop-user-action` / `screenshot:result` /
`tauri://drag-*`。sidecar 的 `starhub/domain-event` 通知内层 `event` 名与之上
一致,bridge 的 SSE 流原样透传(见 M1 `workbench.ts`)。

`plugin:*`(dialog/app/updater/process,6 个)在 dsh 桌面端**不应**由 StarHub 实现:
文件对话框走上游 `dsh-host-directory-picker-auto` / file-upload,版本与自更新归
Electron 壳。工作台侧改为「调 bridge 的 `ui.*` 占位 → 由 dsh GUI 原生面承接」
(M3),M2 先降级为明确的不可用提示。

## 四、M2 施工顺序

1. ✅ **形态确认 + 清单**(本文档):113 命令枚举、两面命名、四组归口。
2. ✅ **A 组 + 传输 seam(已完成)**:
   - sidecar `ui.get_assets` / `ui.create_asset` / `ui.update_asset` /
     `ui.delete_asset` 落地(`AssetStore` 补 `upsert` / `remove`,元数据字段
     group/tags/favorite/时间戳随行读写;文件格式仍 camelCase,UI 线形状
     snake_case 与工作台 `RustAsset` 逐字对齐);方法面 89 → **93**。
   - bridge 的 invoke 端点把 `cmd` 加成 `ui.<cmd>` 前缀(两面不撞名)。
   - **传输 seam 合入**:`client-nav/src/client/tauri.ts` 重写为宿主桥——
     `tauriInvoke` 走 `POST /starhub/api/invoke`(`{ok:false,error}` → reject),
     `tauriListen` 走共享 `EventSource('/starhub/api/events')`(按事件名扇出,
     dispose 移除 handler);导出名/签名不变,**113 个调用点零改动**。
     5 处调用点的 `__TAURI_INTERNALS__` 判定换成 `isTauriRuntime()`(store /
     NewConnectionDialog / AndroidPanel)+ `fileSrc` 改为同源 URL + 自更新交
     Electron 壳(checkForUpdates 恒无更新)。
   - 测试替身 `tests/host-bridge.ts`(`stubHostBridge` / `stubHostEvents` /
     `emitHostEvent` / `hostBridgeCalls` / `hostEventListeners`),**38 个 spec**
     从 `__TAURI_INTERNALS__` 存根整体迁到 fetch/SSE 替身;`tauri.client.spec.ts`
     整文件重写(14 例)。验收:tsc 零错误,**54 spec / 907 例全绿**
     (较迁移前 912 少 5 例:自更新命令序断言随「更新归 Electron 壳」设计移除)。
   - 迁移中修掉一个真 bug:jsdom 下 `window === globalThis`,助手「先写
     globalThis.fetch 再从 window.fetch 取原值」会把替身存成还原值,导致
     restore 不卸载、后续用例拿到 404——改为先取原值再写入。
3. ⬜ **B 组交互会话**:sidecar 加 `ui.ssh_*` / `ui.sftp_*`(会话实体已在
   sidecar;补 connId ↔ 会话映射 + 写通道 + `ssh:data` 事件出口)。
4. ⬜ **C 组数据面连接**:`ui.db_*` / `ui.docker_*` / `ui.broker_*` 经 Go sidecar。
5. ⬜ **D 组其余**:设置/审计/告警的 sidecar JSON 存储;`plugin:*` 交 dsh GUI。
6. ⬜ **iframe 搬入**:工作台从「新开独立窗口/tab」改为壳内面板(client-nav 的
   `openNewPage` → 面板槽位;`starhub://open-asset` 的 focus 语义随面板重写)。
7. ⬜ **验收**:dsh desktop dev 壳内全功能可用(窗口类除外)。

## 五、验收口径

- 每个 `ui.*` 方法一个 roundtrip 契约测试(与 M1 的 `protocol.rs` 同纪律):
  参数白名单、错误码、**模型/用户可读文本逐字保持**(Tauri 版文案是契约)。
- `npm run verify:bridge-compat` 扩到 UI 面:经 `POST /starhub/api/invoke`
  打真二进制,断言资产 CRUD 往返。
- client-nav vitest 全绿(传输 seam 替身的单测替代 `__TAURI_INTERNALS__` 存根)。
