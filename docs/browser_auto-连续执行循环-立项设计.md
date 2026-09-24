# browser_auto 连续执行循环 — Phase 2 立项设计

> 立项对象:Phase 1 `browser_decide`(v0.123.0 落地)之后的**连续执行层**。
> 上游依据:`docs/Jev决策模型-浏览器操作接入调研.md` §6.7(循环形态)/ §6.6.3(授权态)/ §4.1(瓶颈分析)。
> **状态:v0.126.0 已按本文实现并发布**(Rust 循环 + approval-bridge 定时授权 + 设置页步数上限);§7.4 延迟实测(p50/p99)仍待办。

---

## 0. 结论(TL;DR)

1. **目标**:把 Jev 的毫秒级结构化决策从「每步一问」升级为「循环内自治」——主模型一次工具往返,Rust 内部完成最多 N 步 extract → decide → 执行。这是兑现「Jev 做网页操作特别快」的唯一形态:Phase 1 每个动作仍要主模型一次完整 round-trip(调研报告 §4.1),毫秒级决策被秒级往返淹没。
2. **形态**:新工具 `browser_auto { goal, max_steps?, stop_on_lowconf?, input_text?, snapshot? }`;步数默认 8,上限可配(settings `ai.jev.auto_max_steps`,默认 50、区间 1–500,设置 → AI 浏览器);循环在 Rust 内、引擎解耦(webview / obscura 共用)。
3. **授权态(已定:定时授权,会话日志派生,无状态)**:`browser_auto` 首次调用弹软确认卡;确认后 N 分钟(Config 字段 `autoGrantMinutes`,默认 10,cordis.yml 可配)内,本会话后续 `browser_auto` 不再逐一弹卡。授予不新建任何状态——直接从 session 日志的 `approval/asked` + `approval/decided` 审计对派生(与 `sessionPreset()` 读 `permission/preset` 同一模式),**零 Rust 改动、零新 Tauri command**;爆炸半径仍由 `max_steps` 帽死。机制选型见 §4.3。
4. **能力划界(由 Jev 的结构化决策本质决定,不是妥协)**:`click`/`scroll`/`press_key`/`done` 全自动;`type` 需调用方提供 `input_text`;`select_option` 及任何需要「新文本」的步骤 → 交接回主模型。Jev 不生成自由文本——这正是它快的原因(调研报告 §4.2),自动循环必须按这个边界设计。
5. **风险 TOP3**:循环震荡(防震荡判定 + 步数帽)、无逐步人工确认的爆炸半径(步数帽 + 确认卡明示范围)、延迟/成本未实测(§7.4 先实测再开工)。

---

## 1. 问题:Phase 1 为什么不够

现状链路(技术方案 §6.5.1.1 + 调研报告 §4.1):

```
主模型 → browser_extract → (模型读编号列表,自己挑 12) → browser_click
       → browser_extract → (模型挑 8) → browser_type → …
```

- 每个动作 = 主模型一次完整 round-trip:秒级延迟 + 主模型 token 成本;Jev 只替掉了其中「挑编号」的推理。
- 一个 10 步登录流 = 10 次主模型往返;Jev 决策本身毫秒级,却被 round-trip 淹没——「快」兑现不到用户眼前。
- extract 文本(最多 6000 字符,`script::DEFAULT_MAX_CHARS`)每步重复进入主模型上下文,挤占有效窗口。

Phase 2 把循环收进 **Rust 内一次工具调用**:主模型 1 次往返 → 最多 N 步自治执行 → 汇总返回。主模型只保留目标分解、异常处理、收尾三步职责。

---

## 2. 工具规格

`browser_auto`(第 16 个 `browser_*` 工具,只读观察类不变,本工具属**动作类**):

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `goal` | string | 必填 | 非空;≤500 字符(与审计白名单截断一致) |
| `max_steps` | int | `8` | 钳制到 `[1, ai.jev.auto_max_steps]`(默认 50、区间 1–500,设置 → AI 浏览器可改;超出按上限执行,汇总首行披露) |
| `stop_on_lowconf` | bool | `true` | false 时低置信度也继续执行(不推荐) |
| `input_text` | string | 无 | 循环遇到 `type` 动作时输入的内容;缺省 → 交接(§5) |
| `snapshot` | string | 无 | 首屏快照;缺省时循环内部自取(与 `browser_decide` 同语义) |

