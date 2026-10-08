# DSH 升级适配清单(0.1.7-rc.1 → 0.2.1-alpha.1)

> 本文档跟踪 `vendor/deepseek-harness` 从上游 `dsh-v0.1.7-rc.1`(commit
> `46a7f68b`,2026-09-24)整体同步到 `dsh-v0.2.1-alpha.1`(commit `5badb15009`,
> tag `dsh-v0.2.1-alpha.1`,2026-10-03,上游 master HEAD)的适配过程。中间跨越
> 四个上游发布:`dsh-v0.1.7-rc.2`、`dsh-v0.2.0-rc.1`、`dsh-v0.2.0-rc.2`、
> `dsh-v0.2.1-alpha.1`。
>
> 分支:`upgrade/dsh-0.2.1-alpha.1`

---

## 〇、核心主旨:仍是「上游原样 + 插件式扩展」

沿用既有四条解耦铁律(见 `DSH升级适配清单-v0.1.7-rc1.md`):上游源文件 0 改动、
StarHub 定制只活在 `packages/starhub/*`、升级 = 整树替换 + 按本清单逐项核对、
能用插件机制表达的绝不复刻上游实现。

本次同步的本地对上游文件的**真实修改面仍然只有五处**:
`package.json`、`pnpm-lock.yaml`、`tsconfig.base.json`、`tsconfig.client.json`、
`tsconfig.host.json`(其中 4 个是 rc.2 时期建立、每次升级需重贴的根配置补丁,
lockfile 由 pnpm install 收敛),外加 `packages/sdk/server/src/index.ts`
(上游自 rc.1 起未再改动,原样保留)。

## 一、盘点与备份

- ✅ 拉取上游 `deepseek-ai/deepseek-harness` master(HEAD `5badb15009`,
  tag `dsh-v0.2.1-alpha.1`,2026-10-03)。
- ✅ 三方差异盘点(基线 `46a7f68b` × 上游最新树 × 本地 vendor 索引,
  脚本 `D:\StarHub\split-sync.mjs`,比较口径为 git blob SHA):

  | 类别 | 数量 | 处置 |
  |---|---:|---|
  | 直接跟上游(本地未改,上游演进) | 4011 | **整树替换取上游** |
  | 需三方合并(本地补丁 ∩ 上游演进) | 5 | **根配置 4 件 + lockfile** |
  | 上游未动、保留本地 | 1 | `packages/sdk/server/src/index.ts`(notifications 补丁) |
  | 上游新增 | 1914 | **全部并入** |
  | 上游已删(基线有、最新无) | 1006 | **全部删除**(885 个上游 `.agents/notes` + 121 个演进移除文件) |
  | 本地独有(上游从来没有) | 315 | **全部保留** |

  本地独有的 315 个文件构成:`packages/starhub/*` 207 + `.agents/notes` 36 +
  `packages/client/{runtime,schema-form,web-react}` 45(上游早已删除、StarHub
  保留的兼容垫片)+ `apps/starhub-window` 10 + `examples/starhub-*` 4 +
  `packages/sdk/server/src/notifications.ts`(上游包内新增文件式补丁)+
  `scripts/*` 8 + `UPSTREAM_COMMIT.txt` + 品牌资产 3 + 快照 3 +
  `patches/node-pty@1.1.0.patch` + `snapshots/web/present/workspace.expected/说明.txt`。

- ✅ **`packages/starhub/*`、`apps/starhub-window`、`examples/starhub-*` 在
  「本地修改」清单里为 0 条** —— StarHub 定制面与上游演进面继续完全不相交,
  解耦目标达成。
- ✅ 备份 1 个 keep-local 文件与 5 个合并文件的本地版( ours )。

### Windows 同步两个老坑(沿用 rc.2 处置)

1. **symlink**:上游树 14 个 mode-120000 条目(CLAUDE.md、.claude/skills、
   snapshots 各 expected 链接等),`tar -x` 在 Windows 报 `Invalid argument`。
   处置:`git cat-file blob` 取链接文本,按 `core.symlinks=false` 既有约定
   物化为普通文件(内容=链接目标)。
2. **非 ASCII 路径**:`snapshots/web/present/workspace.expected/说明.txt`
   在 `git ls-files` 输出被八进制转义(`\350\257\264\346\230\216`),已在
   本地独有清单中按原样保留。

## 二、整树替换

- ✅ `git archive origin/master | tar -x` 提取上游最新全树(14208 个文件,
   127MB)覆盖 `vendor/deepseek-harness`(node_modules 不受影响,
   不在上游树内)。
- ✅ 恢复 keep-local:`packages/sdk/server/src/index.ts` 原样写回。
- ✅ 删除上游已移除的 1006 个文件,清理 8 个因此空掉的目录。
- ✅ `UPSTREAM_COMMIT.txt` → `5badb15009… (tag: dsh-v0.2.1-alpha.1)`。

