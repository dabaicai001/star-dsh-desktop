# AI 成本顾问插件方案(cost-advisor)

> 状态:设计评审稿(未实施)
> 日期:2026-09-06
> 关联:插件体系打通方案-dsh插件统一.md、AI内核替换方案-deepseek-harness.md

## 1. 目标与场景

DeepSeek API 按「缓存命中 / 缓存未命中 / 输出」×「空闲 / 高峰时段」×「模型」
三维计价(元/百万 tokens),价格差可达一个数量级(缓存命中空闲 0.05 vs
输出高峰 27.0)。用户经常在上下文已经很长时继续会话(每轮全量重发,成本随
上下文线性增长),或在高峰时段新建会话(缓存全 miss,输入按最高价计)。

本插件目标:**在 AI 每次发起模型请求前,把「当前成本快照 + 新建会话的最佳时机
建议」注入上下文**,让 AI 能在对话中主动提醒用户「现在继续 vs 等空闲时段新建
哪个更划算」。

## 2. 计费模型(输入数据)

**价格数据不内置、不靠用户手填,由服务端爬虫聚合后通过 API 下发。**

```
┌─ 阿里云服务器(39.97.231.97,nginx + HTTPS 已就绪)──────────┐
│  爬虫脚本(Node 24, cron 每 6h)                            │
│    ├─ 抓各厂商官方计费页(DeepSeek / 通义 / 智谱 / …)       │
│    ├─ 解析 → 归一化为统一 JSON schema                     │
│    └─ 原子写入 /var/www/starhub-website/api/pricing.json  │
│         (失败保留上一份,绝不清空)                         │
│                                                           │
│  nginx: location = /api/pricing.json → 静态文件直出        │
│         https://starthub.waouzzz.cc/api/pricing.json      │
│         (Cache-Control: max-age=3600;无后端进程,零运维)  │
└───────────────────────────────────────────────────────────┘
            │ 插件启动时 + 每 cacheTtl 拉一次(进程内缓存)
            ▼
┌─ cost-advisor 插件 ───────────────────────────────────────┐
│  拉取成功 → 用远端价格;拉取失败 → 回退 cordis.yml 里的    │
│  fallback 静态表(可空,空则无价不注入);远端与 fallback    │
│  都无匹配模型 → 不注入(沿用「不猜价」原则)               │
└───────────────────────────────────────────────────────────┘
```

### 2.1 API 契约 `GET /api/pricing.json`

```json
{
  "version": 1,
  "updatedAt": "2026-09-04T22:00:00+08:00",
  "currency": "CNY",
  "unit": "per_million_tokens",
  "models": [
    {
      "match": "deepseek-chat",
      "provider": "deepseek",
      "cacheHit":  { "idle": 0.05, "peak": 0.10 },
      "cacheMiss": { "idle": 1.5,  "peak": 3.0 },
      "output":    { "idle": 4.5,  "peak": 9.0 },
      "source": "https://api-docs.deepseek.com/quick_start/pricing"
    }
  ]
}
```

- `match` 规则同原方案(精确 + `*` 后缀通配);`idle`/`peak` 字段允许为
  `null`(该厂商无分时计价 → 插件按 `peak` 单价全天候处理)。
- 爬虫抓不到的厂商不进数组(不下发脏数据);解析失败记日志并保留旧文件。
- 单位固定「元 / 百万 tokens」;`idleWindows`(时段窗口)仍是**客户端配置**
  —— 各厂商优惠窗口不同,首版只服务 DeepSeek 系,窗口由 cordis.yml 配置。

### 2.2 服务端部署(阿里云)

- 爬虫脚本位置:`/opt/starhub-pricing/crawl.mjs`(Node 24,零依赖,fetch +
  正则/cheerio 解析;厂商页面结构变了宁可报错也不输出错价)。
- 调度:`cron` 每 6 小时一次,输出先写临时文件再 `mv` 原子替换
  `/var/www/starhub-website/api/pricing.json`。