**前置条件**:`ai.jev.enabled=1`。auto 是 Jev 的循环,离不开 decide;未启用 → 软错误
`[Error] Jev 决策未启用:browser_auto 需要 Jev 决策,请在 设置 → AI 浏览器 开启`。

**返回**:汇总文本(模型可读),形如:

```
自动执行 6/8 步,终止原因:done(目标已完成)
[1] click 元素[12] <button> "登录" conf=0.87 → ok
[2] done conf=0.91
最终页面:示例站-首页 (https://example.com/)
```

**软错误目录**(全部为可读文本,不 panic、不硬失败):

| 情形 | 文本前缀 | 语义 |
|---|---|---|
| Jev 未启用 / 未配 key / 端点不通 | `[Error]` | 开门即失败(fail loud) |
| 置信度低于阈值且 `stop_on_lowconf` | `[LOWCONF]` | 中断并交接,附已执行摘要 |
| 元素失效 / 执行软错误 | `[Error]` | 中断并交接,附已执行摘要 |
| 防震荡 stall | `[STALL]` | 中断并交接(§3.3) |
| 遇到 `type` 但无 `input_text` / 遇到 `select_option` | `[HANDOFF]` | 交接回主模型(§5) |
| 达到 `max_steps` | (无前缀) | 正常收口,汇总里注明步数用尽 |

---

## 3. 循环设计(Rust 执行层)

### 3.1 主体

新增 `BrowserAction::Auto { goal, max_steps, stop_on_lowconf, input_text, snapshot }`,
在 `browser/mod.rs` 的 `execute_from_bridge` 内分支处理(与 `Decide` 同层的引擎解耦):

```text
loop step in 1..=max_steps:
    snapshot  = 当前引擎 Extract(DEFAULT_MAX_CHARS)        # 每步新鲜,编号空间对齐
    decision  = decide::decide(app, goal, snapshot)         # 复用 Phase 1 客户端
    if lowconf && stop_on_lowconf: break [LOWCONF]
    match decision.action:
        done            => break ok
        click/scroll/press_key => engine.execute_action(...)   # 单步原语,白名单不变
        type            => input_text ? engine.execute_action(...) : break [HANDOFF]
        select_option   => break [HANDOFF]                  # §5,v1 不自动
    追加本步输出;软错误 => break [Error]
    if stall(§3.3): break [STALL]
return 汇总(终止原因 + 每步一行 + 最终 url/title)
```

要点:

- **引擎解耦**:执行走 `webview::execute_action` / `obscura::execute_action`,与单步工具同一路径;无新增后端能力。
- **每步重读配置**(沿用 `decide()` 现状):循环中途用户在设置里关掉 Jev → 下一步 decide 软错误 → 循环中断交接。这是有意保留的 fail-loud 出口,不是遗漏。
- **并发**:循环整体是一次桥调用,`begin_call` 守卫(mod.rs:434)覆盖全程——期间其他 `browser_*` 调用被序列化,天然无并发打架;空闲看门狗也自然把循环视为活动。
- **审计**:`browser_` 前缀自动命中 `browser.action` + `audit_ai_tool`;`goal` 已在 `AUDIT_ARG_WHITELIST`(v0.123.0 加入)。一行审计 = 一次 auto 调用(goal / 步数 / 终止原因)。
- **可观测**:`decide()` 完成时的 `Jev 决策` info 行(action / element / confidence / elapsed_ms)天然覆盖循环内**每一步**;`starhub.log` grep「Jev 决策」可还原整条自动轨迹,与审计行双通道互证。

### 3.2 JevGate 交互(强制模式下)

- `browser_auto` 登记进 **`JEV_REVOKING_TOOLS`**(循环必然改变页面,旧决策令牌作废);
- **不进** `JEV_GATED_ACTIONS`——auto 自决策,若进门则要求「先有 decide 令牌才能 auto」= 死锁;
- 循环内 decide 直接调 `decide::decide()`,**不过桥** → 不授予也不消耗令牌,无令牌泄漏;
- 两个表的分区由现有单测(`jev_gate_tables_partition_browser_tools`)机械钉住,漏登记会红。

### 3.3 防震荡(调研报告 R7)

