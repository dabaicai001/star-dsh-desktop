# StarHub 沙箱桌面(自研 E2B 式架构)— 设计文档

- 日期:2026-08-28(第四版:客户机 OS 固定 Ubuntu,执行层默认 Docker)
- 目标版本:v0.104.0(Phase 1)
- 状态:草案(待评审,**未提交**)

## 1. 定位:我们自己的 E2B Desktop

### 1.1 需求与拍板

让 AI 操作任意第三方桌面应用(通用 computer-use)。用户拍板的三个方向:

1. **不做本机桌面操作,仿照 E2B Desktop 写自己的桌面沙箱平台**——应用跑在沙箱里,AI 在沙箱内拥有全部操作权限;
2. **整体采用 E2B 架构**(模板→秒级实例→envd→SDK→直播→销毁);
3. **客户机 OS 固定 Ubuntu**——用户已确认目标应用无 Windows-only 需求,Linux 应用即可。

### 1.2 固定 Ubuntu 的连锁收益

| 收益 | 说明 |
|---|---|
| **技术栈 100% 现成** | 箱内软件栈全是成熟开源件:Xfce + Xvfb(虚拟显示)+ x11vnc + noVNC + xdotool(键鼠)+ scrot(截图)——Anthropic 官方 computer-use quickstart 即此组合,**零自研箱内代码** |
| **执行层解放** | Linux 客户机可用容器,WSL2,VM 三档执行层(§3.1),默认 Docker——**Windows Home 版宿主也能用**,Hyper-V 不再是前置条件 |
| **guest-agent 砍掉** | Docker 后端下 `docker exec` 就是 envd、`docker cp` 就是文件通道,自研箱内守护进程整个不需要(§3.3) |
| **模板 = Dockerfile** | 比 golden VHDX 优雅一个数量级,层缓存秒级重建,E2B 模板体验的真正来源 |
| **许可清零** | Ubuntu 自由分发,无 Windows 评估版许可问题;镜像 ~700MB,实例内存 1-2GB 足够 |
| **借力已有资产** | sidecar 已有 Docker 适配器(`sidecar/adapters/docker`),编排不从零写 |

### 1.3 E2B 架构对照终版

| E2B 部件 | StarHub 对应物 |
|---|---|
| Firecracker microVM | **Docker 容器**(隔离弱于 microVM,用 §5.2 加固补;WSL2 / Hyper-V 为可选执行层) |
| 多租户编排层 | 砍(单机应用不需要);本地沙箱池管理器 |
| 模板(Packer/Dockerfile) | **Dockerfile + 配方文件**(声明式:基础镜像、装机层、资源、网络档) |
| 模板→秒级实例→用完即焚 | `docker create/start` ~2 秒;任务独占;`docker rm` 即焚 |
| envd(通用 RPC) | **`docker exec` / `docker cp`**(Docker 后端零自研) |
| SDK | `desktop_*` AI 工具,语义对齐 E2B/Anthropic computer-use 约定 |
| noVNC 直播 | 容器发布 noVNC 端口,StarHub tab 内嵌 noVNC 页面直连 |
| pause/resume/销毁 | `docker pause/unpause` / 检查点(`docker commit` 快照)/ `docker rm` |

### 1.4 Phase 1 范围

- 宿主:Windows / macOS / Linux 全平台(Docker Desktop 或等价物在哪都能跑,**首次实现三平台同性**);
- 执行层:仅 Docker;WSL2 后端 Phase 2,Hyper-V Windows 客户机 Phase 3(留给未来的 Windows-only 需求);
- **编排完全复用现有 Docker 能力(用户已拍板)**:**设置页新增「沙箱平台」选择器,列出工作区已有的全部 Docker 连接(tcp/socket/ssh 三传输皆可,远程 docker-over-SSH 即远程沙箱平台),用户选定的连接 = Ubuntu 容器沙箱平台的落点;未选择时默认本机 Docker**。不引入任何独立的 Docker 连接管理;沙箱实例是该连接下的普通容器,Docker 面板里可见可管;
- 全链路:模板/配方 + 实例池 + `desktop_*` 工具 + noVNC 直播 tab + 任务级授权 + 审计回放。

## 2. 现状与先例

