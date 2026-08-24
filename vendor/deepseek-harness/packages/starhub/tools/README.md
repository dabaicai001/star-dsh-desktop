# @deepseek-ai/dsh-starhub-tools

StarHub 本地包(内核替换 P1-4 起,Phase 2 扩展全域工具,不在上游):把 StarHub
宿主能力注册为 dsh 模型工具——全域桥接工具(ssh_*/sftp_*/db_query/redis_exec/
es_*/docker_*/excel_*/mcp_*/skill_save)+ 四个 Rust 侧全局工具
(`starhub_list_capabilities` / `starhub_list_assets` / `session_search` / `memory`)
+ 一个无 UI 资产绑定工具(`bind_asset_context`,桥 `starhub/bind.asset`,仅把当前
AI 会话绑定到资产,不打开或聚焦窗口),以及两个 UI 动作工具(`open_connection` /
`focus_terminal`,联动契约 §2.2 / M5:分别直接桥 `starhub/open.asset`(tool=auto)
与 `starhub/focus.tool`(tool=terminal),宿主 fire-and-forget 返回 `{ok:true, action}`
后文本化为「StarHub: asset X opened/focused」)。

工具不在 dsh 进程内执行;`execute` 经 SDK stdio JSON-RPC 的双向 request
(方法 `starhub/tool.execute`,参数 `{ sessionId, name, args }`,sessionId 取自
`exec.agent.session.id`,结果为模型可读文本)桥回 StarHub 主进程;主进程把域
工具分发给拥有该会话的前端面板执行(连接/凭据/工作簿都在前端),全局工具在
Rust 内直接执行(`src-tauri/src/harness/`)。

确认语义不在本包:`starhub-approval-bridge` 插件在 tools/pre-execute 按只读/风险分级
升级为 ask,经 ctx.approval 桥到前端确认卡(方案 5.2);`_confirmed` 双工具
形态随之退役(旧前端 aiTools.ts 的 ssh_exec_confirmed 等不再存在)。

依赖同组合的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 提供的 `sdk-transport` 服务
(StarHub 对 sdk/server 的本地补丁,见 `docs/AI内核替换方案-deepseek-harness.md`
附录 11.9);组合中缺失时加载即报错。

## Model Experience

### Registered model tools

#### What the model sees

All StarHub domain tools (`ssh_exec`, `sftp_*`, `db_query`, `redis_exec`, `es_*`, `docker_*`, `excel_*`, `mcp_*`, `skill_save`) plus the global tools (`starhub_list_capabilities`, `starhub_list_assets`, `session_search`, `memory`, `bind_asset_context`, `open_connection`, `focus_terminal`) are registered with host-generated Chinese descriptions; tool results are host-produced Chinese text that enters the session history.

#### Token effect

One schema per registered tool; tool descriptions and results are compact host texts bounded by the owning panel, no extra prompt injection.

#### KV Cache effect

The tool surface is static across turns; per-call results vary normally and follow ordinary per-call caching.

## Known Limitations and Deferred Work

- 全部工具注册在一个 runtime 注册表,不按会话绑定过滤工具清单;域不匹配的
  调用由宿主侧执行器报错引导(会话绑定由前端面板持有)。
- `memory` 工具的可用性由 `starhub-memory-context` 插件的 tools/pre-execute
  门禁管理:设置里没配记忆模型(provider + model)时,调用被 deny 并提示去
  设置里配置;配置后交回 approval-bridge 逐条确认。写入 user/global 的项目
  标注约定写在工具描述里(模型侧契约),不做机械校验。

