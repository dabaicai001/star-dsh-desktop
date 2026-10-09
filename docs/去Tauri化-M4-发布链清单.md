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

- `npm run test:provision`:12 例全绿(含端到端:假 vendor 树 + 假 sidecar +
  假 dist 跑真脚本;重跑幂等;用户 patch 行不被冲掉;缺输入 fail loud 且不物化
  半套);
- `npm run smoke:dsh-desktop`:**五条断言全绿**(开发机实跑,见第 2 节);
- `packages/starhub/host-static`:`tsc -b` 零错误 + 3 例新 spec 全绿;
- provisioning 的受管行在 patch 里**各只有一个 `config:` 块**(防摞叠);
- patch 里不出现 `- id: sdk-jsonrpc-server`(bridge 已取代);
- `sidecarCommand` 是 YAML **数组**(块序列),不是带引号的流序列字符串;
- `src-tauri` 删除后:`npm run sidecar-rust:test` 全绿、`npm run smoke:dsh-desktop`
  全绿、`npm run test:provision` 全绿、`verify:bridge-compat` 全绿;
  仓库里 `src-tauri` / `tauri` 引用只存在于历史文档(CHANGELOG / docs 踩坑记录)。

## 五、仍挂着的事

- **Electron 壳本身的冒烟**:boot 的是宿主进程(上游 smoke-runtime.ts 同款
  路径),Electron 窗口层要等一次真安装包。
- **Linux 不发版(决策 A:等上游)**:上游没有 Linux desktop target,deb/rpm 随
  Tauri 壳退役;`release.yml` 的 linux job 已删,上游出 target 后加回来即可。
- **真机联调(M3-6)**:Android 设备接上后跑 scrcpy H.264 + 接管互斥 + 延迟实测。
- **`ui.alert_test_webhook` 降级**:要不要单独开一个「给 sidecar 加 reqwest」
  的小提交。
- **凭据迁移(§六/R7)**:Tauri SQLite + Keyring → sidecar JSON + dsh credentials;
  src-tauri 已删,SQLite 里的资产数据需要一次性导入工具(见 M2 清单 §六)。
