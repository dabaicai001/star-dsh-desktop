# 去 Tauri 化 M4:发布链(provisioning / 打包 / 退役 src-tauri / CI)

> 配套 `docs/StarHub去Tauri化-迁移立项设计.md` §五「发布与打包」、§四「退役清单」
> 与 §八 M4,以及 M1/M2/M3 三份清单(M3 已完成:Android 直播/接管全链面板化,
> 协议层全验,真机联调待设备)。

## 一、M4 要解决什么

M1/M2/M3 把 StarHub 的全部能力搬进了 dsh 壳(插件 + sidecar + 静态资产),
但**发布链还长在 Tauri 上**:`npm run tauri:build` 打的是 Tauri 壳,而 Tauri 壳
里跑的是 Rust 主进程(`src-tauri/src/harness/web.rs`)——它负责物化 profile、
junction 本地包、spawn 便携 node。壳换成上游 Electron 之后没有 Rust 主进程了,
这两件事必须有人接:

| Tauri 时代 | M4 之后 |
|---|---|
| Rust 主进程在启动时物化 `$DSH_HOME/profiles/web/` | `scripts/provision-dsh.mjs` 在安装后 / 首次启动前做一次 |
| Rust 主进程 junction 9 个本地包 | 同一个脚本把 10 个包拷进 `profiles/desktop/node_modules` |
| Rust 主进程 spawn 便携 node + `bin.js web` | 上游 Electron 壳 spawn 它自己的 desktop-host |
| `tauri:build` 打包(品牌/签名/更新) | 上游 electron-builder 原样分发(接受「shell 与 dsh 永远同版本」) |
| `src-tauri/` 在仓 | M4 末删除 |

## 二、施工顺序

1. ✅ **provisioning 脚本 + host-static dist Config 化**:见上。
2. ✅ **打包冒烟**(开发机实跑):`scripts/smoke-dsh-desktop.mjs`
   —— provisioning 一个一次性 `$DSH_HOME` → 用 `dsh-runtime/` 里的便携 node
   boot 宿主进程 → 断言五条。
3. ✅ **CI 切换**:`linux-compat.yml` → `.github/workflows/ci.yml`
   (PR 门),`release.yml` 的 windows job 换链。
4. ✅ **退役 `src-tauri/`**(本批):删目录 + 清全部引用。
5. ✅ **AI 浏览器整体删除**(用户拍板「整体删除」):16 个 `browser_*` 模型面
   工具 + 4 个 `ui.browser_*` 设置 + 设置页「AI 浏览器」tab +
   `starhub-domain-browser` crate + approval-bridge 的 browser 档位与
   `browser_auto` 定时授权(`autoGrantActive` / `autoGrantMinutes`)一并删除,
   方法面 246 → **226**。理由:上游 dsh 原生提供 browser-use 及其可见面,
   StarHub 重复造一份只会双轨维护;保留方法面而执行体答「归上游」是把
   死面继续暴露给模型。留下三个**与具体域无关**的 `ui.*_ai_model_api_key`
   方法(新模块 `methods/ui_keys.rs`)。反向断言钉住回归:tools spec 断言
   `BRIDGED_TOOLS` 不含任何 `browser_` 前缀工具。
6. ✅ **`ui.alert_test_webhook` 实做**(用户拍板「做」):sidecar 引入 reqwest
   0.12(`default-features = false` + `rustls-tls`,本地 registry 缓存可离线
   装)。当初判「不为一个测试按钮引入 reqwest 全家桶」不划算;现在判「划算」——
   sidecar 已有 tokio runtime,reqwest 只是复用它的连接器,且告警外发本就是
   sidecar 该做的事(归口后不再依赖 Electron 壳是否暴露同类能力)。语义:
   `url` 必填(-32602)、非 http(s) 请求前拒绝、3s 超时、2xx → `{ok,status}`。
   单测与验收都只钉**不摸网络**的两条契约(缺 url / 协议不符),真实外发由
   人工在设置页点一次验证(CI 无外网)。
7. ✅ **凭据迁移:一次性导入工具**(§六 / R7):`scripts/migrate-tauri-data.mjs`
   —— src-tauri 已删,但用户机器上的老数据(Tauri SQLite `starhub.db` + 系统
   Keyring)还在。工具把它搬进 sidecar 自己的存储,并做**双跑期校验**。