沿用仓库已验证的 AI 浏览器模式(`packages/starhub/tools` + `harness/` 路由):

1. **工具桥**:`packages/starhub/tools`(StarHub 本地插件)`ctx.tools.register(defineTool(...))` 注册,执行体经 SDK stdio JSON-RPC(`starhub/tool.execute`)桥回 Rust 主进程;
2. **宿主路由**:`harness/mod.rs` → `tools::execute_bridge_request` → 按名分发;`desktop_*` 与 `browser_*` 同档在 Rust 内直接执行,**不新增 Tauri Command、capabilities 零改动**;
3. **编排借力**:Docker 调用走 sidecar 现有 `docker.*` 适配方法;**适配器缺口**(Phase 1 先补齐,均为标准方法、不动架构):`docker.createContainer`(完整配置:端口发布/限额/cap-drop/security-opt/卷/network)、`docker.build`(Dockerfile 模板构建)、`docker.cp`(文件出入箱)、`docker.pause/unpause`、`docker.commit`(检查点)、`docker.createNetwork`(restricted 档);已有可直用:connect(tcp/socket/ssh)/list/inspect/start/stop/remove/logs/exec/execSession;
4. **审批**:`approval-bridge` 在 `tools/pre-execute` 分级;**审计**:`harness/events.rs` 前缀映射落库。

## 3. 总体架构

```
AI 会话(dsh)
  │ desktop_* 工具(starhub/tools 新增条目)
  │ starhub/tool.execute {sessionId,name,args}
  ▼
Rust 主进程 harness → desktop 分发(name 前缀 "desktop_")
  ▼
src-tauri/src/desktop/                    新增模块
  ├── mod.rs        DesktopBackend trait + 沙箱语义层
  ├── template.rs   配方解析、Dockerfile 生成、镜像构建/注册
  ├── pool.rs       实例池:创建/绑定任务/到期回收/销毁;
  │                 目标连接 = 设置页「沙箱平台」选择(connId),
  │                 未选默认本机 Docker
  ├── docker.rs     sidecar docker 适配器调用封装
  │                 (createContainer/build/cp/commit/pause + 端口发布);
  │                 远程连接时 noVNC 端口经该连接的 SSH 隧道转发回本机回环
  └── stream.rs     noVNC 端点管理(URL 签发给前端 tab)

沙箱镜像(Dockerfile 模板,镜像仓库目录 sandbox-images/)
  └── Ubuntu 24.04 + Xfce + Xvfb + x11vnc + noVNC/websockify
      + xdotool + scrot + 配方声明的应用层
```

### 3.1 执行层三档(Phase 1 只做 Docker)

| 执行层 | 隔离 | 前置 | 定位 |
|---|---|---|---|
| **Docker 容器(默认)** | 容器级(§5.2 加固) | Docker Desktop / Rancher Desktop,**Home 版可用** | Phase 1 |
| WSL2 | 中等 | Home 版可用,~1s 启动 | Phase 2 备选 |
| Hyper-V VM | 最强 | Pro 版 | Phase 3,预留给 Windows 客户机 |

### 3.2 模板与配方(E2B 的 Template)

- **配方文件**(`*.starhub-sandbox.toml`,纳入资产、可分享):

```toml
name = "ubuntu-ops"
base = "ubuntu:24.04"
memory_mb = 2048
cpus = 2
network = "restricted"            # none | restricted | full
resolution = "1920x1080"
install = ["firefox", "dbeaver-ce"]   #  apt 包名层
provision = ["curl -fsSL … | bash"]   # 任意装机脚本层
```

- 模板构建 = 生成 Dockerfile(基础桌面层固定 + install/provision 追加层)+ `docker build`,层缓存使增量构建秒级;
- 构建产物注册进模板库(SQLite),标注镜像 id 与配方哈希;配方变更即新版本模板,旧实例不受影响;
- **核心模型不变:模板持久、实例一次性**——任务开始 `docker create` 干净实例,任务结束 `docker rm`,模板永不污染。

### 3.3 envd 等价物:Docker 原语直用(零自研代理)

