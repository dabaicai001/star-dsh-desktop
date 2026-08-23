# Agent Note: StarHub fork 退役半有用的文档门禁

Status: implemented

[English](2026-08-23-starhub-fork-gate-retirement.md) | 中文

## 问题

vendored DSH 副本累积的门禁债在 StarHub fork 里永远无法全绿:`pnpm run lint` 报约 1,955 条错误,`doc-sync` 多项叶子失败,全量 `test:coverage` 又暴露上游 CI 与环境相关的失败。其中一部分是真债要还(lint 类型错误、缺 JSDoc、覆盖率薄),但三道文档门禁强制的是 fork 不遵循的约定,另有一道断言的是 fork 刻意不携带的机制。全部「按规矩修」意味着:把中文优先的 README 语料翻成英文、重建上游 VitePress 站点、凭空造 CI 工作流——这些是服务门禁而不是服务产品。

## 决策

**还真债,退役其余。** 保留并清零:oxlint(1,955 → 0)、per-file 100% 覆盖率门禁(terminal 模块 3–44% → 100%)、export-jsdoc(353 条违规 → 0)、包 README limitations 与 model-experience 门禁、剩余 doc-sync 叶子(23/23)、以及 `pnpm run build`(fork CI 的真门禁)。退役的(AGENTS.md / docs/AGENTS.md 已同步写明):

- **`website/` 文档站点投影**——fork 从未携带上游 VitePress workspace;其投影脚本、`docs:*`/`website:*` 脚本、workspace/knip/oxlint 条目与 doc-site 门禁全部删除。
- **`verify-md-wrap`**——一段一行是 diff 可读性约定,不是正确性门禁;中文 README 语料按语义换行是合理的。
- **`verify-doc-budgets`**——字数上限紧到一行注释就能触发;防膨胀靠评审更合适。
- **`verify-translation-pairing`**——双语配对约定适合英文优先语料;StarHub README 按惯例中文优先。配对**库**与 git merge driver 保留(功能性管道),只摘除门禁与其钩子。
- **`scripts/ci-workflow.spec.ts`**——断言上游 `.github/workflows/*` 文件,fork 未 vendored;像平台排除一样从 vitest 排除。

**顺带做的 fork 专属修复。** `verify-archived-agent-notes` 读 baseline 时用错了 git 根(harness 树位于外层 starhub 仓库的 `vendor/deepseek-harness` 下),现按仓库相对目录前缀 manifest 路径。`gen-tool-catalog` 的完整性扫描把 fork 的 `starhub/tool-context`(上下文注入器,非工具包)匹配进 `tool-*` 命名启发式;starhub 组被排除,其工具由包 README 记录。三个 starhub 包补 `./invariant` 伴生(approval-bridge / host-static / tools);9 个 client-nav 样式表的高位面滚动容器补主题门禁要求的 l2 滚动条重绑定;图标规格钉住 fork 实际集(73);`THIRD_PARTY_NOTICES.md` 重生成。

**存量、未修。** `tool-pwsh` 的沙箱升级测试在本环境 HEAD 即失败(stash 全部工作区改动验证过),`credentials-local` 的并发写测试负载下偶发;fork CI 不跑 vitest,两者都不阻塞发布。均已记入 CHANGELOG 已知限制。

## 考虑过的替代方案

- **按原样满足每道门禁**(把全部 starhub README 翻成英文、恢复网站、重建 CI)——否决:fork CI 不跑这些门禁,工作是服务门禁一致性而非产品;README 翻译尤其会让 starhub 文档语料翻倍而无人读。
- **保留门禁但豁免 fork 文件**——per-file 白名单比门禁本身更重的机制,而且会掩盖未来漂移而不是移除要求。
- **全部保持红色**——真债(lint 类型错误、缺 JSDoc、覆盖率薄)正是这些门禁存在的代码质量信号;把有用的也退役等于放弃它。

## 后果

fork 中 `pnpm run lint`、`pnpm run doc-sync`、`pnpm run build` 与 per-file 覆盖率门禁全部变绿;后续改动受剩余门禁约束,不再被永久红色条目干扰。退役门禁的脚本是删除而非留作孤儿,无任何引用;配对 git merge driver 对未来的任何双语编辑继续可用。被取代的笔记([双语配对门禁](./2026-07-02-bilingual-docs-and-pairing-gate.md)、[文档层级与预算](./2026-07-04-doc-tiers-and-budgets.md)、[文档站点导航](./2026-08-12-documentation-site-navigation-and-chrome.md))现在描述的是上游专属机制;保留为历史记录,死链已去引用。