- nginx 增量配置(`gateway.conf` 的 starthub server 块内加一条,不改现有
  路由):

```nginx
location = /api/pricing.json {
    add_header Cache-Control "public, max-age=3600";
    add_header Access-Control-Allow-Origin *;   # dsh 进程 fetch,宽松即可
    try_files $uri =404;
}
```

- 价格表 schema 版本化(`version` 字段),将来加字段向后兼容。

## 3. 总体设计

按「新功能优先以 dsh 插件形式注入」铁律,新增一个 StarHub 本地包,不改 vendor
内核。所有需要的机制都已存在:

```
┌─────────────────────────────────────────────────────────┐
│ @deepseek-ai/dsh-starhub-cost-advisor(新插件)          │
│                                                         │
│  Config(价格表 + 时段窗口 + 货币) ── cordis.yml 注入     │
│                                                         │
│  agent/pre-step(waterfall,prepend)                     │
│    │                                                    │
│    ├─ ctx.tokenMeter.measure(agent.session)             │
│    │    → 当前上下文总 tokens(下次请求的 input 规模)   │
│    │                                                    │
│    ├─ 折叠 session.events 中 assistant/message.usage    │
│    │    → inputTokens(未命中)/ cacheReadTokens(命中) │
│    │      / outputTokens 实测值                         │
│    │                                                    │
│    ├─ 当前时间 → 空闲/高峰判定(本地时钟 + 配置的 tz)   │
│    │                                                    │
│    └─ 计算 + 渲染 → createUserMessage 注入               │
│         (source: { kind:'plugin', form:'snapshot' })     │
└─────────────────────────────────────────────────────────┘
```

### 3.1 复用的现有设施(均已验证存在)

| 需求 | 现有机制 | 出处 |
|---|---|---|
| 当前上下文 token 规模 | `ctx.tokenMeter.measure(session).totalTokens`(replay-aware,含 provider usage 锚点) | `packages/llm/token-meter` |
| 缓存命中/未命中分解 | `assistant/message` 事件 `usage.cacheReadTokens` / `inputTokens`(DeepSeek 适配器从 `prompt_cache_hit_tokens` 映射) | `packages/llm/llm-deepseek/src/translate.ts` |
| 每步注入点 | `agent/pre-step` waterfall,payload 含 `{ agent, messages, turn, step, signal }`,`{ prepend: true }` 插到队首 | `packages/core/agent/src/runtime-types.ts`;先例:live-context |
| 注入消息格式 | `createUserMessage({ source: { kind:'plugin', plugin, form:'snapshot', sections } })` | live-context 同款,会话日志可重建 |
| 当前会话模型名 | session 头部 / initialize 传入的模型标识(pre-step 时从 `agent.session` 读取,用于匹配价格列) | dsh-session |

### 3.2 为什么不新造轮子

- **不自己估 token**:token-meter 已处理 replay、估算锚点、provider usage 优先,
  重复实现必然失真。
- **不走 sdk-transport 反向 pull**:成本计算所需数据(session 事件、当前时间)
  全部在 dsh 进程内可得,无需回 Rust 主进程,pre-step 零 IPC 延迟。
- **不注入 system prompt**:价格/时段是易变数据,放每步快照注入,改了配置
  立即生效,不污染 persona。
- **价格拉取不过 Rust 主进程**:一次普通 HTTPS fetch(进程内缓存 + 节流点
  顺带刷新),无需新增 Tauri command / ACL 白名单。

## 4. 插件规格

### 4.1 包信息

- 路径:`vendor/deepseek-harness/packages/starhub/cost-advisor/`
- 包名:`@deepseek-ai/dsh-starhub-cost-advisor`
- 形态:function plugin(named-export `name` / `inject` / `Config` / `apply`,
  无 default export —— 避免 postmortem 0001 的 Loader 丢弃问题)
- `inject = ['agents', 'tokenMeter']`(token-meter 已在组合中;若做成可选依赖
  则用 `ctx.get` 降级为纯 usage 折叠)