| 能力 | 实现 |
|---|---|
| 通用命令(装软件/启进程/查状态) | `docker exec <sandbox> <cmd>` |
| 文件出入箱 | `docker cp`,或每实例挂一个 `/exchange` 卷(任务结束随实例销毁) |
| 键鼠 | `docker exec … xdotool mousemove/click/type/key` |
| 截图 | `docker exec … scrot`(Xvfb 显示号固定 `:0`) |
| 直播 | 容器内 x11vnc → websockify/noVNC,发布 `localhost:<动态端口>`,StarHub tab 内嵌 noVNC 页面直连,用户可看可接管 |

WSL2 后端(Phase 2)同理:`wsl -d <distro> -- xdotool …`,依然不需要自研代理。**自研 guest-agent 只在 Phase 3 的 Hyper-V Windows 客户机场景才需要**——本期工程量因此大幅缩水。

### 3.4 DesktopBackend 抽象

```rust
trait DesktopBackend {
    async fn screenshot(&self) -> Result<PngBytes>;
    async fn click(&self, p: Point, button: MouseButton) -> Result<()>;
    async fn r#type(&self, text: &str) -> Result<()>;
    async fn exec(&self, cmd: &str) -> Result<ExecOutput>;
    // …全量桌面原语 + 通用命令
}
```

Phase 1 实现 `DockerDesktop`;后续 `WslDesktop` / `E2BDesktop`(接 E2B 云服务,vendor 已有 `packages/e2b` POC)/ `HyperVDesktop`(Windows 客户机)。工具层与审批层只认 trait。

## 4. Phase 1 工具清单

### 4.1 沙箱管理

| 工具 | 说明 | 审批 |
|---|---|---|
| `desktop_list_templates` | 列出可用沙箱模板 | 只读放行 |
| `desktop_create_sandbox` | 从模板创建实例;**隐含任务级授权**,确认卡显示模板名+任务描述+网络档 | 软确认(每次任务一次) |
| `desktop_sandbox_status` | 实例状态/运行时长/已操作次数 | 只读放行 |
| `desktop_pause_sandbox` / `desktop_resume_sandbox` | `docker pause/unpause` | 软确认 |
| `desktop_destroy_sandbox` | 销毁实例(回放归档后) | 软确认 |

### 4.2 感知(沙箱内,只读放行)

`desktop_screenshot`(支持回灌,见 §5.3)、`desktop_list_windows`(`xdotool search` + `wmctrl -l`)、`desktop_get_foreground_window`(`xdotool getactivewindow`)。

### 4.3 操作(沙箱内,任务授权期内全自动)

`desktop_focus_window` / `desktop_click` / `desktop_double_click` / `desktop_move_mouse` / `desktop_scroll` / `desktop_drag` / `desktop_type` / `desktop_press_key`。

参数语义**对齐 E2B/Anthropic computer-use 约定**:`click` 带 `button`;`press_key` 支持 `ctrl+s` 组合键(xdotool key 语法);坐标=最近一次截图的物理像素;界面变化后需重新截图。

### 4.4 万能钥匙(独立确认档)

`desktop_exec`:箱内执行任意命令(`docker exec` 直通)。装软件、启进程、查箱内状态全用它;作为沙箱与「外界逻辑」的交换口,保持每次确认。

### 4.5 人机协同(登录墙/扫码登录场景)

沙箱内应用普遍需要登录,扫码登录、短信验证、密码输入都只能由人完成。机制三件套:

| 机制 | 说明 | 审批 |
|---|---|---|
| **接管模式** | 直播 tab 一键切换「围观 ⇄ 接管」:接管时 noVNC 双向(指针/键盘注入沙箱),用户在沙箱里亲手扫码确认、输密码;**凭据永不经过 AI 工具与审计** | —(用户主动行为) |
| `desktop_request_user_action` | AI 撞到登录墙时调用:`{message, timeoutSeconds}`;前端把沙箱 tab 顶到前台 + 横幅展示 message,用户完成后点「已完成」交还控制,工具返回「用户已完成」或超时 | 任务授权内放行 |
| **登录态沉淀** | `desktop_commit_sandbox`:任务结束(或登录完成)时把实例 `docker commit` 固化为**模板新版本**,下次从新版创建的实例自带登录态——扫码一次,受益永久 | 软确认 |

