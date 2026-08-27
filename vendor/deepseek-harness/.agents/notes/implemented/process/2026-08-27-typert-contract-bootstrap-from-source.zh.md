# Agent Note：从源码自举 Typert 契约

Status: implemented

## Problem

本 StarHub fork 所含 harness 快照的 `tsconfig.base.json` 把大量包名直接映射到
`src/`——包括所有 `@deepseek-ai/dsh-client-*` 面与 `@deepseek-ai/dsh-api-remotes`，
而七个 owner 包的 `./remote` 子路径只能解析到生成的
`lib/typert.remote-client.d.ts` 产物。干净检出后的第一个 tsc 阶段就会检查到
import 斜杠 remote 子路径的源码，在任何生成器有机会运行前就以 TS2307 崩溃。
[api-remotes 构建顺序 note](../../process/2026-08-08-api-remotes-generated-contract-build.zh.md)
的有序阶段（host tsc → host tsdown → client tsc）假设 Host tsdown 是这些
specifier 的第一个消费者，本工作区的 paths 表面打破了这个前提；本地树从未暴露，
是因为历史构建残留的 `lib/` 产物掩盖了它。这一失败正是 StarHub v0.99.x 的
CI 阻断错误。

## Decision

`build:lib:host` 现在以 `gen:typert` 开头（`scripts/gen-typert-contracts.ts`，
经 tsx 运行）：生成器的 SOURCE 入口按 `faces: ['host']` 分析，用与 tsdown 插件
相同的 `hasTypertExport` 检查过滤发现的包，并把每份产物（`typert.host.*` 加
`typert.remote-client.*` 三件套）直接写入 owner 包被 gitignore 的 `lib/`。
它在每次 host lib 阶段无条件运行——包括都在前面拼接 `build:lib:host` 的
`typecheck` 与 `lint`——并且每次重写全部 face 集，因此退役的 `@Remote` 方法
会在同一次运行中丢掉旧契约，而不是靠陈旧产物遮蔽依赖破坏。

## Alternatives considered

**在安装时生成一次（postinstall）。** 新克隆跳过或失败该钩子即静默回归；
逐阶段再生成把保证放在使用点上。

**给 `/remote` 增加 paths 条目指向源码。** 契约是从多个包的装饰器推导的，
不是单个源文件；静态映射无法替代生成投影。

**把 base paths 回退指向 `lib/types`。** 那会改变 fork 里每个包的解析方式，
与本工作区有意的源码面测试设置相矛盾；影响面远大于缺失的这一类产物。

## Consequences

干净的 StarHub 检出重新可以端到端构建（`build:lib`，随后的
`package-dsh-runtime` 与 release 流程都调用它）。Host tsdown 的 Typert pass
之后仍会全工作区重发一切，所以该自举是前置步骤而非第二权威。2026-08-08 的
顺序 note 对上游形态仍然准确；本 fork 在其前增加一个阶段。代价：即使产物已
存在，host 阶段也要支付一次完整生成器分析（秒级）。

## Related

- [Ordered Build for API Remotes Generated Contracts](../../process/2026-08-08-api-remotes-generated-contract-build.zh.md) — 部分取代语境：其阶段顺序不变，本 fork 在之前拼入自举阶段。