**同一页面、同一动作、同一元素编号的决策,与上一条完全相同** → `[STALL]` 中断
(在执行前判定)——即上一步执行没有产生任何页面变化,继续只会无限重复。该规则
两个方向都安全:翻页/滚动等「合法重复」(页面已变,三元组不同)不受影响;`type`
之后 extract 文本可能不变、但下一步决策不同(如 `press_key`)也不误伤。步数帽是
最后防线。判定(`is_repeat`)、汇总渲染(`render_summary`)、步数钳制
(`effective_cap`)均为纯函数,单测覆盖(§7.1)。

---

## 4. 授权态与审批

### 4.1 现状事实(代码,已核实)

- approval-bridge `classifyStarHubCall`(同步纯函数):`browser_click/type/press_key/select_option/open/navigate` → 软 ask;`browser_decide` → default ALLOW;`desktop_create_sandbox` / `android_connect` → ask,且理由文本即任务级授权宣告;**箱内 / 设备内操作 → default ALLOW,由宿主在执行点强制**(Rust 侧 `authz: HashMap<session_id, {sandbox_id|serial, expires_at}>`,TTL 60 分钟,`require_authz` 三连校验:无授权 / 过期 / 目标不匹配)。
- **审批结局在会话日志里(本立项选型依据)**:`approval/asked`(`{id, toolName, callId?, reason?}`)与 `approval/decided`(`{id, outcome}`)是 `user-approval` 的 `ApprovalService.request()` 自己 append 的审计对,**与 answerer 配置无关**——starhub-web 组合里 approval-bridge 是 `answerer: false`(应答交 web 自己的确认框),插件的 `approval/request` 处理器根本不注册,但审计对照样落日志。插件用现成的 `session.eventAt()` 倒序扫描即可读到(与 `sessionPreset()` 读 `permission/preset`、`overrideOf()` 读 `approval/policy` 同一模式)。`'allowed-once'` 是唯一的授予结局。
- 另注:`danger-full-access` 预设下软 ask 被静默放行(approval-bridge L459)——审批层在该预设下不是硬边界,爆炸半径控制必须靠 Rust 侧的步数帽与白名单。

### 4.2 设计:定时授权(会话日志派生,无状态)

- `browser_auto` 显式登记 `STARHUB_DOMAIN_TOOLS`(**必须**,否则风险门返回 null = 完全不确认,调研报告 §6.6.1 踩过坑)+ switch case → **软 ask**,理由文本:
  「连续执行循环:确认后 AI 将在当前页面自动执行最多 N 步真实操作(每步等同于一次 browser_click/type/scroll/press_key),可能点击链接、提交表单;确认后 N 分钟内本会话的后续 browser_auto 不再逐一确认」。
- **授予判定(日志派生)**:pre-execute 门对 `browser_auto` 分类出 ask 后,倒序扫描本会话日志:
  1. 找**最近一条** `approval/asked` 且 `toolName === 'browser_auto'`(取它的 `id` 与事件头 `time`);
  2. 倒序途中已记录的 `approval/decided`(按 `id` 配对;decided 必随 asked 之后,倒序时先遇到)取 `outcome`;
  3. `outcome === 'allowed-once'` 且 `now - time ≤ autoGrantMinutes × 60_000` → **不当 ask,直接放行**;其余(没有 / 被拒 / 取消 / unavailable / 超时)→ 照弹。
- **TTL**:Config 字段 `autoGrantMinutes`(默认 10,cordis.yml 可配;desktop/android 任务级授权为 60 分钟先例——浏览器操作打到外部站点、效应更外溢,默认取更短的 10 分钟)。TTL 从 `approval/asked` 的事件时间起算(与 decided 只差用户点那几下)。
- **范围**:会话级。浏览器窗口与应用 1:1(`ai-browser` 单 label / obscura 单引擎),无需更细粒度;授予只抑制卡片,**不扩大单次爆炸半径**(仍由 `max_steps` 帽死)。
- **循环内步骤**:不经桥 → 不触发逐动作 ask,继承本次调用的授权(与 desktop 箱内操作同构);任何预设下都成立,与授予判定无关。
- **无状态**:不建 map、不过期清理、不管生命周期——授予判定每次从日志现算,天然可重放、可审计;会话从日志恢复后判定一致。
- **零 Rust 改动、零新 Tauri command、零设置 UI**(TTL 暴露到「AI 浏览器」tab 是抛光项,见 §9)。

