# DSH 升级适配清单(0.1.7-alpha.2 → 0.1.7-rc.1)

> 本文档跟踪 `vendor/deepseek-harness` 从上游 `dsh-v0.1.7-alpha.2`(commit
> `00102833`,2026-09-23)整体同步到 `dsh-v0.1.7-rc.1`(commit `46a7f68b`,
> tag `dsh-v0.1.7-rc.1`,2026-09-24,同时也是上游 master HEAD)的适配过程。
>
> 分支:`chore/upgrade-dsh-0.1.7-rc1`

---

## 〇、核心主旨:仍是「上游原样 + 插件式扩展」

沿用 rc.2 立下的四条解耦铁律(见 `DSH升级适配清单-v0.1.1-rc2.md`):上游源文件
0 改动、StarHub 定制只活在 `packages/starhub/*`、升级 = 整树替换 + 按本清单逐项
核对、能用插件机制表达的绝不复刻上游实现。本次升级**没有新增任何上游文件改动**。

## 一、盘点与备份

- ✅ 拉取上游 `deepseek-ai/deepseek-harness`(注意:`dabaicai001/deepseek-harness`
  这个 fork 停在 `47f9438`、无 tag,**不是有效上游**;有效上游是 `deepseek-ai`)
- ✅ 导出 `dsh-v0.1.7-rc.1` 全树到 `tmp/dsh-0.1.7-rc1`(13302 个文件)。
  **坑:Windows 上 `git archive | tar -x` 无法创建 symlink**(11 个 mode-120000
  条目报 `Invalid argument`),且唯一一个非 ASCII 文件名
  `snapshots/web/present/workspace.expected/说明.txt` 被 tar 按 GBK 解码成
  `璇存槑.txt`。处理:11 个 symlink 用 `git cat-file blob` 取出链接文本、按
  Windows 无 symlink 支持的既有约定(`core.symlinks=false`)物化为普通文件;
  乱码文件名删掉(与 vendored 里既有的正确 `说明.txt` blob 哈希一致,
  `e0f8e326…`,上游树的 octal 转义 `\350\257\274\346\230\216` 即 UTF-8 的「说明」)。