- 文件:`src/index.ts`(主逻辑)+ `src/invariant.ts`(invariant companion,
  仓库强制)+ `README.md`(含 Model Experience 段)+ `tests/`

### 4.2 Config(schemastery 校验,非法 fail loud)

```yaml
- id: starhub-cost-advisor
  name: '@deepseek-ai/dsh-starhub-cost-advisor'
  config:
    enabled: true
    pricingApi: https://starthub.waouzzz.cc/api/pricing.json  # 服务端聚合价格(见 §2)
    cacheTtlMinutes: 360                  # 进程内缓存;到点下次 pre-step 顺带刷新
    fetchTimeoutMs: 3000                  # 超时/失败 → fallback,绝不阻塞 agent
    fallbackModels:                       # 可空;API 不可用时的静态兜底价格表
      - match: deepseek-chat             # 模型名匹配(精确;支持 * 后缀通配)
        cacheHit:  { idle: 0.05, peak: 0.10 }   # 元/百万 tokens
        cacheMiss: { idle: 1.5,  peak: 3.0 }
        output:    { idle: 4.5,  peak: 9.0 }
    idleWindows:                         # 可空;空 = 无空闲时段概念(全天高峰价)
      - { start: "00:30", end: "08:30", tz: "UTC" }
    currency: 元                          # 仅展示用(API 带 currency 时以 API 为准)
    typicalOutputTokens: 2000            # 估算「下一轮成本」用的典型输出量
    adviseIntervalSteps: 5               # 每 N 步注入一次(避免每步刷屏)
    maxChars: 800                        # 注入文本上限,截断保护
```

约束:
- 价格来源优先级:**API(未过期缓存)> API(新拉)> fallbackModels**;两处
  都与当前会话模型无匹配时,插件整段不注入(不猜价,fail silent 但日志可查;
  模型名读不到同理)。
- API 拉取只在 pre-step 的节流点上「顺带」做:缓存未过期直接用,过期则先发
  请求、本轮仍用旧缓存,**永不在关键路径上等网络**。
- `idleWindows` 跨午夜窗口(如 22:00–06:00)必须支持。
- 所有数值正数校验在加载时 fail loud(对齐 live-context `validateConfig`);
  API 返回数据过 schema 校验(version / 数值为正),脏数据整体丢弃走 fallback。

### 4.3 建议算法

每步(按 `adviseIntervalSteps` 节流)在 pre-step 计算:

1. **定位档位**:`now` → 是否落在任一 `idleWindows` → `slot ∈ {idle, peak}`;
   同时算出「距下一个空闲窗口开始还有多少分钟」「距当前空闲窗口结束还有多久」。
2. **实况测量**:
   - `ctxTokens = tokenMeter.measure(session).totalTokens`
   - 最近一次 `assistant/message.usage` → `cacheReadTokens` / `inputTokens` /
     `outputTokens` 实测比例(首轮无 usage 时按全 miss 估)。
3. **两个候选成本**(单位:元,按匹配模型的价格列):
   - **继续本会话下一轮** ≈ `ctxTokens × 命中率 × cacheHit[slot]`
     `+ ctxTokens × (1-命中率) × cacheMiss[slot]`
     `+ typicalOutputTokens × output[slot]`(均 ÷10⁶)
   - **新建会话首轮** ≈ `newSessionInput × cacheMiss[slot]`
     `+ typicalOutputTokens × output[slot]`,其中 `newSessionInput` 为
     系统提示 + 首条用户消息的估算(tokenMeter.estimateMessage 可复用),
     并注明「代价:丢失全部上下文,需重新交代背景」。
4. **时机建议**规则(按优先级):
   - 当前高峰 且 上下文 ≥ 阈值(如 100k)且 距空闲窗口 ≤ 60 分钟
     →「建议 XX:XX(空闲开始)后新建会话,预计省 Y%」;
   - 当前空闲 且 上下文 ≥ 阈值 →「现在是新建会话的好时机(空闲价 + 全新缓存)」;
   - 上下文 < 阈值 →「上下文还小,继续/新建差异可忽略,无需提示」;
   - 缓存命中率骤降( compaction 后 / 缓存过期)→「刚发生缓存失效,
     本轮按未命中价计费,长上下文场景考虑新建」。