### 4.3 机制选型:为什么是日志派生

候选三条(结论已定,留档备查):

| 机制 | 成本 | 结论 |
|---|---|---|
| **会话日志派生**(选定) | approval-bridge 内一个倒序扫描纯函数 + Config 字段 + 单测;零 Rust、零命令、零新事件类型 | **采用**:审计对本来就落在日志里,插件是现成读者(`sessionPreset` 先例);无状态、可重放 |
| 插件内 map + `approval/request` 观察结局 | 要 map 与生命周期管理;且 starhub-web 是 `answerer: false`,该组合里处理器不注册 → 直接失效 | 否:在主力组合里不成立 |
| Rust 侧 authz + 状态命令 + 确认卡按钮 | 新 Tauri command(三道同步)+ capabilities/ACL + client-nav UI | 否:命令面 / UI 面成本最高,且对「抑制卡片」没有额外约束力 |

判定要点:授予判定唯一职责是「本会话 N 分钟内别再问」——这是**审批层的 UX 状态**,不是安全边界(安全边界是白名单 / 编号校验 / 步数帽 / 审批层本身,§4.1 末)。UX 状态放在产生 ask 的插件里、从既有审计日志派生,是所有权与成本的最小解。

---

## 5. 能力划界:Jev 不生成自由文本

Jev 的输出是被 `criteria` 钉死的封闭集选择(调研报告 §4.2)——这是它快的根本原因,也决定它**不能产出任何新文本**。自动循环按此划界:

| 步骤 | v1 行为 | 理由 |
|---|---|---|
| `click` / `scroll` / `press_key` / `done` | 全自动 | 选择即执行,无新文本 |
| `type` | 有 `input_text` 才自动;否则 `[HANDOFF]` 中断,摘要里带元素编号,主模型接着调 `browser_type` | 输入内容是「新文本」,Jev 产不出,调用方提供 |
| `select_option` | v1 一律 `[HANDOFF]` 交还主模型 | 选项值同属新文本;且选项集依赖先选中的元素,Jev 的 choice 问题是独立作答的 |
| 验证码 / 登录策略 / 目标分解 / 错误恢复 | 不碰,主模型职责 | 调研报告 §4.3 原判 |

`select_option` 的 v1.1 增强(两段式:选定元素后,以该元素可见选项为 criteria 再 decide 一次)已预登记进路线图(§9),但不阻塞 v1。

---

## 6. 改动清单(文件级)

### 6.1 Rust(`src-tauri/`,v0.126.0 已按此落地)

| 文件 | 改动 |
|---|---|
| `src/browser/auto.rs` | **新增**:循环主体 `run()` + 防震荡(`is_repeat`)/ 汇总渲染(`render_summary`)/ 步数钳制(`effective_cap`)/ `parse_max_steps` 纯函数 + 8 个单测 |
| `src/browser/decide.rs` | `JevConfig` 增 `auto_max_steps`(settings `ai.jev.auto_max_steps`,默认 50、区间 1–500;`validate`/`save`/`jev_config` 同步,2 个新单测);`decide()` 重构出 `decide_struct()`(结构化决策,循环与单步共用;成功落 `Jev 决策` info 行);`snapshot_url_title` 升为 `pub(crate)` 供汇总复用 |
| `src/browser/mod.rs` | ① `BROWSER_TOOLS` 加 `"browser_auto"`;② `BrowserAction` 加 `Auto{…}`;③ `parse_action` 加 arm(goal 必填;max_steps 非法/缺省回落 8;stop_on_lowconf 缺省 true;input_text/snapshot 空串等同缺省);④ `execute_from_bridge` 加 Auto 分支(引擎分发前、Decide 分支之后);⑤ `JEV_REVOKING_TOOLS` 加 `"browser_auto"`;⑥ tests:parse 覆盖(缺省/全量/非法/空串)+ 表分区测试自动纳入 |
| `src/browser/webview.rs`、`obscura/mod.rs` | `Decide` 的 unreachable 分支扩为 `Decide`/`Auto` 并列(循环与 Decide 都不过后端执行层) |
| `src/commands/browser.rs` | `browser_set_jev_config` 增 `auto_max_steps` 参数(桥命令签名与前端同步) |
| `src/harness/tools.rs` | 零改动(BROWSER_TOOLS 分发通用;`goal` 已在审计白名单) |
| `capabilities/`、`permissions/commands.toml`、`main.rs generate_handler!` | 零改动(桥工具不是 Tauri command;Jev 配置命令 0.123.0 已注册) |