8. ✅ **渲染出的 patch 必须是合法 YAML**:provisioning 落盘前用 YAML 解析器
   过一遍(解析器取自 vendor 树,不给仓库根加依赖),并校验受管行恰好各出现
   一次。坏在**非受管行**上才验得出 fail loud——受管行的 config 块会被 merge
   自动修好(详见第 8 节)。

### 第 3 步落地细节(CI 切换)

**PR 门(`ci.yml`,取代 `linux-compat.yml`)** 跑三类能离线验的东西:

| 门 | 命令 |
|---|---|
| 前端纯逻辑 | `npm run test:utils` |
| Go sidecar | `cd sidecar && go test ./...` |
| **Rust 域单测** | `cargo test --manifest-path sidecar-rust/Cargo.toml` |
| provisioning 合并逻辑 | `npm run test:provision` |
| **provisioning + 宿主冒烟** | `npm run smoke:dsh-desktop` |

Rust 门从 src-tauri 的全量 `cargo test` 换成 sidecar-rust 的:前者内存峰值
27GB(本地机都 OOM)。冒烟前置要构建两个 sidecar + 工作台 dist +
`package:dsh-runtime`(冒烟用 `dsh-runtime/` 里的便携 node 启动宿主进程)。

### 第 4 步落地细节(退役 src-tauri)

**先把依赖挪走,再删。** 冒烟与 provisioning 都指着 `src-tauri/binaries/dsh-runtime`
(便携 node + 运行时树),所以第一步是把产物目录挪到仓库根 `dsh-runtime/`:
`package-dsh-runtime.ts` 的 `STARHUB_BINARIES_DIR`、provisioning 的 `--runtime`
缺省、冒烟的 `resolveNode()` 三处同改;`.gitignore` 的忽略项跟着换。挪完立刻
重跑 `test:provision` + `smoke:dsh-desktop` 确认没踩空。

然后删目录与清引用:

| 删 | 原因 |
|---|---|
| `src-tauri/` | Tauri 壳整体退役(246 command / capabilities / 窗口栈 / 打包链) |
| `shell-placeholder/` | Tauri 跳板页(壳没了,没有 webview 要导 URL) |
| `icons/` | Tauri 打包图标(上游 electron-builder 用自己的品牌图标) |
| `scripts/dev-dsh-shell.mjs` | Tauri dev 壳的 beforeDevCommand |
| `scripts/cargo-env.bat` | 只认 src-tauri;`cargo-sidecar.bat` 已取代 |
| `scripts/refresh-icons.ps1` / `verify-linux-bundles.sh` / `build-linux-jammy.sh` / `build-wsl-linux.sh` | 分别服务 Tauri 图标、Tauri 包审计、Linux Tauri 构建 |
| obscura 构建/测试五个脚本 | browser 帧源已在 M3 定稿去掉 |
| 根 `package.json` 的 tauri/cargo/obscura 脚本 + `@tauri-apps/*` 依赖 | 壳没了 |
| `vendor/obscura` 子模块(用户拍板「整体删除」)+ `.gitmodules` | obscura 是 AI 浏览器 `browser.engine=obscura` 后端的载体,AI 浏览器已删;删后 clone 与 CI 的 `submodules: recursive` 少拉 707MB / 2616 个文件。`踩坑记录` §52 与 `已知坑索引` 第 52 条作为历史记录保留 |

`release.yml` 的 linux / linux-legacy 两个 job **整体删除**(决策 A:等上游出
Linux target,不保留禁用僵尸);`publish` 的 `needs` 只剩 `windows`。

**升版同步从七处降到四处**:`package.json` / `CHANGELOG.md` / `AGENTS.md` /
`README.md`——原 `src-tauri/Cargo.toml`、`Cargo.lock`、`tauri.conf.json` 三处
随壳消失,`scripts/bump-version.mjs` 的三步删除、编号重排。

**发布链(`release.yml` windows job)**:

- `npx tauri build --bundles nsis` → 上游 `package:win:x64:unsigned`
  (electron-builder 原样用;签名/公证是上游的品牌与更新栈);
- 新增两步:「Smoke: provisioning + host boot」与「Provision StarHub into the
  packaged shell」——CI 里先验一遍装的顺序与内容;
- 产物路径换成 `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts`。

