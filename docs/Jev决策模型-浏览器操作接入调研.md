# Jev 决策模型接入 StarHub「AI 浏览器」— 调研报告与落地方案

> 调研对象:① Jev 决策模型(TypeSafe AI);② StarHub 现有浏览器操作功能(`browser_*` 14 工具)。
> 交付物:现状事实 + Jev 能力核实 + 接入点对比 + 推荐架构 + 文件级改动清单 + 风险清单。
> **调研受限说明(必读)**:本报告写作期间 `web_search` 端点返回 `HTTP 402 Insufficient Balance`,Jev 的字段级 API 细节无法进一步核实。凡未能核实处均标注【未核实】,并汇总为 §10.3 实测清单——**在看到这些数字之前不要拍板实现细节,但架构方案(§6)对 API 细节不敏感**。
> 代码调研方式:两个并行子代理分别读完 Rust 侧(`src-tauri/src/browser/**`、`src-tauri/src/harness/**`)与 vendor 侧(`vendor/deepseek-harness/packages/starhub/**`)全部相关文件,行号结论见附录 B。

---

## 0. 落地回执(v0.123.0,Phase 1 已实现)

本报告的推荐架构(§6 方案 A)已按 Phase 1 落地,实现期间从 TypeSafe 官方接口定义补齐了写作时【未核实】的字段级细节,**§2.5 / §10.3 中对应条目标记为「已核实」**:

- **端点**:`POST {base_url}/v1/systemone`(`Authorization: Bearer <key>`)。与 OpenAI Chat Completions **不是同一路径**,不能套会自动追加 `/chat/completions` 的客户端/base_url——这正是实现里用裸 HTTP(reqwest)而不用任何 SDK 的原因。
- **请求**:`{ model, state, questions }`;每个 question 是 `{ type: "choice"|"noul"|"score", instructions, criteria }`,`criteria` 是「候选键 → 说明」的封闭集。
- **应答**:`{ model, answers, usage:{ input_tokens, output_tokens } }`;choice 答案 = `{ type, choice, probabilities:{…}, confidence }`,noul 答案 = `{ type, noul: 0..1 }`,score 答案 = `{ type, score, legend, probabilities, confidence }`。
- 浏览器决策用两个 choice 问题:`action`(六原语白名单)+ `element`(criteria = extract 编号元素)。置信度阈值路由按 §6.5 实现(`[LOWCONF]` 前缀)。
- 实现与验证细节见 `CHANGELOG.md` v0.123.0、`docs/技术方案.md` §6.5.1.1、`src-tauri/src/browser/decide.rs`。

**仍未核实**(影响 Phase 2/3,不影响 Phase 1):延迟/价格量级、限流、低置信度的服务端确切行为、权重许可与本地部署可行性(APUS 复现性质)。

---

## 1. 结论(TL;DR)

1. **Jev 是 TypeSafe AI 的"System One"决策模型:只输出判断、不对话,结构化决策 + 置信度,主打低延迟、低成本**(标题级事实,来源见 §2 与附录 A)。它和 StarHub 浏览器操作里最高频的一步——「从页面元素列表里挑下一个动作」——是同一类问题。
2. **StarHub 浏览器链路现状**:DSH 主模型 →(DSH agent loop)→ `browser_*` 工具 → SDK stdio JSON-RPC → Rust `execute_from_bridge` → webview / obscura 双后端执行。**每一步动作都要主模型一次完整 round-trip**;执行层只有单步原语,**没有"决策层",也没有"连续执行层"**(两后端均无动作队列)。
3. **推荐方案(§6):新增第 15 个工具 `browser_decide`**——把「目标 + 页面快照」发给 Jev,拿回「click 元素[12] / type / scroll / done + 置信度」的结构化决策,交还模型执行。价值:高频、封闭集、低风险的"选元素"决策卸载到毫秒级、便宜的 Jev,**主模型只做目标分解与异常处理**。配置零新增 Tauri command(复用 keyring `model:<id>` + settings 表)。
4. **审批安全边界必须显式登记**:新 `browser_` 工具不进 `approval-bridge` 的 `STARHUB_DOMAIN_TOOLS` 会让风险门返回 null(完全无确认);`browser_decide` 为只读决策,落 default ALLOW 档,但 Phase 2 的自动执行版 `browser_auto` 必须进软/硬确认档。
5. **数据外发是最大合规风险**:Jev 是外部 SaaS,而 `docs/技术方案.md:1021` 明确「私有部署:LLM API 不允许外发(企业版)」。因此**功能默认关闭**,且页面快照会发给第三方这一点必须在设置 UI 明示。
6. **落地成本**(MVP):Rust 改 3 个文件 + 新增 1 个文件;vendor 改 2 个文件;文档/升版按仓库七处纪律。**无新 Tauri command,不动 capabilities/ACL**。

---