并发互斥:接管期间 AI 的 §4.3 写操作一律拒绝(返回「用户接管中,请稍后重试」),避免人机抢鼠标;**接管不撤销任务授权**,交还后 AI 恢复全自动。AI 通过截图回灌自行判断二维码过期/登录成功,登录墙处理流程沉淀为内置 Skill 文案。

典型时序:AI 打开应用 → 截图发现二维码登录页 → `desktop_request_user_action("请用手机扫描沙箱屏幕上的二维码登录")` → 用户在直播 tab 看到二维码、手机扫码确认 → 点「已完成」→ AI 截图确认登录成功 → 继续任务 → 结束提示固化为模板新版本。

## 5. 安全模型

### 5.1 任务级授权,替代逐条确认

1. `desktop_create_sandbox` 的确认即**任务级授权**:「允许 AI 在沙箱(模板 `xxx`)中完成:<任务描述>」;
2. 授权期内该会话对该实例的 §4.2/§4.3 工具**自动放行**(approval-bridge 按「会话持有效授权 + 实例 id 匹配」判定);
3. 授权失效条件(任一):实例销毁/暂停、用户撤销、会话结束、超时回收(默认 60 分钟,可配);**用户接管不撤销授权,只暂停 AI 写操作**(§4.5);
4. `desktop_exec` 不在授权内,恒确认。

### 5.2 容器隔离加固(补容器弱于 VM 的部分)

实例启动固定带:`--network` 按档位(none/bridge/自定义受限 bridge)、`--cap-drop ALL`、`--security-opt no-new-privileges`、**禁挂 docker.sock**、内存/CPU 限额、根文件系统只读 + 可写 tmpfs 挂载点白名单(可配)。三道保险:

1. **一次性实例**:任务结束 `docker rm -v`,模板永不污染;
2. **直播围观 + 可接管**:noVNC tab 全程可见,配醒目**停止/销毁**按钮;默认围观只读,用户可一键接管亲手操作(扫码登录等场景,见 §4.5);
3. **网络三档**:none / restricted(默认,自定义 bridge 只放白名单域名)/ full,配方声明、创建确认卡明示。

### 5.3 截图回灌

沙箱屏幕无用户隐私(专为 AI 准备的干净桌面),`desktop_screenshot` 在模型支持图像输入时走 `read_image` 式回灌——computer-use 体验质变关键;不支持时退化文本描述。

### 5.4 审计与回放

- `harness/events.rs` 前缀映射 `desktop_*` → `desktop.action`;`desktop_type` 只记文本长度;`desktop_exec` 记完整命令(箱内执行,审计重点);
- **操作回放**:每次写操作前自动截屏,任务结束生成带标注的胶片式回放(点击坐标圈、输入标记),随任务归档,留存期可配。

### 5.5 明确不做的

- 不做宿主机本地桌面操作(Phase 3 另议,永远恒确认);
- 实例禁挂 docker.sock、禁特权模式,不预留后门;
- Wine 支持 Windows 应用不在本期(社区方案不成熟,等真实需求)。

## 6. 改动点清单

| 位置 | 改动 |
|---|---|
| `src-tauri/src/desktop/` | 新增(§3) |
| `sandbox-images/` | 新目录:基础 Dockerfile + 配方样例 + 构建脚本(并入 `scripts/`) |
| `src-tauri/src/harness/tools.rs` 或 `domain.rs` | `desktop_*` 分发 |
| `src-tauri/src/harness/events.rs` | 审计映射 |
| `src-tauri/src/db/` | 模板库/实例/任务授权/回放归档表;assets 加 `desktop-template` 类型 |
| `packages/starhub/tools/src/index.ts` | `BRIDGED_TOOLS` 追加 §4 全部工具(StarHub 本地包,不动上游) |
| `packages/starhub/approval-bridge/src/index.ts` | 任务级授权判定 + §5.1 分级 |
| StarHub 工作台(React) | 沙箱 tab(内嵌 noVNC + **围观/接管切换** + 求助横幅 + 停止/销毁)、模板库管理页、**设置页「沙箱平台」Docker 连接选择器(默认本机)** + 回收超时/网络档/留存期、资产树「沙箱桌面」分类 |
| `capabilities/` | 零改动 |

## 7. 已知坑与对策