**Linux 发布路径没了——这是上游能力的边界,不是漏做。** 上游桌面壳的
`SUPPORTED_TARGETS` 只有 `mac-arm64` / `mac-x64` / `win-x64`,没有 Linux
target;原来 Tauri 链产出的 deb/rpm 没有对应物。`linux` 与 `linux-legacy`
两个 job 原样保留但 `if: false` 禁用、并不进 `publish` 的 `needs`(否则发布
永远起不来)。待决策:要么上游出 Linux target,要么单独立一条 Linux 打包路径。

### 第 4 步补记:根 lock 与 package.json 长期不同步(`npm ci` 第一行就红)

删 `@tauri-apps/*` 依赖时只改了 `package.json`,**没重新生成
`package-lock.json`**——而那份 lock 从 v0.96.5 起就没重新生成过(那之后
`@codemirror/state` / `@codemirror/view` 等区间在 package.json 里被提过),
于是 `npm ci` 报 `Invalid: lock file's @codemirror/state@6.6.0 does not
satisfy @codemirror/state@6.7.1` 直接 EUSAGE 退出。`ci.yml` 与 `release.yml`
的第一行「Install frontend dependencies」就红,后面九步全跑不到——**本地因为
`node_modules/` 早已存在、从不跑 `npm ci` 所以发现不了**。

顺着查下去发现根目录那一整套依赖本来就是死重:React 工作台搬进
`vendor/deepseek-harness/apps/starhub-window` 之后,`build:window` 走的是
vendor 自己的 pnpm workspace,根 `scripts/` 与 `tests/` 只 import node 内置
模块加 `typescript`(单测现编译 vendored TS 用)。所以不是「重新生成 lock」,
而是**连依赖带 lock 一起清**:根 `package.json` 清空 `dependencies`、
devDependencies 只留 `typescript`;顺带删掉同样已失效的 `test` / `test:watch`
脚本(vitest 在仓库根既没有 config 也没有 `src/`,真跑起来会把 `vendor/` 一起
glob)、死文件 `tests/linkage.test.ts`(mock `@tauri-apps/api`、import 早已不
存在的 `@/services/linkage`)、v0.72.2 Vue 时代遗留的根 `pnpm-lock.yaml`。
`package-lock.json` 3731 行 → 29 行。

**教训**:lock 是与 package.json 同生共死的产物,删/提依赖的那一次就要一起
重新生成;只改一边的后果是「本地永远绿、CI 第一步就红」。判断根目录还有没有
死依赖的办法很土但可靠:grep 全部 `scripts/` 与 `tests/` 的 import,看有谁
真的从根 `node_modules` 解析。

### 第 2 步落地细节(打包冒烟)

不拉 Electron,直接 boot 宿主进程——上游 `apps/desktop/scripts/smoke-runtime.ts`
就是这么验「Host 启动 + 外部插件」的,同款路径。要证的只有一件事:
**provisioning 装好的组合能真的跑起来**。

```
node scripts/smoke-dsh-desktop.mjs [--keep] [--port <n>] [--timeout <ms>]
```

断言五条:

| 断言 | 证明什么 |
|---|---|
| `GET /starhub-react/` 返回工作台 index.html | host-static 用上了 provisioning 注入的 `windowDist`(安装形态没有仓库可回退) |
| `POST /starhub/api/invoke get_assets` → `{ok:true,result:[]}` | bridge 真的 spawn 了 sidecar 并打通 JSON-RPC |
| 未知命令 → `{ok:false,error}` 含 `method not found` | bridge 的 `ui.` 前缀 + 错误通路 |
| `GET /starhub/api/events` 是 SSE 流 | 工作台事件面的共享连接 |
| `db_mysql_test` 走到连接失败 | **Go sidecar 活着**(Rust 侧 lazy start 它) |

**冒烟实测抓到的三个真 bug**(都已修,前两个有测试钉住):

1. **`sidecarCommand` 被 YAML 解析成字符串而不是数组。** 模板里写成
   `sidecarCommand: '@@占位符@@'`,provisioning 把占位符换成
   `["C:\\...\\starhub-sidecar-rust.exe"]`——引号让 YAML 把它当字符串,桥的
   Config 校验直接报 `expected array but got [...]`,插件 fail loud,连带
   `starhub-session-registry` / `starhub-domain-events` 因等不到
   `sdk-notifications` 全部 pending。改成 **YAML 块序列 + 单引号**(Windows
   反斜杠在流序列里要靠引号转义,整行再加一层引号就有这个歧义)。