### 6.2 vendor(本检出中 `vendor/deepseek-harness` 为普通目录,一次提交覆盖)

| 文件 | 改动 |
|---|---|
| `packages/starhub/tools/src/index.ts` | `BRIDGED_TOOLS` 浏览器段追加 `browser_auto` spec(description 写明:步数上限、确认范围、`[HANDOFF]`/`[LOWCONF]`/`[STALL]` 语义) |
| `packages/starhub/approval-bridge/src/index.ts` | `STARHUB_DOMAIN_TOOLS` 加 `'browser_auto'`(**必须**)+ switch case → 软 ask(§4.2 理由文本);**定时授权**:pre-execute 门内对 browser_auto 先做日志派生判定(§4.2),Config 增字段 `autoGrantMinutes`(schemastery 默认 10),新增导出纯函数 `autoGrantActive()`(JSDoc 齐全);包 README 与模块头同批更新(vendor 纪律) |
| `packages/starhub/tools/tests/bridged-tools.spec.ts` | `RUST_BROWSER_TOOLS` 钉名单追加 `'browser_auto'`(顺序对齐 Rust `BROWSER_TOOLS`) |
| `packages/starhub/approval-bridge/tests/risk-gate.spec.ts` | 补 `browser_auto` 档位断言(软 ask、reason 含循环范围)+ 域工具识别名单;新增 9 个真实 `Session` 驱动的授予判定用例(TTL 边界、各结局、未决、最近一次说了算、跨工具隔离、空会话) |
| `packages/starhub/client-nav/src/client/settings/browser.tsx` | Jev 配置区增「自动执行步数上限(1–500)」数字输入;`JevConfig` 类型 / `JEV_DEFAULT` / `sameJev` / 保存载荷同步 `autoMaxSteps` |
| `packages/starhub/client-nav/tests/browser-settings.client.spec.tsx` | 夹具与保存断言补 `autoMaxSteps`(加载回填 120 / 保存默认 50) |

### 6.3 文档与版本纪律(已执行)

- 已升版 `0.125.0 → 0.126.0`(新功能 → 次版本),七处同步:`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`CHANGELOG.md`、`AGENTS.md`(当前版本行)、`README.md`(badge + 当前版本章节整节替换)。
- `docs/技术方案.md` §6.5.1.2 新增「browser_auto 连续执行循环」小节;工具清单 15 → 16。
- `docs/架构图.html` AI 描述行工具数 **15 → 16**。

---

## 7. 测试

### 7.1 单测(v0.126.0 已执行,全绿)

| 层 | 内容 | 结果 |
|---|---|---|
| Rust(cargo) | `parse_action`:goal 空值拒绝、缺省值(max_steps=8 / stop_on_lowconf=true)、全量参数、非法 max_steps 回落、空串可选参数等同缺省;防震荡(`is_repeat`:首条/同三元组/异动作/异页面);汇总渲染(done/LOWCONF/HANDOFF/STALL + 截断 + 多字节安全);步数钳制(`effective_cap` 六边界);`auto_max_steps` 默认/校验/区间;表分区测试自动纳入 browser_auto 位置 | `browser::` 46 通过;全量 `cargo test` 230 通过 |
| vendor(vitest) | risk-gate:`browser_auto` 软 ask 档 + reason + 域工具识别;授予判定 9 例(真实 Session + 真实审批审计事件:TTL 边界、rejected/cancelled/unavailable、未决、最近一次说了算、跨工具隔离、空会话);bridged-tools 机械对齐;browser-settings 夹具与保存断言 | 3 个套件 44 通过 |
| vendor(真实组合) | 审批行为属产品可见变更,按 vendor 测试政策需 Loader 启动的真实组合测试;starhub 包内暂无该基建(现行为真实 Session 驱动的 fixture 测试),已登记 approval-bridge README「Known Limitations and Deferred Work」待补 | 待补(不阻塞:v1 已交付) |
| 构建 | vendor `pnpm run typecheck`(host + client 双面)、`pnpm exec tsx scripts/run-oxlint.ts`(改动文件零新增违规,仅存量) | 通过 |

### 7.2 真实回归(`npm run tauri:dev`,待手工)

① Jev 关闭 → auto 软错误;② 开启后「找到登录并点击」自动跑通,审计一行 + starhub.log 每步 info 行;③ LOWCONF 中断交接;④ 首次 auto 弹一次卡;TTL 内第二次 auto 不弹卡;把 `autoGrantMinutes` 调小后恢复弹卡;⑤ 元素失效(页面跳转后编号作废)中断交接;⑥ 防震荡触发(构造重复页面);⑦ `type` 无 input_text → `[HANDOFF]`,补 `input_text` 后跑通;⑧ 达到 max_steps 正常收口;⑨ 设置页改「自动执行步数上限」后,模型传更大 max_steps 按新上限执行。

### 7.3 关账

审计面板见 `browser.action` 事件(auto 行带 goal / 步数 / 终止原因);领域事件 `starhub://domain-event` 正常。