## 三、根配置补丁重贴(rc.2 建立,每次升级丢失需重贴)

整树替换会连根配置一起覆盖,以下 StarHub 补丁按三方合并(base=上游 rc.1、
ours=本地补丁版、theirs=上游最新)重贴:

| 文件 | 补丁内容 | 合并结果 |
|---|---|---|
| `package.json` | `gen:typert` script + `build:lib:host` 前置 `pnpm run gen:typert` + devDep `unrun@0.3.1` | 1 处冲突:`build:lib:host` 双边都改。解:`gen:typert` 前缀 + 上游新链(`tsdown --config-loader native` + `pnpm --filter dsh-desktop run bundle`) |
| `tsconfig.base.json` | 9 个 `dsh-starhub-*` 显式别名 + `dsh-starhub-*` 手写通配 + web-react/schema-form/runtime 三个兼容垫片别名 + `client-file-upload/types` | 干净合并 |
| `tsconfig.client.json` | refs 补 `client/schema-form`、`client/web-react`、`client/runtime`、`starhub/client-nav` | 干净合并 |
| `tsconfig.host.json` | refs 补 9 个 `packages/starhub/*` | 干净合并 |
| `pnpm-lock.yaml` | 取上游最新后由 `pnpm install` 收敛(见第四节) | — |

> 上游自身的根配置变化(直接取上游):`build:lib:host` 末尾追加
> `pnpm --filter @deepseek-ai/dsh-desktop run bundle`(desktop 打包进 host 链)、
> `tsdown --config-loader native`、devDeps 新增 `semver` / `@types/semver` /
> `vite@8.0.16`、新增 `check:ci:unit` 等脚本、移除 `gen-scoped-events` /
> `verify-package-invariants` 等退役脚本。

## 四、锁文件收敛与依赖钉版(本次最关键的基础设施适配)

