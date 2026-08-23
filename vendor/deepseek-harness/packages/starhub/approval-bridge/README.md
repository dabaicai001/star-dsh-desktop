# @deepseek-ai/dsh-starhub-approval-bridge

StarHub 本地包(内核替换 Phase 2,不在上游;2026-08-17 由 `starhub-approval`
瘦身改名):StarHub 嵌入 AI 会话的审批桥。**策略不归本包**——审批策略统一由
dsh 权限 preset(`settings.yaml` 的 `permission.defaultPreset`,dsh web GUI
「设置 → 通用 → 权限」写入)供给,本包只消费它。

- **preset 消费**:`session/created` 时读取 `permission.defaultPreset`,把会话
  审批策略固定为 `ask`/`never`(`danger-full-access` → `never`,其余 → `ask`)。
  只填空缺:permission-presets 已按 preset 整体钉入 sandbox + approval 的会话
  不再覆写(无条件覆写会与钉入 preset 冲突,如 `workspace-write + never` 不匹配
  任何 preset,派生出不存在的 `custom` 权限状态)。
  StarHub 不再有自有命令白名单,也不维护策略表。
- **风险门(防误删核心)**:`tools/pre-execute` 上把需要人工确认的 starhub 域
  工具调用升级为 `ask`:写操作(sftp 上下传、ES 写、memory、skill_save、
  mcp_call)恒 ask;命令/SQL 按只读判定放行,风险词(移植自 StarHub
  `commandGuard.ts`)命中或不确定一律 ask;会话策略 `never` 时不拦(与 dsh
  全访问语义对齐)。注意:dsh preset 只提供策略(ask/never),不产生
  「哪些调用该问」的决定——本门是 starhub 域工具唯一的 ask 来源,
  删除它意味着 `DROP TABLE` / `rm -rf` 不再有任何确认。
- **应答桥**:`approval/request` 经 SDK stdio 双向 request
  (`starhub/approval.request`)桥回 StarHub Rust 主进程,由前端确认卡给出
  `allowed-once`/`rejected`;桥不可用 fail closed(`unavailable`)。

依赖同组合的 `sdk-jsonrpc-server` 提供的 `sdk-transport` 服务(StarHub 对
sdk/server 的本地补丁)、`user-approval` 服务与 `settings` 服务
(`dsh-settings-file` 指向与 web GUI 相同的 settings.yaml);缺失时加载即报错。

## 配置

- `answerer`(默认 `true`):是否挂载 approval 应答桥;`false` 时只留权限固定
  与风险门,应答交给组合内其它 answerer(如 dsh web 的浏览器确认框)。
- `ownsPermissionSettings`(默认 `true`):是否由本桥注册 `permission` 设置
  命名空间。内嵌 AI 内核组合(`config/starhub-agent.yml`)没有
  permission-presets,必须由本桥持有才能读到共享 settings.yaml 的
  `defaultPreset`;starhub-web 组合里 permission-presets 已是持有方(GUI
  「设置 → 通用 → 权限」的 schema/base 来源),本桥必须置 `false` 退为
  只读消费(`ctx.settings.get`),否则双注册撞上 settings 的
  duplicate-registration 硬失败,先注册的本桥胜出后 permission-presets
  静默失效,GUI 权限行读到无 `base`/无 `defaultPreset` 的裸注册报
  「permission settings has no defaultPreset value」。

## Model Experience

### Approval outcome semantics

#### What the model sees

Only approval outcomes: a rejected tool call enters the result with its deny reason. The permission policy text comes from the `user-approval` system-prompt snapshot; this package adds no model-visible text of its own.

#### Token effect

None — no message or prompt contribution.

#### KV Cache effect

Not applicable — the package never participates in model requests.

## Known Limitations and Deferred Work

- 授权一律 one-shot(`allowed-once`),没有「本次会话不再询问」记忆——dsh 的
  策略层(preset)承担持久豁免,会话级记忆授权待上游 seam。
- 风险分级只有「只读放行 / 写与风险 ask」两档;L0-L3 精细分级(影响面前置、
  二次确认、执行前备份)见 `docs/联动设计-dsh中枢-2026-08-17.md` 讨论,待立项。