2. **`--port` / `--host` 静默失效。** 首次物化直接落地模板,而模板里的
   `webserver` 行是文档性缺省(`port: 0`)——构造好的受管行从没被合并进去。
   改成首次物化也过一遍 `mergePatchRows`。
3. **`tool-session-query` failed to import。** 它被 patch 的 insert 块按包名
   引用,但不在 dsh CLI 的依赖闭包里;`$DSH_HOME` 又不在安装树里,Node 解析不到。
   Rust 侧的答案是把这类包 junction 进 `profiles/node_modules`
   (`RUNTIME_HOSTED_PATCH_DEPS`)——provisioning 照样做:新增 `--runtime`
   指向打包好的 dsh 运行时,从它的 `node_modules` 里拷。

另有一个环境坑记录在案:CLI 入口用 `import.meta.main` 自决是否执行,该特性要
Node ≥24.2。本机开发的 node v24.0.0 会让它静默退出 0(不报错、不输出),冒烟
因此必须用**打包进去的便携 node**(v24.19.0)——这也更接近生产,desktop 宿主
spawn 的就是它。

## 三、本批的关键决定

### 3.1 拷贝而不是 junction

Rust 侧 junction 指向构建树,升级/换安装目录会让旧 junction 钉死上一次的路径
(漂移),要额外写 `ensure_dir_link_fresh` 兜底。安装形态下包本来就要随安装包走,
**拷贝没有目标可漂移**;重跑时按清单比对,内容变了就地刷新。每个包只搬
`package.json` + `lib/`(运行时段;`src/`、`tests/`、`node_modules/` 不入包)。

### 3.2 patch 行级幂等合并,不是整体覆盖

`cordis.patch.yml` 同时是 dsh 设置体系的落盘目标(GUI「通用 / 模型 / 权限」
经 `ConfigEditor` 直接写它),整体覆盖会把用户设置全重置(v0.122.0 回归,Rust 侧
`materialize_profile_patch` 同样的教训)。也因为文件里可能有 `!!js` 表达式,
不能 YAML 解析再序列化——逐行扫,命中受管 id 就把 `config:` 块整块替换,其余
字节原样保留。受管行只有三个:`webserver` / `starhub-bridge` / `starhub-host-static`。

> 实现里踩到并修掉的一个真 bug:旧 `config:` 块必须**先跳过再写新块**。
> 第一版在 `- id:` 行之后立刻找 `config:`,而真实模板里 `name:` 在 `config:`
> 之前——于是每次重跑都在旧块后面再摞一个 `config:`,重跑不幂等。测试
> 「每个受管行只能有一个 config 块」钉住这一点。

### 3.3 bridge 取代 sdk-jsonrpc-server

两者提供同一对私有服务(`sdk-transport` / `sdk-notifications`),同时组合会在
加载期 fail loud(duplicate service)。Tauri 壳里应答方是 Rust 主进程所以走
`sdk-jsonrpc-server`;desktop 壳里没有 Rust 主进程,应答方换成 bridge 插件
spawn 的两个 sidecar。

### 3.4 端口缺省 0

`port: 0` = 让内核分配空闲端口,desktop 宿主把实际 URL 经 stdout 回给 Electron
壳(上游 `smoke-runtime.ts` 同款)。需要防火墙放行的部署再用 `--port` 钉死。

## 四、验收口径

- `npm run test:provision`:**13 例全绿**(含端到端:假 vendor 树 + 假 sidecar +
  假 dist 跑真脚本;重跑幂等;用户 patch 行不被冲掉;缺输入 fail loud 且不物化
  半套;**渲染出的 patch 不是合法 YAML 时 fail loud 且不落盘**);
- `npm run test:migrate`:9 例全绿;
- `npm run smoke:dsh-desktop`:**五条断言全绿**(开发机实跑,见第 2 节);
- `packages/starhub/host-static`:`tsc -b` 零错误 + 3 例新 spec 全绿;
- provisioning 的受管行在 patch 里**各只有一个 `config:` 块**(防摞叠);
- patch 里不出现 `- id: sdk-jsonrpc-server`(bridge 已取代);
- `sidecarCommand` 是 YAML **数组**(块序列),不是带引号的流序列字符串;
- `src-tauri` 删除后:`npm run sidecar-rust:test` 全绿、`npm run smoke:dsh-desktop`
  全绿、`npm run test:provision` 全绿、`npm run test:migrate` 全绿、
  `verify:bridge-compat` 全绿;
  **`npm ci` 本身可用**(lock 与 package.json 同步,见第 4 步补记——这道在
  M4 之后一直是红的,CI 第一行就退);
  仓库里 `src-tauri` / `tauri` 引用只存在于历史文档(CHANGELOG / docs 踩坑记录);
