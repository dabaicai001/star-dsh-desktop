# browser_auto 连续执行循环 — Phase 2 立项设计

> 立项对象:Phase 1 `browser_decide`(v0.123.0 落地)之后的**连续执行层**。
> 上游依据:`docs/Jev决策模型-浏览器操作接入调研.md` §6.7(循环形态)/ §6.6.3(授权态)/ §4.1(瓶颈分析)。
> 本文只做设计与立项,不含实现;**实现开工前需先过 §7.4 实测关**(延迟 p50/p99 仍是调研报告 §10.3 #4 的未决项,循环会把它放大)。

---

## 0. 结论(TL;DR)

1. **目标**:把 Jev 的毫秒级结构化决策从「每步一问」升级为「循环内自治」——主模型一次工具往返,Rust 内部完成最多 N 步 extract → decide → 执行。这是兑现「Jev 做网页操作特别快」的唯一形态:Phase 1 每个动作仍要主模型一次完整 round-trip(调研报告 §4.1),毫秒级决策被秒级往返淹没。
2. **形态**:新工具 `browser_auto { goal, max_steps?, stop_on_lowconf?, input_text?, snapshot? }`;步数默认 8、硬上限 20;循环在 Rust 内、引擎解耦(webview / obscura 共用)。
3. **授权态(v1)**:「一次调用一次软确认,循环内步骤继承该确认」——与 `desktop_create_sandbox` / `android_connect` 的既有任务级授权同构(确认即授权本次爆炸半径)。调研报告 §6.7 的「N 分钟免重复确认」**降级为 v1.1**,原因见 §4.3。
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
| `max_steps` | int | `8` | 钳制到 `[1, 20]`(硬上限 20,超出按 20) |
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

同一 `(action, element_id)` 组合出现 **3 次**,或连续两步 snapshot 完全一致(页面无进展)→ `[STALL]` 中断。步数帽(硬上限 20)是最后防线。判定与汇总渲染抽成纯函数,单测覆盖(§7.1)。

---

## 4. 授权态与审批

### 4.1 现状事实(代码)

- approval-bridge `classifyStarHubCall`(同步纯函数):`browser_click/type/press_key/select_option/open/navigate` → 软 ask;`browser_decide` → default ALLOW;`desktop_create_sandbox` / `android_connect` → ask,且理由文本即任务级授权宣告;**箱内 / 设备内操作 → default ALLOW,由宿主在执行点强制**。
- 即仓库既有范式:**确认承载调用建立授权,细粒度操作不再逐次确认,执行点在 Rust 强制**。
- 另注:`danger-full-access` 预设下软 ask 被静默放行(调研报告 §3.4)——审批层在该预设下不是硬边界,爆炸半径控制必须靠 Rust 侧的步数帽与白名单。

### 4.2 v1 设计(推荐)

- `browser_auto` 显式登记 `STARHUB_DOMAIN_TOOLS`(**必须**,否则风险门返回 null = 完全不确认,调研报告 §6.6.1 踩过坑)+ switch case → **软 ask**,理由文本:
  「连续执行循环:确认后 AI 将在当前页面自动执行最多 N 步真实操作(每步等同于一次 browser_click/type/scroll/press_key),可能点击链接、提交表单」。
- 循环内步骤不经桥 → 不触发逐动作 ask,**继承本次调用的授权**(与 desktop 箱内操作同构)。
- 爆炸半径 = `max_steps`(默认 8,硬上限 20)次既有单步原语;动作白名单、编号纯数字校验、confidence ∈ [0,1] 全部沿用 Phase 1 现成逻辑。
- **零新增状态**:v1 不加 Rust 授权态(map / 过期时间)、不加 Tauri command、不动设置 UI。

### 4.3 为什么把「N 分钟免重复确认」降级 v1.1

调研报告 §6.7 原设计「一次确认 = 本会话 N 分钟内免重复确认」需要 approval-bridge 在读得到 Rust 授权态的前提下才 skip;而 `classifyStarHubCall` 是同步纯函数,拿不到异步状态。两条可行机制都有成本:

1. **session 事件同步**:Rust 授信时发事件,插件仿现成 `sessionPreset()`(按 seq 倒序读 `permission/preset` 事件)倒序读授权事件—— vendor 侧要改读取逻辑 + Rust 侧发事件,且事件模型属于模型可见面,改动面超出「一个新工具」;
2. **状态命令 + 设置 UI**:新增 `browser_*` Tauri command(三道同步)+ 确认卡动作按钮——多一处 ACL / 命令面 / UI 面。

v1 的「每次调用一卡」并非不可接受:auto 的定位是**一次任务一轮**,卡上文本就是授权范围;真正的频繁调用是 Phase 3 之后的事。先零状态上线,用真实使用数据(审计里 auto 调用频次)决定要不要 v1.1。

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

### 6.1 Rust(`src-tauri/`)

| 文件 | 改动 |
|---|---|
| `src/browser/mod.rs` | ① `BROWSER_TOOLS` 加 `"browser_auto"`;② `BrowserAction` 加 `Auto{…}`;③ `parse_action` 加 arm(goal 必填、max_steps 钳制、stop_on_lowconf/input_text/snapshot 校验);④ 新增循环函数(§3.1,含防震荡纯函数 + 汇总渲染纯函数);⑤ `JEV_REVOKING_TOOLS` 加 `"browser_auto"`;⑥ tests:parse 覆盖 + 防震荡/汇总单测 + 表分区测试自动纳入 |
| `src/browser/decide.rs` | 零改动(循环复用 `decide()`;`input_text` 只在调用方提供时出现,不进 Jev 请求) |
| `src/browser/webview.rs`、`obscura/mod.rs` | 零改动(复用 `execute_action`;Decide 分支已证明引擎解耦) |
| `src/harness/tools.rs` | 零改动(BROWSER_TOOLS 分发通用;`goal` 已在审计白名单) |
| `capabilities/`、`permissions/commands.toml`、`main.rs generate_handler!` | 零改动(桥工具不是 Tauri command) |

### 6.2 vendor(submodule,仅动 `packages/starhub/*`)

| 文件 | 改动 |
|---|---|
| `packages/starhub/tools/src/index.ts` | `BRIDGED_TOOLS` 浏览器段追加 `browser_auto` spec(description 写明:步数上限、确认范围、`[HANDOFF]`/`[LOWCONF]` 语义) |
| `packages/starhub/approval-bridge/src/index.ts` | `STARHUB_DOMAIN_TOOLS` 加 `'browser_auto'`(**必须**)+ switch case → 软 ask(§4.2 理由文本) |
| `packages/starhub/tools/tests/bridged-tools.spec.ts` | 零改动(机械对齐断言自动覆盖新工具) |
| `packages/starhub/approval-bridge/tests/risk-gate.spec.ts` | 补 `browser_auto` 档位断言(软 ask、reason 含步数范围) |

### 6.3 文档与版本纪律

- 升版(新功能 → **次版本**,如 `0.125.0 → 0.126.0`),七处同步:`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`CHANGELOG.md`、`AGENTS.md`(当前版本行)、`README.md`(badge + 当前版本章节整节替换)。
- `docs/技术方案.md` §6.5.1.1:Phase 2 段落从「另行立项」改为已实现描述(链路、步数上限、授权态、审批档)。
- `docs/架构图.html` AI 描述行工具数 **15 → 16**。
- submodule 流程:`packages/starhub/*` 改动在 `vendor/deepseek-harness` 内提交,回父仓库更新指针后一起 commit/push。

---

## 7. 测试计划

### 7.1 单测

| 层 | 内容 |
|---|---|
| Rust(cargo) | `parse_action`:goal 空值拒绝、max_steps 越界钳制(0 / 21 / 非数字)、stop_on_lowconf 缺省 true;防震荡纯函数(重复 3 次触发 / 2 次不触发 / snapshot 连续一致);汇总渲染(终止原因 + 截断);表分区测试自动纳入 browser_auto 位置 |
| vendor(vitest) | risk-gate:`browser_auto` 落软 ask 档、reason 文本;bridged-tools 机械对齐自动覆盖 |
| 构建 | `npm run build:window`、`npm run cargo:check` |

### 7.2 真实回归(`npm run tauri:dev`,AGENTS.md 强制)

① Jev 关闭 → auto 软错误;② 开启后「找到登录并点击」自动跑通,审计一行 + starhub.log 每步 info 行;③ LOWCONF 中断交接;④ 确认卡弹出一次、循环内多步不再弹;⑤ 元素失效(页面跳转后编号作废)中断交接;⑥ 防震荡触发(构造重复页面);⑦ `type` 无 input_text → `[HANDOFF]`,补 `input_text` 后跑通;⑧ 达到 max_steps 正常收口。

### 7.3 关账

审计面板见 `browser.action` 事件(auto 行带 goal / 步数 / 终止原因);领域事件 `starhub://domain-event` 正常。

### 7.4 实测关(开工前必须)

调研报告 §10.3 #4「延迟(单次调用 p50/p99)与价格」至今未核实(`web_search` 端点 402,标题级来源只到「毫秒级」)。**auto 把 decide 从「每步一次人工触发」变成「每步必调」,延迟与成本被循环放大**——开工前用 curl 打 50 次真实请求拿 p50/p99 与每千次价格,填回调研报告 §10.3;若 p99 × 20 步超出可接受范围,先调 `ai.jev.timeout_ms` 与步数默认值再开工。

---

## 8. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| A1 | 循环震荡(同页反复) | 空转烧额度 | 防震荡判定 + 步数帽(§3.3) |
| A2 | 无逐步人工确认,注入面放大(页面文本诱导点击) | 真实站点误操作 | 步数帽;确认卡明示范围;白名单/编号校验延续;页面文本只能影响「选哪个候选」,不能创造候选(decide.rs 安全边界) |
| A3 | 延迟/成本不达预期(循环放大) | 自动化收益归零 | §7.4 实测关;步数默认 8 可调 |
| A4 | 与 JevGate 交互出错(死锁或令牌泄漏) | auto 不可用或门失效 | 表分区单测机械钉住;循环内不过桥(§3.2) |
| A5 | 审批疲劳(每 call 一卡) | 用户体验 | v1.1 定时授权(§4.3 两机制);先用审计频次数据决策 |
| A6 | auto 中途页面跳转,元素编号失效 | 步骤失败 | 软错误中断交接(现成语义);v1.1 可加「失效重取一次」 |
| A7 | `danger-full-access` 预设下软 ask 静默放行 | 该预设下 auto 无卡 | 既有预设语义(用户已全局授信);Rust 侧步数帽是硬边界 |

**未决问题(需拍板)**:

1. 授权态是否做 v1.1 定时授权?若做,§4.3 两机制选哪个(建议:先看 v1 审计频次再定)。
2. `max_steps` 硬上限 20 是否够(长表单场景)?
3. `select_option` 两段式(v1.1)优先级。
4. §7.4 实测的执行人与时间(建议:实现开工前一周,curl 50 次即可)。

---

## 9. 路线图

- **v1(本立项)**:循环 + 防震荡 + per-call 软确认 + 能力划界(§5)+ 单测/回归。
- **v1.1(按数据启动)**:定时授权态(§4.3)、`select_option` 两段式、元素失效重取一次。
- **Phase 3(调研报告 §6.8)**:路由质量统计(decide 命中率 / LOWCONF 率 / 平均置信度 / 每任务步数分布——数据已在审计行,只需聚合);同一决策层复用至 `desktop_*` / `android_*`(换原语词表);内网自建端点(数据不出域)。