- ✅ 取上游 `pnpm-lock.yaml` 原样为底,`pnpm install --no-frozen-lockfile`
  收敛出 StarHub 增量:apps/starhub-window、packages/starhub/* 12 个 workspace
  importer、三个兼容垫片 importer、`unrun@0.3.1`。最终 lockfile 相对上游
  仅 **+479/-20 行**。
- ⚠️ **坑 1:pnpm「假性 up to date」**。首次全量 install 后我又把 lockfile
  恢复成上游原版,此后 `pnpm install`(含 `--force`、`--lockfile-only`)一律
  报 "Already up to date" 且**不写 importer 条目**。真凶是
  `node_modules/.pnpm-workspace-state-v1.json` 缓存:它记录着首次 install 时
  的 workspace manifests,使 pnpm 跳过重扫。删除该缓存后 install 立即恢复
  正常工作。**教训:同步 vendor 后若 install 行为异常,先删这个状态文件。**
- ⚠️ **坑 2:CI 的 `--frozen-lockfile` 会在干净环境失败**。上面那个「假性
  up to date」也会骗过本机 `--frozen-lockfile`(有 node_modules 时);把
  node_modules 挪走再做干净 frozen install,才暴露出
  `ERR lockfile 缺 schema-form 的两个依赖`。**lockfile 必须带上全部
  StarHub importer 才能过 CI。**
- ⚠️ **坑 3:上游 lockfile 之后的补丁发布会炸 tsc**。非 frozen 重解析把
  `micromark-util-types`(2.0.2→2.0.3)、`micromark-factory-space`
  (2.0.1→2.1.0)、`micromark-core-commonmark`(2.0.3→2.0.4)换成了上游定稿后
  新发的补丁版。2.0.3 的 `Construct`/`Exiter` 签名与
  `mdast-util-from-markdown@2.0.3` 在 `exactOptionalPropertyTypes` 下不兼容,
  同一棵树混两套类型,`packages/client/ui-primitives/src/markdown/parse.ts`
  tsc 直接报 TS2769。**处置:在 `pnpm-workspace.yaml` 的 `overrides` 增加
  StarHub 钉版块,把这三个包钉回上游 lockfile 版本**,冻结安装即复现上游依赖图。
- ✅ 安装后复核:`node_modules` 无 2.0.3 消费者残留;`pnpm install
  --frozen-lockfile`(CI 同款)通过。

## 五、上游破坏性变更适配(runtime invariants 移除,唯一实质断点)

上游 `dsh-v0.2.0-rc.2` 删除 `@deepseek-ai/dsh-invariants` 包及所有
`<pkg>/invariant` 子路径导出(`docs/upgrade-guide/v0.2.0-rc.2/
remove-runtime-invariants/`)。StarHub 侧 9 个插件包 + 2 个兼容垫片包此前
按上游旧包规范各自维护 `./invariant` 伴生插件,本次按官方迁移指南整体移除:

| 面 | 处置 |
|---|---|
| `src/invariant.ts` | 删除 11 个(9 starhub + schema-form + web-react) |
| `tests/invariant.spec.ts` | 删除 4 个(live-context / domain-events / session-registry / schema-form 的 `.client.spec.ts`);client-nav 套件内联测试块一并移除 |
| `package.json` exports | 删 `"./invariant"` 导出(11 个) |
| `package.json` files | 删 `lib/invariant.js`(8 个) |
| `package.json` 依赖 | 删 `@deepseek-ai/dsh-invariants`(dependencies / peerDependencies / devDependencies,按包实际所在 section) |
| `tsconfig.json` references | 删 `../../runtime-diagnostics/invariants` 引用(11 个) |
| `tsdown.config.ts` | client-nav / schema-form / web-react 删 invariant 入口 |
| `tsconfig.base.json` | 删 web-react / schema-form 两条 `/invariant` 别名 |
| `examples/package.json` | 删 `dsh-invariants` 依赖 |

> 迁移坑:tsconfig 的 references 条目是**多行对象**,按行删除会留下空 `{}`,
> `gen-typert`(typert analyzer 解析 workspace tsconfig)随即以
> `Compiler option 'reference.path' requires a value of type string` 失败;
> 且空对象块有「带尾逗号」「收尾」「单行」三种形态,需逐一清掉并去掉 `]` 前
> 悬空逗号。已全树复扫 412 个 tsconfig 确认 0 残留。

其余三篇升级指南评估后确认**不影响 StarHub**:

| 变更 | 结论 |
|---|---|
| `account-sign-in-errors`(no-response) | StarHub 不接账户 API,零影响 |
| `schedule-bundle-retired` | StarHub profile 不用 `dsh-experimental-schedule-bundle`(全仓 0 引用) |
| `subpath-plugin-display-manifest` | 只影响导出 `./子路径/package.json` 的包;StarHub 导出的是包根 `./package.json`,按新规照常生效 |

## 六、运行时契约核对(tsc 抓不到的字符串面)

- ✅ StarHub overlay(`examples/starhub-web/cordis.patch.yml`)引用的三个上游
  行 id 在最新树均在:`webserver`(web-app)、`session-query-sqlite`(base +
  web-app)、`permission`(base);未引用任何被删的 invariants / time-context 行。
- ✅ client-nav 注册的 6 个槽位名在最新 SlotMap 均在:`shell.overlay`、
  `sidebar.panellist`、`main`、`conversation.session.header.actions`、
  `conversation.input.left`、`settings.section`。
- ✅ `package-dsh-runtime.ts` 依赖的上游事实未变:deploy 根包仍是
  `dsh-python-runtime-closure`;`apps/cli/lib` + `apps/cli/config` 仍在。
  上游把 agent 预设改声明式(`packages/bundle/web-app/presets/*.patch.yml`)后
  `apps/cli/config/agent-presets` 目录已不存在,脚本注释中该句已过期,但
  脚本整体复制 `apps/cli/config` 的行为不受影响。
- ⬜ `--profile sdk` 启动链与 Rust 物化 overlay 的真实启动验证见第七节。

## 七、验证清单

| 项 | 命令 | 结果 |
|---|---|---|
| vendor host 构建(gen:typert → tsc → tsdown → desktop bundle) | `pnpm run build:lib:host` | ✅ |
| vendor client 构建 | `pnpm run build:lib:client` | ✅ |
| starhub 包 + 垫片包单测 | `pnpm exec vitest run packages/starhub packages/client/{schema-form,web-react,runtime}` | ✅ 69 spec / 1088 例 |
| sdk/server 单测(notifications 补丁) | `pnpm exec vitest run packages/sdk/server` | ✅ 4 spec / 45 例 |
| starhub-window 构建 | `npm run build:window` | ✅ |
| Rust 检查 | `npm run cargo:check` | ✅ |
| Rust 全量单测(含 dsh runtime 启动链端到端) | `npm run cargo:test` | ✅ 230 passed / 0 failed / 1 ignored |
| 根目录纯逻辑单测 | `npm run test:utils` | ✅ 106 pass |
| DSH runtime 入包(node 下载 + deploy 闭包 + 产物裁剪) | `npm run package:dsh-runtime` | ✅ 514.3 MB |
| CI 同款冻结安装 | `pnpm --dir vendor/deepseek-harness install --frozen-lockfile` | ✅ |

### 已知遗留 / 观察项

- `vite-tsconfig-paths`(上游 devDep 6.x)对 8 个 starhub 包打
  `[tsconfig-paths] An error occurred while parsing …/tsconfig.base.json`
  警告。tsconfck 独立复测该警告不影响解析结果(69 spec 全绿),
  列为观察项;ts 自身解析器(host/client tsc 全过)无此抱怨。
- 上游新增 `packages/telemetry`、`packages/client/product-analytics`、
  `packages/experimental/claude-code-mods`、client shortcuts 等包已随整树
  并入,StarHub 未启用,维持上游默认关闭状态。