1. **沙箱平台连接失效**:设置页选中的 Docker 连接被删除/不可达时,创建沙箱报明确错误并引导回设置页重选,**不静默回退本机**(用户的平台选择是安全决策——以为在远程沙箱跑、实际落在本机,是不可接受的语义);选择器上标注每个连接的在线状态;
2. **Docker Desktop 前置**:默认本机时做环境自检(适配器 ping),缺则引导安装 Docker Desktop / Rancher Desktop / colima;Linux 宿主原生 docker 直接可用;
3. **远程平台延迟**:docker-over-SSH 上截图 ~100-300ms 起步,computer-use 高频操作体验下降,设置页对远程连接标注「远程平台,操作延迟较高」;noVNC 端口经 SSH 隧道转发回本机回环,不直接暴露远端端口;
4. **noVNC 端口冲突**:发布端口动态分配(`-P`),池管理器记录映射;
5. **xdotool 对个别 toolkit 的兼容**:Xvfb 是纯 X11,无 Wayland 问题;个别 Electron 应用需 `--no-sandbox` 类参数,沉淀进配方样例与踩坑记录;
6. **截图延迟**:scrot 全屏 ~100-300ms,computer-use 节奏可接受;不够再换 x11vnc framebuffer 直读(Phase 2 优化);
7. **分辨率一致性**:Xvfb 分辨率配方固定(默认 1920×1080),截图与坐标系恒一致,**DPI 坑天然不存在**;
8. **镜像首次构建**:基础桌面层构建 5-15 分钟,走 `ssh_exec_background` 同款后台任务 + 进度展示;之后层缓存秒级;
9. **容器时区/中文输入/字体**:基础镜像预装中文字体与 locales,输入法(ibus)进配方可选项,避免 AI 打字中文变豆腐块。

## 8. 测试

| 层 | 内容 |
|---|---|
| Rust 单测 | 配方解析、Dockerfile 生成、池状态机(创建/绑定/回收/销毁)、授权判定、审计脱敏 |
| 集成(手动矩阵) | 建模板 → 创建实例 → AI 全流程「开 Firefox-访问页面-截图-文件出箱」→ 销毁;pause/resume;none 网络档;noVNC 接管 |
| 回放 | 20 步任务回放完整性抽查 |
| 回归 | `cargo check/test`、sidecar `go test ./...`、vendor 侧 `pnpm typecheck` |

Docker 沙箱环境可进 CI(Linux runner 原生支持 docker),集成测试写「自建模板→跑桌面原语→断言截图非空/窗口出现」的冒烟用例。

## 9. Roadmap

| 阶段 | 内容 | 版本 |
|---|---|---|
| Phase 1(本期) | Docker 执行层全链路:配方/模板、实例池、工具集、任务级授权、noVNC 直播 tab、回放、**人机协同(接管模式 / `desktop_request_user_action` / 登录态沉淀,§4.5)**;三平台宿主 | v0.104.0(M0 sidecar 编排能力)+ v0.105.0(M1-M4 全量落地,✅ 已完成) |
| Phase 2 | WSL2 执行层(免 Docker Desktop);`E2BDesktop` 云后端(vendor `packages/e2b` POC 借力);模板市场(配方分享);framebuffer 直读高性能截图 | 视反馈 |
| Phase 3 | Hyper-V Windows 客户机(若 Windows-only 需求出现,届时才需自研 guest-agent);`LocalDesktop` 本机降级(恒确认);UIA/AT-SPI 语义元素树 | 视反馈 |

## 10. 文档同步义务(落地时)

`docs/技术方案.md` 沙箱桌面章节、`docs/架构图.html`、`AGENTS.md`(目录结构 + 技术栈 + 测试表)、踩坑记录、CHANGELOG `[未发布]` + 升次版本。

---

*v4 已落地(v0.105.0):M0 sidecar 编排能力(v0.104.0)+ M1 Rust desktop 模块 /
M2 工具桥与审批分级 / M3 前端(直播 tab、模板管理、设置平台选择器、人工介入横幅)/
M4 截图回灌与回放。实现偏差:实例池未单独抽象(单实例按授权绑定,够用);
`desktop_request_user_action` 不走 dsh://tool-exec 泛化转发,改为专用
`starhub://desktop-user-action` 事件 + `desktop_user_action_reply` 命令(应答链路自有).*