### 7.4 实测关(仍待办)

调研报告 §10.3 #4「延迟(单次调用 p50/p99)与价格」至今未核实(`web_search` 端点 402,标题级来源只到「毫秒级」)。**auto 把 decide 从「每步一次人工触发」变成「每步必调」,延迟与成本被循环放大**——用 curl 打 50 次真实请求拿 p50/p99 与每千次价格,填回调研报告 §10.3;若 p99 × 步数上限超出可接受范围,先调 `ai.jev.timeout_ms` 与步数默认值。

---

## 8. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| A1 | 循环震荡(同页反复) | 空转烧额度 | 防震荡判定 + 步数帽(§3.3) |
| A2 | 无逐步人工确认,注入面放大(页面文本诱导点击) | 真实站点误操作 | 步数帽;确认卡明示范围;白名单/编号校验延续;页面文本只能影响「选哪个候选」,不能创造候选(decide.rs 安全边界) |
| A3 | 延迟/成本不达预期(循环放大) | 自动化收益归零 | §7.4 实测关;步数默认 8 可调 |
| A4 | 与 JevGate 交互出错(死锁或令牌泄漏) | auto 不可用或门失效 | 表分区单测机械钉住;循环内不过桥(§3.2) |
| A5 | 审批疲劳 | 用户体验 | 定时授权(§4.2):TTL 默认 10 分钟、可配;按审计频次调 TTL |
| A8 | 授权期内模型反复 auto | 额度 / 外部站点负担 | TTL 短 + 步数帽;授予只抑卡、不扩半径;审计频次可观察 |
| A6 | auto 中途页面跳转,元素编号失效 | 步骤失败 | 软错误中断交接(现成语义);v1.1 可加「失效重取一次」 |
| A7 | `danger-full-access` 预设下软 ask 静默放行 | 该预设下 auto 无卡 | 既有预设语义(用户已全局授信);Rust 侧步数帽是硬边界 |

**未决问题(需拍板)**:

1. `select_option` 两段式优先级。
2. §7.4 实测的执行人与时间(建议:实现开工前一周,curl 50 次即可)。

已定(用户拍板):授权态采用定时授权——机制为**会话日志派生**(§4.2 / §4.3),无状态、零 Rust 面;`max_steps` 上限支持自定义(settings `ai.jev.auto_max_steps`,默认 50、区间 1–500,设置 → AI 浏览器)。

---

## 9. 路线图

- **v1(本立项,v0.126.0 已实现)**:循环 + 防震荡 + 能力划界(§5)+ 定时授权(§4.2)+ 步数上限可配 + 单测/回归。
- **v1.1(按数据启动)**:`select_option` 两段式、元素失效重取一次、TTL 暴露到「AI 浏览器」设置 tab。
- **Phase 3(调研报告 §6.8)**:路由质量统计(decide 命中率 / LOWCONF 率 / 平均置信度 / 每任务步数分布——数据已在审计行,只需聚合);同一决策层复用至 `desktop_*` / `android_*`(换原语词表);内网自建端点(数据不出域)。