## 2. Jev 是什么(调研结论)

### 2.1 定位(标题级事实,来源见附录 A)

| 事实 | 来源 |
|---|---|
| Jev 是 TypeSafe AI 的模型,社区仓库称其为 "System One model for typed decisions"(为**带类型的决策**而生的"系统一"模型) | [GitHub: everything-about-jev](https://github.com/qingshungLI/everything-about-jev) |
| 「不会说话」:**只下判断,不做对话**;36氪/腾讯新闻均以"不说话"概括,阿里云研讨会标题「只下判断不说话,低延时才是被低估的变量」 | [36氪](https://eu.36kr.com/zh/p/3988164509711361)、[腾讯新闻](https://news.qq.com/rain/a/20260918A058BW00)、[阿里云开发者社区](https://developer.aliyun.com/article/1765496) |
| 参与者背景:前 OpenAI 研究员 / ChatGPT 早期研究者,官网解释涉及 Diogo | [腾讯新闻](https://news.qq.com/rain/a/20260918A058BW00)、[搜狐](https://www.sohu.com/a/1079280701_100106801) |
| 卖点:更快、更便宜的 LLM 替代;**结构化决策** | [TechTarget](https://www.techtarget.com/it-infrastructure/news/366650696/Jev-decision-model-touted-as-quicker-cheaper-LLM-alternative)、[Spring 官方博客 2026-09-21](https://spring.io/blog/2026/09/21/spring-ai-typesafe-structured-judgment) |
| 热度:被韩媒称为"史上用户量增长最快的付费模型";官方"今天向所有人开放,送 1.2 亿 token" | [ZDNet Korea](https://zdnet.co.kr/view/?no=20260920215302)、[今日头条](https://www.toutiao.com/article/7687890766747681321/) |

### 2.2 接入渠道(标题级事实)

- **官方 API**:申请 API Key 即可调用(七牛云指南标题:「从申请 API Key 到置信度路由,把 TypeSafe 决策模型接进自己的代码」)。
- **网关托管**:AI/ML API 有 `decision-models/typesafe/jev` 文档页;OpenRouter 有社区指南页(`openrouter.ai/docs/guides/community/jev`)。
- **框架集成**:Spring AI 官方博客给出集成方式("Fast, Cheap, Structured Decisions")。
- **开源复现**:APUS 公布「全球首批跨平台开源复现」(央广网、新华网、科技日报均有报道),国内厂商跟进复现→未来有私有部署/内网可能。

### 2.3 置信度路由(标题级事实 + 推断)

七牛云指南把「置信度路由」列为接入后的核心玩法;结合多方标题,可合理推断其生态用法为:**Jev 返回带置信度的决策,低置信度时升级给更强的模型(或人工)**。这正是浏览器操作需要的形态(§4)。确切行为(升级/反问/回退默认动作)【未核实】,需 §10.3 实测。

### 2.4 争议(标题级事实)

- 「刷屏爆火的"不说话"AI Jev 真的是 AI 新范式吗?」(36氪)、「Jev 真是新范式吗?」(腾讯)——社区存在"这是不是新范式"的质疑。
- 「Jev 是分类器吗?」(今日头条)——有观点认为它本质是分类器/结构化判别器。
- **对本方案的影响**:即便 Jev 只是"更快的分类器",在"从 N 个编号元素里选一个"这个封闭集判别任务上恰恰完全够用;不追求让它承担开放推理。

### 2.5 未能核实清单(实现前必须实测,§10.3 展开)

输入是否支持「结构化上下文(元素列表)+ 候选动作集」、输出字段(data/confidence 的确切名字)、延迟与价格量级、限流、权重许可与本地部署、是否有官方 UI/浏览器自动化用例。

> **回填(v0.123.0)**:输入/输出 schema、置信度路由的最小形态已由 TypeSafe 官方接口定义核实(见 §0);延迟/价格/限流/权重许可仍未核实。

---

## 3. StarHub「操作浏览器」功能现状(代码事实)

### 3.1 端到端链路(现状全景)

```
DSH 主壳(模型 agent loop)
  └─ 工具 browser_*  ← packages/starhub/tools/src/index.ts BRIDGED_TOOLS(L342-434,14 个)
       └─ callHost() → sdk-transport JSON-RPC "starhub/tool.execute" (经 stdio)
            └─ Rust HarnessRuntime::dispatch_frame / web.rs read loop
                 └─ handle_inbound_request (harness/mod.rs:920)
                      └─ tools::execute_bridge_request (harness/tools.rs:128)
                           ├─ audit_ai_tool 落审计(任何工具都记,category="ai")
                           └─ dispatch_tool (tools.rs:165)
                                └─ BROWSER_TOOLS.contains(name) (tools.rs:193)
                                     └─ browser::execute_from_bridge (browser/mod.rs:273)
                                          ├─ parse_action (mod.rs:158) → BrowserAction 枚举
                                          ├─ engine_setting (settings 表 browser.engine)
                                          └─ webview::execute_action (webview.rs:187)
                                             obscura::execute_action (obscura/mod.rs:376)
```

关键事实:
- **不是 Tauri invoke 转发**,是 DSH 进程内经 SDK stdio JSON-RPC 双向 request 回 Rust 主进程;新增 `browser_*` 工具时 `harness/tools.rs` 的 `BROWSER_TOOLS` 分发是**名字通用**的,零改动。
- `Ok` = 模型可读文本(含 `[Error]` 软错误,模型自行纠正重试);`Err` = 硬错误(JSON-RPC -32603)。
- 每次调用都过 `audit_ai_tool`(action=工具名,detail 只取白名单参数);成功后 `on_ai_tool_success` 生成 `browser.action` 领域事件(`events.rs:104` 前缀匹配,新工具自动命中)。

### 3.2 双后端执行层(webview / obscura)

| | webview 后端(默认) | obscura 后端 |
|---|---|---|
| 载体 | 无痕独立 Tauri 窗口 `ai-browser`(WebView2/WKWebView/WebKitGTK) | vendored 无头二进制(Rust V8 引擎)+ CDP WebSocket + 直播查看器窗口 |
| 控制通道 | Windows:CDP(`Runtime.evaluate`/`Input.dispatch*` 可信输入);其余平台:注入 `script::HELPERS_JS` + `browser_internal_result` 回传 | CDP loopback(`Target.createTarget/attachToTarget`、`Page.navigate`、`Input.dispatch*`、`Page.startScreencast`) |
| 动作执行 | `execute_action`(webview.rs:187),单步 | `execute_action`(obscura/mod.rs:376),单步 |
| 平台限制 | 截图 mac/linux 各有 `snapshot_*`;cdp.rs 仅 Windows | 跨平台 |

**关键缺口(两份代码调研一致确认):两个后端都没有"自动执行一串动作"的能力**——每次桥调用 = 一个 `BrowserAction` 单步。最接近的设施是 obscura 的 `LiveCmd` 泵(只转发查看器窗口的**用户**输入,不是 AI 批量)。

### 3.3 工具面(模型可见的 14 个工具)

`browser_open / navigate / back / forward / reload / state / extract / click / type / press_key / select_option / scroll / screenshot / eval`。
- `browser_extract` 是决策闭环的关键输入:输出 `url/title + 编号可交互元素列表([id] <标签> "文本" href=…,含 open Shadow DOM 与同源 iframe 递归)+ 正文截断`,**编号即 click/type 的 id**。
- `browser_eval`(页面内执行任意 JS)已经存在——这就是为什么需要先确认"jev"不是指 JS eval。

### 3.4 审批与审计(approval-bridge)

三档:`ALLOW`(不弹卡)/ 软 ask(`kind:'ask'`,`danger-full-access` 预设下静默放行)/ 硬 ask(必弹卡)。
- browser_open/navigate/click/type/press_key/select_option → 软 ask(「对外部站点产生真实操作」)。
- state/extract/screenshot/scroll/back/forward/reload → default `ALLOW`(只读观察)。
- **browser_eval 免卡**:不在 switch 也不在 ALWAYS_ASK,落 default(仍写宿主审计)。
- **新 `browser_` 工具若不进 `STARHUB_DOMAIN_TOOLS` → `classifyStarHubCall` 返回 null = 风险门完全不介入**;进去但无 case → 落 default ALLOW。**必须显式登记**(approval-bridge/src/index.ts:334-361、switch L271-330)。

### 3.5 配置与密钥设施(为 Jev 接入准备就绪的部分)

- **密钥**:keyring 已有 `store_ai_model_api_key(id) / load_ai_model_api_key(id)`(entry key `model:<id>`,keyring/mod.rs:311-341),对应 Tauri 命令 `set/get/delete_ai_model_api_key` **已注册且在 ACL 白名单**(commands.toml:152-205)→ **Jev API key 零新增 command**。
- **非密配置**:settings 表(key/value),`browser.engine` 就是范例(browser/mod.rs:226-266 的读/upsert)。
- **设置 UI**:`client-nav` 的「AI 浏览器」tab(`settings/browser.tsx`,注册于 `client/index.ts:381` 的 `settings.section` 槽位)直接扩展即可。

---

## 4. 为什么浏览器操作适合接 Jev

### 4.1 瓶颈:每一步都是主模型的一次完整 round-trip

典型操作流:`browser_open → navigate → extract → (模型选 12)→ click → extract → (模型选 8)→ type → …`。
- 每一步「从 extract 输出里挑编号元素」是**封闭集判别**(高频、低风险、低创造性),却占用主模型的上下文与推理预算,延迟按秒计、成本按主模型 token 计。
- 页面一复杂(几十个编号元素),extract 文本反复进入上下文,挤占主模型的有效窗口。

### 4.2 Jev 的能力错位匹配

- **输入**:目标(goal)+ 编号元素列表;正是 extract 的输出格式。
- **输出**:结构化决策(click/type/scroll/select/press_key/navigate/done + 参数)+ 置信度;可直接映射 `BrowserAction`。
- **特征**:毫秒级低延迟 + 远低于 LLM 的成本 → 适合"每步一调"的 agent 循环;置信度 → 可做路由(低置信度交还主模型)。
- **即便 Jev 只是"更快的分类器"**:封闭集选择恰好是分类任务——怀疑者的质疑(Jev=分类器)对本场景不构成否定。

### 4.3 不适合 / 要谨慎的地方

- 不要让它做开放推理(目标分解、错误恢复、验证码/登录策略)——这仍是主模型的职责。
- 不要把 Jev 决策直接当"已授权操作":审批边界(§6.6)不因决策来自谁而改变。
- 企业私有部署场景:外部 API 外发合规(§9)。

---

## 5. 接入点方案对比(4 选 1)

| | 方案 A:`browser_decide` 新工具(Rust 内 HTTP→Jev,只读决策) | 方案 B:`browser_auto` 自动执行循环(decide→act,步数上限) | 方案 C:vendor 插件做决策服务(node 侧 HTTP) | 方案 D:把 Jev 包成 dsh-llm provider(替换主模型) |
|---|---|---|---|---|
| 模型可见形态 | 1 个新工具 | 1 个新工具(Phase 2) | 工具行为透明变化 | 主模型切换 |
| 审批影响 | ALLOW(只读,改动小) | 必须软/硬 ask,借鉴 desktop 任务级授权 | 执行仍在现有工具,门不变 | 不动审批但改变全部行为 |
| 改造面 | Rust 3 文件 + 新 1 文件;vendor 2 文件 | 同 A + 循环层 + 授权态 | vendor 新插件 + key 通道搬迁;snapshot 获取要绕桥 | dsh-llm 接口不匹配(Jev 非对话模型),不可行 |
| 主模型 round-trip | 省"选元素"这步的 LLM 推理(决策仍经模型转执行) | 省全部中间步 | 同 A 但依赖链更长 | — |
| 审计/事件 | 自动(前缀命中) | 自动 | 自动 | — |
| 风险 | 低(只读 + 配置默认关) | 中(自动执行,需授权态设计) | 中(dsh 侧无 keyring,要把 key 搬去 credentials) | 否决不议 |
| 结论 | **MVP 首选** | **Phase 2** | 不推荐(重复造 keyring/桥,违反"优先插件"精神的成本反例) | **否决** |

> 说明:仓库铁律是"新功能优先 dsh 插件注入"。方案 A 之所以落在 Rust 侧:决策的输入(页面快照)与输出(BrowserAction)都在 Rust 执行层,且 keyring/settings/HTTP 客户端(reqwest)都已在 Rust 就绪;vendor 侧只做"工具登记 + 审批登记"两处必需改动(与 AGENTS.md 允许的 `packages/starhub/*` 本地包改动一致)。C 方案的代价(在 node 侧重建密钥/桥调用)远大于收益。

---

## 6. 推荐架构与详细设计

### 6.1 总体形态

```
主模型:  "打开 https://x,找到登录并进入"
  ├─ browser_open / navigate        (现有)
  ├─ browser_extract                (现有,或由 decide 内部代取,见 6.2)
  ├─ browser_decide { goal }        【新】→ Jev:"click 元素[12]「登录」 conf=0.87"
  ├─ browser_click { id: "12" }     (现有;审批链路原样保留)
  └─ browser_decide { goal }        【新】→ Jev:"done conf=0.91"
Phase 2:
  └─ browser_auto { goal, maxSteps } 【新】内部循环 decide→act,任务级授权
```

原则:**"决策"与"执行"分离**——Jev 只看不说、只选不做;执行的确认卡照旧弹给用户(卡上仍是什么动作就显示什么)。

### 6.2 `browser_decide` 工具规格(MVP)

**参数**:
- `goal`(必填,string):当前子目标,如 `找到"登录"按钮并点击`、`在搜索框输入 starhub 并回车`。
- `snapshot`(可选,string):调用方直接提供 extract 原文;**不传则 Rust 内部自动执行一次 Extract**(省主模型一次工具 round-trip,同时天然对齐编号空间)。

**行为(Rust 层)**:
1. 读配置(§6.4);`enabled=false` → 软错误 `[Error] Jev 决策未启用,请在 设置→AI 浏览器 配置并开启`。
2. `snapshot` 缺省 → 内部执行对应后端的 Extract(webview: `eval_text("return window.__shb.extract(6000);")`;obscura: 同 function evaluate),失败 → 软错误透传。
3. 构造 Jev 请求(adapter 层,§6.3):上下文 `{ url, title, goal, elements[] }` + 候选动作集(七原语枚举)。
4. 校验响应:action 必须在白名单(click/type/scroll/select/press_key/navigate/done),id 必须纯数字(复用 `element_id` 校验语义),confidence ∈ [0,1];任何不符 → 软错误。
5. 置信度路由:confidence < `ai.jev.threshold` → 返回 `[LOWCONF]` 前缀文本 + 原始决策,提示模型自行决策(主模型兜底)。
6. 返回模型可读文本(不执行!):
   `决策:click 元素[12]<button> "登录"(confidence 0.87,阈值 0.60)\n备选:元素[15] "Sign in"(0.31)\n当前页面:标题 (url)`

**审批归类**:只读(自己不产生副作用)→ approval-bridge 落 default `ALLOW`(与 extract 同档);真动作仍走 click/type 的软确认。
**审计**:`browser_` 前缀自动进 `browser.action` + audit_ai_tool;把 `goal` 加进 `AUDIT_ARG_WHITELIST`(tools.rs:226,便于回放"为什么点它")。

### 6.3 Jev 客户端(Rust,带 adapter 边界)

- 新文件 `src-tauri/src/browser/decide.rs`:
  - `JevConfig { base_url, model, api_key_ref, threshold, timeout_ms, enabled }`:base_url/model/threshold/enabled/timeout 读 settings 表(键名 §6.4);api_key 用 `keyring::load_ai_model_api_key("jev")`。
  - `JevClient`:reqwest 静态 `OnceLock` client + 每请求 `.timeout()`(仿 `commands/alert.rs::webhook_client` 的 OnceLock+timeout 与 `mcp.rs::add_configured_headers` 的 header 模式;Authorization: Bearer)。
  - **请求构造 / 响应解析写成纯函数**(输入输出都是 `serde_json::Value`/结构体,单测覆盖:候选动作白名单、id 纯数字校验、confidence 缺省/越界、HTTP 非 200、超时、截断)。字段级细节【未核实】→ adapter 边界把未知隔离在一处,实测后只改构造/解析两个纯函数。
- 拒绝让页面文本直接拼进可执行语义:候选动作是**服务端白名单枚举**,不接受任何自由文本动作。

### 6.4 配置与密钥(零新增 Tauri command / ACL)

| 项 | 载体 | 默认 |
|---|---|---|
| `ai.jev.enabled` | settings 表(`0`/`1`) | `0`(**默认关**) |
| `ai.jev.base_url` | settings 表 | 空(用户填官方 API 或 AI/ML API 网关) |
| `ai.jev.model` | settings 表 | `jev` |
| `ai.jev.threshold` | settings 表(`0.00`–`1.00`) | `0.60` |
| `ai.jev.timeout_ms` | settings 表 | `8000`(决策对延迟敏感) |
| API key | keyring `model:jev`(现成命令 `set/get/delete_ai_model_api_key`) | — |

设置 UI:扩展 `client-nav/settings/browser.tsx`「AI 浏览器」tab(启用开关 + base_url + model + 阈值 + key 状态显示;key 输入走 `set_ai_model_api_key`)。**提示文案必须写明:页面快照与目标将发送至所配置的第三方端点**。

### 6.5 置信度路由(与主模型的协作契约)

- conf ≥ 阈值:decide 返回明确动作 → 模型照执行(快路径)。
- conf < 阈值:`[LOWCONF]` → 模型自行判断(慢路径,不强行自动化)。
- 响应含 `done` 动作:表示目标已达成,模型收尾。
- Phase 3 可把「decide 命中率 / 平均置信度 / LOWCONF 率」写进 recentExecs 或审计统计,形成路由质量面板(数据已在审计行里,只需聚合)。

### 6.6 审批与审计边界(硬约束)

1. `browser_decide` 必须显式进 approval-bridge `STARHUB_DOMAIN_TOOLS`(否则门返回 null = 无任何确认,这是**引入 bug 而非引入功能**)。
2. `browser_decide` 不加 switch case → default ALLOW(与 extract 同级,合理:只读)。
3. Phase 2 `browser_auto`(自动执行)必须加 case → 软 ask(参考 browser_click 文案),**并借鉴 desktop 的任务级授权模式**(一次确认 = 本会话 N 分钟内该沙箱/该浏览器窗口的 auto 操作免重复确认;授权态在 Rust 执行点强制,审批层只定 ask 级别)。
4. 审计:自动生效;建议 `AUDIT_ARG_WHITELIST` 加 `goal`(≤500 字符截断,已有机制)。

### 6.7 Phase 2:`browser_auto`(自动执行循环)

- 参数:`goal`、`max_steps`(默认 8,硬上限 20)、`stop_on_lowconf`(默认 true)。
- 循环:extract → Jev decide → 执行为对应 `BrowserAction`(经 webview/obscura 的 `execute_action`)→ 追加输出;软错误(`[Error] 元素失效` 等)立即中断并回传已执行摘要;`done` 正常收口。
- 总输出截断(参考 `browser_eval` 的 8000 字符上限机制)。
- 授权态:Rust 侧 `auto_grants: (sessionId, window_label, expires_at)`,`browser_auto` 首次执行时若无授权则产出需要确认的理由文本(由 approval-bridge 软 ask 承接),确认后写入授权;窗口关闭/到期失效。
- **这个循环层现状不存在,是唯一必须新增的执行设施**(两后端共用:循环调 `execute_action`,与引擎解耦)。

### 6.8 Phase 3:扩展

- 同一决策层可复用到 `desktop_*` / `android_*`(换成各自原语词表),但那是后话,本期不做。
- Jev 权重/APUS 复现可私有部署后,`ai.jev.base_url` 指向内网端点即可满足数据不出域(需先核实 §10.3 的许可条款)。

---

## 7. 改动清单(文件级,MVP = Phase 1)

### 7.1 Rust(`src-tauri/`)

| 文件 | 改动 |
|---|---|
| `src/browser/mod.rs` | ① `BROWSER_TOOLS` 加 `"browser_decide"`;② `BrowserAction` 加 `Decide { goal: String, snapshot: Option<String> }`;③ `parse_action` 加 arm(参数校验);④ tests 加 parse 覆盖 + `browser_tools_table_covers_every_parseable_name` 自动覆盖;⑤ Decide 分支:内部 Extract + 调 decide.rs(引擎解耦) |
| `src/browser/decide.rs` | **新增**:`JevConfig`(settings 读)+ `JevClient`(reqwest,仿 alert.rs)+ 请求构造/响应校验纯函数 + 置信度路由 |
| `src/browser/webview.rs` `src/browser/obscura/mod.rs` | Decide 需要的 Extract 复用现有路径;若循环层(Phase 2)落地,在此或 mod.rs 加步数循环 |
| `src/harness/tools.rs` | **零改动**(BROWSER_TOOLS 分发通用);可选:`AUDIT_ARG_WHITELIST` 加 `goal` |
| `src-tauri/capabilities/*`、`permissions/commands.toml`、`main.rs generate_handler!` | **零改动**(桥工具不是 Tauri command;key 命令已注册) |

### 7.2 vendor(submodule `vendor/deepseek-harness/`,仅动 `packages/starhub/*`)

| 文件 | 改动 |
|---|---|
| `packages/starhub/tools/src/index.ts` | `BRIDGED_TOOLS` 浏览器段(L342-434)追加 `browser_decide` spec(description + parameters:`goal` 必填、`snapshot` 可选);执行链自动获得(callHost/registerBridged 名字通用) |
| `packages/starhub/approval-bridge/src/index.ts` | `STARHUB_DOMAIN_TOOLS`(L334-361)加 `'browser_decide'`(**必须**);不加 switch case → default ALLOW;tests/risk-gate.spec.ts 补断言(该文件已有 browser_* 档位 it,加一条) |
| `packages/starhub/client-nav/src/client/settings/browser.tsx` | 「AI 浏览器」tab 扩展 Jev 配置(键走现成 `set/get_ai_model_api_key`);补一个 tab 单测(client-nav tests 有 browser settings 先例) |
| (可选,建议)`packages/starhub/tools/tests/` | 建 tools 包首个 spec:把 BRIDGED_TOOLS 的 browser_* 名单钉成断言——**目前"vendor 工具表 ↔ Rust BROWSER_TOOLS"跨语言对齐只靠注释互引,没有任何机械校验,这是本次调研发现的最大结构性缺口** |

### 7.3 文档与版本纪律(AGENTS.md 强制)

- 升版 `0.121.9 → 0.122.0`(新功能,次版本):同步七处——`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`、`CHANGELOG.md`(「未发布」下补条目)、`AGENTS.md`(当前版本行)、`README.md`(版本 badge + 当前版本章节整节替换)。
- `docs/技术方案.md` §6.5.1 补「Jev 决策层」小节(链路、审批归类、外发提示);`docs/架构图.html` 的 AI 描述行更新工具数(14 → 15)。
- **submodule 流程**:`packages/starhub/*` 的改动在 `vendor/deepseek-harness` 内提交,再回父仓库更新 submodule 指针并随父仓库一起 commit/push;不要绕过。

---

## 8. 测试计划

| 层 | 内容 | 命令 |
|---|---|---|
| Rust 单测 | `parse_action` 新 arm(必填/可选参数、goal 空值);请求构造/响应解析纯函数(白名单动作、id 非数字拒收、confidence 越界与缺省、HTTP 错误映射、截断);BROWSER_TOOLS 全覆盖测试自动纳入 | `npm run cargo:test` |
| vendor 单测 | risk-gate.spec.ts:`browser_decide` 落 ALLOW 档断言;browser settings tab 渲染/保存 | `cd vendor/deepseek-harness && pnpm exec vitest run packages/starhub` |
| 构建 | `npm run build:window`、`npm run cargo:check`(CI 链上游) | — |
| 真实回归(必须,AGENTS.md 7.3) | `npm run tauri:dev`:① 不配置 Jev → decide 返回软错误;② 配置 key 后 extract→decide 流式跑通;③ LOWCONF 路径;④ 审批:click 仍弹卡、decide 不弹卡;⑤ 审计里能看到 decide 行与 goal | 手工 |
| 关账 | 审计面板看到 `browser.action` 事件;领域事件(`starhub://domain-event`)正常 | 手工 |

---

## 9. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **Jev API 字段未核实**(输入输出、conf 字段名、错误码) | 实现细节返工 | adapter 边界把未知隔离在两个纯函数;§10.3 实测后再写死 |
| R2 | **外部 API 数据外发**违反私有部署策略(技术方案:1021) | 企业用户合规风险 | 默认关;设置 UI 明示外发;Phase 3 支持指向内网自建端点 |
| R3 | 页面内容注入(prompt injection via DOM 文本) | Jev 被页面文本劫持 | 候选动作服务端白名单;响应严格校验;Jev 无自由执行通道;执行仍过现有审批 |
| R4 | 新工具漏登记 `STARHUB_DOMAIN_TOOLS` | 风险门失效(比不加功能更糟) | 落地清单 §7.2 标"必须";risk-gate 补断言 |
| R5 | Jev 延迟/价格不达预期(每步一调) | 自动化收益归零 | §10.3 实测;decide 是**可选**工具,模型/用户可不用 |
| R6 | vendor submodule 提交流序出错 | 主壳加载旧插件 | 按 §7.3 submodule 流程;改完 `npm run package:dsh-runtime` 视需要重打 |
| R7 | 置信度语义不稳定( Same 页面反复决策不同) | 循环震荡(Phase 2) | MVP 不循环(Pure decide);Phase 2 加步数上限与停止条件;LOWCONF 升级主模型 |
| R8 | APUS 复现的许可条款未核实 | 商用/私有部署不确定 | §10.3 核实后再承诺"本地部署" Option |

---

## 10. 路线图与前置验证

### 10.1 Phase 0 — 先验证再实现(0.5 天,强烈建议)

用现成工具直接打 Jev API(Postman/curl/或 StarHub 自己的 `browser_eval` 都不合适——就用命令行),拿真实响应;同时实测延迟与计费。产出物:请求/响应样例(填进 adapter)、延迟数字、置信度分布样例。

### 10.2 分期

- **Phase 1(MVP,~2-3 天)**:`browser_decide` + 配置/密钥 + 设置 UI + 审批登记 + 单测 + 文档升版。
- **Phase 2(~2 天)**:`browser_auto` 循环 + 任务级授权态 + 中断/截断 + 集成回归。
- **Phase 3(按需)**:路由质量统计(命中率/LOWCONF 率/平均置信度);desktop/android 原语词表复用;内网自建端点支持。

### 10.3 实测清单(搜索端点恢复或 Phase 0 后逐项打勾)

1. 请求字段:能否传结构化候选(元素列表),还是只有自然语言问句;— **已核实(v0.123.0)**:`questions[].criteria` 即结构化候选集,`state` 传自然语言上下文;
2. 响应字段:决策字段名、置信度字段名与量纲(0-1?)；— **已核实**:choice 答案为 `choice` + `probabilities` + `confidence`(0-1);
3. 低置信度的确切行为(升级?反问?默认动作?）— **部分核实**:API 只回 confidence,升级/路由由调用方决定(StarHub 侧用阈值 + `[LOWCONF]` 交还主模型);
4. 延迟(单次调用 p50/p99)与价格(每千次调用);
5. 限流与并发;
6. 官方是否有 UI/浏览器自动化/agent 动作选择用例与推荐 prompt;
7. 权重许可与本地部署可行性(APUS 复现的性质:权重 / 推理框架 / 规模 / 可否商用)。

---

## 附录 A:Jev 调研来源(本报告 §2 全部依据)

- [央广网:Jev模型是什么?TypeSafe"决策模型"爆火后,APUS 交出全球首批跨平台开源复现](https://tech.cnr.cn/techph/20260920/t20260920_527819594.shtml)
- [新华网:APUS 开源 Jev 跨平台复现:国产模型实现秒级决策](http://www.news.cn/tech/20260921/8f1c9bd6a9254e629383f1ac51e0d27d/c.html)
- [科技日报:APUS 公布针对 Jev 的独立开源复现成果](https://www.stdaily.com/web/gdxw/2026-09/20/content_584657.html)
- [GitHub: qingshungLI/everything-about-jev(TypeSafe AI's System One model for typed decisions)](https://github.com/qingshungLI/everything-about-jev)
- [Spring 官方博客:Spring AI and TypeSafe Jev: Fast, Cheap, Structured Decisions](https://spring.io/blog/2026/09/21/spring-ai-typesafe-structured-judgment)
- [TechTarget: Jev decision model touted as quicker, cheaper LLM alternative](https://www.techtarget.com/it-infrastructure/news/366650696/Jev-decision-model-touted-as-quicker-cheaper-LLM-alternative)
- [ZDNet Korea: Jev, 역사상 가장 빠르게 사용량이 증가한 유료 모델](https://zdnet.co.kr/view/?no=20260920215302)
- [36氪:刷屏爆火的"不说话"AI Jev 真的是 AI 新范式吗?](https://eu.36kr.com/zh/p/3988164509711361)
- [腾讯新闻:ChatGPT 早期研究者做了一个"不会说话"的 AI,Jev 真是新范式吗?](https://news.qq.com/rain/a/20260918A058BW00)
- [七牛云:Jev 使用完整指南:从申请 API Key 到置信度路由](https://news.qiniu.com/archives/1789969178302)
- [今日头条:Jev 是分类器吗?今天向所有人开放,送 1.2 亿 token](https://www.toutiao.com/article/7687890766747681321/)
- [阿里云开发者社区:JEV 模型最新研讨:只下判断不说话,低延时才是被低估的变量](https://developer.aliyun.com/article/1765496)
- [搜狐:不会说话的 Jev,为什么爆火?](https://www.sohu.com/a/1079005971_120603108)
- [搜狐:Jev 是什么?来自官网的解释告诉你](https://www.sohu.com/a/1079280701_100106801)
- 渠道页:[AI/ML API: decision-models/typesafe/jev](https://docs.aimlapi.com/api-references/decision-models/typesafe/jev)、[OpenRouter: community/jev](https://openrouter.ai/docs/guides/community/jev)

> 备注:受 `web_search` 端点 402(余额不足)影响,上述来源仅核实到标题/摘要级;正文字段级细节以 §10.3 实测为准。恢复检索后应优先补齐:输入/输出 JSON schema、延迟/价格、置信度路由行为、权重许可。

## 附录 B:关键代码坐标(调研结论索引)

| 主题 | 位置 |
|---|---|
| 工具表(vendor) | `vendor/deepseek-harness/packages/starhub/tools/src/index.ts` `BRIDGED_TOOLS` L164-941(browser 段 L342-434) |
| 桥执行入口 | `src-tauri/src/harness/tools.rs` `execute_bridge_request` L128 / `dispatch_tool` L165(browser 分支 L193) |
| 浏览器执行层 | `src-tauri/src/browser/mod.rs` `BROWSER_TOOLS` L41 / `parse_action` L158 / `execute_from_bridge` L273 |
| webview 后端 | `src-tauri/src/browser/webview.rs` `execute_action` L187(Extract L233、Eval L366) |
| obscura 后端 | `src-tauri/src/browser/obscura/mod.rs` `execute_action` L376(CDP 客户端 obscura/cdp.rs) |
| 页面助手脚本 | `src-tauri/src/browser/script.rs` `HELPERS_JS`(extract/click/type 等 `__shb.*`) |
| 审批门 | `vendor/deepseek-harness/packages/starhub/approval-bridge/src/index.ts` `classifyStarHubCall` L261、`STARHUB_DOMAIN_TOOLS` L334、browser 档位 L302-308 |
| 审计 | `src-tauri/src/harness/tools.rs` `audit_ai_tool` L253、`AUDIT_ARG_WHITELIST` L226;`src-tauri/src/harness/events.rs` `kind_for_tool` L104 |
| 密钥 | `src-tauri/src/keyring/mod.rs` `store/load_ai_model_api_key` L311-341;`src-tauri/src/commands/secret.rs`(命令已注册,ACL commands.toml L152-205) |
| HTTP 范例 | `src-tauri/src/commands/alert.rs` `webhook_client` L9-19 / `alert_test_webhook` L287-314;`src-tauri/src/mcp.rs` `add_configured_headers` L449 |
| settings 读写范例 | `src-tauri/src/browser/mod.rs` `engine_setting` L226 / `save_engine_setting` L250 |
| 设置 UI 范例 | `vendor/deepseek-harness/packages/starhub/client-nav/src/client/settings/browser.tsx`(注册 client/index.ts L381) |
| 跨语言对齐缺口 | Rust `BROWSER_TOOLS` ↔ vendor `BRIDGED_TOOLS` ↔ approval `STARHUB_DOMAIN_TOOLS` 三者仅注释互引,Rust 内部测试 mod.rs L434 + risk-gate L184-194 硬编码,无机械校验 |