- ✅ 三方差异盘点(路径分隔符统一为 `\`,build 产物 `lib/`/`dist/` 排除):

  | 类别 | 数量 | 处置 |
  |---|---|---|
  | 仅 vendored 有(本地独有) | 322 | **全部保留** |
  | 仅上游有(上游新增) | 66 | **全部并入** |
  | 双方都有且内容不同 | 886 | **全部取上游** |
  | 双方一致 | 13236 | 不动 |

  本地独有的 322 个文件构成:`packages/starhub/*` 207 + `packages/typert/*` 87
  (见下)+ `packages/client/{runtime,schema-form,web-react}` 45(上游早已删除、
  StarHub 保留的兼容垫片)+ `.agents/notes` 36 + `apps/starhub-window` 10 +
  `examples/starhub-*` 4 + `packages/sdk/server/src/notifications.ts`(上游包内
  新增文件式补丁)+ `scripts/*` 7 + 品牌资产 5 + 杂项。

- ✅ **`packages/starhub/*`、`apps/starhub-window`、`examples/starhub-*` 在
  「内容不同」清单里为 0 条** —— 即 StarHub 定制面与上游演进面完全不相交,
  解耦目标达成。

## 二、整树替换

- ✅ `robocopy /E /XO` 把新树覆盖到 vendored(保留 `node_modules`);
  覆盖后校验 13302 个上游文件逐一 SHA256 相同,**0 处不符**。
- ✅ 清理上游已迁走的死文件(否则成为孤儿源码/重复导出):
  - `packages/client/ui-attachment/src/ImageLightbox.{tsx,module.css}` +
    `tests/image-lightbox.client.spec.tsx` —— 上游 rc.1 把 ImageLightbox 从
    ui-attachment **迁到 ui-primitives**(新 `ui-primitives/src/ImageLightbox.tsx`
    + `ImagePreview.tsx`),ui-attachment 改为 `import … from
    '@deepseek-ai/dsh-client-ui-primitives'`;ui-primitives 是 client baseline
    external,无需登记。
  - `packages/runtime-diagnostics/invariants/src/index.{js,js.map,d.ts,d.ts.map}`
    —— 误提交的构建产物(上游该目录只有 `src/index.ts`)。
- ✅ `UPSTREAM_COMMIT.txt` → `46a7f68b… (tag: dsh-v0.1.7-rc.1)`

## 三、根配置补丁重贴(rc.2 时建立,本次升级丢失需重贴)

整树替换会连根配置一起覆盖,以下 StarHub 补丁每次升级都要重贴(已重贴):

| 文件 | 补丁内容 |
|---|---|
| `package.json` | `gen:typert` script + `build:lib:host` 前置 `pnpm run gen:typert` + devDep `unrun@0.3.1` |
| `tsconfig.base.json` | 9 个 `dsh-starhub-*` 显式别名(通配符单捕获不够)+ `dsh-starhub-*` 手写通配 + web-react/schema-form/runtime 三个兼容垫片别名 + `client-file-upload/types` |
| `tsconfig.client.json` | refs 补 `client/schema-form`、`client/web-react`、`client/runtime`、`starhub/client-nav` |
| `tsconfig.host.json` | refs 补 9 个 `packages/starhub/*` |

> 上游 rc.1 自身的变化(非补丁,直接取上游):`package.json` version 0.1.7-alpha.2
> → 0.1.7-rc.1;`pnpm-workspace.yaml` 的 libreoffice-kit 钉版 0.0.1 → 0.1.0。

## 四、构建链适配

- ✅ `pnpm install --no-frozen-lockfile` 通过(343 workspace projects,28s;
  锁文件从上游 alpha.2 基底收敛到 rc.1)。注意 `pnpm-lock.yaml` 是被 robocopy
  覆盖后由 install 重新收敛的,已跟踪。
- ✅ `pnpm run build:lib:host` 通过(含 StarHub 的 `gen:typert` 前置步骤)。
- ✅ `pnpm run build:lib:client` 通过。
- ✅ `npm run build:window`(starhub-window vite 别名表是「手工闭包」,
  见 `踩坑记录.md` §51)**本次净检出无新增断点**——rc.1 未再引入新包,
  `dsh-util-workspace-path` / `dsh-client-store` 两个别名仍然够用。
- ✅ `pnpm exec vitest run packages/starhub`:64 spec / **1008 例全绿**。

## 五、Rust 侧适配(唯一实质断点)

`llm-deepseek` 在 0.1.7 删除了 `protocol` 配置项:

- 上游 `packages/llm/llm-deepseek/src/config.ts:215`
  `if (Object.hasOwn(config, 'protocol')) throw new Error('llm-deepseek: protocol
  is not configurable; remove it and use a Messages-compatible baseURL')`
  —— provider 固定走 Messages 协议(Anthropic 风格 `/v1/messages`)。
- mock server 同步改为服务 `/v1/messages`
  (`packages/test-support/llm-mock-server/src/index.ts:158` "Base URL without
  `/v1`; the endpoint is `/v1/messages`")。
- **StarHub 测试补丁退役**:`src-tauri/src/harness/mod.rs` 的
  `setup_test_dsh_home` 此前生成 `test-protocol.patch.yml`
  (`- id: llm-deepseek / config: { protocol: chat-completions }`)把 mock 的
  chat/completions 扮成 DeepSeek 默认 messages 协议。该 patch 现在会让
  llm-deepseek 整个 entry 激活失败(boot 日志 "3 entries did not activate"),
  agent loop 拿不到 LLM,`dsh_tool_call_bridges_to_host` 断言工具结果事件失败。
  **处置:删除该 patch 生成,`setup_test_dsh_home` 只返回 DSH_HOME**,三个调用方
  (`dsh_stdio_roundtrip_with_mock_llm` / `dsh_tool_call_bridges_to_host` /
  `dsh_boots_with_generated_wrapper_config`)的 `patch_files` 相应去掉一项。

## 六、附带修复:设置重启后失效(v0.125.0,见 `踩坑记录.md` §53)

升级盘点时发现并修复一个**由 0.1.7 引入的回归**(与本次升级无因果关系,但是被
本次「读上游 diff」的工作暴露):DSH 0.1.7 把设置落盘目标从 `$DSH_HOME/settings.yaml`
改到 `$DSH_HOME/profiles/web/cordis.patch.yml`,而 `src-tauri/src/harness/web.rs`
自 v0.95.x 起每次启动都用模板整体覆写该文件 → GUI「通用 / 模型」设置重启后全部
重置。修复与单测见 §53,不属本次升级的 API 适配面。

## 七、`pnpm run test:gui` 结果与遗留项(重要)

升级后首次跑 `test:gui`:**532 个 spec 文件,8 failed / 524 passed;7681 例,12 failed / 7668 passed**。
逐个隔离复跑后归类如下——**没有任何一例是本次升级引入的功能性回归**:

### A. 并行执行争抢(3 例,隔离复跑即过)
`packages/client/connection/tests/binary-rpc.host.spec.ts`(2 例)、
`packages/client/ui-deliverables/tests/review-tab.client.spec.tsx`(1 例)、
`packages/client/ui-primitives/tests/code-block.client.spec.tsx`(1 例)。
单独 `vitest run <这几个文件>` 全部通过。上游 `packages/AGENTS.md` 自己写明
「Specs run concurrently in forked workers beside other gate processes…a spec
that passes only when run alone is a defect in the spec」——这是上游测试自身的
并行缺陷,与 StarHub 无关。

### B. 环境限制(2 例,上游自身测试)
| 用例 | 原因 |
|---|---|
| `ui-deliverables/tests/present-open.host.spec.ts`「refuses final symlinks」 | `EPERM: operation not permitted, symlink` —— Windows 建 symlink 需管理员/开发者模式,本机不具备 |
| `ui-sidebar-documentpreview/tests/document-preview-license-bundle.client.spec.ts`「keeps bundled licenses in the packed lazy chunks」 | `npm_execpath is required to run pnpm on Windows` —— 该用例假设经 `npm test` 启动;经 `pnpm exec vitest` 启动时 `npm_execpath` 为空 |

两例的测试代码与断言都不涉及 StarHub(`packages/client/**` 全组对 `starhub` 零引用)。

### C. 上游新增的样式门禁扫到 StarHub 自己的 CSS(7 例,真实欠债)
rc.1 新增 4 个「全树扫描」样式 spec,扫描范围是 `packages/`(含 `packages/starhub/`),
把 `packages/starhub/client-nav` 里既有的 CSS 欠账翻了出来:

| 门禁 | 违反数 | 内容 |
|---|---|---|
| `ui-theme/elevation-styles`「draws every solid neutral-token border at 0.5px」 | 209 | `border: 1px solid var(--dsw-alias-border-l2)` 等未用 0.5px |
| `ui-theme/elevation-styles`「never pairs an lv/elevation shadow with a neutral border token」 | 19 | 阴影面同时描中性边 |
| `ui-theme/elevation-styles`「draws every filled divider line at 0.5px」 | 1 | `SftpPanel.module.css .menuDivider height: 1px` |
| `ui-theme/corner-shape-styles`「pairs corner-shape: round with every full-round border-radius」 | 24 | 全圆角未配 `corner-shape: round` |
| `ui-theme/scrollbar-styles`「every sheet that scrolls on an elevated surface rebinds」 | 1 | `RedisValueEditor.module.css` 滚动面未 rebind |
| `ui-theme/scrollbar-styles`「each rebinding rule sets the thumb and the hover variable together」 | 1 | `TransferDialog.module.css .fileList` 只设 thumb 未设 hover |

**为什么本次不修**:① 这是 200+ 处的 CSS 重构,带视觉回归风险,远超「升级适配」范围;
② StarHub 的 CI(`.github/workflows/release.yml` 的 "Test frontend and Go sidecar"
只跑 `npm run test:utils` + `go test`,`linux-compat.yml` 只跑 `build:window`)
**不跑 vendor 的 `test:gui`**,不会因此红;
③ 上游自己的 CI 树里没有 `packages/starhub/`,这些门禁在上游是绿的。
按上游 `packages/AGENTS.md` 的规矩(`test:gui` 红在自己没碰的代码上时,既不静默修也不无视,
记入手移清单进下一个 PR 窗口),此处登记为**遗留项**,建议单开一个
`style/client-nav-design-tokens` 分支集中清理。

## 八、验证清单

| 项 | 命令 | 结果 |
|---|---|---|
| vendor host 构建 | `pnpm run build:lib:host` | ✅ |
| vendor client 构建 | `pnpm run build:lib:client` | ✅ |
| starhub 包单测 | `pnpm exec vitest run packages/starhub` | ✅ 64 spec / 1008 例 |
| starhub-window 构建 | `npm run build:window` | ✅ |
| Rust 全量单测 | `npm run cargo:test` | ✅ 221 passed / 0 failed |
| sdk/server 单测(补丁重放后) | `pnpm exec vitest run packages/sdk/server` | ✅ 4 spec / 45 例 |
| vendor GUI 套件 | `pnpm run test:gui` | ⚠️ 见第七节(0 功能性回归,7 例样式欠债 + 5 例环境/并行) |
| cargo fmt / clippy | `cargo fmt --check` / `cargo clippy --all-targets` | fmt 有既存未格式化文件(非本次改动),clippy 0 error |