- `npm run test:migrate`:9 例全绿(资产/设置/告警/审计/known_hosts 五种线形状、
  密钥导出与裸字符串归一、双跑期校验抓「条数不一致」与「内容不一致」、重跑
  幂等不产生第二份 .bak、dry-run 不落盘、审计修剪到 5000 保留最新、缺库
  fail loud)。

### 第 8 步落地细节(渲染出的 patch 必须是合法 YAML)

provisioning 的行级合并是**字符串操作**:拼出非法 YAML(缩进错、引号不闭)不会
在合并时暴露,只会在壳启动时炸出一句 `failed to parse overlay`——那时候用户已经
在装机界面了。因此落盘前先用 YAML 解析器过一遍,并顺带校验受管行恰好各出现
一次(多一次 = 合并逻辑回归,少一次 = 模板被改坏)。

解析器从 vendor 树取(`vendor/deepseek-harness/node_modules/js-yaml`,上游闭包
自带),不给仓库根加依赖;取不到就**跳过**校验而不是失败——校验是加固,不是门槛。

有一个反直觉的发现值得记下来:受管行的 **config 块缩进错乱会被 merge 自动修
好**(合并本来就整块重排 config),所以「坏在受管行上」验不出 fail loud。测试
因此坏在**非受管行**上(未闭合的单引号)——那才是合并管不到的地方。

## 五、仍挂着的事

- **Electron 壳本身的冒烟**:boot 的是宿主进程(上游 smoke-runtime.ts 同款
  路径),Electron 窗口层要等一次真安装包。**发布链本身也刚刚才第一次真正跑
  起来**——见下面「补记:CI 与发布链曾经一次都没跑过」。
- **Linux 不发版(决策 A:等上游)**:上游没有 Linux desktop target,deb/rpm 随
  Tauri 壳退役;`release.yml` 的 linux job 已删,上游出 target 后加回来即可。
- **真机联调(M3-6)**:Android 设备接上后跑 scrcpy H.264 + 接管互斥 + 延迟实测。
- **凭据迁移的 Keyring 半边**:Windows 凭据管理器没有官方 CLI,需用户在旧壳
  导出 `--secrets-export`(工具已支持并在报告里列出读不到的 key_id);dsh
  credentials 服务作为密钥长期归属仍未接线(§六)。

### 补记:CI 与发布链曾经一次都没跑过(v0.128.1 修)

M4 第 3 步把 `linux-compat.yml` 换成 `ci.yml`、重写 `release.yml` 时,步骤名
写成 `- name: Smoke: provisioning + host boot`——值里那个 `: `(冒号加空格)
在 YAML 里是映射条目分隔符,整份文件非法。GitHub 加载不了工作流文件,于是
**一个 job 都不起、秒级 failure**,只留一句「This run likely failed because
of a workflow file issue」,没有任何步骤日志。从 2026-10-09 到 2026-10-10
被发现为止,CI 门和发布链一次都没真正跑过;`v0.128.0` 的 tag 也没产出任何
Release(上一个 Release 还是 v0.126.0)。

**本地发现不了,因为本地从不跑 CI**——那期间所有「绿」都是本机单测的绿
(`test:provision` / `test:migrate` / `smoke:dsh-desktop` 都是直接 node 跑,
不经过 GitHub)。这条坑值得记住:**「工作流文件合法」和「CI 真的在跑」是两件
事**,前者只能在 GitHub 的 Actions 页上确认,或者像现在这样加一道
`npm run test:workflows`(新增 `tests/workflows-yaml.test.mjs`,断言每个工作流
是合法 YAML 且至少有一个 job,并扫描所有裸标量值里的 `: `)在最早、最便宜的
位置拦住。

顺带还修了一个同源问题:release.yml 提取 Release 正文的 awk 用整行相等去匹配
版本标题(`$0 == "## [0.128.0]"`),而标题长这样:`## [0.128.0] - 2026-10-10`
(带日期)——永远不相等,`RELEASE_NOTES.md` 恒为空,Release 看着成功、点开没
正文。改成前缀正则,并把「提取为空」从 warning 升成 error。
