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

1. ✅ **provisioning 脚本 + host-static dist Config 化**(本批):
   - `scripts/provision-dsh.mjs`:物化 `$DSH_HOME/profiles/desktop/`
     (manifest + `cordis.patch.yml` + `pnpm-workspace.yaml`)、落 10 个 StarHub
     包、落两个 sidecar 二进制与 React 工作台 dist、按 id **行级幂等合并**
     受管 patch 行、写物化清单;
   - `scripts/lib/provision-patch.mjs`:合并纯逻辑(单独成模块才能单测);
   - `vendor/.../examples/starhub-desktop/cordis.patch.yml`:desktop 组合的
     patch 模板——与 starhub-web 模板只差两处:`starhub-bridge` 取代
     `sdk-jsonrpc-server`(两者提供同一对私有服务,同时组合会 fail loud),
     以及部署变化项写成占位符由 provisioning 填;
   - `packages/starhub/host-static` 增加 `windowDist` Config:安装形态下 dist
     不在仓库里,provisioning 把绝对路径写进 patch(遵守上游「No hardcoded
     tunables」——部署变化项是 validated Config,不是插件里的常量);
   - 测试:`tests/provision-dsh.test.mjs` 12 例(合并纯逻辑 6 + 端到端 6)、
     `packages/starhub/host-static/tests/host-static.spec.ts` 3 例。
2. ⬜ **打包 smoke**:用上游 electron-builder 打一个包 → 装到干净机器 →
   跑 provisioning → 起壳 → 断言 9 插件激活 + sidecar 探活 + 工作台可开。
   (上游 `apps/desktop/scripts/smoke-runtime.ts` 是同款路径的实证。)
3. ⬜ **CI 切换**:`release.yml` 的 `tauri:build` 链换成「上游 installer +
   StarHub provisioning」链;`linux-compat.yml` 同步。
4. ⬜ **退役 `src-tauri/`**:删目录 + 清引用(根 `package.json` 脚本、
   `scripts/dev-dsh-shell.mjs`、`scripts/package-dsh-runtime.ts` 的
   `STARHUB_BINARIES_DIR`、CI)。**放在打包 smoke 通过之后**——smoke 需要
   Rust 侧的对照实现做 diff。

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
- `packages/starhub/host-static`:`tsc -b` 零错误 + 3 例新 spec 全绿;
- provisioning 的受管行在 patch 里**各只有一个 `config:` 块**(防摞叠);
- patch 里不出现 `- id: sdk-jsonrpc-server`(bridge 已取代);

## 五、仍挂着的事

- **打包 smoke 未跑**:需要一台干净机器(或容器)装包验证。
- **真机联调(M3-6)**:Android 设备接上后跑 scrcpy H.264 + 接管互斥 + 延迟实测。
- **`npm run cargo:test`(src-tauri 全量)**:机器内存在链接阶段跑不完;
  `cargo check` / `check --tests` 均通过。
- **`ui.alert_test_webhook` 降级**:要不要单独开一个「给 sidecar 加 reqwest」
  的小提交。
- **16 个 `browser_*` 模型面工具**:是否整体删除(连同能力文本契约)单独评审。