5. **渲染注入**,示例:

```
[Cost advisor] deepseek-chat · 高峰时段(空闲 16:30 开始,还有 42 分钟)
上下文 486k tokens(最近命中率 91%)
· 继续本会话:下一轮 ≈ 0.089 元(命中 0.10/M,输出 9.0/M)
· 新建会话:首轮 ≈ 0.012 元,但丢失上下文
建议:上下文已很大且高峰计价,若任务可拆分,16:30 后新建会话约省 75%;
否则继续本会话仍比高峰新建划算(缓存命中价仅为未命中的 1/30)。
```

文案面向模型视角(模型再转述给用户),不含实现词汇;经 `maxChars` 截断。

### 4.4 可选增强(二期,不在首版)

- `cost_advice` 工具:用户直接问「现在新建划算吗」时 AI 主动调用,返回同样的
  计算结果(JSON),不依赖注入节流。
- 成本累计统计:折叠全 session usage × 当时时段价格,给出「本会话已花费 ≈ X 元」。
  需要按事件时间戳还原当时 slot,首版先不做。
- 设置面板 UI:经 settings 命名空间让用户在 GUI 里改 `pricingApi` / `idleWindows`
  / fallback 价格表(首版只走 cordis.yml)。

## 5. 注册与接线清单

1. `packages/starhub/cost-advisor/` 新包(src + tests + README + package.json,
   tsconfig 按包规范注册进聚合)。
2. `examples/starhub-agent/cordis.yml`:注册在 `token-meter` 之后(依赖其服务);
   `examples/starhub-web/cordis.patch.yml` 同步。
3. `examples/package.json` 加 workspace 依赖;根 `tsconfig.base.json` 加 paths;
   (verify-cordis-config 会强制)。
4. README 按规范写 Model Experience(token 影响:每 N 步注入 ≤800 字符,对
   KV 缓存的影响与 live-context 同级——注入文本稳定前缀可命中缓存)。
5. 测试:包级单测(算法:时段判定/跨午夜/成本公式/无匹配不注入)+ REAL
   composition 测试(Loader 启动测试 cordis.yml)+ keyless snapshot(对齐
   仓库 testing policy)。
6. 文档:本文件 + `docs/技术方案.md` AI 章节补一段 + CHANGELOG。
7. 服务端(先于插件上线,可独立交付):爬虫脚本 `/opt/starhub-pricing/crawl.mjs`
   + cron 调度 + nginx `location = /api/pricing.json`(先改 `gateway.conf` 备份
   再 `nginx -t && reload`);首版至少覆盖 DeepSeek 官方计费页,输出符合 §2.1
   schema 的 `pricing.json`。
8. 升版:代码改动 → 按纪律升修订/次版本,同步七处。

## 6. 风险与边界

- **模型名拿不到**:pre-step 时 session 模型标识若为空(历史会话/恢复),
  不注入而不是猜价。
- **注入本身花 token**:节流(`adviseIntervalSteps`)在成本收益间权衡;
  800 字符 ≈ 数百 tokens,相对 486k 上下文可忽略,但小上下文场景要允许
  `enabled: false` 或加大间隔。
- **时段判定时区**:以配置 `tz` 为准,用进程本地时钟换算;不引入网络授时。
- **价格变动**:由服务端爬虫自动跟进(§2),插件不内置价格;API 不可用时
  回退 cordis.yml `fallbackModels` 并记日志,全链路断网也不阻塞 agent。
- **爬虫失真**:厂商改价目页结构时解析必须 fail loud(报错 + 保留旧数据),
  严禁输出猜测价格;`updatedAt` 超过 48h 视为陈旧,插件注入文案里标注
  「价格数据更新于 X 小时前」。
