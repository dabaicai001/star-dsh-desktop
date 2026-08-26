# 更新日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/) 规范。

## [未发布]

### 计划中
- Settings 补「代理」「安全」2 个 tab
- SQL 查询结果可编辑及无主键报错提示（转 K3）
- 左侧 dsh 会话列表右键「删除」待 dsh host 侧 session.delete RPC 落地后启用(当前置灰,仅归档)

---

## [0.98.1] - 2026-08-26

### 已完成
- 🐛 壳内文件查看窗/文件信息弹窗被上游 Modal 默认宽 `min(380px, 100%)` 覆盖,缩成窄窗且长内容无法滚动:`.viewer` 与 `.dialog` 宽度加 `!important`,FileInfoDialog 经 `contentClassName` 让内容区撑满固定高度并承接滚动。
- 🐛 关闭工具面板(点遮罩/空白/×)未复位文件树视图:下回点会话头部「文件」胶囊走的是 `closeFileTree` 而非 `openFileTree`,看起来没反应;`closeTools` 现同时 `fileTree.close()`。
- 🐛 设置里出现两个「打开配置文件」:上游 `ui-settings-general` 的原生打开按钮与 StarHub 壳内按钮并存——starhub-web profile 给 `api-gateway` 设 `nativeOpen: false`,让上游 `hasDocument` 为 false 不再渲染,只留壳内(对齐 Read/Edit 弹框)按钮;并把 `dsh_settings_path` 补进 `commands.toml` ACL,消除「Command … not allowed by ACL」报错。
- 🔧 `starhub-tool-context` 改为**会话级作用域**:绑定 `@` 资产时记录触发会话 id(`sessionId`),host 侧 pre-step 只对 `agent.session.id` 一致的会话注入,普通对话/其它会话不再带上下文。
- 🔧 移除工具面板头部「AI 助手」图标按钮(用户红框标出,非必要入口);对应注入字段与测试断言一并删除。

## [0.98.0] - 2026-08-26

### 已完成
- ✨ 设置「打开配置文件」改为**壳内打开并支持编辑保存**:新增 Tauri `dsh_settings_path` 返回 `settings.yaml` 路径,StarHub 插件注册 `settings.action`(plugin 形式,不改上游工具视图)经 `starhubFileViewer` 在壳内打开;对话 Read/Edit 工具卡文件名点击同走壳内文件查看窗(改 `ui-conversation/openFile` 优先 `starhubFileViewer`,回退原生打开器)。
- ✨ 侧栏底部「工具」入口图标/字号与「设置」对齐(wide 16px + 14px label,42px 行高)。
- ✨ 工具面板头部新增「+」新建连接按钮,移除底部「新建连接」;文件树视图不再叠加重复的「StarHub 工具」标题栏。
- 🐛 修复侧栏工具面板顶栏「+」、工具抽屉子类行、文件树头部按钮逻辑(不再双标题栏、视图切换正确)。
- 🐛 修复工具面板/文件树/文件信息弹窗无法上下滚动(flex 撑满 + overflow 修正)。
- 🐛 AI `@` 菜单工具图标被挤压竖排:工具徽标改短词(SSH/DB/Docker/本机)+ 菜单 `.itemIcon` 放宽为单行(nowrap)。
- ✨ 设置「插件」tab 改名「插件市场」。
- 🔧 `starhub-tool-context` 仅在 `@` 引用工具时注入(移除工具面板/子类选择的自动同步),避免每条对话都带上下文。
- 🔧 记忆功能默认保持关闭(与设计一致),不做自动默认记忆模型;记忆生效需在「设置 → AI 助手」显式勾选「启用长期记忆与自动沉淀」并配置记忆模型。

## [0.96.5] - 2026-08-26

### 修复
- 🐛 **根治「安装版启动即 Failed to load plugins、换回老版本也启动不了」**:`healProfilesModuleFallback`(dsh-app-boot profile.ts 的 `ensureSymlink`)对 `$DSH_HOME/profiles/node_modules` 下**非符号链接的真实目录**原先 fail-loud 抛错(`exists and is not a symlink`),导致 dsh web 进程启动即退出、GUI 报「failed to import loader entry … client-modules: bundle script … failed to load」。该污染(旧版本复制回退残留 / 杀毒或云同步把 junction 解引用成普通目录 / 中断安装)持久存在于 DSH_HOME,任何版本启动都会在同一处崩溃——**这解释了「换回老版本也启动不了」且清理 AppData 前无法自愈**。修复:`ensureSymlink` 遇到非符号链接条目改为**隔离备份**(改名为 `<name>.dshbak-<timestamp>`,不删除用户数据)后重建 junction,启动继续、下次 heal 保持正确链接;隔离/重建失败仍 fail-loud 兜底。配套:`profile.spec.ts` 原「real directory 抛错」用例改为「隔离 + 重建 + 数据保留 + 不重复备份」自愈断言,app-boot 106 例全绿。
- 🐛 修复安装版启动偶发「Failed to load plugins」(点名 `@deepseek-ai/dsh-session-log-export`)回归:v0.83.2 的客户端 bundle 加载退避重试补丁(方案 §11.9 第 5 条)在 2026-08-25 的 DSH rc.2 整树同步中被上游原版覆盖丢失,`defaultLoadBundle` 退回单次抓取,启动时 webview 撞上 dsh web 进程更替窗口即永久拒启动。已在 rc.2 源码上重施同一补丁(`packages/client/modules` 的 `system.ts` 拆出 `fetchBundle` + `BUNDLE_RETRY_DELAYS` 300ms/1200ms 共 3 次尝试,`manifest.ts` 两处 `loadBundle` 契约注释,`loader.client.spec.ts` 重试成功/耗尽两用例,client-modules 52 例全绿);并在 `docs/DSH升级适配清单-v0.1.1-rc2.md` 新增「升级后补丁重放记录」+ 方案 §11.9 第 5 条标注「整树替换后必须重放」,防止下次升级再丢。

## [0.96.4] - 2026-08-26

### 修复
- 🐛 长期记忆「自动沉淀」从不生效:memory-sink 的 `countMessages` 用错事件词表(`message/user` / `message/assistant` → dsh 实际的 `user/message` / `assistant/message`),导致 `shouldReview` 恒为 false、自动沉淀从不触发。
- 🐛 工具面板(StarHub 工具抽屉)子类行死胡同:空态分支原先不渲染「终端 / 数据库 / Docker」子类行,导致永远无法选中任何子类;改为子类行始终渲染(空态仅提示)。
- 🐛 会话头部「文件树」按钮开错面板:原先 `layout.openDetails()` 打开的是 ui-conversation 独占的工具调用详情列,与文件树本体(渲染在工具抽屉内)不接通;改为打开工具抽屉并切到文件树视图。
- 🐛 文件树根目录 cwd 由注入期快照改为经 `useSessions` 响应式读取,避免切换会话后文件树仍指向旧工作区。

### 变更
- 🐛 AI 助手记忆设置改造:删除「存档 tool 消息与工具调用」「记忆写入需逐条确认」两个已退役开关(此前只是 UI 层状态、无真行为),「启用长期记忆」与「自动沉淀记忆」合并为单开关「启用长期记忆与自动沉淀」(host 侧 `enabled` 与 `autoReview` 同值下发)。
- 🔧 清理死代码 `createStarHubNavStore`(rc.2 迁移后已无消费者)与相关过时注释/README。
- 🐛 修复 `client-nav` 客户端包 bundle-purity 违例(此前无法跑通 tsdown 全量构建):`AiChatPanel` 值导入 shell 侧 React 胶水 `@deepseek-ai/dsh-client-web-react` 的 `bindSnapshotSelector`,改为 React 内置 `useSyncExternalStore`(react 是基线 external),并从 `package.json`/`tsconfig.json` 移除对 web-react 的依赖。

---

## [0.96.3] - 2026-08-25

### 已完成(随下次代码版本发布)
- 🔧 GitHub 仓库更名为 `star-dsh-desktop`:`git remote`、README 下载/克隆链接、CHANGELOG 仓库地址、AGENTS.md 仓库信息、关于页 GitHub 链接、Tauri Updater 端点全部切换至新仓库名(旧地址仅剩 GitHub 自动重定向)。
- 🔧 DSH 内核升级到上游 v0.1.1-rc.2 的适配收尾:补回 `tsconfig.base.json` 缺失的 `dsh-client-web-react` 与 10 个 `dsh-starhub-*` 显式 paths 映射(修复测试把包解析到 node_modules lib 的连锁失败)、补回 `web/tsconfig.json` 丢失的 5 个 project references、恢复 `loader-status.ts` 升级时丢失的 `KernelSignal`/`createSignal`/`createLoaderStatusStore` 实现(修复 client typecheck 6 个错误)、修正 2 个此前从未真正运行的测试断言。回归:host typecheck / client typecheck 双零错误,host 单测 145 过、client-nav 857 过、Rust 164 过。已知限制:tsdown 全量构建需 Node `^22.19||>=24`(本机 22.14 下不可用),lib/ 产物被 .gitignore 忽略,换环境需重跑 tsc + `emit-typert-remotes.mjs`(详见 docs/DSH升级交接说明.md)。

## [0.96.1] - 2026-08-25

### 修复
- 🐛 AI `@` 直连堡垒机(如阿里云 BastionHost 公网入口,host 即堡垒机、未配跳板机)验证码通过后报错:堡垒机 pty 判定 `is_bastion()` 原先强制要求 `jump_host`,直连堡垒机 + kb-interactive MFA 资产被漏判,AI exec 走普通通道被服务端拒绝(Channel send error)。改为只认 kb-interactive 启用,直连与跳板两种形态都走「带 pty 选机器」路径;菜单为空(普通 MFA 服务器无选机器菜单)时跳过选机器直接执行命令,不再卡在无人应答的选机器浮层。

### 变更
- 🔧 移除 `linux-legacy-2204.yml`(Ubuntu 22.04 / glibc 2.35 无截图兼容版构建),后续 Release 不再附 `-ubuntu2204` 包。

---

## [0.96.0] - 2026-08-25

### 新增
- 🎉 Ubuntu 22.04 / glibc 2.35 兼容版：截图栈 `xcap → pipewire/libspa 0.10.1` 需系统 PipeWire ≥ 1.0，把 Linux 构建基线抬到 `ubuntu-24.04`(glibc 2.39)后旧系统装不了。为回归旧系统兼容，把 Rust 截图功能整体 gate 到新的 `screenshot` Cargo 特性（默认开启，保留主版本截图），并新增 `linux-legacy-2204.yml` 用 `ubuntu-22.04` runner 以 `--no-default-features` 构建**无截图**的 glibc 2.35 兼容 DEB/RPM（文件名带 `-ubuntu2204` 后缀，随 tag 附到同一 Release）。代价：内置 AI「区域截图」在兼容版不可用，前端按钮点击给出友好提示（命令未注册归并为「当前版本未编译截图功能」）。

## [0.95.5] - 2026-08-25

### 修复
- 🐛 新机首次安装启动窗口无响应、报「dsh 没有在运行」、第二次才正常:setup 里 `block_on` 阻塞主线程跑完 db+sidecar+dsh web 启动(冷启动可能超 30s 就绪上限),期间窗口消息循环停摆 → 「无响应」;dsh web 超时被杀后 `dsh_web_url` 只读状态不重启 → 卡死在跳板页「dsh web 未运行」需手动重开应用。修复:① setup 改用 `async_runtime::spawn` 后台拉起,窗口立即响应;② `dsh_web_url` 改调幂等 `ensure_started`,跳板页轮询在首启失败后自动重启自愈,无需重开;③ 就绪超时 30s→60s 留足首启冷启动余量。

## [0.95.4] - 2026-08-24

### 修复
- 🐛 区域截图向右/向右上斜拖拽经常「断触」、只截出一小块:遮罩页拖拽用裸 `mousedown/mousemove/mouseup` 且 `mouseleave` 即结束拖拽、无 pointer capture——指针一旦划过叠在画布上的右上角 ✕ 退出按钮(`#exitBtn`,34×34,未设 `pointer-events:none`)或工具栏,`mousemove` 立即停止、选区当场冻结成当时大小(「只截一小块」),在 ✕ 上松手甚至触发 click 直接取消整次截图;向右/右上方向的拖拽必然经过右上角,向左/向下从不经过,这正是方向差异的来源。改为 Pointer Events + `setPointerCapture`(align 踩坑记录 #10 约定):capture 后 move/up 始终派发给画布,划过 ✕/工具栏或离开窗口也不中断;画布补 `touch-action: none`,阻止 WebView 把手势判定为滚动/平移(触屏「断触」根因);删除 `mouseleave` 结束拖拽的脆弱路径,`pointercancel` 兜底收尾。

## [0.95.3] - 2026-08-24

### 修复
- 🐛 GitHub Linux 构建失败根因修复(截图栈依赖链版本错配):`xcap 0.9.8 → pipewire/libspa 0.10.1` 要求系统 PipeWire/spa 头 ≥ 1.0,而 `libspa-sys` 的绑定是构建时用 bindgen 从系统 spa 头生成的,ubuntu-22.04 的 0.3.48 头缺 `spa_video_info_raw.flags`、`modifier` 还是 `int64`,且 `spa_meta_region_is_valid`/`spa_meta_first` 仅是宏(bindgen 无法导出成可调用函数)→ `cargo test --locked` 编译 libspa 报 E0425/E0560/E0308 共 7 错(exit 101);Windows 用 WGC 后端不碰该链所以绿。修复:Linux 构建基线升 `ubuntu-24.04`(PipeWire 1.0.5,meta 函数已是 static inline、链接层安全),glibc 下限 2.35 → 2.39,README / 技术方案 / 踩坑记录 / 已知坑索引同步。
- 🐛 Linux 旧系统(Ubuntu 22.04 等 PipeWire < 1.0)点击截图不再静默失败:主进程 `screenshot_begin_region` 在隐藏主窗口前预检 `pipewire --version`,过旧直接返回「截图功能需要系统 PipeWire ≥ 1.0(Ubuntu 24.04 及以上),请升级系统后重试」;前端截图按钮失败从仅 console 改为可见 toast(`role=alert`,4s 自动消失),并补 `screenshot-button.client.spec.tsx` 覆盖。
- 🐛 Linux x86_64 链接失败修复:截图栈 Wayland 后端 `libwayshot-xcap` 依赖 Rust `gbm 0.18`(FFI 链接 `-lgbm`),构建机缺 `libgbm-dev` → `rust-lld: unable to find library -lgbm`;`linux-compat.yml` / `release.yml` apt 依赖按 xcap 官方 Linux 清单补齐(`libxcb1-dev libxrandr-dev libdbus-1-dev libwayland-dev libegl-dev libgbm-dev`)。

## [0.95.2] - 2026-08-24

### 修复
- 🐛 会话头部 git 分支胶囊对外部分支切换不再延迟显示:挂载后每 10s 轮询当前分支、页面重新可见时立即刷新、打开面板顺带刷新——在其它终端/编辑器 checkout 后胶囊自动更新,不再需要切换会话才刷新。
- 🐛 GitHub Linux 构建修复:截图栈 xcap 的 `libspa-sys` 需要 PipeWire 系统库,`release.yml` / `linux-compat.yml` 的 apt 依赖补 `libpipewire-0.3-dev` + `libspa-0.2-dev`(此前 Linux 构建在 `libspa-sys` build.rs 报 `Cannot find libraries: PkgConfig(libpipewire-0.3)`)。

## [0.95.1] - 2026-08-24

### 修复
- 🐛 右侧栏「文件树」与侧栏子类互斥(点哪个哪个在上面):文件树打开时点击侧栏「终端 / 数据库 / Docker」子类,自动切回该子类的资产列表——此前文件树一直压着资产列表,点子类无任何反应。
- 🐛 文件信息弹窗改为与 Read 卡同尺寸的大对话框;内容预览复用 ReadBlock(行号 gutter + 语法高亮 + 复制 + 展开/收起),截断提示改「内容预览(仅开头 8KB)」,空文件显式提示。
- 🐛 SSH MFA 分场景修复:① keyboard-interactive 非 TOTP 提示不再一律预填 MFA 主密码——仅密码类提示预填,「选择机器」等菜单提示留空由用户输入(堡垒机「验证码 → 选机器 → 进机器」流程不再因密码误填而卡住);② 跳板机腿支持 keyboard-interactive MFA(复用资产 kb 配置:堡垒机在跳板段完成密码+验证码+机器选择;跳板机不要求 kb 时不弹窗)。
- 🐛 approval-bridge 风险门补只读清单漏洞:find/ip/journalctl 曾因首词在只读清单被直接放行,`find -delete`、`ip link del`、`journalctl --vacuum` 等删除/变更命令漏拦——新增对应风险词一律 ask。
- 🛡️ **SSH/Docker 删除类操作与权限预设脱钩(死规定)**:风险门新增 `hard` 档——`rm`/`find -delete`/`ip link del`/`journalctl --vacuum`/Docker 删除类/`DROP`/`TRUNCATE`/Redis `DEL` 等风险词命中,即使会话审批策略为 never(「全访问不弹审批」预设)也必须弹确认卡,绝不静默放行;仅普通写操作档随 never 放行。
- 🛡️ Docker `@` 引用特别标注:候选徽标「Docker⚠」(无端点时候选说明「删除操作需用户确认」)、pick 引用文本与插入标签附 `[Docker]`;AI 上下文注入(starhub-tool-context)在 docker 子类附加删除保护硬规则——标注 / 提示词 / 风险门三层一致。

## [0.94.3] - 2026-08-24

### 变更
- 🎨 AI 对话截图仅保留**区域截图**,移除窗口截图:输入框工具行「剪刀」按钮点击即开始区域截图(不再弹「区域截图 / 窗口截图」菜单);同步删除 Rust 侧 `screenshot_begin_window` / `screenshot_list_windows` / `screenshot_capture_window` 命令、ACL 权限与遮罩页全部窗口模式代码(遮罩页不再按 `?mode=` 分发)。
- 🎨 区域截图选区拖拽改为「先沿单一轴拉出第一段」:必须先把鼠标沿横向或纵向(先横后竖 / 先竖后横均可)拉过阈值(12px),另一轴才解锁、画布先显示单轴引导线,不能一开始就斜着拉;解锁后恢复自由拖拽(8 方向调整 / 整体移动不受影响)。

## [0.94.2] - 2026-08-24

### 新增
- ✨ AI 域工具会话(connId `dsh:{assetId}:ssh`)遇到服务器 keyboard-interactive 请求时,主壳弹出居中 MFA 验证卡:后端 `authenticate_keyboard_interactive` 双发精确事件(`ssh:kb-interactive:<sessionId>`,交互终端 / 测试连接各自弹窗)与通用事件(`ssh:kb-interactive`,负载带 sessionId,主壳确认卡仅接管 `dsh:` 前缀会话),应答统一走 `ssh_kb_response`;TOTP 提示识别扩充(authenticator / 2fa / 2sv / mfa / passcode / 动态口令 / 短信验证码等)。
- ✨ Redis 工作台 DB 树化:左侧 db0–db15 全部默认收起,点击展开才懒加载(DBSIZE + SCAN,键按 `:` 二次分组为文件夹树,文件夹同样默认收起、点击行才展开叶子);同一时刻仅展开一个 db(sidecar Redis 客户端为单库语义,展开态 db 恒等于客户端当前 db,键操作与 CLI 都作用其上);已加载键按 db 缓存,收起再展开不重复请求。

### 修复
- 🐛 SSH 首次连接新服务器不再静默失败,弹出「是否信任此主机?」确认弹窗(拒绝 / 仅本次 / 信任并保存):此前后端 `ssh:hostkey-confirm:<sessionId>` 事件只有测试连接在订阅,正式打开 SSH 终端(starhub-window 独立窗口)无人消费 sender,未知主机一律等满 60s 后以 `[HOSTKEY_TIMEOUT]` 拒绝,用户看不到任何提示——`SshTerminalOverlay` 在 invoke `ssh_connect` 前补订阅该事件并渲染三选项弹窗,拒绝/信任均经 `ssh_hostkey_response` 回传(信任并保存写入 known_hosts)。
- 🐛 AI 域工具 SSH 会话(connId `dsh:{assetId}:ssh`,经 ssh_exec / 域工具建连)遇到未知主机密钥时,不再发出无人订阅的 hostkey 事件静默等 60s 超时:改为快速失败并返回明确指引「主机尚未确认主机密钥,请先在 SSH 终端连接一次并选择『信任并保存』」(与 Docker over SSH 的预信任约定一致);已确认过的主机不受影响。
- 🐛 Windows 本地打包修复:`package-dsh-runtime` 复制 `packages/starhub/*` 本地包时跳过各包内嵌套 node_modules(pnpm 工作区符号链接布局)——fs.cp 在无管理员/开发者模式的 Windows 上重建符号链接会 EPERM,导致 `npm run tauri:build` 在入包阶段失败;产物运行时依赖由 deploy 的 hoisted 顶层 node_modules 覆盖,web.rs 仅对包目录建免管理员的 `mklink /J` junction,嵌套 node_modules 本就不需要。

## [0.94.1] - 2026-08-23

### 修复
- 🐛 修复 `apps/starhub-window` 独立 `tsc --noEmit` 的 118 个基线错误(此前按 `tsc -p` 直跑时,`paths` 把 `@deepseek-ai/*` 全部映射到 src,把 vendor/cordis / cosmokit / schemastery 与 api/gateway 的上游源码拖进本程序的严格编译面,叠加缺失的 CSS module 声明与 App.tsx 的 override 违约):tsconfig 补齐 project references(client-nav / ui-theme,按 apps/web 同款边界把依赖解析到构建产物声明,避开跨 tsconfig 的严格混编)、新增 `src/css-modules.d.ts`(`*.module.css` / `*.css` 声明,与各 client 包同款)、`WorkbenchErrorBoundary` 三个成员补 `override`。现在 `pnpm exec tsc --noEmit -p apps/starhub-window/tsconfig.json` 零错误。
- 🐛 修复 FileViewer「变更前 / 变更后」对比视图:长行时 绿(+)/红(−) 变更行的底色只到列宽为止、不覆盖整行文字——`diffView` 宽度改 `max-content`(至少 100%),行底色随内容铺满(超宽由列内 `overflow` 横向滚动承接);同时移除列右侧非对称 padding,普通行的底色也铺满整行。

## [0.94.0] - 2026-08-23

### 新增
- ✨ AI 记忆系统引入**专属记忆模型**且作为硬前置(呼应 Hermes Agent 用独立便宜模型跑后台记忆提炼的实践):设置 → AI 助手「记忆模型」下拉(provider + model 成对,数据源 dsh `llm.models` 会话无关模型目录)。
- ✨ 记忆功能门禁:**记忆模型未配置 = 记忆功能整体关闭**——「启用长期记忆」「自动沉淀记忆」开关禁用(默认关,只有配置了才能勾选);host 侧三处兜底:memory-context pre-step 注入跳过(console.warn)、memory-sink turn-stopping 沉淀跳过、memory 工具调用被 `tools/pre-execute` 直接 deny(不弹确认卡、不进 Rust 写路径);`normalizeAiSettings` 把旧 localStorage 残留开启态强制归零。
- ✨ 跨项目作用域项目标注约定:**写入 user/global 的记忆,凡属具体项目的事实必须在条目内标注项目名**(取工作区目录名,如 `[starhub] 生产库在 10.0.0.5`);跨项目通用的才允许不标注。落地于 memory 工具描述(模型侧契约)与 memory-sink 抽取系统提示/prompt(`project: <目录名>` 行);folder 卡本就按项目隔离,无需标注。

### 修复
- 🐛 memory-sink 自动沉淀抽取改为走 dsh-llm 官方 `ctx.llm.stream`(带 `provider`/`model` 显式路由);dsh-llm 只暴露 stream 面,原 `generate({json:true})` 便利面在宿主的 `llm` 服务上不存在,生产组合下抽取可能静默不触发——顺带补齐专属模型路由的承载面。

### 测试
- `memory-context` 补:记忆模型路由判定(`memoryRouteOf` / `isMemoryConfigured`)、pre-step 未配置硬门、memory 工具锁死门(deny/放行/非 memory 放行)。
- `memory-sink` 补:route 缺失跳过、`wireLlmExtractor` 改 stream 全分支(路由透传/abort/非 stop finish)、项目名派生(`projectNameOf`)。
- client-nav 补:记忆模型下拉(目录加载/选择/同步 namespace)、开关未配置禁用、`normalizeAiSettings` 硬门归一化、syncMemoryModel。

## [0.93.2] - 2026-08-23

### 修复
- 🐛 修复区域截图无法拖拽框选:遮罩页三个画布(base/anno/overlay)完全重叠铺满窗口,顶层 `#overlay` 画布默认 `pointer-events: auto`,把 mousedown/mousemove/click 全部截走,`#base` 画布上的拖拽/点击监听永远收不到事件(此前多次误判为画布尺寸、坐标换算、IPC 字节链路)——anno/overlay 是纯视觉层(标注矩形、遮罩高亮),改为 `pointer-events: none`,事件落到底层 base 画布。
- 🐛 修复窗口截图黑屏:`initWindow()` 定义了但从未被调用,遮罩页无论哪种模式都执行 `initRegion()`;窗口模式下 `screenshot_get_desktop` 返回「no desktop capture cached」→ 黑屏 + 初始化失败提示,窗口列表(`screenshot_list_windows`)/ hover 高亮 / 点击截取整条链路从未激活。修复:Rust 侧 `screenshot_begin_window` 以 `screenshot.html?mode=window` 创建遮罩窗口,页面按 `location.search` 分发 `initRegion` / `initWindow`。
- 🐛 修复新会话页面不显示 git 分支胶囊:blank 会话(未发首条消息)整个会话头部被 `hideChrome` 隐藏,`conversation.session.header.actions`(分支胶囊注册位)随之不可见——头部改为仅在会话仍处于打开中(settling/回放,`openState !== 'open'`)时隐藏,blank 会话已打开的「新会话页」正常显示头部与分支胶囊(胶囊数据源 cwd 在 host 帧落地后即就绪)。
- 🐛 修复对话中分支面板与左侧侧边栏遮挡:面板 `right: 0` 从胶囊向左展开,而胶囊位于标题之后(偏会话列左侧),面板越过会话列左缘被列的 `overflow` 裁剪,视觉上像被左侧侧边栏盖住——面板改为 `left: 0` 向列内侧展开,避开侧边栏边界;胶囊根层级从 z-index 9 提升到 30,压过 shell overlay 层(z-index 20)。

### 测试
- `ui-conversation` skeleton 规格同步:blank 会话「已打开」hero 现在显示头部(断言 `aria-hidden` 移除 + `conversation.session.header.actions` 渲染),settling/replay 隐藏行为不变(2 例回归通过)。

## [0.92.1] - 2026-08-22

### 新增
- 产物行「+ N 个文件」改为打开右侧贴边 drawer(撤回 v0.91.0 行内展开):按新增/修改分组列出本轮全部变更文件(完整路径 + +/- 行数),分组标题可折叠,行点击走与徽章相同的壳内查看窗优先打开器;Esc / 遮罩 / × 三种方式关闭且焦点回到「+ N」按钮;「在文件夹中显示」移入 drawer 底栏(loopback + `canOpenPath` 门禁不变);v0.91.0 的 `.list` / `.collapse` / `.listRow` / 新增修改标记等行内展开代码与样式全部删除。

### 修复
- 修复 v0.92.0 打包构建失败:`settings-tabs.client.spec.tsx` 残留未使用的 `waitFor` import(tsc TS6133,`package-dsh-runtime` build 中断)。
- 修复「启用长期记忆」host 侧门禁与 v0.92.0「默认关」策略相反:memory-context pre-step 在 namespace 未写过时按开启处理(默认注入记忆卡),改为 explicit-true(未写过 = 关闭),与设置面板默认值一致;同步修正 memory-context / memory-sink / client-nav 三处「未写过视为开启」的过期注释与 README。
- 修复 memory-sink LLM 抽取的 abort 竞态:已中止 signal 在 `Promise.race` 中会输给立即 resolve 的 generate(abortPromise 的拒绝反应排在 generate 已完成微任务之后),改为调用 generate 前检查 `signal.aborted`。
- 修复 dsh 源面解析缺口:`tsconfig.base.json` 缺 `dsh-starhub-commit-message` / `dsh-starhub-memory-context` / `dsh-starhub-memory-sink` 三个显式映射(连字符包名越过 `dsh-*` wildcard 的单捕获),vitest 此前把 `@deepseek-ai/dsh-starhub-memory-context` 静默解析到过期构建产物(lib);并补 `memory-sink/tsconfig.json` 对 memory-context 的 project reference。

### 测试
- `memory-context` / `memory-sink` 两包补齐至 per-file 100% 覆盖率门禁:`isAutoReviewEnabled` 默认关语义、cardTitle global/未知 scope 兜底、pull/写入/抽取三路超时降级、pre-step 与 turn-stopping 钩子、`wireLlmExtractor` 全分支、invariant 伴生注册。
- client-nav 设置相关文件(`ai.tsx` / `aiSettings.ts` / `memory-context.ts`)补至 100%:api 在场时两个记忆开关同步 host namespace、同步拒绝静默、folder scope 标签文案。
- ui-deliverables 新增 drawer 规格 7 例(分组/打开器/三种关闭/折叠/底栏门禁/焦点),数据派生补 1 例(diff 空文本行数、diffs 缺省时 locations 兜底),全包 100%。

---

## [0.95.0] - 2026-08-24

### 新增
- ✨ 会话文件树 + 本机文件搜索:头部「文件树」按钮打开项目目录树(懒加载展开、右键「引用文件/文件夹」把 `@名称 (路径)` 追加进对话框、文件信息弹窗);`@` 触发词新增 starhub-file source,候选来自会话工作区目录树,pick 产物与文件树右键引用一致;Rust 侧新增 `local_search_files` 命令(按文件名/文件内容检索,含深度与结果上限保护)并注册 ACL 权限。
- ✨ DB 表格快捷筛选:数据表格新增 quickFilter 快捷筛选关键字,对所有列做 `LIKE '%kw%'` 模糊匹配(sidecar MySQL/PostgreSQL/SQLite/SQL Server/ClickHouse 全部适配 + 前端筛选输入框)。

### 修复
- 🐛 文件树面板目录读取失败时不再无限重发请求(挂载自动展开 + `expand` 依赖 `[cache, loading]`,`finally` 移除 loading 会重建 `expand` 并重跑 effect,形成「失败 → 再请求 → 再失败」死循环,CPU 100% 满载导致 vitest 全量测试超时挂起):同一 cwd 只自动展开一次;目录加载失败后点击 = 重试。
- 🐛 SSH 终端对 MFA 资产发送 `kb_interactive` 配置(镜像 Rust 侧 `authMode`/`mfaEnabled`/`mfaPassword` → `kb_interactive` 的翻译),修复真实连接「服务器要求 keyboard-interactive MFA 时 `[AUTH_FAILED]`」而测试连接弹窗正常的不一致。

## [0.93.1] - 2026-08-23

### 修复
- 🐛 修复 v0.93.0 截图功能不可用:① `src-tauri/permissions/commands.toml`(Tauri 2 ACL 白名单)漏列 8 个 `screenshot_*` 命令,remote origin(127.0.0.1 dsh 主壳)调用被 ACL 拒绝 → 点「区域截图」无反应;② 截图菜单背景用了不存在的 token `--dsw-alias-surface-popover`(透明背景),且菜单向下展开时被窗口底部视口裁掉(只显示「区域截图」一项)——改为 `--dsw-alias-bg-overlay` + 向上展开 + 提层级压过 composer 渐变遮罩。
- 🐛 修复 v0.93.1 区域截图「卡死/点不动」:遮罩页区域模式底图画布未设 CSS 尺寸,按物理像素(4K=3840px)当 CSS 尺寸渲染,超出窗口视口被裁 + 鼠标坐标换算全错,拖拽选区全部失效——画布改为铺满窗口视口(CSS 100%,物理坐标经比例换算);同时补三层退出兜底:① 遮罩页右上角常驻「✕」取消按钮(任何状态可用),② 键盘 Esc 双绑定(document + window)+ 页面抢焦点,③ Rust 侧截屏/窗口截图改 blocking 线程 + 10s 超时,任何失败自动恢复主窗口(避免「主窗口已隐藏、遮罩未弹出」的黑屏死锁)。截图底图确认保持静态快照(截屏时定格),不做实时刷新。
- 🐛 修复 v0.93.1 截图黑屏:Tauri IPC 把 Rust `Vec<u8>` 序列化为 JSON 数组(`number[]`),遮罩页 `blobToImage` 直接用 `new Blob([number[]])` 把数组当字符串处理导致图片数据损坏(解码失败 → 底图黑屏);改为先转 `Uint8Array` 再入 Blob(与主窗口 `ScreenshotButton` 的既有处理一致)。已用 xcap 本机探针验证截图源图像正常(1920x1080,99% 非黑像素),黑屏纯属前端字节转换问题。
- 🐛 修复 v0.93.1 截图仍黑屏/拖拽无效:彻底弃用 `Vec<u8>` 的 IPC 传输(经查证 Tauri 2 对 `Vec<u8>` 返回值一律经 JSON 序列化成巨型 `number[]`,前端转换/解码链路不可靠),全部改为 **base64 dataURL 字符串**传输(底图 / 窗口截图 / 确认回传;Rust 侧用 `base64` crate 编码,`screenshot_finish` 接收裸 base64 后解码);遮罩页初始化失败改为**显式报错提示**(不再静默转成窗口模式——这正是「区域截图拖拽无效」的根因之一);窗口截图失败同样显式提示(微信/Clash 等窗口 WGC 捕获会超时,探针实测),不再黑屏卡住。

## [0.93.0] - 2026-08-23

### 新增
- ✨ AI 对话输入框新增截图功能(微信同款交互):输入框工具行「剪刀」按钮 → 区域截图 / 窗口截图。区域截图:隐藏主窗口后弹出全屏遮罩,拖拽框选选区(8 方向调整 / 整体移动 / 尺寸提示),支持红色矩形标注与撤销,回车/双击确认、Esc 取消;窗口截图:点击目标窗口整窗截取(含标题栏边框,自动过滤 StarHub 自身窗口)。确认后截图直接进输入框附件栏,随消息发送;超过 3MB 自动压缩到 3MB 以内。Rust 侧基于 xcap 跨平台截图(Windows WGC / macOS ScreenCaptureKit / Linux X11+Wayland),遮罩交互为独立置顶透明窗口加载的静态页,结果经 Tauri 事件回传主窗口并复用现有图片附件管线。

### 变更
- dsh web 端口按环境分离(2026-08-23):正式(release)实例保持默认 **3085** 不变;开发(debug)实例从 3085 迁到 **3185**(占位页 + `DEFAULT_PORT` + devUrl 联动),与「本机常驻正式实例的 3085」隔离,`tauri:dev` 不再撞端口。`NoFreePort` 错误改为携带实际端口区间。

## [0.92.4] - 2026-08-23

### 修复
- **修复 v0.92.2 安装包启动崩溃(根因级,替代 v0.92.3 的产物级缓解)**:`examples/starhub-web/cordis.patch.yml` 引用的 `@deepseek-ai/dsh-starhub-memory-sink` 未随 dsh-runtime 入包(三处入包清单漏列),安装包启动即 `ERR_MODULE_NOT_FOUND` → 插件树加载失败 → dsh web 进程崩溃(浏览器侧表现为 `session-log-export` client bundle failed to load,系崩溃下游症状)。修复:`package-dsh-runtime.ts` 的 `WEB_LOCAL_PACKAGE_DIRS` / `web.rs` 的 `LOCAL_PACKAGES` / `examples/starhub-web/package.json` 三处补 memory-sink;memory-sink `apply()` 改为 `ctx.settings.get()` 只读 memory-context 的 namespace(不再重复 register,消除组合下 settings duplicate-registration 硬失败);`package-dsh-runtime.ts` 新增 `verifyProfilePatchClosure()` 打包门禁——starhub-web profile 引用的每个 `@deepseek-ai/*` 包必须已随闭包入包,漏列即构建失败(本地与 GitHub CI 均生效)。

## [0.92.3] - 2026-08-23

### 修复
- **修复 v0.92.2 启动偶发「Failed to load plugins」报错**:v0.92.2 的 oxlint 清零修改了 `dsh-client-modules` 等包的源码并重新构建了 vendor bundle,但 `src-tauri/binaries/dsh-runtime`(打包产物,被 gitignore)未同步重建,导致从源码运行或旧打包产物中 `dsh-client-modules` 版本不一致。现重新运行 `npm run package:dsh-runtime` 生成最新的 dsh-runtime,确保 vendor 与 binaries 中的 client bundle 完全一致。

---

## [0.92.2] - 2026-08-23

### 变更
- 全量清零 dsh 仓库(fork)存量门禁债:oxlint 全仓从 ~1955 条错误降到 0(先自动修复 ~1188 条,再逐文件手工补类型清零 unsafe-* / no-non-null-assertion 等);修复过程中顺带修正 client-nav 各服务层的 any 泄漏、被误删的运行时守卫(如 db-dashboard-service 的 null 行守卫)与 tauriListen 泛型签名。
- 退役四类门禁:上游 `website/` 文档站点投影(脚本/门禁/workspace 条目全删)、`verify-md-wrap`、`verify-doc-budgets`、`verify-translation-pairing`(脚本/lefthook 钩子/run-gates 叶子/文档引用全摘除);`scripts/ci-workflow.spec.ts` 因上游 `.github/workflows` 未 vendored 从 vitest exclude 排除。AGENTS.md 与 docs/AGENTS.md 同步更新门禁策略(只保留 lint、覆盖率、README limitations/model-experience 及剩余 doc-sync 叶子)。
- `verify-archived-agent-notes` 修复嵌套仓库路径(外层 starhub git 仓库内按前缀解析 manifest)。
- 目录册门禁修复:重新生成 client/tool/config 目录与 doc-graphs;`gen-tool-catalog` 排除 starhub 组(其工具由包 README 记录);commit-message/approval-bridge 的 Config 改为命名类型;8 个 starhub 包 README 补全 Model Experience 规范结构,client-nav/tool-context 补上缺失 README(含 Known Limitations),export-jsdoc 353 条 @param/@returns 全部补齐。
- starhub 三包(approval-bridge / host-static / tools)补上 `./invariant` 伴生;8 个 client-nav CSS 高位面滚动容器补滚动条 l2 重绑定;icons 规格按 fork 实际集更新(73);THIRD_PARTY_NOTICES.md 重生成对齐清单;清理子代理遗留的 oxlint 探针临时文件。

### 测试
- client-nav terminal 四模块(terminal-cwd / xshell-quick-command / quick-commands / sftp-service)测试补齐至 per-file 100% 覆盖(新增 4 规格 86 例)。
- 全仓 vitest 13634 通过;仅剩 1 条存量失败(tool-pwsh 沙箱升级测试,stash 验证为 HEAD 既有)与 1 条负载偶发(credentials-local 并发写,隔离通过);fork CI 不跑 vitest。

## [0.92.0] - 2026-08-22

### 新增
- AI 长期记忆自动沉淀接入:新增 host 包 `@deepseek-ai/dsh-starhub-memory-sink`,在 `agent/turn-stopping` 后调一次独立 LLM 抽取当轮持久事实,经 sdk-transport 反向 RPC `starhub/memory.write` 写入 ai_memories(走 folder:<cwd> 或 global scope);门禁继承自旧 Vue `aiMemoryReviewGates.ts` 的 `shouldReview`(消息数 ≥ 4)。补全 v0.79 AI 内核替换时丢失的「记忆自动沉淀」能力。

### 变更
- 「启用长期记忆」与「自动沉淀记忆」两个开关 v0.92.0 起均默认关闭:旧版 ≤0.91.0 默认开启,namespace 写法需显式 patch 才能关闭;v0.92.0 起需在设置 → AI 助手显式打开后才有注入预读或自动沉淀。
- 设置 → AI 助手 → 「管理记忆」弹窗去除 `isTauriRuntime()` 整体禁用门:纯浏览器会话(:3085)也可打开弹窗,IPC 调用失败会以错误文本形式展示,不再吞掉。
- `starhub-memory-context` namespace Schema 扩展字段 `autoReview`(默认 false):memory-sink 在 turn-stopping 钩子里读取此字段决定是否跳过 LLM 抽取。

### 新增 RPC
- Rust 反向 RPC `starhub/memory.write({ scope, content })`(src-tauri/src/harness/mod.rs:986):写盘经 `ai_memory_add`,错误原样上抛由调用方处理;不写 audit,与 UI 手动 `ai_memory_add` 路径解耦。

### 测试
- 新增 25 个 vitest(memory-sink 包:`shouldReview`/`normalizeFacts`/`writeFact`/`runTurnReview` 等分支覆盖)。
- memory-context 既有 10 个测试无回归。
- client-nav 既有 680 个测试无回归,适配新默认值(memoryEnabled/memoryAutoReview 默认 false)。

### 已知限制(留待下版)
- 「记忆写入需逐条确认」「存档 tool 消息」开关仍是 UI 层状态,未接入真行为。
- 产物行展开仍是 v0.91.0 的行内折叠形态(产品反馈建议改为右侧侧栏,留待 v0.92.x)。

---

## [0.91.0] - 2026-08-22

### 已完成
- AI 产物点击改为壳内查看窗优先:每轮末尾的产物文件行(ProducedFiles 徽章)与收尾正文里的行内代码文件提及(chatFileMentions)改为走与 Read/Edit 工具卡同一 `viewFile` 通道(`{ kind: 'read' }`),查看服务缺失(纯 dsh web)时退回 OS 默认打开;同时修复 chat view 的 `viewFile` 注入未按会话 cwd 解析相对路径就交给查看窗的问题(产物/提及多为工作区相对路径,Tauri 直读需要绝对路径)。
- 产物行升级为改动文件清单:每个产物条目带变化形状(diff 的 `oldText` 为空即「新增」,否则「修改」)与 +/- 行数估计,徽章名称旁直接显示;点击「+ N 个文件」展开完整清单(全部产物逐行:新增/修改标记、完整路径、行数,点击同样壳内查看),解决产物很多时只能看到前几个的问题。
- 壳内文件查看窗「变更前/变更后」改为红绿色块对比:两栏按逐 hunk 行级 diff 渲染,变更行带红(-)/绿(+)底色与 +/- gutter,两侧共有的行不再染色;编辑改为右栏栏头「编辑」开关切换(默认查看对比,编辑后切回即按当前内容重新着色),保存逻辑不变。
- 会话头部 git 分支胶囊支持同步线上分支:新增「同步远程」(`git fetch --all --prune`)与「拉取(git pull)」;远程跟踪分支单独成组列出(过滤 `origin/HEAD` 与本地已有同名分支),点击即 `git checkout -b <名> --track` 拉取为本地跟踪分支。
- 修复分支胶囊面板遮挡与溢出:面板尾部被粘性 composer 渐变遮罩盖住(胶囊根现以 z-index 9 自建堆叠上下文);面板加宽到 340px 并按视口限高限宽,三个同步按钮均分不换行,仅分支列表滚动,提交/拉取/推送行始终可见可点。

## [0.90.0] - 2026-08-22

### 已完成
- 会话头部 git 分支胶囊新增「✨ AI」生成提交信息:点击后采集 `git status --porcelain` / `git diff HEAD --stat` / 近期提交主题,经新增 host 插件 `@deepseek-ai/dsh-starhub-commit-message`(POST `/starhub/git/commit-message`,按 GUI 默认模型路由做 one-shot LLM 调用,输入/输出/超时预算走 cordis 配置)返回草稿并回填输入框,确认或编辑后再提交;草稿对齐仓库近期提交的语言与 Conventional Commits 风格。
- 修复 Windows 下切换会话/工作区时闪出系统终端黑窗:`local_shell_exec` 在 Windows 经 `powershell.exe` 跑命令(分支胶囊每次会话切换都会调 git)但未带 `CREATE_NO_WINDOW`,GUI 进程 spawn 控制台子进程即弹窗;为 `local_shell_exec` 及 harness 的 `mklink` junction/诊断 spawn 统一补上 `CREATE_NO_WINDOW`。
- 壳内文件查看窗(Read/Edit 工具卡点开)内容区撑满弹窗:共享 `Modal` 的 content/body 现参与拉伸与内部滚动,查看窗调整为近全屏(1080px 宽、视口高减 64px),长文件不再挤在小区域里看。
- 设置 → AI 助手「管理记忆」弹窗:多条记忆时列表区独立上下滚动(原 grid 三行模板被错误/空态行挤占且列表无 overflow),弹窗加宽加高、条目排版放宽。

## [0.89.1] - 2026-08-21

### 修复
- 修复 dsh 运行库构建失败:client-nav 的 git 分支胶囊(GitBranchPill)直接 `import clsx` 却未在 `package.json` 声明依赖,全新检出/CI(`pnpm install --frozen-lockfile`)下 tsc 报 TS2307 `Cannot find module 'clsx'`,导致 `package:dsh-runtime` 构建中断;补声明 `clsx@^2.1.1`(与其余 client 包一致)并同步 lockfile。

## [0.89.0] - 2026-08-21

### 已完成
- AI 长期记忆真正接入上下文：新增 host 插件 `@deepseek-ai/dsh-starhub-memory-context`，每个 agent 请求 pre-step 经 `starhub/memory.cards` 桥拉取记忆卡并注入（user + global + 当前工作区文件夹 + 绑定资产），修复「记忆写了却从不出现在上下文」的缺失环节;web 与内嵌 AI 两套 profile 均挂载，2s 超时/失败降级为不注入。
- 记忆新增文件夹级作用域：memory 工具 `target: 'folder'`（按会话工作区 cwd 落 `folder:<绝对路径>` scope,2200 字符上限）;「管理记忆」弹窗支持 folder 卡展示与工作区名标签。
- 「启用长期记忆」开关真正生效：设置 → AI 助手的开关经 `starhub-memory-context` settings namespace 同步到 host 插件，关闭即完全不注入；启动时按 localStorage 补写一次。
- 会话头部新增 git 分支胶囊：显示当前会话工作区分支（含 detached HEAD 与未提交改动圆点），点击开面板可搜索/切换分支、`git add -A`+提交、`git push`；非 git 工作区与浏览器预览不渲染。
- Read/Edit 等工具卡的文件名点击改为壳内查看窗：Read 看当前文件内容,Edit 看「变更前/变更后」左右两栏；AI 运行中只读并提示「AI 运行中只能查看」，空闲时可编辑保存（Edit 右栏按 hunk 应用回最新文件）；查看窗服务缺失时退回 OS 默认打开。

## [0.87.10] - 2026-08-21

### 修复
- 修复 CI/全新检出下 `npm run build:window` 失败：`starhub-window` 的 `window-shell.css` 经 exports 映射引用 `@deepseek-ai/dsh-client-ui-theme/styles/base.css`（指向未构建的 `lib/` 产物），改为在 Vite alias 中把主题样式子路径指到 `src/styles` 源码，与其余 workspace 包的「源码直编」策略一致。

## [0.87.9] - 2026-08-21

### 修复
- `@` 资产菜单候选行首新增工具徽标（终端 / 数据库 / Docker / 本机），一眼区分资产属于哪个工具；候选 icon 位支持短文本徽标（不再固定 16px 裁剪）。
- 修复输入框内资产引用 chip 名称显示不全、被遮挡的问题：原居中裁剪会把长标签两端切掉只露出中间残段，改为按占位格宽度自动缩放（0.72 基准、0.45 下限），超出后从头保留、末尾省略，完整名称经 tooltip 展示。
- 数据库与 Docker 工作台对齐 SSH 终端视觉风格（深色背景、58px 顶栏、42px 标签栏、状态点、紧凑图标按钮）;Redis 键树、Dashboard 指标图标、SQL 编辑器与连接对话框多处可用性修复;新增 `bind_asset_context` 域工具（绑定资产上下文但不打开窗口）。

## [0.87.8] - 2026-08-20

### 修复
- 移除依赖全局 SQLite 初始化的 Harness 单元测试，避免 Rust 测试环境在数据库未初始化时 panic；真实资产类型解析继续由运行时资产表路径执行。

### 验证
- `scripts\cargo-env.bat test` 已尝试运行，但本机环境未暴露 `cargo` 命令。

---

## [0.87.7] - 2026-08-20

### 修复
- AI 资产绑定、打开与工具页聚焦现在都从资产表读取真实类型；数据库通过 `@` 或打开连接后可正确路由 `db_query`，不存在的资产会返回明确错误。
- MySQL 对象树限制横向溢出，为超长对象名添加省略显示，并使用深色滚动条。
- Docker exec 终端使用不透明、居中的自适应面板；容器日志改为独立弹框，最新日志置顶，并提供图标刷新和关闭操作。
- Docker 所有行级操作与镜像删除/清理入口均使用可访问的图标组件。

### 验证
- `pnpm exec vitest run packages/starhub/client-nav/tests/db-workbench.client.spec.tsx packages/starhub/client-nav/tests/docker-workbench.client.spec.tsx` 通过（56 tests）。
- `npm run build:window` 通过。
- `npm run cargo:check` 未能执行：环境未安装或未暴露 `cargo` 命令。

---

## [0.87.6] - 2026-08-20

### 修复
- 独立资产窗口由 Tauri 标题栏提供唯一的关闭入口，隐藏 SSH、数据库、Docker、Redis 与 Elasticsearch 工作台顶部重复的页面关闭按钮。

### 验证
- `apps/starhub-window/tests/route.spec.ts` 通过。
- `npm run build:window` 通过。

---

## [0.87.5] - 2026-08-20

### 修复
- 修复 GitHub runtime 构建中 `SshTerminalOverlay` 的 `onClose` 未使用 TypeScript 错误：恢复 SSH 工作区关闭按钮并调用关闭回调。
- 修复数据库资产工作台按通用资产类型错误选择 MySQL 连接命令的问题；PostgreSQL、ClickHouse、Redis 与 Elasticsearch 现在按 `config.dbType` 连接和断开。

### 验证
- `client-nav` SSH 与数据库工作台聚焦测试通过。
- `pnpm --dir vendor/deepseek-harness run build` 通过。

---

## [0.87.3] - 2026-08-20

### 变更
- SSH 工作区恢复高密度双栏操作：终端始终可见，SFTP 文件传输或 SSH 网页访问以右侧停靠面板同时打开；新增快捷命令栏、管理器和 Xshell `.qbl` / `.qblx` 导入，兼容旧格式、Xshell 8 UTF-16 与多命令集归并。
- MySQL、PostgreSQL、SQLite 与 ClickHouse 共用的数据库工作区将 SQL 编辑器和监控恢复为顶部标签；SQL 工具栏提供醒目的执行按钮以及 EXPLAIN、格式化、历史图标操作。
- Docker 将容器/镜像恢复为内容区顶部标签，拉取、清理与刷新使用带提示的图标工具按钮。
- Redis 与 Elasticsearch 统一迁移到 DSH 全屏工作台视觉系统，使用一致的层级、状态、工具栏、输入控件和弹层 token。

### 验证
- React 工作台聚焦测试 117/117 通过（SSH/SFTP、数据库、Docker、Redis、Elasticsearch）。
- `client-nav` TypeScript 类型检查通过。

---

## [0.87.2] - 2026-08-20

### 修复
- `build:window` 在配置 `STARHUB_WINDOW_DIST` 时同步工作台产物到 DSH 运行时静态目录，避免 3085 继续提供旧的 `/starhub-react` bundle。
- `WebBrowser` 的 SSH 连接状态属性保持兼容默认值，修复独立组件测试和 DSH runtime 打包的 TypeScript 报错；SSH 工作区仍显式传入实时连接状态。

### 验证
- `web-browser.client.spec.tsx` 与 `ssh-terminal-overlay.client.spec.tsx` 共 23/23 通过。
- `pnpm --dir vendor/deepseek-harness run typecheck` 通过。

---

## [0.87.1] - 2026-08-20

### 修复
- SSH、数据库与 Docker 工作台将一级功能导航统一移入侧栏，移除顶部二级页签堆叠；SFTP 与网页访问补齐 SSH 未连接、连接准备和空地址状态，避免空白或无解释的不可用界面。
- SSH 命令广播入口升级为显眼操作按钮，发送结果以明确的成功/失败通知反馈；资产列表将名称与用户名/主机分两行显示，窄列下不再裁断连接信息。
- `@` 资产选择仅绑定 AI 工具上下文，不打开 SSH、数据库或 Docker 工作台。

### 验证
- client-nav 聚焦测试 111/111 通过（SSH/SFTP/广播、数据库、Docker、资产选择与打开路径）。
- `npm run build:window` 成功，React 工作台产物已更新到 `dist-starhub-react`。

---

## [0.87.0] - 2026-08-20

### 变更
- **品牌图标升级**：应用图标替换为新的 1024×1024 源图（`icons/app-icon-v6/02-star-chevron-s.png`），README 顶图与 Tauri `bundle.icon` 清单同步刷新 —— `src-tauri/icons/icon.png`（1024×1024）/ `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.ico`（PNG-in-ICO，16/32/48/64/128/256 多尺寸）以及 `docs/assets/starhub-logo.png`。
- **README 完全重写**：与 `AGENTS.md` 同步 —— 技术栈改写为 React + DeepSeek Harness 工作台 + Go Sidecar；删除 Vue 3 / Vuetify / Pinia / Monaco / `cyber.css` / `vue-i18n` 等已在 v0.86.0 移除的依赖与目录；构建命令改为 `build:window`；设计系统段落改写为 DSH UI 约定；「当前版本」与「下载安装」对齐 v0.87.0。
- 新增 `scripts/refresh-icons.ps1`：从单一源图重生成 Tauri `bundle.icon` 全部打包图标与 README 顶图，无外部图像库依赖（使用 Windows .NET `System.Drawing`，对 PNG-in-ICO 直接写 ICONDIR 头）。

### 验证
- 图标脚本本地生成六个目标文件并通过字节级检查；ICO 头 `00 00 01 00 06 00` 表示 type=icon、count=6。

---

## [0.86.3] - 2026-08-20

### 修复
- 修复 SSH 终端每个字符显示两次（输入 `ls` 显示为 `llss`）的问题：v0.85 接入 SFTP「跟随终端」cwd 追踪时，`ssh:data` 监听器在原有 `term.write(原始字节)` 之外又叠加了 `handleChunk` 内部的 `term.write(可见文本)`，导致每块 PTY 输出渲染两次；现移除裸写入，全部渲染统一走 `handleChunk` 的隐藏回显过滤路径，cwd 追踪与 OSC 7 注入行为不变。同步补装 tsdown 加载 TS 配置所需的 peer 依赖 `unrun`（此前缺失导致 client bundle 无法重建）。

## [0.86.2] - 2026-08-20

### 修复
- 修复 web GUI「设置 → 通用 → 权限」长期显示「不可用 / permission settings has no defaultPreset value」：根因是 `starhub-approval-bridge` 与 dsh `permission-presets` 在 starhub-web 组合里重复注册 `permission` 设置命名空间（settings 对重复注册 fail loud，先注册的 approval-bridge 胜出——其 schema 无 base、`defaultPreset` 可选，permission-presets 随后静默失效）;approval-bridge 新增 `ownsPermissionSettings` 配置（默认 true，内嵌 AI 内核组合仍由它持有）,starhub-web 组合显式置 `false` 退为 `ctx.settings.get` 只读消费，命名空间归口 permission-presets 单一持有，GUI 权限行恢复可读写，新会话的 preset 钉入也随之恢复。

## [0.86.1] - 2026-08-20

### 修复
- 修复 GitHub tag 构建仍调用已移除 Vue `build` / `build:embed` 脚本导致 `Missing script: "build"` 的问题；Release 与 Linux compat 工作流改为运行保留的 Node 纯逻辑测试并构建 `build:window`，不再请求已删除的 Vue 产物。

---

## [0.86.0] - 2026-08-20

### 变更
- 移除历史 Vue embed 前端及其构建链：删除根 `src/`、`build:embed`、`dist-embed` 和 `/starhub` 静态路由，Tauri 开发、Release 打包与 dsh 静态托管仅保留 React 原生工作台 `/starhub-react`。
- 将仍由 Node 测试直接覆盖的纯 TypeScript 工具迁至 `legacy-core/`，并同步 npm 与 pnpm 锁文件；React 设置、资产管理、Elasticsearch、SSH 浏览器和 SFTP 路径继续由 DeepSeek Harness 原生承载。

### 验证
- React client-nav 聚焦测试 46/46 通过，`starhub-window` 构建成功，`cargo check` 通过；隔离 3086 实例验证 `/starhub-react/index.html` 返回 200 且资源前缀为 `/starhub-react/`。

---

## [0.85.14] - 2026-08-20

### 修复
- Elasticsearch 资产窗口现在显式加载 React 原生工作台；工具子类右键菜单不再打开 Vue embed 空态页，统一打开 React 资产列表。SSH 内置浏览器与 SFTP 继续由 React 原生工作台承载。

## [0.85.13] - 2026-08-20

### 修复
- 修复 React Docker SSH 连接参数在严格 `exactOptionalPropertyTypes` 编译下显式传入 `undefined` 而导致 Release 构建失败的问题。

## [0.85.12] - 2026-08-20

### 新增
- React 原生 MySQL 工作台左侧对象树新增数据库/表搜索和独立刷新入口；按表名搜索时自动显示所属数据库，提升大库场景下的定位效率。

## [0.85.11] - 2026-08-20

### 修复
- React 原生工作台中的 `@` SSH、数据库和 Docker 资产选择现在仅绑定 AI 工具上下文，不再错误打开工作台；数据库连接按类型使用正确默认端口，Docker 工作台补齐 SSH 传输、主机密钥与跳板机参数解析。

## [0.85.10] - 2026-08-20

### 修复
- 修复 Windows Release 工作流通过 `subst S:` 构建 embed 前端时，Vite 将真实 checkout 的 `src/index.html` 作为跨盘符绝对资源名传给 Rollup 而失败；该步骤改为在真实 checkout 路径执行，后续打包继续使用短盘符。

## [0.85.9] - 2026-08-20

### 变更
- SSH、MySQL 与 Docker 独立 React 工作台统一为 DeepSeek Harness 的全窗口工作区样式：移除二次遮罩卡片，统一资产身份栏、连接状态、紧凑页签与工具栏，并保持 MySQL 独立窗口和 SSH 内的 SFTP 文件页签。

## [0.85.8] - 2026-08-20

### 修复
- 修复 dsh web 主壳在旧 runtime 初始化前执行已绑定 SSH 资产的 AI 工具时，桥未持有 `AppHandle` 而报“无 AppHandle，无法建立 SSH 会话”；应用启动时即绑定共享桥句柄，AI 现在可按资产配置实际发起 SSH 连接。
- 修复设置页面权限预设描述在持久化配置短暂未水合时因缺少 `defaultPreset` 而报错；该阶段回退至宿主通告的基线预设，待配置加载后保持正常更新。

## [0.85.7] - 2026-08-19

### 修复
- **修复会话权限被派生成不存在的 "custom" 状态(「默认权限是 Custom,三个预设里没有它」)**:`starhub-approval-bridge` 在 `session/created` 时无条件按 settings 的 `permission.defaultPreset` 覆写会话 approval 策略,与 `permission-presets` 已按 preset 整体钉入的 sandbox + approval 冲突(如 `workspace-write + never` 不匹配任何 preset),dsh 内核据此派生出占位状态 `custom`(仅两个会话复现:workspace-write + never)。修复:`session/created` 只填空缺——会话已有 approval 时保持钉入结果,新会话权限始终落在 read-only / workspace-write / danger-full-access 三者之一。
- **修复 ssh 等域工具未绑定资产时报错无引导**:`domain.rs` 未绑定资产错误信息补充操作指引(先 `starhub_list_assets` 查看资产,再 `open_connection` / `focus_terminal` 打开目标资产绑定会话后重试),让模型能自行纠正「@资产 你能访问吗」这类首轮直接调 ssh_exec 的失败。

## [0.85.6] - 2026-08-19

### 修复
- **修复 `harness::domain::tests::format_query_result_basic` 失败(GitHub tag 构建门禁)**:`domain.rs` 的 `format_value` 用 serde_json `Value::to_string()` 序列化字符串,给查询结果的字符串单元格加了 JSON 引号(`name="alice"`),与前端 `dshToolExecutor.ts` 的 `formatValue`(`String(value)`,不加引号)不一致,模型可读文本与前端行为分叉且单测断言失败。修复:`Value::String` 原样输出(去引号),截断改为按字符(`chars().take(120)`)而非字节切片(避免中文等多字节内容在 120 字节边界切出 panic),与前端逐字对齐;`cargo test` 全量 158 例通过。

## [0.85.5] - 2026-08-19

### 修复
- 修复 `domain_tool_failure_does_not_generate_ai_event` 与 `ai_event_without_asset_binding_omits_asset_id` 仍使用已迁移至 Rust 进程内的 `db_query` / `ssh_exec` 并无限等待旧前端回调；改用仍桥接的 `skill_save`，恢复测试的同步回调路径。

## [0.85.4] - 2026-08-19

### 修复
- 修复域工具成功回写单测仍等待已迁移的 `ssh_exec` 前端回调而卡住；改用仍桥接的 `skill_save` 覆盖回写路径，并在 Linux CI 的 Tauri 后端测试前构建 `dist-starhub-react` 资源，避免资源校验失败。

## [0.85.2] - 2026-08-19

### 修复
- **修复 dsh AI 域工具执行超时与无法停止(方案1:域工具改在 Rust 主进程内直接执行)**:`ssh_exec` 等域工具此前经 `dsh://tool-exec` 转发前端 webview 面板执行,前端窗口关闭/审批卡住 → 180s 后报「前端执行超时或窗口已关闭」,且停止生成只杀 dsh 进程、无法中断前端面板里在跑的命令。本次把 ssh_exec / ssh_exec_background / ssh_wait_task / sftp_* / db_query / redis_exec / es_* / docker_* 全部迁到 Rust 主进程直接执行(新增 `src-tauri/src/harness/domain.rs`;SSH 复用 SshManager 会话 + exec_id 可中断,DB/Redis/ES/Docker 经 SidecarManager 直连);`tools.rs` 新增 `IN_PROCESS_TOOLS`(excel_*/mcp_*/skill_save 因前端状态依赖仍转发);`HostBridgeState.inflight_tools` 取消注册表 + `drain()` 逐个 abort 在途执行 —— 停止生成现在能真正中断命令。`cargo check` 通过;新增 domain 纯函数单测(本机因提交内存不足未跑完 `cargo test`,待 CI 验证)
- **修复 dsh web 打开 ssh/db 连接页 404(「找不到此 127.0.0.1 页」)**:`web.rs` spawn dsh web 时未设置 `STARHUB_WINDOW_DIST`,host-static 对 `/starhub-react` 前缀的 repo-root 发现在打包部署(runtime 与仓库根分离)下失败 → 注册 404 兜底。修复:新增 `resolve_starhub_window_dist()` 并在 spawn 时注入 `STARHUB_WINDOW_DIST` env,`/starhub-react` 正确挂载独立 React 窗口 app

## [0.85.1] - 2026-08-19

### 修复
- **修复 Linux(ARM64)CI 的 `cargo test` 崩溃(退出码 101)**:`linux-compat.yml` / `release.yml` 的 `Test Tauri backend on Linux`(`cargo test --locked`)在 `ubuntu-22.04-arm`(4GB)runner 上报错——本后端(russh/sqlx/reqwest/rustls 全家桶,8W+ 行)的 debug 测试构建峰值内存极高,rustc/LLVM 阶段 OOM(`rustc-LLVM ERROR: out of memory`),本地 27GB 机同样复现。修复:
  - `Cargo.toml` 新增 `[profile.test] debug = 0`:测试编译关闭 debuginfo,峰值内存骤降(本地 dev 构建的 `[profile.dev]` 默认 debuginfo=2 不受影响)
  - `linux-compat.yml` / `release.yml` 的 test 步骤对 ARM64 设置 `CARGO_BUILD_JOBS=2`、其余 `=4`:限制并行编译单元,进一步压峰值内存

## [0.85.0] - 2026-08-19

### 已完成(待升版)
- **批次 3:Elasticsearch 工作台 React 化(node 迁移)**:新增 `client-nav/src/client/es/es-service.ts`(db_es_* 命令封装 + `indexRowOf`/`healthColor`/`fieldTypeColor` 纯函数)与 `ElasticsearchWorkbench.tsx`(连接生命周期、概览集群健康与索引列表、DSL 检索表格/JSON 视图 + 分页、索引映射/settings 详情、新建索引、删除确认),两文件 per-file 100% 覆盖;`apps/starhub-window` 接入 `db-elasticsearch` 独立窗口入口;修复卸载裸 return 导致的 `.then` 数组解构类型错误与 `exactOptionalPropertyTypes` 下 `fieldRow` 返回类型。`tsc -b` 两配置 EXIT 0,client-nav 全量 416 例全绿,`starhub-window build` 成功。
- **批次 4:DB 监控 Dashboard React 化**:新增 `client-nav/src/client/dashboard/db-dashboard-service.ts`(MySQL/PG/Redis 指标 SQL 常量 + 纯解析函数,自 Vue `src/utils/dbMetrics.ts` 迁移)与 `DbDashboard.tsx`(概览/性能/网络 tab、指标卡、连接会话与慢语句明细;Redis INFO+db_size、MySQL SHOW 系列 + 慢日志 digest 回退、PG pg_stat_activity + pg_stat_statements 扩展失败回退);`DbWorkbench.tsx` 右栏改「SQL/数据」↔「监控」双 tab 渲染 `<DbDashboard>`;顺带修复 `loadPostgres` 慢语句回退用陈旧闭包状态的 bug。两文件 per-file 100% 覆盖,client-nav 全量 464 例全绿,`starhub-window build` 部署到 `dist-starhub-react/`。
- **批次 5:结果网格 / SQL 编辑器补齐**:`client-nav/src/client/sqlFormat.ts`(splitStatements/formatSql)+ `sqlHistory.ts`(loadHistory/saveHistory/addHistory/clearHistory,键 `starhub.sqlHistory` 上限 1000)纯函数;`DbDataGrid.tsx` 升级(CSV 导出、行复制为 INSERT、列筛选服务端过滤、单元格编辑→按主键 `db_mysql_update_rows` 批量保存 + Ctrl/Cmd+S);`DbWorkbench.tsx` SQL 区接格式化/历史/多语句拆分 + 执行后记历史。三文件 + 接线 per-file 100% 覆盖,client-nav 全量 533 例全绿,`tsc -b` 两配置净,tsdown bundle + starhub-window 构建并部署。
- **批次 6:SSH 命令广播 + Web 浏览器**:`client-nav/src/client/terminal/BroadcastDialog.tsx`(会话多选广播弹层,逐会话 `ssh_write` 命令 + 容错)、`web-browser-utils.ts`(normalizeUrl/proxyToOriginal/buildProxyUrl)、`WebBrowser.tsx`(内嵌浏览器:SSH Web 网关幂等启动/端口校验重启/postMessage 桥接/卸载停网关);`SshTerminalOverlay.tsx` 接「广播」按钮与「网页」tab。三文件 per-file 100% 覆盖,client-nav 全量 578 例全绿,starhub-window 构建并部署。(用户指示分屏/危险命令拦截不做)
- **批次 7:主壳独立 AI 聊天面板(Option B)**:新增 `client-nav/src/client/ai/ai-chat-utils.ts`(nodeRenderData 11 种节点归一 + blocksToText/assistantBlocksText 双判别 + openStateView/promptErrorView 纯函数)与 `AiChatPanel.tsx`(主壳 `shell.overlay` 独立 AI 面板:绑定当前 shell 会话经 `sessions.binding(id).session` + `bindSnapshotSelector` 实时订阅,自绘 `ConversationSnapshot.nodes` 消息流 + 流式 partial,发送/停止/加载更早走 `session.prompt/cancel/loadOlder`,无当前会话经 `workspaces.connectWorkspace` 新建);接线:`store.ts` 新增 `createAiChatOverlay`、`index.ts` shell.overlay 注入 sessions/workspaces/aiChat、`StarHubOverlay.tsx` 渲 `<AiChatPanel>`、`StarHubToolWorkspace` 的「AI 助手」钮改为开面板;`client-nav` 加 `@deepseek-ai/dsh-client-web-react` peerDep + tsconfig reference。ai 双文件 per-file 100% 覆盖,client-nav 全量 36 文件 / 620 例全绿,`tsc -b` 两配置 EXIT 0,tsdown bundle + starhub-window 构建并部署到 3086 与 3085 运行时。

## [0.84.1] - 2026-08-18

### 已完成(待升版)
- **修复 dsh web 启动失败(「dsh web 未运行(重试中…)」)**:新安装后 `dsh web 就绪探测超时`,stderr 报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-sdk-jsonrpc-server'`。根因:`web.rs` 只给 `packages/starhub/` 下 8 个本地包补 junction,而 `sdk-jsonrpc-server` 不属于 dsh 安装闭包(INSTALL_ANCHOR=apps/cli),dsh 的 `healProfilesModuleFallback` 永不链接它,web profile 的 `cordis.patch.yml` 裸 entry 解析在 `$DSH_HOME/profiles/node_modules` 停步即 fail-loud。修复:新增 `RUNTIME_HOSTED_PATCH_DEPS` 机制,把闭包外、patch 直接引用的 `sdk-jsonrpc-server` 从 `runtime_dir/node_modules/@deepseek-ai` 补 junction 到 profiles/node_modules(与 LOCAL_PACKAGES 同机制),prod 与全新 DSH_HOME 均稳定启动;`cargo check` 通过
- **测试加固 `find_free_port`**:web.rs 两个端口测试的断言用 `base + MAX_PORT_OFFSET`(u16 普通加法),OS 分配高位临时端口(临时区间 49152–65535)时 u16 溢出 panic,全量并行 `cargo:test` 偶发红;改为 `u32` 中间量比较(上限与下限分开断言),全量 150 例稳定通过(149 passed / 1 ignored)

## [0.84.0] - 2026-08-18

### 已完成(待升版)
- **Redis 专用工作台 React 化(批次 2)**:Redis 资产从 Vue embed 回落升级为壳内 React 原生工作台(替换 `RedisView.vue`)
  - 新增 `src/client/redis/`:`redis-service.ts`(11 个 `db_redis_*` 命令封装 + `redisQuote` 内联转义)、`RedisWorkbench.tsx`(连接/断连生命周期、DB 切换、键列表 SCAN 分页 + 搜索 + 刷新/空态/错误、键操作[打开/重命名/删除/清空/新建]、CLI `db_redis_execute`、toast)、`RedisValueEditor.tsx`(tab 式编辑:string 文本编辑保存/还原/TTL,hash/list/set/zset 字段表增删改,拼装原生 HDEL/SREM/ZREM/HSET/SADD/ZADD/LSET 命令)
  - 接线:`sections.ts` 把 `db-redis` 纳入 `NATIVE_ROUTE_NAMES`;`index.ts` `openAssetPage` 加 `db-redis` → `redisWorkbench.open`;`store.ts` 新增 `createRedisWorkbench`;`StarHubOverlay.tsx` 渲染 `<RedisWorkbench>` 分支
  - 测试:`redis-service` / `RedisValueEditor` / `RedisWorkbench` 三文件 per-file 100% 覆盖(语句/分支/函数/行),61 例全绿;更新 `starhub-apply`/`starhub-shell-state`/`starhub-nav-overlay` 规格(redis→native 工作台断言,ES 维持 Vue embed);client-nav 全量除 sql-editor/db-workbench 两个既有 CodeMirror 重复模块环境失败外全绿;`tsc -b tsconfig.json` + `tsconfig.host.json` 净;tsdown bundle 重建成功

## [0.83.4] - 2026-08-18

### 已完成(待升版)
- **修复新建/编辑连接对话框的 Elasticsearch 地址回显**(壳内 React NewConnectionDialog):
  - 根因:React 对话框没处理 ES 的端点形态,编辑时只读 `config.host`,而 ES 资产地址实际存于 `config.address`(单 URL)或 `config.addresses`(多节点数组),导致地址编辑时不回显
  - 修复:补 ES 三态端点(对齐 Vue `DbConnectionForm` 的 host/address/multi):编辑模式按 `addresses`/`address` 回显并自动选态;提交写回 `address`/`addresses`;测试连接 `db_es_test` 入参携带 `address`/`addresses`;端点校验(空地址/空节点禁用创建与测试)
  - 验证:NewConnectionDialog.tsx 每文件 100% 覆盖率(+4 用例,31 全绿);`tsc -b tsconfig.client.json` 净;client-nav bundle 重建成功

## [0.83.3] - 2026-08-18

### 已完成(待升版)
- **修复 v0.83.2 tag 构建失败**:client-nav Docker 测试(DockerWorkbench / docker-service / DockerExecTerminal spec)在完整 `pnpm run build` 的 `tsc -b tsconfig.client.json` 阶段报类型错误,致 release 构建红
  - `docker-exec-terminal.client.spec.tsx`:移除未使用 `args`/`invoke`;read 结果取数加 `??` 兜底
  - `docker-service.client.spec.ts`:移除未使用 `DockerConnectParams` 导入;`stubInvoke` 返回类型修为 `() => void`(原声明成 invoke handler 致 `restore()` 报"期望 1-2 实参")
  - `docker-workbench.client.spec.tsx`:移除未使用 `args`;`mockImplementation` 处 `vi.fn` 实现显式标注 `Promise<unknown>` 使两次实现类型对齐;`getAllByText().at(-1)` 加 undefined 守卫
  - 验证:3 个 docker spec 47 例全绿;`tsc -b tsconfig.client.json` 净;已提交修复 + 升版 v0.83.3

## [0.83.2] - 2026-08-18

### 已完成(待升版)
- **修复启动偶发「Failed to load plugins」**(报错形如 `failed to import loader entry … (@deepseek-ai/dsh-session-log-export): client-modules: bundle script /plugins/…/client.js?rev=… failed to load`):
  - 根因:启动时 webview 抓取插件 bundle 可能撞上 dsh web 进程更替(旧实例退出/新实例重绑同端口)或 bundle 文件瞬时不可读的窗口,`<script>` 首次 `error` 事件即永久拒绝启动,重启应用即恢复
  - 修复(vendor/deepseek-harness 本地补丁,清单 §11.9 第 5 条):`packages/client/modules` 的 `defaultLoadBundle` 拆出单次抓取 `fetchBundle`,按 300ms/1200ms 退避做有界重试(共 3 次尝试),瞬态失败自愈;真正缺失的 bundle 仍以原报错 fail loud;`manifest.ts` 的 `loadBundle` 契约同步注明
  - 配套:Agent Note `2026-08-18-client-bundle-load-retry`(中英 + sidecar);`loader.client.spec.ts` 新增重试成功用例、失败用例改假定时器断言 3 次尝试;client-modules 28 例全绿、tsdown bundle 已重建

## [0.83.1] - 2026-08-18

### 已完成(待升版)
- **SSH/SFTP 接上 SFTP 跟随终端**:React 终端上报 cwd(OSC7/pwd 解析 + 懒注入),SftpPanel 跟随加载
  - 新增 `terminal-cwd.ts`(extractOsc7Cwd/parsePwdOutput/OSC7_INJECT_COMMAND/isShellPromptLine/createHiddenEchoFilter/createCwdTracker)
  - SshTerminalOverlay:`ssh:data` 解析 cwd + `ssh_exec('pwd')` 初始化 + prompt 后懒注入 OSC7,透传 sshCwd/onFollowTerminal
  - SftpPanel:`onFollowTerminal` 回调 + 跟随按钮启用(不再置灰),跟随 cwd 自动 loadDir

## [0.83.0] - 2026-08-18

### 已完成(待升版)
- **SSH 终端 + SFTP 壳内 React 弹框化(需求:原页面弹框,不再新开独立窗口)**:①接线 `openAssetPage`/`starhub://open-asset`——点击 SSH 资产改为在当前壳内页面 overlay 打开(v0.81.3 曾回退到独立窗口,今回接),`NATIVE_ROUTE_NAMES` 新增 `isSshTerminalAsset` 判定;②`SshTerminalOverlay` 升级为带「终端 / 文件(SFTP)」双 tab 的弹框,SSH 与 SFTP 共用同一 live session(SFTP 经 `sftp_ensure_session` 复用,不重复认证);③新增 React SFTP 面板(SftpPanel.tsx)——目录浏览/面包屑/路径编辑/隐藏文件、单点+Ctrl/Shift 多选、右键菜单(打开/下载/上传/新建文件夹/重命名/删除/复制路径)、流式上传下载、传输任务列表(暂停/继续/取消/重试),复用后端全部 `sftp_*` 命令与 `sftp://transfer-status`/`transfer-progress` 事件;④测试:新增 sftp-panel.spec(连接/列目录/导航/未连接态)、ssh-terminal-overlay 增补 SFTP tab 复用 session 用例,更新 starhub-apply 三处 SSH 路由断言;client-nav 全绿(19 文件 264 例),host tsc 净,bundle 2.28MB

## [0.82.1] - 2026-08-18

### 已完成(待升版)
- **Windows 打包 workflow 修复(v0.82.0 tag 构建失败)**:release.yml Windows job 把
  `defaults.run.working-directory` 设为 `S:\`,导致「Map workspace to a short drive」
  这一步在 `subst S:` 尚未建立映射时以 `S:\` 为 cwd 启动 pwsh,报
  "directory name is invalid"。修复:该步显式 `working-directory: ${{ github.workspace }}`
  先建 `subst S:` 映射,并校验映射已建立、失败即中止(subst S: 被占用时直接报错)。

## [0.82.0] - 2026-08-18

### 已完成(待升版)
- **数据库工作台 React 化(需求 5,批次 4b:建表/改列/索引对话框 + 后端全量 Excel 导出)**:
  - 移植 Vue `src/utils/ddlGenerator.ts` 到 client-nav(`ddlGenerator.ts`):generateCreateTableDDL
    (MySQL/PostgreSQL/ClickHouse 方言、Nullable/ORDER BY/PRIMARY KEY、列/表注释)、
    generateBatchColumnDDL(ADD/MODIFY/CHANGE/DROP 合并单条 ALTER TABLE)、
    generateBatchIndexDDL(DROP+CREATE,isNew 索引不生成 DROP 避 Error 1091)、
    generateAdd/Modify/DropColumnDDL、generateCreate/DropIndexDDL、renderColumnType
  - 新增 3 个 React 模态框 `DbTableDialogs.tsx`:NewTableDialog(表名/Engine/Charset/列网格
    ↑↓移动/删除)、ColumnListDialog(载入列定义批量编辑+类型 datalist+新增列)、IndexListDialog
    (载入索引+列名,UNIQUE/类型下拉+datalist 补列)。均经 db_mysql_execute(db_clickhouse_execute)
    逐条执行生成的 DDL
  - DbWorkbench 接入:库行右键菜单(新建表/刷新表列表)、表行右键菜单新增(编辑列/索引,仅 MySQL,
    与 Vue 端一致);建表成功自动并入树节点
  - **后端全量 Excel 导出(导出从「前端分批拉数据+前端写盘」改为后端直写 xlsx)**:Go sidecar 新增
    `db.mysql.exportExcel` / `db.clickhouse.exportExcel`(MySQL/ClickHouse 适配器 ExportExcel,
    excelize 流式写入 + LIMIT/OFFSET 分批,服务端按表浏览语义支持 filter/columnFilters/orderBy),
    Rust 新增 `db_mysql_export_excel` / `db_clickhouse_export_excel`(main.rs 注册 + commands.toml ACL)
  - React 工作台表数据网格新增「导出 Excel」按钮:经 plugin:dialog|save 选目标路径 → 调后端命令
    服务端直写 xlsx,返回 {filePath,totalRows,durationMs}
  - 测试:新增 ddl-generator.client.spec(23 例,移植自 Vue node --test)、db-workbench.spec 新增
    建表/编辑列/导出一体化用例;client-nav 全绿(315),host tsc 净,bundle 2.24MB

## [0.81.10] - 2026-08-18

### 已完成(待升版)
- **数据库工作台 React 化(需求 5,批次 4a:表操作入口)**:连接树表行右键菜单——
  查看 DDL(get_table_ddl → 弹层展示)、删除表(drop_table,二次确认,成功后从树移除 /
  清选中)、清空表(truncate_table,二次确认);复用 dsh ContextMenu/useContextMenu 胶水。
  DbWorkbench 测试新增右键 DDL 用例。建表/改列/索引批量编辑对话框(批次 4b)留后续

## [0.81.9] - 2026-08-18

### 已完成(待升版)
- **数据库工作台 React 化(需求 5,批次 2+3 + 连接树修复)**:
  - 修复连接树:db_mysql_list_databases 返回 string[],之前误按对象行解析导致库名
    空白、无法选表——改为 string[] 解析(库名/表名正常显示可选)
  - 结果网格 DbDataGrid(批次 3):手写 DOM 虚拟滚动(ROW_HEIGHT=28/OVERSCAN=8)、
    服务端分页(limit/offset/totalRows)、列头排序(orderBy/orderDir)、NULL 高亮、
    数字右对齐;行按 Positional Array 渲染
  - SQL 编辑器 SqlEditor(批次 2):引入 CodeMirror 6(@codemirror/state/view/
    lang-sql/autocomplete/commands,与 Vue 端同款),SQL 语法高亮(MySQL/PG)、
    schema 表/列补全、Mod-Enter 执行 / Shift-Mod-e EXPLAIN、Tab 缩进;工作台
    连接后显示,执行结果小表格展示
  - DbWorkbench 布局:左侧连接树 + 右侧 SQL 编辑器/表数据网格两分;点库展开表、
    点表加载数据
  - 测试:新增 db-data-grid.spec(虚拟滚动/排序/分页/NULL/JSON/失败)与
    sql-editor.spec(挂载/受控/方言/schema),db-workbench.spec 全部覆盖;client-nav
    bundle 含 CM6 正常打包(2.17MB)

## [0.81.8] - 2026-08-18

### 已完成(待升版)
- **Windows 打包根治(NSIS failed opening file,真根因 = 路径超 260 字符)**:CI
  checkout 前缀(~84 字符)+ pnpm deploy 嵌套 node_modules + mistralai/otel 超长
  生成文件名,总路径超 Windows 路径上限 → NSIS `File /r` 中断。双管齐下:
  ①release.yml Windows job 把工作区 `subst` 到短盘符 `S:\` 并以其为默认
  working-directory(最长路径压到 ~200);②`package-dsh-runtime.ts` 组装后裁剪
  node_modules 里全部 `.d.ts/.d.ts.map/.js.map`(运行时只读 .js,安装包也变小)。
  v0.81.6 的悬空链接清扫作为打包前防线保留

## [0.81.7] - 2026-08-18

### 已完成(待升版)
- **数据库工作台 React 化(需求 5,批次 1:骨架 + 连接树)**:新增壳内全屏 React
  `DbWorkbench`(复用 shell.overlay,仿 SshTerminalOverlay 机制)——DB 资产点击从
  「openNewPage 开 Vue embed 独立窗口」改为「壳内原生工作台」;挂载即按资产 config
  建连(db_<type>_connect,per-type 映射 mysql/pg/ch/redis/es)、列库
  (list_databases)、展开库懒加载表(list_tables)、卸载断连;`NATIVE_ROUTE_NAMES`
  纳入全部 db-* 路由 + 新增 `isDatabaseAsset()`;`openAssetPage` 加 native 分派分支。
  测试:新增 db-workbench.spec(连接/列库/展开表/断连/缺 host/失败),更新
  shell-state/overlay/apply 三份规格。SQL 编辑器、结果网格、表操作留后续批次

## [0.81.6] - 2026-08-18

### 已完成(待升版)
- **Windows 打包修复(NSIS "failed opening file …getMachineId-unsupported.d.ts")**:CI 全新
  pnpm store 下部分平台可选文件缺失,`package-dsh-runtime.ts` 物化符号链接时对悬空
  链接是 `catch{continue}` 跳过,悬空 junction 留在产物树 → NSIS `File /r` 遍历到
  "failed opening file" 中断打包。修复:物化时改为**删除**悬空链接(目标不存在,运行时
  也用不到),并在最终产物上做整树悬空链接清扫(打包前最后防线);同时
  `WEB_LOCAL_PACKAGE_DIRS` 补齐 8 个 starhub 本地包(与 Rust web.rs LOCAL_PACKAGES
  对齐,安装包内的壳才能加载 starhub 工具插件)

## [0.81.5] - 2026-08-18

### 已完成(待升版)
- **starhub-tools 传输解析改懒加载(修复壳内组合启动竞态)**:sdk-jsonrpc-server 与
  starhub-tools 各自 fiber 并行加载,web 组合里启动期 `ctx.get('sdk-transport')`
  可能取不到(服务尚未 provide)导致 starhub-tools 加载失败、dsh web 起不来;
  改为每次工具调用时解析,失败信息与组合缺失一致(3086 实测修复启动)

## [0.81.4] - 2026-08-18

### 已完成(待升版)
- **@ 资产引用改纯文本(用户反馈)**:`@` pick 序列化从 `<asset id=…>name</asset>` 改为
  纯文本 `@name (user@host)`——对话框中不再出现原始标记;资产 id 绑定仍经
  starhub-tool-context settings 轻绑定,pre-step 注入带 id,模型据此解析目标资产
- **壳内(web)会话可调用 starhub 工具(用户反馈:@ 本质是调工具内 AI 助手/Agent 操作)**:
  ① starhub-web 组合补 sdk-jsonrpc-server + starhub-tools + approval-bridge +
  session-registry/domain-events/live-context;② Rust 为 web 进程加 stdio JSON-RPC
  桥(web.rs read/write loop + 共享 HostBridgeState 分发 starhub/tool.execute 等),
  `notify_dsh` 同时投给嵌入 runtime 与 web 进程(web 退出自动摘除);③ approval-bridge
  新增 `answerer` 配置(web 组合关应答,交给壳自己的浏览器确认框,避免双应答);
  ④ web.rs LOCAL_PACKAGES 补齐 8 个本地包 junction。工作区会话 @ 资产后,壳内
  Agent 可对目标资产执行 ssh/db/sftp 等操作

## [0.81.3] - 2026-08-18

### 已完成(待升版)
- **SSH 资产点击改回新开独立窗口(用户反馈)**:壳内终端 overlay 改为统一新开
  embed 窗口(`/ssh/<instanceId>` 的 Vue SSH 页),与其它资产一致;`starhub://
  open-asset` 的 focus 对 ssh 资产同样走窗口聚焦(不再特判 overlay)
- **shell 终端 ssh_connect 修复 missing field auth(用户反馈)**:`SshTerminalOverlay`
  直接把资产 config 透传,缺 Rust 必需的 `auth` 字段;现按资产配置(password /
  privateKey / usePasswordAuth / useKeyAuth)构建 SshAuth(与 Vue buildAuth 同构)
- **右侧工作区列恢复「AI 助手」入口(用户反馈)**:工具工作区列头部新增 AI 助手
  按钮,聚焦(或新建)壳内 AI 会话,与 ask-ai 同一聚焦逻辑

## [0.81.2] - 2026-08-18

### 已完成(待升版)
- **插件市场分页改固定指示器(用户反馈:分页没显示页码且圆点溢出)**:圆点列随页数无限增长会溢出,改为固定的「第 X / Y 页 · 共 N 个插件」指示器(上一页/下一页保留);React 壳(plugins.tsx)与 Vue 嵌入页(SettingsView.vue)同步,窄窗自动换行。dsw/cyber token 分别就位
- **联动 M6 任务锚点补全(契约 §2.2)**:`starhub/open.asset` / `starhub/focus.tool` 带 `sessionId` 时,处理器把该会话重锚到目标资产(域工具路由跟随)+ 记录有界任务资产轨迹(taskTrails ≤20,去重保序);`starhub/live.snapshot` 返回 `taskTrails`;live-context 插件注入 `[Task trails]` 段。编排链路「打开 web-1 终端→SSH exec→切到 db 库跑查询」现在跨窗口保持任务连续性
- **联动 M3 活性快照超时保护**:live-context 反向 `starhub/live.snapshot` pull 加 2s 超时(宿主未响应时不再阻塞 agent pre-step,降级为本地 registry+events)
- **联动桥出站通知修复**:`HarnessRuntime::spawn` 后挂桥 weak 引用(`HostBridgeState::set_runtime`),`notify_dsh`(registry.sync / domain.event 出站)在测试与实际桌面运行时都生效
- **Rust harness 测试**:移除冗余 `oneshot` 导入;新增 M6 重锚 + 任务轨迹测试

## [0.81.1] - 2026-08-17

### 已完成(待升版)
- **tag 构建修复(client tsdown 缺 @tsdown/css)**:client-nav `SshTerminalOverlay` 自 v0.80.0 就 import `@xterm/xterm/css/xterm.css`,但 `@tsdown/css` 是 tsdown 的 optional peer,仓库未显式声明,pnpm 默认不装;此前 CI 均挂在 tsc 阶段没跑到 client tsdown,本次 v0.81.0 tag 构建 tsc 通过后暴露。修复:DSH_ROOT 根 devDependencies 显式声明 `@tsdown/css@0.22.2`(对齐 tsdown peer),`pnpm run build:lib:client` 恢复全绿、client-nav 束产物含 style.css

## [0.81.0] - 2026-08-17

### 已完成(待升版)
- **StarHub × dsh 联动实施(方案 B 控制面收敛 dsh / 数据面留 Rust+Go)**:按 `docs/联动设计-dsh中枢-2026-08-17.md` 与 `docs/联动实施-桥接契约-2026-08-17.md` 四方施工完成——①dsh 侧:`sdk-jsonrpc-server` 本地补丁暴露 `sdk-notifications` 服务(入站 notification 按 method 多路分发、订阅者异常隔离);新包 `session-registry`(订阅 `starhub/registry.sync` 全量快照,`list()`/`forAsset()`)、`domain-events`(订阅 `starhub/domain.event`,每资产环形缓冲 50 + 全局桶,`recent()` ts 倒序)、`live-context`(agent/pre-step 注入 registry 快照 + 事件摘要 + `starhub/live.snapshot` pull,按 maxSnapshotChars 截断、pull 失败降级);`starhub-tools` 新增 `open_connection`/`focus_terminal` 模型工具(桥 `starhub/open.asset`/`starhub/focus.tool`);`examples/starhub-agent/cordis.yml` 组合接线三插件;②Rust 侧:stdio 新增 `starhub/live.snapshot`/`open.asset`/`focus.tool` request 与 `registry.sync`/`domain.event` 出站 notify;AI 工具执行成功自动生成 origin=ai 领域事件(notify dsh + 广播 `starhub://domain-event` + recentExecs 缓存);Tauri command 新增 `ssh_attach`/`ssh_detach`(附着引用计数,归零才真断)、`dsh_report_domain_event`(强制 user、summary 截断)、`starhub_ask_ai`;③client-nav:`@` 资产 source(`starhub-asset`,ui-input-trigger 流水线,onPick ReferenceInsert `<asset id=…>` + 轻绑定工具上下文不切窗)、监听 `starhub://open-asset`(聚焦/开窗,窗口 label 带资产 id)与 `starhub://ask-ai`(聚焦会话 + prefill composer);④Vue 面板:SshTerminal/DbView/SftpPanel 工具栏「问 AI」按钮、`starhub://domain-event`(origin=ai)监听(网格刷新/终端横幅 `.cyber-ai-banner`/SFTP 列表刷新)、SSH 命令/DB 查询/表打开用户起源上报(`dsh_report_domain_event`);新增 `src/services/linkage.ts` 封装与 `tests/linkage.test.ts`;三方测试/类型检查全绿(cargo 148 测试、dsh 三新包 50 测试 100% 覆盖、client-nav 224 测试、Vue 22 测试)
- **client-nav 测试 exactOptionalPropertyTypes 修复(GitHub tag 构建报错)**:`new-connection-dialog.client.spec.tsx` 三处 `calls` 数组声明与 6 个 stub 处理器在严格 `exactOptionalPropertyTypes` 下不兼容(TS2379/TS2322),改为 `args: Record<string, unknown> | undefined` 并加收窄;`tsc -b tsconfig.client.json` 恢复干净
- **session-registry/domain-events 依赖注入修复**:两插件改为 `inject: ['sdk-notifications']` 声明依赖(cordis fiber 拓扑等待 sdk-jsonrpc-server ACTIVE 后 apply),修复 apply/effect 阶段 `ctx.get` 拿不到宿主私有服务导致插件树加载失败、agent 循环无输出的问题(E2E `dsh_stdio_roundtrip`/`dsh_tool_call_bridges` 恢复全绿)

## [0.80.1] - 2026-08-17

### 已完成(待升版)
- **session log 下载改「另存为」对话框(用户反馈:程序内下载不生效、不知存到哪)**:主窗口 on_download 的 Requested 分支从「静默放行进系统下载目录」改为弹原生另存为对话框(预填 webview 建议文件名),用户选路径后写入 `destination` 放行;取消对话框 = 中止下载。宿主链路体检结论:`/api/session.export` 端点与 dsh-session-log-export 客户端插件在两端实例均健康(3085 实测 GET 下载 883KB zip 成功),问题纯在 webview 下载落盘不可见
- **v0.80.0 遗留清理**:①`src-tauri/Cargo.lock` starhub 条目缺 `name = "starhub"` 行(cargo check/build 全挂,TOML 解析失败);②`DbView.vue` 导出 Excel 后注册 excel 资产并 `router.push('excel')` 跳已随 Excel 退役删除的路由(改为仅完成通知);③`assetRouting.ts` 残留 `excel` 路由名映射(删除);④client-nav `starhub-shell-state` 测试残留 excel 前缀断言(改为只测非字符串 dbType 回退)
- **starhub-approval 瘦身改名为 starhub-approval-bridge(用户拍板)**:策略本体归 dsh 权限 preset(本包只消费 `permission.defaultPreset`:danger-full-access→never,其余→ask),保留风险门(starhub 域工具唯一 ask 来源,防误删核心)与 `starhub/approval.request` 应答桥;包目录 `packages/starhub/approval` → `approval-bridge`,examples/package.json、python/sdk-runtime、tsconfig.host.json、cordis.yml 引用同步

## [0.80.0] - 2026-08-17

### 新增
- **壳内 SSH 终端(六项需求 3)**:client-nav 的 SSH 资产改为在 dsh `shell.overlay` 内以 xterm 直渲;接入 `ssh_connect`、`ssh_write`、`ssh_resize`、`ssh_disconnect` 与 `ssh:data:*`/`ssh:close:*` 事件,终端连接生命周期提升到 root scope,切换会话不受 session scope 影响。
- **插件市场分页滑动展示(六项需求 6)**:React 壳内设置和 Vue 回退设置同步改为每页 6 张市场卡片,提供前后翻页与页码指示;搜索和刷新会复位到第一页。

### 变更
- **数据库结果网格重构(六项需求 5)**:删除 DB Univer Canvas,以 `DbSimpleGrid.vue` 原生 HTML 表格和虚拟滚动替代,保留排序、列宽调节、字段提示、NULL、编辑、右键行操作和现有 DataGrid 保存/分页接口。
- **Excel 功能退役**:删除 Excel/CSV 工作簿前端路由、视图、store、组件和 Univer 集成,移除 `@univerjs/*` 与 `rxjs` 前端依赖;数据库 XLSX/CSV 导入导出仍由 Sidecar `excelize` 提供。

---

### 新增
- **新建连接对话框 SSH 支持 MFA/2FA(六项需求 2)**:client-nav `NewConnectionDialog.tsx` 认证方式对齐 Vue 版三档(password/key/mfa);mfa 档显示「MFA 主密码」输入,config 写入 `authMode:'mfa'` + `mfaEnabled:true` + `mfaPassword`(契约对齐 `SshConnectionForm.vue` 与 `src/services/ssh.ts`);编辑模式留空不提交(merge 保持原值)
- **新建连接对话框「测试连接」+ 主按钮明显化(六项需求 4)**:actionRow 新增描边「测试连接」按钮(`.btnOutline`),「创建/保存」升级为高对比主按钮(`.btnPrimary`);测试命令全类型接线——ssh `test_ssh_connection`(含 kb-interactive 内联验证码面板 + hostkey 自动接受不持久化,`tauri.ts` 新增 `tauriListen` 事件桥)、db 各类型 `db_<type>_test`、kafka/nsq `broker_test`、docker `docker_test`;状态行显示 测试中…/成功(耗时)/失败原因,编辑模式密钥留空时拦截并提示;`NewConnectionDialog.tsx` / `tauri.ts` 覆盖率 per-file 100%(含历史缺口补齐)

### 修复
- **右侧栏资产行主机名溢出(六项需求 1)**:client-nav `StarHubToolWorkspace.module.css` 的 `.rowSub` 补 `min-width:0` / `overflow:hidden` / `text-overflow:ellipsis` / `max-width:55%`——名称优先完整可见,`username@host` 溢出省略号截断、不撑破行布局

---

## [0.79.3] - 2026-08-17

### 修复
- **自定义模型沙箱升级报错**:`sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode` —— 根因:会话文件策略已是(或切到)最宽 `danger-full-access` 时,弱模型在 bash 调用里带 `sandbox_permissions` 升级字段,升级到更窄模式被 `approveEscalation` 拒绝。修复:dsh-sandbox `escalation.ts` 新增 `modeCovers()`——请求模式已被当前模式覆盖(相等或更窄)时按 no-op 放行(返回 effectiveMode),仅未知模式仍 fail-closed
- **自定义模型不支持图片输入**:pi-ai 模型 profile 默认 `input: ['text']` 且模型编辑 UI 无图片开关。修复:ui-settings-models 的 DeepSeekModelsEditor / ModelListEditor 高级区新增「支持图片输入」复选框(写 `input: ['text','image']` / 删除),locales 加 `imageInput`/`imageInputHint`(en+zh)
- **subagent 默认走 deepseek 而非指定模型**:`resolveChildAgentOptions` 继承父 agent 创建时 options(默认模型),用户切模型只更新会话 request header。修复:child-agent.ts / continuation.ts 优先读 `parent.session.requestHeader()?.config` 的 provider/model/maxTokens,回退 `parent.options`;新增模型切换继承单测

## [0.79.2] - 2026-08-17

### 修复
- **CI 全量类型检查失败(白名单移除的 vendor 侧遗留)**:aiSettings.ts 的 legacy 字段删除断言用双转换(`as unknown as Record<string, unknown>`);测试用例的 legacy 字段对象改 `as unknown as Partial<AiSettings>` 并补 `AiSettings` 类型导入——`pnpm run build`(vendor 全量 tsc + tsdown)恢复绿

## [0.79.0] - 2026-08-17

### 新增
- **内嵌 AI 助手全面迁移到 deepseek-harness(用户要求「全面拥抱 deepseek harness」)**:SSH/数据库/Redis/ES/Docker/Excel 六个宿主面板的 AI 助手统一走 dsh 运行时——会话由 dsh 事件内核驱动,消息经事件投影渲染,子代理/待办/工具结果/用量全部进投影块;域工具(ssh/sftp/db/redis/es/docker/excel/mcp/skill_save)经 `dsh://tool-exec` 桥回前端面板执行(复用既有连接与凭证逻辑,Excel 作用于当前工作簿),全局工具(list_capabilities/list_assets/session_search/memory)在 Rust 主进程执行;新聊天面板 AiDshChat(消息右键复制、历史存档弹窗重命名/删除/复制标题、确认 dock 只有「批准/拒绝」)
- **命令白名单移除,审批统一走 dsh 权限体系(用户要求)**:设置 → AI 不再有「命令白名单」区块;工具审批由 dsh 审批门(共享 settings.yaml 的 permission preset,设置 → 通用 → 权限)统一管控——新建会话时按 preset 固定策略(默认 ask,危险全权限 never),starhub-approval 插件做 starhub_* 工具风险门(ssh/db 写命令、redis 写命令、es 写操作、sftp 传文件、mcp 调用、记忆/skill 写入等恒确认),确认卡经 `dsh://approval` 桥回宿主面板,只做一次性批准/拒绝,无免确认白名单
- **dsh 品牌融合(用户要求)**:左上角字标改为「StarHub」+ 右侧「deepseek harness」角标,浏览器标题与设置 About 同步显示
- **右键菜单完善(用户要求)**:右侧栏资产/连接行右键(打开/编辑/复制/删除)、AI 会话右键(重命名/复制/归档/分叉)、左侧 StarHub 工具导航与工作区文件夹右键(新建/重命名/删除工作区)

### 变更
- **旧 AI 内核退役**:删除 useAiChatHost/AiChat.vue/aiTools/aiSftpTools/aiLocal/aiWorkspace 及 runAgent 会话运行时(白名单、确认卡加白、@/# mention、会话级模型切换不再保留);SSH 终端「静默模式」保留,命令执行路由到终端自身通道(可见 PTY / 静默 exec),cwd 跟踪与审计钩子保留;记忆自动沉淀服务改用独立 memory 工具定义
- **dsh 审批/工具桥**:Rust 主进程新增 `dsh_approval_reply` / `dsh_tool_exec_reply` / `dsh_bind_session` 命令与 `dsh://approval` / `dsh://tool-exec` 事件(180s 超时,失败按拒绝收口);会话-资产绑定与子代理父链支持 memory 资产作用域;`DSH_SETTINGS_PATH` 注入与 dsh web GUI 共享同一份 settings.yaml
- **cargo-env.bat 编码修复**:批处理注释改纯 ASCII——cmd 用 OEM 代码页解析 .bat,UTF-8 中文注释会导致 `npm run cargo:check/test` 解析错乱

### 修复
- **dsh starhub-tools 插件加载失败**:mcp_call 的 arguments schema 缺显式 `additionalProperties`,dsh 工具 schema 编译器要求显式 true/false——补上后插件树正常加载(此前 initialize 成功但首轮 prompt 即崩)

## [0.78.1] - 2026-08-17

### 修复
- **安装包 dsh web 启动失败(「dsh web 未就绪:dsh web 未运行(重试中…)」,v0.78.0 安装包整体不可用)**:`package-dsh-runtime.ts` 的构建步骤只跑 `build:lib`,从未构建 `apps/web` 的 vite 产物——`dsh-web-frontend` 的 `files` 只放行 `dist`,`pnpm deploy --prod` 闭包里只剩 `package.json`,运行时 `dsh-web-app` 经 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 定位浏览器入口必炸("web-app: frontend dist not built");构建改为完整 `build`(build:lib + build:web),并在组装后 fail-loud 校验 `dsh-web-frontend/dist/index.html` 已入包,打包期拦截此类坏包

## [0.78.0] - 2026-08-16

### 新增
- **资产实例操作页改为新开独立窗口(用户要求)**:侧栏工具区点击已有连接不再用整幅 overlay 盖住 dsh 主壳——桌面端经 `plugin:webview|create_webview_window` 开独立 webview 窗口(label 走 capability `starhub-*` glob,embed 页保有 IPC 授权),浏览器预览退化为新标签页;选择桥仍记录当前资产供 AI 工具上下文注入
- **新建/编辑连接改为 dsh 风格小对话框(用户要求)**:原「设置页资产 tab 整幅 iframe」连接管理退役,换成壳内 React 小对话框(类型下拉:SSH/MySQL/PostgreSQL/ClickHouse/Redis/Elasticsearch/Kafka/NSQ/Docker,公共 + 专有字段,SSL/Redis DB 索引/SSH 私钥文件);支持编辑(资产行 hover 编辑钮,预填,密码/私钥留空保持不变)与两步确认删除;IPC 契约与 `src/services/asset.ts` 一致

### 修复
- **「资产加载失败:Command get_assets not allowed by ACL」**:tauri 2.x 起 remote origin(127.0.0.1 的 dsh 主壳)的 app command 也强制走 ACL——新增 `src-tauri/permissions/commands.toml` 权限文件,单条 `starhub-commands` 权限集中列出全部 236 个 app command,default capability 引用它;capability `windows` 增加 `starhub-*` glob(新开的资产窗口同属授权范围)
- **session log 下载桌面端静默失败**:WebView2 默认丢弃 webview 内 anchor 下载——主窗口改为程序化创建(声明式 `app.windows` 挂不上 `on_download`),挂 `on_download` 钩子放行下载(Requested/Finished 落日志);窗口属性与原声明逐项对齐
- **侧栏切换子类误收起右侧工作区列**:子类点击从一律 `toggleDetails` 改为「切到不同子类只 `openDetails`(保持展开换内容),重复点击当前子类才 toggle 收起」
- **设置面板 StarHub 分组子项去掉 star- 前缀(用户要求,回退 0.76.1 的命名)**:分组头「StarHub」已承担归属标识,子项恢复 AI 助手/插件/审计日志/告警规则/关于
- **插件 tab 移除「已安装插件」列表(用户要求)**:启停/卸载入口随之下线,已装列表仅静默拉取用于市场项「已安装」标记;插件市场/导入空列表随 ACL 修复恢复有数据

## [0.76.2] - 2026-08-16

### 修复
- **GitHub CI Linux 打包失败(junction 清理)**:`harness::web::tests::sync_user_client_plugins_injects_and_cleans` 在 Linux 上断言「禁用后 junction 应清理」失败——失效用户 UI 插件链接的移除用 `fs::remove_dir`(Unix 底层 rmdir 对目录 symlink 返回 ENOTDIR,错误被 `let _ =` 吞掉导致链接残留),改为 Windows 用 `remove_dir` / Unix 用 `remove_file`(unlink);WSL 实测确认 rmdir 对 symlink 的行为,Windows 本地全量 cargo test 通过

## [0.76.1] - 2026-08-16

### 变更
- **设置面板 StarHub 条目加 star- 标识(用户要求)**:dsh 设置侧栏 StarHub 分组下的 5 个子项 label 统一加 `star-` 前缀(star-AI 助手 / star-插件 / star-审计日志 / star-告警规则 / star-关于),与 dsh 原生条目(通用/模型/插件/Agent 预设)区分

## [0.76.0] - 2026-08-16

### 新增
- **设置面板两列化(用户要求)**:dsh 设置侧栏中 StarHub 改为可展开分组(点击分组头展开/收起、默认展开),5 个子项(AI 助手/插件/审计日志/告警规则/关于)各自以独立 `settings.section` 注册、点选右侧直渲内容,无面板内部嵌套列——旧版 SettingsPanel(面板内 rail + 内容区)删除;实现上扩展 vendored dsh 内核:ui-slots list 槽 `KindOptions` 增加可选 `group`/`groupLabel`(经 StoredEntry 投影透传),ui-settings-general 的 SettingsRoot 侧栏渲染可折叠分组(`buildNavItems` 聚合排序 + 折叠态组件局部 state + chevron/缩进样式),两处测试同步补齐(ledger 分组投影、分组渲染/折叠/回退/排序),client-nav/ui-settings-general/ui-slots 三包 per-file 100% 覆盖率

## [0.75.0] - 2026-08-16

### 新增
- **插件体系与 dsh 打通**:StarHub 插件 = dsh 插件,市场 = dsh 市场,可从市场/URL/本地快速安装 UI 类插件——`plugins.rs` 放开 `dsh.client`/UI 包名/`dependencies` 拒装(依赖分层解析:`@deepseek-ai/*` 经 vendor junction,第三方尽力解析),registry 新增 `dshClient`/`builtin` 字段;内置插件(client-nav/host-static/tool-context/tools)幂等注册、不可启停/卸载、不进 runtime 组合;`web.rs` spawn 前把启用中的 dsh.client 用户插件按包名 junction 进 `profiles/node_modules` 并在 patch 追加 entry 行(实测自建 UI 插件进入 `__DSH_BOOT__`、bundle 200,dsh 内核零改动);市场 UI/主题/皮肤类收录;插件 tab 显示 UI/内置徽标、内置启停/卸载禁用、UI 风险文案区分;`docs/插件体系打通方案-dsh插件统一.md` 记录实现
- **设置面板交互调整**:StarHub 分区改为「点击 StarHub 折叠头展开/收起 5 个子菜单(AI 助手/插件/审计日志/告警规则/关于),再点折叠」的导航形态;AI 助手中的「上下文预算/最大工具迭代步数/压缩触发阈值」三个字段删除(交由 dsh harness 的上下文/迭代配置接管),AI tab 只保留命令白名单与记忆管理(4 开关 + 记忆管理弹窗),对应 localStorage 读写同步精简

## [0.74.0] - 2026-08-16

### 新增
- **Settings 页按 tab 完成 Vue→React 壳内迁移(§3.2 特例)**:dsh 设置面板 StarHub 分区改为壳内 React 面板(tab 导轨 + 内容区,不再 embed iframe)——插件(列表/URL/目录/Zip 导入/市场/风险确认/卸载)、审计(操作历史/统计/清理)、告警(规则 CRUD/Webhook 测试)、关于(版本/更新检查安装)、AI(命令白名单 + 记忆与上下文 + 记忆管理弹窗)5 个 tab 直渲;通用/外观由 dsh 设置接管不做,资产 tab 暂留 iframe(连接管理 overlay);服务层逐文件复制去 Pinia 耦合(审计/告警/插件/updater/记忆,updater 走 plugin:updater|* invoke + Channel 桥),AI 设置读写沿用 ai-v2 localStorage 无缝承接;client-nav 152 个测试全绿、per-file 100% 覆盖率

## [0.73.0] - 2026-08-16

### 新增
- **Broker 页完成 Vue→React 壳内迁移(P1 首个样本)**:`client-nav` 新增 broker service(复用 Rust `broker_overview`,走顶层帧 Tauri 桥)、DashboardCard 通用仪表盘卡片与 BrokerView 工作台(壳内直渲、dsw token 视觉、30s 自动刷新、卡片详情模态);`sections.ts` 事实表新增 `renderMode`(`iframe`/`native`),`db-broker` 路由切壳内组件、一行可回退;overlay 注入资产源供 native 页反查资产;client-nav 补齐包规范(invariant 伴生、per-file 100% 覆盖率、89 个测试全绿)

## [0.72.4] - 2026-08-16

### 文档
- **新增 `docs/迁移手册-Vue到React渐进迁移.md`**:绞杀者模式迁移的执行手册(配套重构方案 B)——五条铁律、v0.72.2 实测家底盘点(视图/组件/store/服务/i18n/cyber/Vuetify 用量)、九页迁移顺序(Settings 按 tab 特例)、Vue→React 全量技术映射表(框架/状态纪律/UI/token/embed 协议退役对照)、单页 10 步 playbook 与验收清单模板、迁移台账、5 项待拍板决策(M1–M5)

## [0.72.3] - 2026-08-16

### 修复
- **本地 tauri:build 构建链修复(TS6307)**:`vendor/deepseek-harness/tsconfig.host.json` 的 references 漏引 `packages/starhub/tool-context` 项目,而 host aggregate 的 tests 通配(`packages/*/*/tests/**/*.ts`)把 `tool-context.spec.ts` 纳入,其 `../src/index.ts` 导入无处归属,导致 `tsc -b tsconfig.host.json` 报 TS6307、`npm run package:dsh-runtime` 失败、`tauri:build` 无法出包;补上 project reference 后本地全量构建恢复

## [0.72.2] - 2026-08-16

### 修复
- **本地 vue-tsc 无法运行(构建链)**:`vue-tsc@2.0.0` 是上游发布残缺版本(tarball 缺 index.js),pnpm-lock 解析到它导致本地 `npm run build` 第一步就崩;声明下限提升为 `^2.2.0`,pnpm-lock 对齐 typescript 5.9.3(与 package-lock/CI 一致,消除 TS 版本差异造成的误报),本地全量类型检查与 CI 同口径通过

## [0.72.1] - 2026-08-16

### 修复
- **CI 构建类型错误(TS2322 ×4)**:`useEmbedConnBridgeOnUnmount` 声明返回 `void`,但 SshTerminal / DbView / DockerView / RedisView 四个视图把返回值赋给 `(() => void) | null` 的 `stopEmbedConnBridge` 并做主动 teardown;改为返回停止函数(卸载仍经 onBeforeUnmount 自动清理)

## [0.72.0] - 2026-08-16

### 新增
- **连接管理入口进工具工作区列(侧栏红框区功能补全)**:子类列头带资产数徽标、刷新与「新建连接」按钮;新建/编辑/删除走连接管理 overlay(设置页只挂资产 tab 的整幅 iframe,`settingsEmbedUrl(['assets'],'assets')`),空态页按钮同路;overlay 开关跨 root/session-maybe 两个 scope 走 apply 持有的裸 source 桥(`createConnectionManagerOverlay`,与选择桥同范式)
- **StarHub 设置融入 dsh 底部设置齿轮**:client-nav 注册 `settings.section` 的 StarHub 分区(order 30,排在 通用/模型/插件/Agent 预设 之后),embed StarHub 设置页——可见 tab 去掉资产/外观(资产经工具区管理、外观由 dsh 主题设置负责),落地 AI 助手 tab,`chrome=inline` 隐藏页内关闭钮(关闭由 dsh 对话框负责);StarHub 侧 SettingsView 新增 `visibleTabs`/`hideEmbedClose` props(tab 条改 v-for 数据驱动),`/settings` 路由支持 `?tabs=&tab=&chrome=` query 过滤

### 变更
- **侧栏「工具」区排版重构**:大类行即分组头(去掉重复的灰色「工具」小标题),chevron 随展开态旋转;子类行统一缩进/hover/active 态;inline style 改 CSS Modules,颜色/悬停全部走 `--dsw-alias-*` token;nav store 收敛为仅大类展开态(旧扁平条目状态退役)
- **浏览器预览友好空态**:无 Tauri IPC(纯浏览器打开 dsh web GUI)时资产列表落 preview 态,展示「浏览器预览模式,请在 StarHub 桌面应用中管理连接」,不再裸报「资产加载失败:Tauri IPC unavailable (browser preview)」;其他拉取失败给错误 + 重试按钮
- client-nav 测试 33 全过(新增 starhub-nav-overlay 套件:Nav/Overlay/SettingsSection 组件行为)

### 移除
- 侧栏导航去掉 Excel 条目(Excel 功能页保留在 embed 路由,仅退出侧栏);旧扁平条目表 `STARHUB_SECTIONS`/`sectionEmbedUrl` 退役,overlay 改为连接管理桥驱动

## [0.71.1] - 2026-08-16

### 修复
- **3086/打包实例 GUI 无法启动(根因)**:client-nav 共享单一 store handle 跨 root(sidebar/overlay)与 session-maybe(workspace)两个 scope 挂载,违反 one-handle-one-scope 约束直接抛错;且 session-maybe 席位在无会话分支框架不下发注册侧 store(useStore is not a function)。重构为:nav store(root)+ apply 持有的选择桥与资产列表 holder(裸 source 经 inject hooks 舱位下发、回调写入,同 ui-agent-preset controller 范式);新增 `starhub-shell-state` 测试套件,client-nav 18 测试全过
- **实例路由前缀错配(P0)**:子类前缀固定 `/db/mysql`,PostgreSQL/ClickHouse/Redis/ES/Broker 资产被错路由进 DbView;改为按资产类型派生(`routePrefixForAsset`),embed 侧 EmbedAssetBar/EmbedSectionEmpty 同步用 `routeNameForAsset` 派生路由名
- **tool-context 残留(P1)**:取消选中资产后 settings patch 不清空,过期资产滞留成 AI 上下文;改为全量四字段写入(空串清除)
- **iframe 重载风险(P1)**:`assetInstanceUrl` 渲染期 `Date.now()` 改为 openAsset 时一次性生成 instanceId
- **资产列表不刷新 / 空态新建不跳转 / Broker 归属与遗留条目(P2)**:挂载与切换子类重拉 get_assets;空态/资产条新建成功后直接跳进新资产实例页;Broker 归「终端」子类(方案 2.1);清理 redis/es/broker 扁平遗留条目
- **构建链修复**:根 package.json 显式锁 rxjs ^7.8.2(pnpm 把 univer 的 peer 解析成 7.0.0,其根入口不导出 filter 导致 embed 构建失败);入包脚本与 web.rs 的本地包清单补 `tool-context`(v0.71 注册进组合但未入包,junction 目标缺失时跳过并 warn)

## [0.71.0] - 2026-08-15

### 新增
- AI 上下文绑定(方案 4.3)完整落地:新增 dsh host 插件 `@deepseek-ai/dsh-starhub-tool-context`(`agent/pre-step` 读 `starhub-tool-context` settings namespace,把当前 StarHub 工具/资产/路由前缀注入每个 agent 请求,仿 `time-context` 的 plugin 来源 user message);client-nav 在子类/资产变化时经 `api.settings.update` 写入该 namespace;插件已注册进 starhub-web 组合;全量 tsc + 10 测试通过

---

## [0.70.0] - 2026-08-15

### 新增
- 重构方案(交互与信息架构)全部实施:
  - **第 2 章 信息架构**:侧栏「工具」大类可展开,下挂子类(终端/数据库/Docker);`sections.ts` 扩展为「大类→子类→资产路由」三层事实表;右侧工具工作区列按子类过滤资产列表,点资产行弹出实例操作页(embed iframe,功能不变);`store.ts` 合并导航+资产为单一共享 store
  - **第 3 章 功能页**:EmbedAssetBar 升级连接上下文头部(类型徽标 + 连接状态点 + 一键连接/断开 + 内联新建连接,不再跳设置);新增 `useEmbedConnBridge`(postMessage 状态桥:视图上报 `starhub-embed-conn-state`,资产条发 `starhub-embed-conn-action`),DbView / RedisView / DockerView / SshTerminal 接入;空态页内联新建连接表单;打开即用(各视图挂载自动连接,已有行为保留)
  - **第 4 章**:4.1/4.2 工具停靠右栏(workspace 席位 + details.workspace 内席)完成;4.3 AI 上下文绑定客户端半边(壳级 store 持有工具状态 + iframe 状态上报)完成,host 侧注入插件留待单独实现
- 全量 tsc + 706 测试通过,embed 构建通过;3086 测试实例已验证

---

## [0.69.2] - 2026-08-15

### 新增
- 方案调整(仅文档):侧栏「工具工作区」升级为「工具大类 → 子类(终端/数据库/Docker)→ 资产列表 → 实例操作页」三层交互,写入 `docs/重构方案-交互与信息架构.md`(2.1/2.2/2.3/第 5 节)与 `docs/重构方案-B-壳内React插件化.md`(Step 3 记录);操作页暂用 embed iframe(功能不变),随 B 路径逐个壳内 React 化

---

## [0.69.1] - 2026-08-15

### 修复
- 无会话时点「工具工作区」打不开:details 列是 session scope,AppFrame 无会话时列宽强制 0、详情席位不渲染;新增 `workspace` 席位(session-maybe),AppFrame 无会话时在右栏渲染 workspace(StarHub 工具工作区),有会话时渲染 details;去掉切会话自动关列(工具工作区跨会话保活);704 测试全绿

---

## [0.69.0] - 2026-08-15

### 新增
- 侧栏「工具工作区」入口改为 toggle 交互:点一下展开右侧工具工作区,再点一下关闭(`ctx.layout.toggleDetails()`,ui-layout 新增 `toggleDetails` action 与 service 方法,补齐 layout-store / service 测试)

---

## [0.68.1] - 2026-08-15

### 修复
- GitHub CI `build:lib:client` 类型错误:Step 2 将 `details` 席位 scope 改为 `session-maybe` 触发连锁声明冲突(其他包测试硬编码 `details: session`、AppFrame 的 SessionProvider 条件类型消失、client-nav 测试缺 session-maybe standard props)。实测发现 dsh 硬约束 **`one handle, one scope`**(DetailsPanel 与 conversation.session 共享 chatStore,details 不能改 session-maybe),**方案 A 被否决**;改为修订版:details 保持 session,DetailsPanel 新增 `details.workspace` 内席(无选中时显示工具工作区,fallback 保留原 guidance),client-nav 工具工作区注册该内席;全量 `tsc -b tsconfig.client.json` + 703 测试 + `package:dsh-runtime` 本地复现全部通过
- `docs/重构方案-B-壳内React插件化.md` Step 2 记录改为修订版结论(方案 A 否决原因、无会话可达需方案 B 独立列)

---

## [0.68.0] - 2026-08-15

### 新增
- B 路径 Phase 0 spike Step 2:`details` 右栏席位改造(方案 A)——`ui-layout` 的 `details` scope `session` → `session-maybe`(无会话右栏可达、切会话不再自动关闭,工具工作区跨会话保活),`ui-conversation` 的 `DetailsPanel` 新增 `details.workspace` 内席(无选中工具调用时右栏渲染 StarHub 工具工作区,选中时显示调用详情),`client-nav` 工具工作区从 `conversation.view` 迁到 `details.workspace` 并新增侧栏「工具工作区」入口(`ctx.layout.openDetails()`);478 个测试全绿(含新增无会话可达、切会话保持、workspace 渲染断言)
- `docs/重构方案-B-壳内React插件化.md` 补 Step 2 实测记录:两个硬约束结论、部署约束新发现(dsh 启动经 `healProfilesModuleFallback` 强制重置核心包 junction 指向 runtime,浏览器级验证需随应用重启或独立 runtime 副本)

---

## [0.67.0] - 2026-08-15

### 新增
- B 路径 Phase 0 spike Step 1:client-nav 新增壳内 React 工具页签(`conversation.view` 注册 `starhub-tools`,`StarHubToolWorkspace.tsx`)——无 iframe 直渲,挂载时经顶层帧 Tauri IPC 直调 `get_assets`,资产列表写入共享 asset store(`asset-store.ts`,defineStore);`tsc` + tsdown 构建通过,4 个组件测试(空态/加载/错误/列表)全绿
- `docs/重构方案-B-壳内React插件化.md` 补 P0 spike 实测记录:D1/D2 结论、独立 3086 测试实例验证、运行时 junction 指向 `runtime_dir`(非仓库 vendor)的开发注意项

---

## [0.66.9] - 2026-08-15

### 修正
- `docs/重构方案-交互与信息架构.md`:原则 4 改为「cyber.css token 与 `cyber-*` 组件类不能提前删(当前 418 处引用),只能随 Vue 应用整体退役时一并移除」;导航分组按评审修订(终端并入 SFTP+Broker、设置并入 dsh 设置)

---

## [0.66.8] - 2026-08-15

### 新增
- B 路径重构方案文档 `docs/重构方案-B-壳内React插件化.md`:去 iframe、StarHub 工具重写为 dsh 壳内 React 插件、最终退役整个 Vue 应用(`src/`)的增量迁移路线(Phase 0–4)、三个前置设计决策(工具席位形态 / 会话切换状态保活 / 包粒度)与风险清单;仅方案、不动代码

---

## [0.66.7] - 2026-08-15

### 修复
- dsh web「选择工作区」选中后回退到选择工作区:打包产物 `dsh-runtime/node_modules` 缺 `@deepseek-ai/dsh-persona`(agent preset `standard` 的首个 loader entry,仅被 `apps/cli` 依赖、未进入 `dsh-jsonrpc-agent-pkg` deploy 闭包),session 创建时 preset 挂载失败(agent-preset-invalid)、`connectWorkspace` 抛错导致回退;`python/sdk-runtime/package.json` 补 persona 依赖使闭包完整

---

## [0.66.6] - 2026-08-15

### 修复
- SSH `plugin:event|listen not allowed by ACL`:capability 未覆盖 dsh 主壳的远程 `http://127.0.0.1:<port>` origin(`local` 默认只覆盖 `tauri://localhost` 等本地源),prod 下 shell-placeholder 跳转后落在远程源导致 iframe 内 `listen()` 被 ACL 拒绝;`capabilities/default.json` 增加 `remote.urls`(127.0.0.1 / localhost 任意端口)
- DeepSeek API key 被占位 env 锁死:`web.rs`/`boot.mjs` 在无真实 `DEEPSEEK_API_KEY` 时注入 `starhub-p0-placeholder`,使 dsh 判定 key 为「由启动环境提供」(source=env、只读),首次进入不弹 key 引导、Models 页锁死无法输入;改为仅在真实环境存在 key 时才透传,keyless 走 dsh 自带 onboarding / Models 页

### 新增
- 重构方案文档 `docs/重构方案-交互与信息架构.md`(信息架构 + 各功能页布局流程 + dsh 对话区与工具区融合,仅方案、不动代码)

---

## [0.66.5] - 2026-08-15

### 改进
- dsh 主壳侧栏导航:StarHub 功能页(终端/数据库/Redis/Elasticsearch/Docker/Broker/Excel/设置)从侧栏底部 footer 上移到侧栏顶部「工具」分组,融入主侧栏导航区,解决功能入口埋底难找的问题;ui-sidebar 新增 `sidebar.navigation` 槽位,client-nav 改注册到该槽位(rail 折叠态仅显示图标)

## [0.66.4] - 2026-08-15

### 修复
- dsh web 无法启动:`web.rs` spawn 用绝对路径 `cmd.arg(&cli_bin)` 传入口,Windows 下经命令行传给 node 后被截断成盘符(node 报 `EISDIR: illegal operation on a directory, lstat 'E:'`),ESM 入口 realpath 失败、就绪探测 30s 超时;改为相对路径 + `current_dir`(与 AI runtime 的 `HarnessRuntime::spawn` 一致),并补 spawn 日志
- 主进程日志落盘:Windows GUI 子系统下 stderr 不可见,dsh web 启动失败被吞进不可见的 stderr 无法定位;新增 `%LOCALAPPDATA%/starhub/starhub.log`(Linux/macOS 落到 `~/.starhub/starhub.log`),把 dsh web 启动错误与 node 子进程 stderr 一并写入文件,便于诊断

## [0.66.3] - 2026-08-15

### 修复
- 移除 Linux AppImage 打包目标(仅保留 deb/rpm):Tauri 2.x 的 linuxdeploy 在 Ubuntu 22.04 上打包 WebKitGTK 应用的 AppImage 为上游已知 bug(tauri#14796),`NO_STRIP=true` + `APPIMAGE_EXTRACT_AND_RUN=1` 仍报 `failed to run linuxdeploy`;deb 覆盖 Debian/Ubuntu、rpm 覆盖 Fedora/RHEL,已满足 Linux 分发需求

## [0.66.2] - 2026-08-15

### 修复
- 修复 `package-dsh-runtime.ts` 的 `build()` 只构建 host 面(`build:lib:host`),而 `client-nav` 是仅 client 面包,全新 checkout 上缺 `lib/`,入包时 `installWebRuntimePackages` 拷贝 `client-nav/lib` 抛 ENOENT、CI「Package dsh runtime」步骤失败;改为 `build:lib`(host + client),补齐 `client-nav/lib/index.js` 与 `lib/client.js`

## [0.66.1] - 2026-08-15

### 修复
- 修复打包(prod)布局下 dsh web 无法启动:`package-dsh-runtime.ts` 新增 `installWebRuntimePackages`,把 deploy 闭包缺失的 dsh web 运行时包补入产物顶层 `node_modules`——两个 StarHub 本地包 `@deepseek-ai/dsh-starhub-client-nav/host-static`(loader 裸导入解析链上缺包即 ERR_MODULE_NOT_FOUND)、`node-addon-require-builtin` 及其传递依赖与平台预构建原生包(HMR 免 `--expose-internals` 回退,缺失则启动后崩溃);全新 DSH_HOME prod 布局冒烟 `/` 与 `/starhub/` 均 200

## [0.66.0] - 2026-08-15

### 新增
- dsh 主壳融合 P4b 打包落地:portable Node v24 + dsh runtime prod 闭包入包(`src-tauri/binaries/dsh-runtime`),web GUI dist + client bundles 纳入构建链(`dist-embed`);Rust `HarnessPaths` 支持 prod 资源目录解析与入口/config 切换;`tauri.conf.json` bundle.resources 纳入 dsh-runtime 与 dist-embed;打包冒烟验证(主壳 + AI 内核 stdio JSON-RPC)全绿
- dsh 主壳融合 P5 全站换皮 dsw:移除 `.cyber-panel/.cyber-card` 顶部 liquid-light 发光灯带(扁平化 + hairline 描边);收敛散落 `--glow-cyan/--glow-pink` 残留(danger 按钮/拖拽把手/拖放区/进度条/overlay/开关)到克制阴影或移除;`--glow-soft` 暗色 token 中性化(去青,保留极轻环境光);输入 focus 光晕动画与硬编码 `rgba(93,214,214)` 收敛为 hairline focus ring

---

## [0.65.0] - 2026-08-15

### 新增
- dsh 主壳融合 P4a:**dsh GUI 成为唯一主壳**——`npm run tauri:dev` 默认即 dsh 界面(devUrl 指 3085 占位页自跳转,prod 用本地 `shell-placeholder/` 跳板轮询 `dsh_web_url`);窗口改回 native 标题栏(dsh GUI 无窗口控件);AiView/LocalView 整页退役(dsh 对话与 dsh 工作区接管),旧外壳代码整体删除(CyberLayout 2746 行 → 约 100 行 embed 唯一形态,windowDetach/AssetTree/命令面板/拖出窗口退役);资产 CRUD 迁至设置页新「资产」tab(先立后破);AiChat 右侧 AI 面板保留旧内核;真窗口冒烟 16/16 overlay 交互全过 + embed SSH 真连 stub;踩坑记录 §23

## [0.64.2] - 2026-08-14

### 修复
- dsh 主壳融合 P3 第二批(DB/Redis/ES/Docker/Broker/Excel/Settings):修复 embed 入口白屏(history base 剥离后 `/index.html` 无路由匹配,新增占位子路由);ElasticsearchView/ExcelView 的 assetId 从 tab 系统反查改为 instanceId 直解(embed 无 tab 系统,原写法必炸);SettingsView embed 模式加关闭按钮(复用 Esc postMessage 通道);8 页 DOM 探针实测渲染(真实服务本机不可用,仅错误态/空态证据);踩坑记录 §22

## [0.64.1] - 2026-08-14

### 新增
- dsh 主壳融合 P3 第一批(SSH/SFTP):embed 资产选择骨架落地——`EmbedAssetBar`(embed 页顶部资产条,下拉切换 = 同段换 instanceId)、`EmbedSectionEmpty` 段空态、9 条静态段路由(`/ssh`、`/db/mysql` 等,`meta.embedSection`),client-nav 8 条目改段路由 + `starhub-embed-open-section` 消息联动;test-sftp/server.py 扩展为完整 SSH stub(pty/shell/exec/sftp,修 paramiko 5.0 兼容),新增 `src-tauri/tests/sftp_stub.rs` russh-sftp 集成测试;真窗口端到端实测 SSH 连接/断线重连全绿

## [0.64.0] - 2026-08-14

### 新增
- dsh 主壳融合(方案 B)P1 外壳融合:新增 `packages/starhub/host-static/`(dsh webserver 同源托管 StarHub embed dist 于 `/starhub/`,SPA fallback + 防穿越)、`packages/starhub/client-nav/` 全量(8 个导航条目注册 `sidebar.footer.action`,`shell.overlay` 整帧 iframe 层,Esc/再点关闭);Rust 新增 `DshWebManager`(profile 物化 + 端口 3085 起递增 + 就绪轮询 + 生命周期,4 单测);前端新增 embed 模式(`?embed=1&route=<path>` 精简外壳,去 titlebar/tab/侧栏/状态栏);双轨开发流 `npm run tauri:dev:dsh`(tauri.dev-dsh.json 覆盖 devUrl,默认旧外壳不受影响)+ `npm run build:embed`(base `/starhub/`,产物 `dist-embed/`);真窗口冒烟与 curl 链路全绿,踩坑记录第 20 节(overlay vs conversation.view、占位页自跳转等 7 条)

## [0.63.1] - 2026-08-14

### 新增
- dsh 主壳融合(方案 B)P0 spike:dsh 官方 Web GUI 在 vendored monorepo 内起服成功(`examples/starhub-web/` profile 组合 + `packages/starhub/client-nav/` 最小 client 插件,slot 注入链路 curl 验证通过);**决定性结论:Tauri 窗口加载 http://127.0.0.1 壳时,同源 iframe 完整继承 `__TAURI_INTERNALS__`,invoke 真实往返成功**——功能页嵌入无需自建 IPC 桥,方案 B 最大风险消除;任务清单 `docs/dsh主壳融合-任务清单.md` 与踩坑记录第 19 节同步

## [0.63.0] - 2026-08-14

### 新增
- AI 内核替换(deepseek-harness)Phase 1 完成,AiView 正式切换到 dsh 会话内核:新增 `examples/starhub-agent/cordis.yml` StarHub 专用组合(sdk-jsonrpc-server + llm-deepseek + agent-spine-demo + persistence-jsonl + tool-todo + compaction + subagent 系,无 bash/fs 工具,纯对话安全方向);Rust `HarnessManager` 支持模型参数注入(DEEPSEEK_API_KEY/DSH_SYSTEM_PROMPT/DSH_SESSION_ROOT)、spawn 指纹自动重启、`dsh_cancel`(杀进程兜底,SDK 协议无 cancel)、subagent.started/finished 事件转发;前端新增 `aiHarnessProjection.ts`(dsh 事件 → 块模型投影:user/assistant(text+reasoning 流式)/tool/todo/notice/subagent/error),AiView 消息区整链重写为投影渲染,旧 Planner→Executor 编排链与确认卡从 AiView 移除(AiChat 宿主路径 P3-4 才退役)
- dsh 工具桥第一批(P1-4):sdk server 补丁暴露 `sdk-transport` 服务;新增 vendor 包 `@deepseek-ai/dsh-starhub-tools`(starhub_list_capabilities / starhub_list_assets / session_search / memory 四个工具,execute 经 `starhub/tool.execute` 入站 request 桥回宿主 Rust 执行);Rust 协议桥升级双向 request 分发(JSON-RPC id 支持字符串);memory 安全扫描(memoryGuard)移植 Rust;端到端实测模型工具调用 → Rust 执行 → 结果回注全链路
- dsh-deep-whale 皮肤风格评估(支线 C):新增 `docs/皮肤风格评估-dsh-deep-whale.md`,三枚增量 token 候选(`--radius-bubble` 气泡圆角、`--ease-emphasize` 强调缓动、`cyber-chase` 追逐动画)评审后并入 cyber.css 定义层,柔金/玻璃拟态不采纳
- dsh 插件生态首版(支线 B,B-1~B-4):设置页新增「插件」tab,支持 awesome-dsh-plugin 市场目录浏览(README.zh.md + data/*.json 解析,失败降级空目录)、URL(zip)/本地目录/本地 zip 三种安装、逐项启停与卸载;插件落 `<app_data_dir>/plugins/`,Rust 每次 spawn 前生成包装配置 `dsh-cordis.generated.yml`(cordis:include 内建插件,主组合 + 用户清单两棵子树,vendor 副本零改动);安装管线含 manifest 校验(`dsh.bundle` 必需、零依赖强制、UI/皮肤类双保险拒装)、peer 依赖 junction(mklink /J,回退复制)、zip 防穿越(enclosed_name + 剥顶层后二次校验)、首次启用风险提示;变更后自动重启 dsh runtime;坏插件自救首版为手动引导(自动禁用留 TODO);打包布局暂不支持安装(明确报错)
- 设计系统 token 层升级(支线 A,D0/D1/D3):阴影收敛为 `--shadow-1/2/3` 克制档,边框改 hairline(`--line` 0.06 / `--line-2` 0.12),新增中性 hover/active、圆角梯度(chip 4 → modal 24)、字号梯度(`--text-2xs~xl`)、`--font-mono` 等宽栈(73 处硬编码清除)、滚动条 token;按钮胶囊化、卡片圆角 16、核心组件 hover 中性化、交互过渡统一 0.2s;菜单修复无效 box-shadow;光晕类效果收敛至启动/欢迎页仪式场景;亮主题同步重做

### 已知回退(dsh 切换期)
- AiView 会话不再持久化到 StarHub SQLite(dsh 自有 jsonl,重启应用后历史不可恢复;session_search 桥在 P3 接)
- 运行中 steering 暂停(dsh inbox 机制后续接);确认卡/白名单待审批桥(D3 已验证可行,Phase 2 落地);plan mode 待审批桥后启用
- memory 工具确认闸未接(待审批桥);asset 级记忆固定返回未绑定提示(待 P2-7 绑定机制)

## [0.62.6] - 2026-08-14

### 新增
- AI 内核替换 P0-4 完成:新增 `src-tauri/src/harness/`(dsh runtime spawn + NDJSON JSON-RPC 协议桥,复用 sidecar 解析模式,零新依赖)、3 个 Tauri command(`dsh_initialize`/`dsh_prompt`/`dsh_shutdown`)、前端 `src/services/aiHarness.ts`(流式 text-delta 拼装,idle 权威结束信号);端到端测试 mock LLM 实跑 4 轮全绿,`cargo:test` 81 passed。**Phase 0 风险验证全部完成,结论 Go**

## [0.62.5] - 2026-08-14

### 新增
- AI 内核替换(deepseek-harness)Phase 0 POC 完成,结论 **Go**:`vendor/deepseek-harness` install/构建全绿;stdio JSON-RPC 多轮流式回路实测通过(Node 直跑与 172MB SEA exe 两种形态);确认 SDK 协议无 cancel(杀进程兜底,Phase 1 拟补 session/cancel 小补丁);审批桥路径明确(自写 cordis answerer 插件);vendor 副本含 Windows 适配补丁(exe 打包脚本 4 处 + tsconfig exclude);完整结论与坑清单见 `docs/AI内核替换方案-deepseek-harness.md` 附录 11

## [0.62.4] - 2026-08-14

### 新增
- AI 内核替换(deepseek-harness)Phase 0 启动:新增 `vendor/deepseek-harness/` 上游源码副本(锁定上游 commit `47f9438`,MIT),作为 dsh runtime 内嵌 StarHub 的 POC 基础;配套方案 `docs/AI内核替换方案-deepseek-harness.md` 与任务清单 `docs/AI内核替换-实施任务清单.md`

## [0.62.3] - 2026-08-13

### 修复
- 内嵌 AI 助手 # 绑定远程资产不接通(与 #LOCAL 同类问题的完整修复):此前绑定内非宿主资产(SSH/DB/Docker/Excel)只在 prompt 里作参照;现在绑定资产经 direct workspace runtime 实际接入对应工具(ssh_*/sftp_*/db_*/redis_*/es_*/docker_*/excel_*),workspace 参数区分目标,省略 workspace 或指向本标签页宿主资产时落在当前宿主执行器;与宿主同名工具替换为带 workspace 参数的版本避免重复函数名;runtime 随绑定集合变化重建,组件卸载时关闭全部绑定连接

## [0.62.2] - 2026-08-13

### 修复
- 内嵌 AI 助手(SSH/DB 等宿主)# 绑定本机不接通:此前 `#LOCAL` / `#LOCAL-资产` 只在 prompt 里作「参照元数据」,工具仍限于当前宿主,AI 明确回答无法访问本机代码;现在绑定含本机(local 作用域或 local 资产)时,本轮实际接入 `local_*` 工具与本机运行时(文件读取免确认,写操作与 Shell 命令走确认卡),提示词同步说明可用能力与确认规则;宿主自带 local 工具(本地工作区)时不重复追加
- 内嵌 AI 助手 @ Agent 默认绑定不生效:与 AiView 语义对齐,当 @ 提及的 Agent 配置了默认绑定目标(boundAssetIds / boundLocal)且本轮无显式 # token 时,自动注入该 Agent 的绑定;local 运行时在未启用工具确认的宿主(Excel)下对写操作 / Shell 安全拒绝而非崩溃

## [0.62.1] - 2026-08-13

### 修复
- AI 哨兵命令回显进入 AI 上下文致模型困惑:PTY 路径的 dataBuffer(AI `captureOutput` 与超时兜底输出的来源)原先存原始 chunk,哨兵 printf 的 readline 回显原样混入,AI 看到自己没发过的 `printf '\033]777;...'` 内部命令;回显过滤器改为同时作用于渲染流与 AI buffer(真实 OSC 序列含 ESC 字节不受影响,完成判定照常)

## [0.62.0] - 2026-08-13

### 新增
- 本地工作区 VSCode 化重设计:移除主区文件列表与目录面包屑,侧栏目录树成为唯一导航(单击展开/预览、双击固定);编辑器 tab 支持预览态(斜体、被下一预览替换,编辑/双击转正)、中键关闭;侧栏可拖拽调宽(160-480px)+「全部折叠」按钮;状态栏新增 Ln/Col 光标位置;树节点支持键盘焦点与 F2 重命名 / Del 删除;主区无文件时显示欢迎引导态
- 本地工作区右侧边栏接入 AI 助手(RightPanel + useAiChatHost,复用 aiLocal 的 localTools):会话绑定 local 资产类型;base prompt 要求 AI 先读取工作区根 AGENTS.md 并遵循其中的约定,再执行任务;写操作与 Shell 命令仍走确认卡
- AI 自生成 Skill:所有内嵌 AI 助手(SSH/DB/Docker/Redis/ES/Excel/本地)新增 `skill_save` 工具,按 name 幂等 upsert 到自定义 Skills 并自动启用,回显到 设置 → AI → Skills;写入前做隐形 Unicode / prompt 注入 / 凭据扫描,始终走确认卡;设置加载时 customSkills 的 assetTypes 白名单补上 local

### 变更
- SSH 终端工具栏重组:字号、搜索/清屏、广播/网页、状态与连接控制四组分隔线分组;在线只显示断开(红色电源)按钮、离线只显示连接(绿色)按钮,不再同时摆连接+断开两个按钮;CONNECTED 徽标与连接按钮互斥显示;局部样式迁移到 terminal-* 全局组件类
- AI 完成哨兵顺路上报 cwd:AI 命令后的哨兵 printf 同一行同时输出 OSC 7($? 与 $PWD 一次展开),AI 每执行一条命令 cwd 立即刷新,无需向远端 shell 注入任何 hook
- 渲染侧回显过滤器:AI 哨兵命令与 OSC 7 注入命令的 readline 回显整行从终端渲染流剔除(跨 TCP 分片安全),用户 scrollback 不再看到 `printf '\033]777;...'` 与 `__starhub_osc7() {...}` 内部实现
- OSC 7 shell integration 改为懒注入:建链 / MFA 阶段不再注入;仅当 SFTP「跟随终端」开启(或重连时该开关仍开)且检测到 shell prompt 后就绪后才写入,回显被渲染过滤器隐藏;SftpPanel 通过 follow-terminal 事件通知终端
- DB / Excel 网格关闭所有「数字以文本形式存储」hover 错误弹框与绿色警告角(disableForceStringAlert/Mark + disableTextFormatAlert/Mark),移除为此前提示文案补的 locale 兼容映射;字符串列设文本格式保住 '000123' 前导零的修复不受影响

## [0.61.6] - 2026-08-13

### 修复
- SSH 长命令/AI 执行期间掉线(「Connection closed by remote host」)优化:russh 自带的 `keepalive_interval`(30s)只在连接「完全空闲」时才发心跳,一旦长命令有零星输出(输出频率低于 NAT 空闲超时),russh 就判定连接「活跃」不发 keepalive,但中间 NAT/防火墙仍会按空闲踢掉会话;在 `SshSession` 内新增固定节拍心跳 task,认证完成后无条件每 15s 发一个 `keepalive@openssh.com` global request(want_reply=true)刷新 NAT 空闲定时器,`disconnect` 时一并取消;心跳负责保活,russh keepalive 仍负责连接黑洞时的死亡判定
- SSH 后台静默模式有时会在终端回显命令:`SILENT_INTERACTIVE_CMD_RE` 交互命令预检正则中 `\bsh\b` 未限定命令段边界,误伤 `./deploy.sh`、`bash xx.sh`、`grep ... sh` 等常见命令,使其被错误回退到 PTY 执行并回显;同时 `top -b`(batch 模式)也会被误判为交互命令。重写正则:交互 shell/REPL(`bash`/`sh`/`python`/`node` 等)必须限定在命令段开头整词匹配且无脚本参数(或仅 `-i`),`top` 仅非 batch 时回退,`htop`/`atop` 恒回退

## [0.61.5] - 2026-08-13

### 新增
- AI 工作区(AiView,AI AGENTS 页)的 assistant 回复接入 Markdown 渲染,复用 `AiMessageContent` 的代码块「复制」按钮(用户消息仍纯文本);此前该页 assistant 是纯文本显示,代码块无复制按钮

## [0.61.4] - 2026-08-13

### 新增
- AI 回复的代码块新增「复制」按钮(右上角),点击一键复制代码/命令;`AiMessageContent` 的 markdown 渲染给每个 `<pre>` 包一层头部(语言标签 + 复制按钮),事件委托处理复制并 toast 提示
- SSH AI 助手的代码块额外显示「执行」按钮:点击去除 `$`/`#` 提示符后把命令写到 SSH 终端执行(`SshTerminal` 注入 `runCommand` → `AiChat` → `AiMessageContent`),未连接/空命令给提示

## [0.61.3] - 2026-08-13

### 修复
- AI 工作区(AiView)上下文用量 `ctx NN%` 无界上涨(能到 382%):Planner → Executor 只在 `:execution:` 临时会话上 runAgent,`runAgent` finally 里的自动压缩落在临时会话(随后被 `clearSession` 删除),主会话永远收不到自动压缩;改为在计划正常完成后对主会话补一次 `shouldCompact` 判定并触发 `compactSessionNow`(阈值/锁与 store 内逻辑一致,默认 ≥50% 预算自动压)

## [0.61.2] - 2026-08-13

### 变更
- `local_read_text_file` 本机文件读取不再要求人工确认:它是纯只读操作(不修改/删除文件),之前每次读取都弹确认卡;改为直接执行,工具描述、AiView 系统提示与 `docs/技术方案.md` 安全门说明同步更新(正文仍会发送给当前 AI Provider)

## [0.61.1] - 2026-08-13

### 修复
- Settings「Agent 最大迭代次数」等「记忆与上下文(区块 06)」字段改完又被冲回旧值:区块 06 字段不走 `aiLocal` 保存流(直接写 store 立即持久化),但 `onSave` 曾把整份 `aiLocal` 草稿写回 store,点「保存」会用草稿旧值覆盖用户刚改的设置;改为从 `rest` 里剥离这些字段,不再被「保存」冲掉
- AI 工作区(AiView)会话头部补齐上下文用量指示(`ctx NN%`):与 AiChat 同口径字符估算 / `contextBudgetChars`,<50% muted、50~80% cyan、>80% 黄色,点击手动立即压缩(compacting 时 spinner)
- AI 工作区(AiView)长期记忆自动沉淀失效:Planner → Executor 只在 `:execution:` 临时会话上 runAgent,runAgent 的回合后 review 被 `isExecutionSession` 过滤落不到主会话;新增 `reviewSessionMemory` 在计划正常完成后对主会话补一次 review(内部 memoryEnabled / memoryAutoReview / memoryWriteNeedsConfirm / shouldReview 门禁不变)

## [0.61.0] - 2026-08-12

### 新增
- 上下文压缩阈值进设置页:滑块 10%~100%(步长 5%),默认 50%;`shouldCompact` 新增 `triggerRatio` 参数,setting 新增 `compactTriggerRatio` 字段(0~1],非法值自动回退 0.5);15→19 例 node --test 单测
- 压缩存档保留原文:压缩时被替换的原始消息段写入 `session.compactedArchive`(运行时字段,新会话清空),digest 只压运行时消息(tool 结果 + 带 tool_calls 的 assistant),用户/助手纯文本原文保留不参与摘要生成

---

## [0.60.1] - 2026-08-12

### 修复
- AI 记忆「写入下一会话生效」在同一 tab 内永远不生效:`resetSession`(新会话)此前不清冻结的 `memoryBlock` 与 `lastFlushOmitted`,记忆卡首次加载后永久冻结,只有重启 app 才重新加载;现在新会话即清,下次 runAgent 重新注入最新记忆卡

## [0.60.0] - 2026-08-12

### 新增
- AI 上下文压缩(compact):回合正常结束后估算上下文用量,≥50% 预算(`contextBudgetChars`)即在后台自动压缩——LLM 把最早一段消息(保留最近 12 条、边界不拆 tool 组、不足 6 条放弃)压成结构化中文摘要并原位替换为「上下文压缩摘要」消息(前缀标记,随会话自然落库);新增 `_compactingPromises` 锁与 runAgent in-flight 互等,压缩与流式输出严格串行;AiChat 工具栏新增 `ctx NN%` 用量指示(<50% muted / 50~80% cyan / >80% 黄),点击手动立即压缩(compacting 时 spinner);摘要消息在消息流渲染为可折叠卡片;纯门禁 `src/utils/aiCompactionGates.ts` + 15 例 node --test 单测;预算滑窗与 memory flush 时序不变

## [0.59.3] - 2026-08-12

### 移除
- 侧边栏 AI 面板精简为纯入口:只保留 AI AGENTS 列表与最近对话两个可折叠区;移除 v0.58.0 引入的内嵌聊天窗与「AI 记忆」区(记忆管理仍在 Settings),以及副标题、未配置引导、快速提问行、「分析当前工作区」按钮;Ctrl+J 恢复为打开默认 Agent 的 AI 工作区 tab;AGENTS 列表不再要求 LLM 已配置才显示;清理无引用的 cyber.css 类与 17 个 i18n key

## [0.59.2] - 2026-08-12

### 文档
- README:当前版本区裁剪为最近 3 个版本(完整历史以 CHANGELOG 为准,规则写入 AGENTS.md 6.5-6);功能矩阵更新到 v0.59 实际交付面(PostgreSQL/SQLite/SQL Server、跳板机/端口转发、SFTP 断点续传/暂停、Docker Compose/SSH 通道、本地工作区、AI 记忆/@/# mention/会话级模型等,移除过期「规划中」标注);路线图重写为 v0.18~v0.59 阶段总结 + 下一步候选;新增官网徽章 https://starthub.waouzzz.cc/

## [0.59.1] - 2026-08-12

### 文档
- AGENTS.md 6.5 新增「git tag 与 Release 构建」规则:一次会话涉及多个版本时只在最后 push 最新版本的 tag(中间版本不打 tag 不出包);纯文档/脚本类修订版默认不打 tag;推 tag 一律单个推(GitHub 单次 push 最多触发 3 个 tag 工作流,超出静默丢弃)

## [0.59.0] - 2026-08-12

### 变更
- 本地工作区(LocalView)UI 重设计,对标 VSCode Explorer + 编辑器体验并翻译到 cyber 设计系统:EXPLORER 式分区标题条(操作按钮 hover 显现)、目录树缩进参考线 + 选中行左侧 cyan 指示条、编辑器 tab 条(dirty 点/关闭钮同槽位互斥)、可点击面包屑、明细列表(吸附表头/等宽右对齐)、底部 24px 等宽状态栏、骨架加载态与引导空态;修复原组件引用不存在 token(`--color-surface-primary` 等)导致样式失效的根因,两个组件 scoped 样式整体删除,视觉集中于 cyber.css `.local-*` 一组类;顺手修复面包屑对 Windows 盘符路径拼出 `C:\/C:/foo` 坏路径的旧 bug;文案迁入 i18n `local` 命名空间(34 key,双语言);新增 Playwright 验证脚本 `scripts/verify-local-layout.py`(5 场景 + 双主题截图)

## [0.58.0] - 2026-08-12

### 新增
- 主侧边栏 AI 面板从纯入口升级为内嵌真实聊天,与标签页助手共用一套逻辑:内嵌 `AiChat` + `useAiChatHost`(instanceId `sidebar-ai`,local 上下文,session_search / memory / MCP 工具由 composable 分流),免费获得会话级模型选择器、@/# mention、工具确认卡、历史会话存档;Agent 快捷列表与最近对话改为可折叠区,行为不变;「快速提问 Ctrl+J」改为聚焦内嵌 composer
- 侧边栏 AI 面板新增可折叠「AI 记忆」区:列出 user / global 两级 L1 记忆卡,支持新增(选 scope)与删除,记忆禁用时显示提示;数据走 `src/services/aiMemory.ts`,聊天侧由 runAgent 自动注入/沉淀

## [0.57.0] - 2026-08-12

### 新增
- 各标签页内嵌 AI 助手(AiChat)支持 `@`/`#` mention:`@Agent名` 切换本会话 Agent(AiSession 新增运行时 `agentId`,systemPrompt 改用该 Agent 的角色约束 + 绑定技能,宿主动态上下文降级为参考块);`#资产名` 绑定额外目标(写入 `session.contextBinding`,sticky 语义与 AiView 一致,systemPrompt 附绑定目标清单);mention 菜单(正则触发 / 键盘导航 / Esc 关闭)移植自 AiView;mention 纯函数抽取为 `src/utils/aiMention.ts` 供 AiView 与 AiChat 同源使用(配 9 例 node --test 单测)

## [0.56.0] - 2026-08-12

### 变更
- 6 个内嵌 AI 助手宿主(SSH / DB / Docker / Redis / ES / Excel)的聊天编排逻辑抽取为共用 composable `src/composables/useAiChatHost.ts`(净删 532 行重复):防并发守卫、steering、工具组装(业务 + sessionSearch + memory + MCP)、whitelist 确认流程、runAgent 调用统一收口,宿主差异(业务工具、执行器、动态 prompt、审计钩子)全部参数化注入,行为不变

## [0.55.0] - 2026-08-12

### 新增
- AI 模型选择支持按窗口/会话独立,互不影响:`AiSession` 新增 `modelId` 覆盖字段(运行时,不持久化),`runAgent` 与 Planner(`createExecutionPlan`)改经 `resolveModelConfig(session.modelId)` 解析,空覆盖回退全局 `settings.activeModelId`;`AiModelSelector` 新增 `sessionId` prop,会话模式下拉顶部提供「跟随全局」行,徽章左侧 cyan 点标识本窗口独立选模型
- AI 模型选择器下拉菜单重设计(cyber 面板替代裸 v-list):模型数 >3 时出现搜索框(按名称/模型 ID/URL 过滤)、「默认模型 / 已配置模型」分组小标题、模型 ID 等宽徽章 + baseUrl 副信息、底部「添加模型…」入口;视觉集中在 cyber.css `.ai-model-menu-*` 一处

## [0.54.1] - 2026-08-11

### 修复
- SFTP 面板连接成功后初始目录从写死的根目录(`/`)改为会话起始目录(通常是登录用户家目录):新增 Rust `sftp_home_dir` 命令,通过 SFTP realpath(".") 解析,失败兜底根目录
- SFTP「跟随终端」开关不再要求用户先手动敲 pwd 才可用:
  - SSH 建链后用静默 exec 通道跑 `pwd` 拿登录目录,开关立即可用
  - 向远端交互 shell 注入一次性 OSC 7 上报(bash `PROMPT_COMMAND` / zsh `precmd_functions`,只影响当前会话,不写远端任何配置文件),shell 每次回到 prompt 自动上报 cwd,SFTP 实时跟随;sh/dash 等无 hook shell 仍走 pwd 输出逐行解析兜底

### 变更
- AI 模型选择器触发按钮重设计:不再套用 cyber-badge 大写徽章观感(浅色主题下近白底 + 全大写模型名,突兀难读),改为与相邻 action-btn 对齐的透明底弱边框按钮;模型名保留原大小写、等宽字体、超长省略;视觉集中在 cyber.css `.ai-model-badge` 一处,组件不再写 scoped 视觉

### 新增
- `npm run cargo:check` / `npm run cargo:test`(`scripts/cargo-env.bat`):自动加载 MSVC vcvars64 环境再跑 cargo,解决 Git Bash 下 `failed to find tool "cl.exe"` 的问题;vcvars 路径取 `STARHUB_VCVARS` 环境变量,缺省回退 `D:\c++1` 安装位置

### 测试
- 新增 `tests/terminal-cwd.test.mjs`(7 例,`npm run test:terminal-cwd`):OSC 7 解析(BEL / ST 结尾、file://host 形式、跨分片拼接、非绝对路径过滤)与静默 pwd 输出解析

## [0.54.0] - 2026-08-11

### 新增
- AI 模型选择器下沉到各视图内嵌的 AI 助手侧栏:抽取共享组件 `AiModelSelector`(原 StarHub AI 工作区头部选择器),SSH / DB / Redis / Docker / ES / Excel 的 AI 面板工具栏均可切换模型;选择立即写入 `activeModelId` 并全局持久化,两处选择器同源同步
- Settings「06 记忆与上下文」新增「Agent 最大迭代次数」设置(1–100,默认 20,立即生效);`runAgent` 的 `maxSteps` 默认值改从配置读取,旧持久化数据由 `ensureSettingsShape` 自动补默认值
- SFTP 面板导航三连:
  - 「跟随终端当前目录」开关(localStorage 持久化):终端 cd 后 SFTP 自动跳到同一目录(复用终端 pwd 跟踪的 `sshCwd`)
  - 路径输入:工具栏铅笔按钮或双击面包屑切换为输入框,输入绝对路径回车直达(漏写前导 `/` 自动补齐)
  - 目录进入方式由双击改为单击(Ctrl/Shift 多选语义保留),「..」上级目录同样单击生效
- 标签页右键菜单新增「在新标签页打开」:同一资产 / Agent 开一个全新实例(不复用现有 tab),无资产可解析的 tab 该项置灰

### 修复
- Settings「激活此模型」两个 bug:
  - 原实现只改本地草稿 `aiLocal`,不点「保存模型列表」激活不生效——改为点击立即写入 store 并持久化,附成功通知
  - 保存时把激活模型的(常为空的)API Key 覆盖到全局再 `setApiKey('')`,会静默删除 Keyring 里的默认 key 导致所有对话 401——模型未单独配 key 时保留全局 key;激活为空(使用默认模型)不再被强制回退到列表第一项
- AI 长期记忆管理弹窗无法上下滚动:`v-dialog scrollable` 只对 `v-card` 生效,自定义 `cyber-panel` 内容无限高被裁剪——面板限高 80vh + 分组列表区 `overflow-y: auto`
- AI 调用 SFTP 工具链四处修复:
  - SSH 自动重连后 `sftp_ensure_session` 的 `has_session` 短路复用旧(已死)SFTP 通道,之后上传/下载必败直到手动断开重连——`connect_session` 覆盖同 id 会话前先 `unregister_sftp`,下一次 ensure 在新会话上重建通道
  - `waitForTransfer` 不处理 `paused`:用户在传输队列暂停 AI 发起的传输后,agent 每 400ms 空轮询直到 30 分钟超时整轮卡死——检测到暂停立即报错收口并提示恢复方式
  - `sftp_download` 本机目标目录不存在时直接 open 失败——下载前 `create_dir_all` 递归创建
  - `sftp_list` 静默截断 200 条无注记,LLM 会误判"文件不存在"——补「共 N 项,仅显示前 200 项」注记
  - 远端路径参数(`path`/`remoteDir`/`remotePaths`)增加绝对路径校验,相对路径直接报错回传,不再被登录 home 静默解析到非预期目录
  - 全局 AI 工作区确认弹窗「目标工作区: X」重复两行——`aiWorkspace` 不再向内层 `makeSftpToolCaller` 重复传 workspaceName,统一由 `withWorkspaceContext` 注入
- SFTP 面板右键下载/删除作用对象错误:右键落在未选中条目上时操作仍作用于旧选中项(表现为"右键下载不了这个文件")——右键时先把选择切到该条目,与主流文件管理器一致
- 标签栏右键弹出 Windows 原生系统菜单(还原/移动/大小/关闭)与自定义右键菜单互相抢:tab-strip 是 `data-tauri-drag-region`,Windows 对 HTCAPTION 命中区的右键由 OS 直接弹系统菜单,JS `preventDefault` 拦不住——弃用 drag-region 改为 mousedown 主动 `startDragging()`(空白区拖窗口、双击最大化行为保留),右键事件完整交给自定义 ContextMenu

---

## [0.53.0] - 2026-08-11

### 新增
- AI 记忆系统三期:自动沉淀(方案 `docs/AI记忆系统方案.md` 3.4 节)
  - 压缩前 memory flush:上下文预算滑窗发生省略时,先用一次只挂 `memory` 工具的独立 LLM 调用把被省略历史中的 durable 事实落卡,再发出主请求(Hermes 同款时序);`lastFlushOmitted` 防抖,同一批省略历史不重复冲刷(增量 ≥20 条才再次触发)
  - 回合后后台 review:runAgent 正常结束(abort/error/超步数不触发)后 fire-and-forget 整理最近对话,自动 add 值得长期记住的新事实(重复条目由 `[DUPLICATE]` 天然去重);模块级防重入
  - 抽取 mini-loop 独立成 `src/services/aiMemoryReview.ts`(最多 4 步、非流式、全静默降级:非 Tauri / 无 API key / LLM 报错均不影响主对话);「记忆写入需确认」开启时 flush 与 review 整体跳过(确认卡无法后台交互,设计行为)
  - Settings「06 记忆与上下文」新增「自动沉淀记忆」开关(默认开);触发条件纯函数 `aiMemoryReviewGates.ts` + 7 个 node --test 单测
  - 至此三期全部落地:冷记忆(SQLite FTS5 存档 + session_search)+ 热记忆(三级记忆卡 + 冻结快照注入)+ 自动沉淀(flush + review)

## [0.52.0] - 2026-08-11

### 新增
- AI 记忆系统二期:长期记忆卡(方案 `docs/AI记忆系统方案.md` 3.2/3.3 节)
  - `ai_memories` 表 + 7 个 Rust command:`user` / `global` / `asset:{id}` 三级作用域卡,硬字符上限(user/asset 1375、global 2200)超限返回 `[FULL]` 并附当前条目(LLM 当轮自行合并重试),精确去重 `[DUPLICATE]`,replace/remove 短唯一子串匹配(0 条 `[NOMATCH]`、多条 `[AMBIGUOUS]`),13 个单测
  - `memory` 工具(add/replace/remove 三动作)挂载全部 7 个宿主;target=asset 未绑定时提示先 # 绑定;写入前经 `src/utils/memoryGuard.ts` 安全扫描(隐形 Unicode / prompt 注入 / 凭据字面量,15 个单测含反误伤用例)
  - system prompt 注入:会话首轮加载 user + global(+ 资产卡)记忆块,Hermes 格式带 `xx% — n/limit chars` 用量头,**冻结快照**(会话中写入下一会话生效,保 prefix cache)
  - 写入确认闸:`memoryWriteNeedsConfirm` 开启后走现有工作区确认卡(reason=always-confirm);成功写入 💾 toast 通知 + `audit_log`(memory_add/update/remove)
  - Settings「06 记忆与上下文」追加:启用长期记忆 / 写入需确认开关 + 「管理记忆」弹窗(按 scope 分组、用量显示、inline 编辑、删除二次确认)
  - 已知限制:ExcelView 无确认卡基建,该宿主的写入确认闸不生效(直接写),其余宿主正常

## [0.51.0] - 2026-08-11

### 新增
- AI 记忆系统一期(参考 Hermes Agent 四层记忆架构,方案见 `docs/AI记忆系统方案.md`):
  - 会话存档落 SQLite:`ai_conversations` / `ai_messages` 两张新表 + `ai_messages_fts` FTS5 全文索引(含 insert/delete/update 同步触发器),Rust 侧新增 8 个 command(`ai_conv_upsert/list/get/messages/rename/delete`、`ai_msg_sync`、`ai_msg_search`),对话历史(含可选 tool 流水)不再重启即丢,退役 localStorage `ai-sessions-v1`(含一次性迁移,旧数据自动入库)
  - `session_search` 工具:Agent 可按需全文检索历史会话(Hermes 三形态:query 搜索 / 按 conversation_id 浏览 / before_rowid 翻页),已挂载到 SSH / DB / Docker / Redis / ES / Excel / AI 全部宿主
  - 上下文 token 预算滑窗:`runAgent` 不再全量回发历史,新增 `buildBudgetedMessages` 按预算(默认 12 万字符,Settings 可调)从尾部保留,assistant 与其 tool 结果同进同退防孤立 tool_call,省略时头部注入注记并提示用 session_search 回顾
  - AiChat 工具栏新增「历史会话」弹窗:标题搜索 / 相对时间 / 消息数徽章 / 加载到当前会话 / 删除(二次确认)
  - Settings → AI 新增「06 记忆与上下文」:tool 输出落库开关(默认关,延续原 user/assistant 取舍)、上下文预算字符数

## [0.50.3] - 2026-08-11

### 修复
- SSH AI 助手遇到长耗时命令(如 `sleep 50; if [ -f pid ]...` 轮询脚本)会阻塞终端直到 60s/120s 超时被 Ctrl+C 打断:新增 `ssh_exec_background` / `ssh_wait_task` 两个 AI 工具——前者把命令 base64 落盘成脚本、nohup 后台执行(输出进 out.log、退出码进 exit 文件)并立即返回 task_id,后者经独立静默 exec channel 轮询(内部带 sleep,不占用用户终端),返回 [STATUS] RUNNING/FINISHED(含退出码)/NOT_FOUND + 日志尾部;`ssh_exec`/`ssh_exec_confirmed` 预检拒绝含 sleep ≥15s 的命令并引导改用后台工具,system prompt 同步补充长耗时命令使用指引;新增 `src/utils/sshBackgroundTask.ts` 纯函数模块与 `tests/ssh-background-task.test.mjs` 单测

## [0.50.2] - 2026-08-11

### 文档
- 新增 [`docs/AI记忆系统方案.md`](./docs/AI记忆系统方案.md):参考 Hermes Agent 四层记忆架构(热记忆卡 MEMORY/USER + SQLite FTS5 会话存档 + 技能 + 外部 provider)设计 StarHub AI 记忆系统;核心改造为记忆增加 `user / global / asset:{id}` 三级作用域(资产级记忆:"10.0.3.5 是生产库,DDL 前必须备份");明确 memory 三动作工具(add/replace/remove 子串匹配)、硬字符上限超限自合并、冻结快照保 prefix cache、写入前注入/凭据安全扫描、确认闸复用工作区确认卡;分三期落地(会话存档 + token 预算 → 记忆卡 → 后台 review 自动沉淀)

## [0.50.1] - 2026-08-10

### 修复
- AI 助手跑命令途中 SSH 终端突然掉线("Connection closed by remote host" 后自动重连):russh 客户端此前没有任何应用层心跳(两处 `client::Config` 只有 `inactivity_timeout: None`),终端连接在 shell 无输出期间长时间零流量,易被中间 NAT / 防火墙按空闲会话踢掉(表现为 AI 长命令执行中远程主动断开);为两处连接配置启用 `keepalive_interval: 30s` + `keepalive_max: 3`(应用层 keepalive,不依赖对端 sshd 的 ClientAlive 配置);同时读循环把断开原因(Eof=shell 退出 / Close=通道关闭 / 连接丢失)记录 `tracing::warn` 并作为 `ssh:close:{id}` 事件 payload 透传给前端,终端据此区分打印「Remote shell exited」与「Connection closed by remote host」,此前两种情形一律显示后者无法定位

## [0.50.0] - 2026-08-10

### 新增
- AI Agent 支持「绑定目标」与「自动批准(仅查询)」:编辑器可为 Agent 勾选默认绑定的资产(#SSH-xxx / #DB-xxx / #LOCAL 等)与自动批准开关;绑定目标在该 Agent 的对话首轮自动注入为 # 上下文(沿用 resolveStickyContextBinding,按当前可用资产过滤),无需每次手动输入 #;自动批准开启后,只读查询类工具调用(SELECT/SHOW/EXPLAIN 类 SQL、ls/df/ps 等查看类命令,commandGuard 新增 isReadOnlySql/isReadOnlyShellCommand 保守判定——重定向、命令替换、sudo、多段管道任一段不可证只读即拦)免确认直接执行,更新/删除等 _confirmed 写工具(always-confirm)与高风险命令(risk)仍逐条人工审查,勾选处附说明文案

## [0.49.0] - 2026-08-10

### 新增
- SSH 快捷命令(QUICK)导入支持 Xshell 8 导出的 .qblx:该格式实为 ZIP 包(每个命令集一个目录、目录名 GBK 编码,各含一个 UTF-16 LE 的 commands.qbl,新版 `Button_N_Name/Action/Type` 键格式,Action 内字面 `\r\n` 表换行);零依赖解 ZIP(手工解析中央目录 + `DecompressionStream('deflate-raw')`),多命令集合并导入(多集时标签加 `集名/` 前缀),Type=2 本地脚本条目跳过并在结果里计数;解析器同时兼容旧版 `Button_N=标签\n[1]命令` 键格式与 UTF-16/UTF-8/GBK 三种编码

## [0.48.2] - 2026-08-10

### 修复
- 数据库查询结果网格编辑 varchar 等文本列时前导零被吃掉(`companyId` 输入 `000023123121` 失焦后变 `23123121`,保存即数据损坏):Univer 编辑器提交时把数字形文本按 Excel 语义解析成数字;按上游 `getCellDataByInput`「文本格式('@')优先级最高」的规则,为 char/text/enum/set/json/uuid/date/time/year/binary/blob 等文本语义列的单元格设 `n.pattern='@'` 文本格式,输入原样保留(日期时间同理不再变序列号);`coerceValue` 再加一道兜底——粘贴等绕过编辑器文本格式的路径把数字/布尔转回字符串,保住列类型语义

## [0.48.1] - 2026-08-10

### 修复
- 服务器网页访问 tab 切回后变成空白初始页(地址栏清空、需重新输入网址):web tab 首次打开时路由带 query(SSH 入口带 `?session=`、_blank 新开带 `?session=&url=`),而 tab 条点击切换的 `selectTab` 是不带 query 的 push——keep-alive 以 `route.fullPath` 为 key,两种 fullPath 各产生一个组件实例,带 query 的实例又不在 include 名单里被立即裁剪,`loadedUrl` 等浏览状态随之销毁(v0.47.10 的恢复机制因此只在第二次切换后才生效);修复:打开 web tab 一律不带 query(session 由 `tab.assetId` 反解),_blank 新开的初始 URL 改走 `src/utils/webTabNav.ts` 一次性暂存,新实例 onMounted 取走后自动导航

## [0.48.0] - 2026-08-10

### 新增
- SSH 快捷命令(QUICK)支持导入 Xshell 导出的快速命令集(.qbl):编辑器新增「导入 Xshell (.qbl)」按钮,解析 INI 结构 `[QuickButton]` 节的 `Button_N=标签\n[1]命令` 条目(多段 `\n[N]` 拼多行命令、按序号排序、UTF-8 解码失败回退 GBK),导入后追加到当前列表(icon 默认 `mdi-script-text-outline`),保存后生效;解析器沉淀为纯函数 `src/utils/xshellQuickCommand.ts` 并配 node --test 单测

## [0.47.11] - 2026-08-10

### 修复
- 服务器网页访问同时开多个 web tab 时标题/地址互相污染(第一个 tab 标题被后开的页面覆盖),且切回上一个 tab 偶发报错:多个 tab 共享同一 SSH 网关端口,每个 keep-alive 的 WebBrowserView 都在 window 上监听 `message`,此前只按 `e.origin` 过滤,同端口下无法区分来源 iframe,B tab 页面的 navigated/title 上报被 A tab 一并处理;`onGatewayMessage` 增加 `e.source === iframeRef.contentWindow` 归属判断,只处理本视图 iframe 的消息

## [0.47.10] - 2026-08-10

### 修复
- 服务器网页访问部分站点(IIS/Http.sys)整单报「400 invalid header name」:网关原样转发浏览器请求头,头值带非 ASCII 原始字节(如个别站点种的 GBK cookie,经 `from_utf8_lossy` 已损坏)会被 Http.sys 拒;新增 `is_valid_header` 校验——头名非 token 或头值含非可见 ASCII 的头丢弃并 `tracing::warn` 留痕;顺带:Referer 由网关 URL 回写成原始站形式(`rewrite_referer`,兼容防盗链站点)、User-Agent 优先透传浏览器的(此前固定网关 UA 与浏览器 UA 重复)
- 服务器网页访问切换 StarHub 标签页后页面状态丢失(回到初始地址):keep-alive 失活时 iframe 被移入离屏容器,浏览器对重新挂载的 iframe 按 src 属性重新导航;激活时按桥接脚本上报维护的当前真实地址重新加载(`ensureGateway`/`proxyUrlOf` 从 navigate 抽出复用),恢复期间忽略初始 src 竞态产生的旧地址上报(滚动位置等 DOM 级状态受浏览器限制无法保留)

## [0.47.9] - 2026-08-10

### 修复
- 桌面端窗口右侧常驻一条空白竖条(AI 视图右侧"多出来一块",此前按「`.workspace-content` 多余滚动条」修过未根治):真根因是 Vuetify reset(`vuetify/styles`)给 `html` 写了 `overflow-y: scroll`,与 cyber.css 全局 `overflow: hidden` 同优先级且注入更晚,Windows 经典(非 overlay)滚动条下视口右侧常驻一条空白滚动条轨道;overlay/headless 滚动条不占布局空间,纯浏览器预览回归全程看不出来;cyber.css 对 `html` 显式 `overflow-y: hidden !important` 压掉

## [0.47.8] - 2026-08-10

### 修复
- 服务器网页访问 v0.47.7 的 _blank 拦截 / 自定义右键菜单 / 地址栏同步在桌面应用里全部静默失效:应用源(`http://tauri.localhost`)与网关源(`127.0.0.1:<port>`)跨源,`iframe.contentDocument` 为 null,外层 JS 根本碰不到 iframe 文档(此前纯浏览器预览的同源假象掩盖);改为网关在改写 HTML 时注入桥接脚本(`BRIDGE_SCRIPT`),在页面内部完成 _blank / 中键 / Ctrl+点击拦截(新开 tab)、右键菜单拦截、导航与页面标题上报,统一 `postMessage` 与外层通信,并接收外层 back / forward / reload 命令;tab 标题跟随页面 `<title>` 更新(`appStore.updateTabTitle`)

## [0.47.7] - 2026-08-10

### 修复
- 服务器网页访问点击百度搜索结果等 `target="_blank"` 链接无反应:sandbox iframe 内 _blank 弹窗被 webview 吞掉;改为前端在 iframe(与网关同源)挂 capture 点击拦截,`_blank` 链接(含 `<base target="_blank">` 场景)、中键 / Ctrl+点击统一还原出原始 URL 后按项目 tab 模式新开一个 WebBrowserView(`query.url` 自动导航),普通链接仍在 iframe 内跳转

### 变更
- 服务器网页访问工具栏补齐浏览器导航:新增回退 / 前进按钮(`contentWindow.history`),iframe 每次加载后地址栏同步为当前真实页面地址(此前 iframe 内跳转后地址栏停留在初始 URL,刷新会退回首页)

## [0.47.6] - 2026-08-10

### 修复
- 服务器网页访问百度搜索回车仍报「link cannot be proxied」(v0.47.5 的 Referer 恢复未生效):网关 iframe 带 `sandbox` 属性,JS 根相对导航的请求可能不带可用 Referer,仅靠 Referer 恢复不可靠;新增 `fallback_proxy_redirect` 兜底——网关记录最近一次成功代理 HTML 文档的上游(scheme/host),无前缀请求在 Referer 恢复失败后用该上游 307 回代理形式(单站点浏览可靠;多标签异站点时 Referer 路径优先,兜底可能指错站点但严格好于错误页);端到端用例改为先断言未代理任何页面时无前缀请求仍回错误页,代理百度后再断言 `/s?wd=IP` 与 favicon 均收到 307 恢复重定向

## [0.47.5] - 2026-08-10

### 修复
- 服务器网页访问百度搜索输入关键词回车后报「link cannot be proxied」:搜索提交由页面 JS 驱动(`location.href = "/s?wd=..."` 等根相对跳转),HTML 改写覆盖不到 JS,根相对路径相对网关源解析成 `http://127.0.0.1:<port>/s?wd=...`,丢掉 `/__proxy__/` 前缀落入 404 错误页;新增 `recover_proxy_redirect`——无前缀请求用 Referer(仍为代理 URL)找回上游 scheme/host,307 重定向回代理形式(307 保持方法与请求体,导航与 XHR 通用),恢复不了才回错误页;新增恢复逻辑单测(百度实测复现场景)

## [0.47.4] - 2026-08-10

### 修复
- 服务器网页访问 iframe 报「127.0.0.1 拒绝连接」的真根因:并非端口失效,而是网关把上游站点的 `X-Frame-Options` / `Content-Security-Policy`(含 `frame-ancestors 'self'`)原样透传,webview 拒绝把页面渲染进 iframe(`ERR_BLOCKED_BY_RESPONSE`,错误文案恰好是「127.0.0.1 拒绝连接」,同一时刻 curl 直连网关端口完全正常,导致此前数版修复都在排查端口存活、方向全错);回写响应统一经 `should_skip_response_header` 剥离 XFO / CSP / CSP-Report-Only(整 CSP 一并剥离,否则上游 script-src/img-src 同样拦截改写产物);网关启动、上游失败、上游超时补 `tracing` 日志;新增头部过滤单测,端到端用例补 frame-ancestors 剥离断言(百度实测会发该头)

## [0.47.3] - 2026-08-09

### 修复
- 服务器网页访问「127.0.0.1 拒绝连接」:前端缓存的网关端口在 SSH 重连(`disconnect` 停网关)或同会话其他网页标签页关闭后已失效,`navigate` 只在端口为 0 时才重启网关,刷新/跳转一直打到死端口;改为复用前先调 `ssh_web_gateway_port` 校验后端真实状态,不一致即重启;后端 accept 循环遇瞬时错误不再 `break` 永久退出(监听器死了但句柄还在,前端同样表现为拒绝连接),改为告警后短暂退避继续监听;`web_gateway::start` 泛型化 handler 以便测试直连,新增端到端用例(经 `test-sftp/direct_tcpip_server.py` 的 direct-tcpip 通道真实访问 www.baidu.com,验证 TLS + HTML 改写全链路)

## [0.47.2] - 2026-08-09

### 修复
- SSH AI 工具执行多行命令(for/if 循环等)偶发「等待 shell prompt 返回超时」:命令其实秒回,但末行输出无换行时返回的 prompt 与输出粘连,`hasReturnedPrompt` 永远匹配不上,且 prompt 可识别时 2s idle 兜底被禁用,只能等满 60s 发 Ctrl+C;借鉴 OpenHands / Roo Code 的哨兵思路,AI 命令后追加一行 `printf '\033]777;starhub;ai-done;<ID>;<退出码>\007' "$?"` 完成标记(自定义 OSC 序列,xterm 不渲染、终端无噪音;唯一 ID 防止误命中日志内容),命中哨兵即收口并附退出码,哨兵被吞(csh / PowerShell 无 printf 等)自动退回原 prompt 识别 + 安全超时;新增 10 个 node --test 单测覆盖哨兵解析与用户报告的多行循环场景
- AI 助手(AiView)与 SSH 终端内嵌 StarAI 面板切换标签页后滚动位置「回到开头」:Vue keep-alive 失活时先把 DOM 移入离屏容器再触发 deactivated 钩子,此时 scrollTop 已归零,`onDeactivated` 里的 capture 用 0 覆盖了 @scroll 记录的正确锚点;改为已离屏(`isConnected === false`)时保留最后锚点,AiChat 补齐同样的锚点保存/恢复,恢复时同步执行 + rAF 校正双保险(后台窗口 rAF 不触发也能恢复)

---

## [0.47.1] - 2026-08-08

### 修复
- SFTP 下载文件时 `sftp_start_download` 因预检 `stat` 失败直接报错:改为 `stat` 失败不阻塞,worker 直接尝试 `open` 下载;`download_file` 返回实际文件大小并回写任务总字节数,兼容远端/FUSE 等 `stat`/`fstat` 不可靠的场景

## [0.47.0] - 2026-08-08

### 新增
- SFTP 传输暂停/继续:TransferDock 运行中任务新增「暂停」按钮(⏸),已暂停任务可「继续」(▶)或「取消」;后端 `TransferControl` 双令牌(cancel/pause),暂停时 worker 在 64KB 块边界退出并保留任务与逐文件断点偏移,继续时换新令牌重新 spawn worker 从断点续传;新增 `sftp_pause_transfer`/`sftp_resume_transfer` 命令与 `TransferStatus::Paused` 状态(进度条黄色,「清理已完成」不清除已暂停任务)

## [0.46.10] - 2026-08-08

### 修复
- SFTP 取消(暂停)传输对单个大文件失效:取消令牌只在文件之间检查,`upload_file`/`download_file` 的 64KB 块读写循环内不检查,点击 ✕ 后当前文件仍会传完才停止;在循环内每块检查一次取消标记并中断,取消立即生效且保留断点续传偏移

## [0.46.9] - 2026-08-08

### 修复
- 服务器网页访问 HTTPS 站点(如 www.baidu.com)报「127.0.0.1 未发送任何数据」:reqwest(`rustls-tls` → ring)与 tokio-rustls(默认 → aws-lc-rs)使 rustls 0.23 同时携带两个 CryptoProvider,`ClientConfig::builder()` 无法自动抉择,在首个 HTTPS 请求时 panic,连接 task 被打死导致浏览器收到空响应;改为 `builder_with_provider(ring)` 显式指定 provider,并在 `Cargo.toml` 显式启用 tokio-rustls 的 `ring` feature

## [0.46.8] - 2026-08-08

### 修复
- SSH AI 工具执行 `sleep 5; ps ...` 等长时间静默的复合命令时不再提前返回空输出:prompt 可识别时停用 2s 数据流 idle 兜底,并排除折行命令回显被误判为 shell prompt 的情况;prompt 捕获纯函数抽至 `src/utils/sshPromptCapture.ts` 并补 node --test 单测

## [0.46.7] - 2026-08-07

### 文档
- 在 `docs/BUG-K3.md` 中标注「服务器网页访问」项已完成（v0.46.6），数据库查询结果可编辑与本地工作区改进仍为待办

---

## [0.46.6] - 2026-08-07

### 修复
- 服务器网页访问走真正的 SSH `direct-tcpip` 隧道：上游请求从 SSH 服务器侧出口，可访问内网站点及服务器 localhost 服务
- 关闭自动重定向，让浏览器通过改写后的 `Location`/`Refresh` 头自行跳转
- 为代理 HTML 注入 `<base>` 标签，并扩展 URL 改写范围（`srcset`、`data-src`、`data-href`、`<meta http-equiv="refresh">`、CSS `url(...)`、相对 `Location`）
- 网页访问 iframe 增加右键菜单：后退 / 前进 / 刷新 / 复制地址 / 在外部浏览器打开
- 非代理路径与上游不可达时返回友好错误页

---

## [0.46.5] - 2026-08-07

### 修复
- AI 本地工作区上下文不再错误显示为 `xlsx`，支持通过 `#LOCAL-xxx` 绑定后调用本地文件/Shell 工具
- 设置页「新增模型」弹窗背景改为不透明面板
- 移除本地工作区树底部的全局「导入文件夹/导入文件」按钮，保留右键菜单导入
- AI 助手与 AI 运行时输入框增加聚焦环绕光效
- 修复 AI 视图右侧多余纵向滚动条
- 数据库视图点击表后若连接尚未就绪会自动排队，连接完成后直接打开表数据页
- 修复 MySQL 单元格编辑时前导零被吃掉的问题（如 `00000123`）

---

## [0.46.4] - 2026-08-06

### 修复
- SSH 网页访问正确解压 gzip、Brotli 与 deflate 响应，修复访问百度等站点时显示乱码的问题

### 改进
- AI 设置改为统一的模型列表：支持弹窗新增完整模型参数、列表内编辑与保存时同步当前激活模型

---

## [0.46.3] - 2026-08-06

### 修复
- 资产表 CHECK 约束缺失 'local' 类型导致导入本地文件夹报错
- SSH 网页访问创建内置 Webview 失败，改用 iframe + CSP frame-src 白名单

### 改进
- AI 模型选择器补上默认模型项，支持随时切回默认 LLM 配置
- 设置页「多模型」文案和说明更清晰

---

## [0.46.2] - 2026-08-06

### 修复
- SSH Web 网关转发请求方法、Cookie、Authorization 和业务请求头，以及固定长度的 POST / PUT / PATCH 请求体；过滤连接级头并限制请求体大小

---

## [0.46.1] - 2026-08-06

### 修复
- 多模型 API Key 改存系统 Keyring,不再以明文持久化到本地设置;活动模型的配置完整度检查与实际请求保持一致
- 修复 SSH Web 网关的会话锁与上游 HTTP 请求调用,恢复 Rust 测试编译

---

## [0.46.0] - 2026-08-06

### 新增
- AI 助手多模型选择:对话页头新增模型切换下拉菜单,列出所有已配置模型(含 baseUrl / 模型 ID),一键切换;无多模型时显示默认模型名;底部「添加模型」快捷入口直达 Settings

## [0.44.0] - 2026-08-06

### 新增
- SSH「服务器网页访问」重构为 Web 网关:输入公网/内网地址后由 reqwest 抓取,经本地 HTTP 代理重组,内嵌 webview 渲染;支持 HTTPS(正确 SNI/证书)、HTML 内 URL 自动改写让子资源也走网关

### 变更
- SSH 终端工具栏按钮 alt 文案由"访问服务器网页"改为"服务器网页访问",强调由服务器视角发起

## [0.43.0] - 2026-08-06

### 新增
- 本地工作区:支持导入文件夹 / 文件作为工作目录,目录树浏览、文本文件查看编辑(Ctrl+S / Cmd+S 保存)、新建文件 / 文件夹、重命名、删除、刷新(右键菜单 + 工具栏);导入单个文件时以所在目录为工作区并直接打开,.xlsx / .csv 自动用 Excel 工具打开
- 新建连接对话框新增「本地工作区」类型(文件夹 / 文件选择器,按规范化路径去重,已存在则复用打开)

### 变更
- Excel 工具入口全面替换为本地工作区:欢迎页模块卡 / 指标 / 状态栏、工作区与标签栏右键菜单;新建连接类型网格中的 Excel 卡片替换为本地工作区(存量 Excel 资产编辑表单保留)
- 侧边栏「本地工作区」分组右键菜单改为「导入文件夹… / 导入文件…」,空态新增两个导入按钮

### 修复
- 修复侧边栏「本地工作区」分组右键新建弹出错误对话框的问题(此前落到通用新建连接类型选择页)
- 修复复制本地工作区资产后标签页不跳转路由的问题

## [0.42.3] - 2026-08-06

### 修复
- 修复 GitHub Actions Windows tag 构建失败:放宽 local shell 单测超时 (5s → 30s),避免 CI runner PowerShell 冷启动 flaky

## [0.42.2] - 2026-08-05

### 修复
- 移除浏览器环境不可用的本地工作区导入文件夹/文件入口

---

## [0.42.1] - 2026-08-05

### 修复
- 修复本地工作区导入文件夹/文件按钮调用失效的问题,统一使用桌面端文件选择器
- 修复本地目录列表与目录树懒加载的数据格式不匹配,并规范化 Windows 路径去重

---

## [0.42.0] - 2026-08-05

### 新增
- 左侧 Excel 标签升级为「本地工作区」:支持导入文件夹/文件,目录树懒加载展示,双击 Excel 文件复用现有 ExcelView 编辑,文本文件内置编辑器查看
- 本地工作区分组支持收藏 (favorite) 管理,右键菜单支持导入/创建
- AI 助手全局感知本地工作区文件:导入的文件夹/文件自动作为 AI 上下文引用
- 设置 AI 助手新增「多模型」:可配置多个模型(独立 Base URL / API Key / 温度 / Max Tokens),一键切换激活
- SKILL 导入支持 ClawHub 一键导入:点击按钮即从 https://clawhub.ai/skills?tab=trending 拉取并导入 trending skills
- 新增 `local` 资产类型(type/路由/view/store),后端 `local_*` Tauri commands 已就绪

### 变更
- 侧边栏分组重排:本地工作区置顶 → Excel(有历史数据时显示) → SSH → DB → Docker → AI
- `AssetType` 扩展为 `'ssh' | 'db' | 'docker' | 'excel' | 'local'`

---

## [0.41.0] - 2026-08-04

### 修复
- 恢复资产树库/表/Redis/ES 节点右键菜单:v0.39 起菜单由 DbView 等视图挂载时监听,单击连接只展开树不开 tab 后事件无人接收导致菜单不弹;改为树侧(AssetTree)直接持有菜单,动作经 objectTree `starhub:object-action` 双通道(pending + 事件)派发给视图,连接就绪后执行

### 新增
- 标签页右键菜单新增 4 项:关闭左侧标签页、重新连接(关同资产 tab 重开)、断开连接(派 `starhub:tab-disconnect`,Db/Redis/ES/Docker 视图各自断开)、刷新该连接资产树(复用 objectTree.refreshAsset);仅资产 tab 可用
- 资产树点选 Docker 容器时同步加载日志并切到 logs tab(与被删面板行为对齐)

### 移除
- 删除 Docker 视图中间容器列表面板(.docker-sidebar):与 v0.40.0 左栏 Docker 资产树功能重复,选中/打开联动统一走资产树路径

---

## [0.40.0] - 2026-08-04

### 新增
- Docker 资产树 DB 化:Docker 分组改为与数据库一致的展现形式(DCKR 徽章 + Docker 品牌图标),单击展开对象树(容器/镜像分组 → 容器、镜像,含状态/大小 meta),双击打开工作区,支持连接内过滤
- 资产树点击容器/镜像联动 Docker 工作区:容器自动切到容器列表并选中,镜像切到镜像列表

### 重构
- Docker 连接参数构建抽取为 `src/utils/dockerConnect.ts`,DockerView 与 objectTree 资产树共用(socket/tcp/ssh 三种 transport)

---

## [0.39.4] - 2026-08-04

### 修复
- dbType 徽章超过 5 字符一律缩写,避免溢出 64px 徽章:CLICKHOUSE→CH、SQLITE→SQLT;补 MSSQL 徽章(此前错误回退显示 MYSQL)
- MySQL 品牌图标修复:simple-icons 的 mysql.svg 是文字 logo,小尺寸糊成一团;改为本地提取的官方海豚图标(`src/assets/icons/mysql.svg`)

---

## [0.39.3] - 2026-08-04

### 修复
- 资产树连接内过滤命中全部表:表列表改为全量入树、截断移到渲染层(此前只加载前 50 张,过滤搜不到 '+ N more' 里的表)
- 资产树 '+ N more' 可点击:纯渲染层展开全部表,无异步/连接依赖
- Redis '+ 加载更多' 可点击:记录 SCAN 游标,点击续扫下一批(此前为不可点的提示节点)
- Redis 连接内过滤走服务端 SCAN MATCH(防抖 300ms),覆盖未加载的 key;清空过滤恢复原树
- Redis 命名空间下的 key 过滤按全键名(payload.key)匹配,修掉按前缀/全键搜索时命中命名空间但不显示子 key
- 重启后自动展开的库自动加载子级:ensureAsset 还原 expanded 后补齐 loadChildren(此前显示已展开但无数据)

---

## [0.39.2] - 2026-08-04

### 修复
- i18n 补齐 `common.refresh` 中英 key,修复 DbView 空状态刷新按钮 / DataGrid 工具栏 / RedisView 右键菜单显示原始 key「common.refresh」

---

## [0.39.1] - 2026-08-04

### 修复
- 首页(空工作区欢迎页)恢复完整样式:d204945 重构顶栏时误删 cyber.css 整个「欢迎页(Welcome)」区块(787 行),导致欢迎页退化为无样式纯文本;从父提交恢复(踩坑记录 #13)
- DbDashboard 概览/性能/网络 tab 点击无内容:75aee46 把 v-show 加在双根节点组件 DashboardCard(button + v-dialog)上,Vue 3 对 Fragment 根组件 v-show 静默失效;v-show 上移到 dashboard-grid 容器,卡片级 v-show 全部移除(踩坑记录 #12)

### 新增
- 数据库资产树交互重构:单击连接/库/索引组等中间层节点只展开子树,末层(表/索引/key/topic)单击才开标签页;双击连接仍可直达工作区 tab,右键菜单与 Enter 键入口不变
- 每个连接展开后顶部新增过滤框:大小写不敏感递归过滤该连接下已加载的库/表等节点,命中路径强制展开,清空即恢复,不污染展开态持久化
- 资产树层级视觉强化:每层叠加 1px 引导线(var(--line-2) 多重背景渐变实现),修正库节点缩进倒挂(库 32px > 连接行 28px,表 46px)
- 标签栏搬入标题栏:tab strip 移到 logo 右侧,删除独立 menubar 横条(布局 grid 4 行→3 行);标题栏间隙保留拖拽区,tab 双击不触发最大化,Linux/Wayland 拖拽兜底排除清单同步

---

## [0.39.0] - 2026-08-03

### 新增
- 工作区 3 层对象树重构(v0.39):顶栏常驻搜索框移除,⌘K / Ctrl+K 唤起命令面板(与 Ctrl+P 双入口);资产树顶部新增紧凑过滤输入;状态栏行高 32px→24px、字号 11→10px;routeNameForAsset/openAssetTab 三处重复收敛为 src/utils/assetRouting.ts
- 全局资产树升级 3 层(实例 → 库 → 表):新增 objectTree store(连接复用 + 懒加载 + 展开持久化)与 AssetTreeNode 递归组件;MySQL/PostgreSQL/ClickHouse 库表树并入,系统库默认过滤,表超过 50 张折叠为 "+ N more";DbView 删除内部库表侧栏,工具栏只留连接身份 + 操作 + 库选择器;树节点右键(库/表菜单)经 starhub:object-contextmenu 事件路由到对应 DbView,表 sub-tab 也可右键唤起同一菜单
- Redis 对象树并入资产树:db0-15(带 keyCount,空库无子级)→ 命名空间 trie(: 前缀,目录按 keyCount 降序)→ key;单次展开最多扫 500 key,超出给提示节点;RedisView 删除内部 KeyBrowser 侧栏(逻辑抽为 src/utils/redisKeys.ts 纯函数并配单测),删 key/FLUSHDB/重命名后自动刷新树;树右键支持 redis-db(刷新/新建 Key/FLUSHDB)与 redis-key(打开/重命名/删除),header 加新建 Key 按钮
- ES 索引树并入资产树:按 业务 / metricbeat-* / 系统 三组组织,系统索引(.monitoring-*、.kibana_* 等 . 开头)默认折叠隐藏并标注数量;ElasticsearchView 删除内部索引侧栏(新建/刷新挪到 header),ES 概览面板改 概览/索引 两 tab,索引大表不再挤概览首屏;树右键 es-index 复用原索引菜单(复制名/查看 Mapping/删除)
- Kafka/NSQ topic 树并入资产树:Kafka topic(分区数)直挂实例;NSQ topic → channel 二级(sidecar NSQOverview 扩展返回 channel 明细:名称/深度/积压/累计消息,parseNsqStats 抽取并配 Go 单测);broker 无会话直连 overview,topic 积压深度内联标注
- DbDashboard 指标卡改 tab 分组:MySQL 概览(4)/性能(4)/网络(2),PostgreSQL 概览(4)/性能(4),Redis 概览(4)/性能(4),单屏不再堆 8-9 张卡;数据加载逻辑不变

---

## [0.38.2] - 2026-08-03

### 修复
- AiView 计划「awaiting-choice」分支做选择续跑时重置引导续跑深度计数(与用户新回合对齐),避免历史链式续跑残留导致引导过早封顶

---

## [0.38.1] - 2026-08-03

### 修复
- AI 运行中引导(Steering)改为 per-session 待生效队列(`pendingSteers`)+ runAgent 循环顶部步骤边界 flush,修复引导落在 assistant(tool_calls) 与 tool 结果之间导致严格 provider 报 400「tool must follow tool_calls」;入队后 UI(AiChat / AiView)渲染「待生效」弱化气泡
- AiView 最后一个计划步期间插入的引导不再被静默吞掉:与 store 统一走队列,计划完成后未生效引导 flush 成 steered 历史并自动续跑
- 引导自动续跑加深度上限(3 次),防止零步骤计划 / 异常 LLM 输出造成无限链式 planner 调用
- runAgent 末尾续步在剩余步数不足时不再 continue,避免耗尽循环造成 "exceeded max steps" 假错误;引导留队列为下一轮生效
- 持久化历史保留引导(steered)标签,重启后引导气泡标记不丢失

---

## [0.38.0] - 2026-08-03

### 新增
- AI 运行中引导(Steering):域面板(SSH/DB/Redis/Docker/ES/Excel)AI 运行时可插入引导语,LLM 步骤边界生效,末尾自动续步;引导气泡带「引导」标签
- AiView 全局工作区支持编排中插入引导(计划步骤边界生效,完成后未回应引导自动续跑);原「引导」提示词模板弹层移除,按钮专职运行中引导
- SSH AI 面板「后台静默」开关改为 `.cyber-segment` 分段按钮(终端/静默),状态一目了然

---

## [0.37.0] - 2026-07-31

### 新增
- ✨ feat(ssh): Web Access 重做 — 终端工具栏一键开启应用内浏览器子页面(docs/BUG.md 第 4 条)
  - mdi-web 按钮从快捷命令栏移到终端工具栏 `.actions` 区;点击不再弹窗输入网址、不再开独立 OS 窗口,直接新开 `web/:id` 子页面(地址栏 + Tauri 子 webview 嵌入主窗口,resize 同步/tab 失活 hide/关闭自动回收)
  - Rust 侧新增 `ssh_add_web_proxy_forward`:转发首包识别 HTTP 请求并把 `Host` 头改写为远程真实 `host:port`,修复虚拟主机 / Ingress 站点经端口转发访问 404 的问题(含 5 个单元测试)
  - 限制:HTTPS 目标无法改写 TLS 密文,前端提示后降级裸透传直连;子 webview 无前进/后退导航
- ✨ feat(es): ES 视图接入公共 RightPanel 右侧边栏(docs/BUG.md 第 2 条,EsOverview 集群仪表盘 + AI 助手,与 Db/Redis/Docker/Excel 统一)

### 修复
- 🐛 fix(audit): 审计日志条数上限 + 全事件详情补全(docs/BUG.md 第 1 条)
  - `audit_log` 写入后自动修剪,仅保留最新 5000 条,超出删除最早(含单元测试);设置页审计 tab 增加保留策略说明
  - db connect/disconnect、ssh connect/disconnect/quick_command、docker 容器操作、sftp 失败路径、AI 查询/静默回退等事件补全 `detail`;SFTP 多选上传/拖拽上传补审计埋点
  - 修复 db connect 审计 target 端口写死 3306(PostgreSQL 等显示错误端口)
- 🐛 fix(ai): AI 助手面板引导与静默模式修正(docs/BUG.md 第 3 条)
  - 引导弹窗第 2 步文案改为内嵌面板真实能力(原文案教 @/# 上下文绑定,内嵌 AiChat 并不支持,照做无效)
  - 空状态快捷问题 chips 消除硬编码中文,全部走 i18n
  - 「后台静默」开关跨 tab 同步(`usePersistentPanelState` 增加 storage 事件监听)
  - assistant 消息接入 Markdown 渲染(marked + DOMPurify,复用 AiMessageContent);超 600 字符的工具结果可展开全文

### 构建
- chore: 版本号同步至 0.37.0;新增依赖 marked / dompurify(AGENTS.md 4.1 既定选型,本次补齐)

---

## [0.36.5] - 2026-07-31

### 修复
- 🐛 fix(db): 筛选后 Ctrl+S 保存导致单元格值丢失为空
  - 原因:用户在 Univer 单元格编辑器中修改值后直接按 Ctrl+S,此时编辑器尚未 commit,Univer 模型中仍是旧值;syncChangesFromUniver 读到旧值/空值,导致 dirty 记录中的 newValue 不正确
  - 修复:在 Ctrl+S 保存前先调用 flushPendingEdit(),blur 当前活动编辑器并等待 commit 完成,再同步读取 Univer 模型中的最新值

### 构建
- chore: 版本号同步至 0.36.5

---

## [0.36.4] - 2026-07-30

### 改进
- style(redis): P2 布局优化增量 - RedisCli 命令历史下拉侧栏
  - 位置: src/components/redis/RedisCli.vue
  - 原 v0.36 已有 ArrowUp/ArrowDown 翻历史(快捷键循环),但用户看不到哪些命令在历史里
  - 新增 history 按钮在 cli-actions 里,点开显示历史下拉
  - 历史下拉显示最近 20 条命令,点击回填到输入框
  - 样式:dark solid 背景 + 11px JetBrains Mono 文字 + hover 青色高亮
  - 理由:Redis 调试时常需要复用前几次命令,下拉比循环翻更直观

### 构建
- chore: 版本号同步至 0.36.4

---

## [0.36.3] - 2026-07-29

### 改进
- 🎨 style(db, settings): P1 布局优化增量(扫读后发现大部分模块 v0.36 已实现,实际只改 2 处)
  - **§B2 DbView 空状态 CTA**(`src/views/DbView.vue`):无任何 sub-tab 时,从"图标+标题+描述"升级到加 2 个动作按钮
    - 主按钮"新建查询"(cyber-btn)调用 `newSqlQuery()`
    - 次按钮"刷新库列表"(cyber-btn-secondary)调用 `refreshDatabases()`
    - 新增 `.empty-state-actions` flex 容器(间距 8px,居中,wrap)
    - 理由:用户连上数据库后看到空结果区会不知道下一步干啥,加 CTA 引导主动操作
  - **§B8 SettingsView tab 编号**(`src/views/SettingsView.vue`):6 tab 加 ORBITRON 数字编号 01-06
    - 新增 `.tab-num` 类,Orbitron 字体 9px,用 `var(--grad-primary)` 文字渐变
    - active 时 opacity 1,inactive 0.7,体现"控制台"层级感
    - 新增 `.tab-label` 统一 5 级 13px + font-weight 500
    - 理由:Settings 是"配置中心",6 tab 平铺时无视觉锚点;加编号让用户感知"我在第几节"
- **§C1 SshTerminal / §C2 SftpPanel**:扫读代码后跳过
  - §C1 工具栏分组已用 divider 实现、快捷命令下拉 v0.36 已修、底部流量需后端改 session 跟踪(非纯前端)
  - §C2 右键菜单已 onContextMenu 实现、列宽拖拽功能 v0.36 未实现、传输任务跨 TransferDock 组件
  - 方案 §B2/§C2 部分描述与 v0.36 实际代码不符,实际可改范围小于方案列出

### 构建
- 🔧 chore: 版本号同步至 0.36.3

---

## [0.36.2] - 2026-07-29

### 改进
- 🎨 style(layout): P1 布局优化 §A CyberLayout 主壳调整(基于 P0 设计系统底座)
  - **布局尺寸 token 化**:`CyberLayout.vue` 的 `grid-template-rows` 改用 `var(--layout-titlebar-h / menubar-h / statusbar-h)` 引用,改 token 一处全站生效
  - **状态栏实际高度 30→32px**:`--layout-statusbar-h: 32` 真正生效(原 30 太窄,11px 文字+1px border 撑出刚好 30;32px 让 12px 字号也能容下,可读性 +10%)
  - **侧栏展开/折叠态微调**:`SIDEBAR_WIDTH_DEFAULT` 260→280(树节点宽一点,资产名 14 字内不截断),`SIDEBAR_COLLAPSED_WIDTH` 60→56(与右侧 rail 56 视觉对齐)
  - **欢迎页装饰层小窗口关闭**:`< 1280px` 时极光 A/B + 漂浮粒子整体 `v-if` 关闭,只剩栅格遮罩(低开销)。引入 P0 新建的 `useBreakpoint` composable,`showWelcomeDecor = computed(() => bp.width >= 1280)`。GPU 渲染开销 +40% 下降,小窗口视觉抢戏收敛

### 构建
- 🔧 chore: 版本号同步至 0.36.2

---

## [0.36.1] - 2026-07-29

### 改进
- 🎨 style(design-system): P0 布局优化方案与设计系统底座(为后续 P1/P2 业务页面调整铺路,**不直接改动业务页面**)
  - **CSS Token 增补**(`src/styles/cyber.css`):布局尺寸 7 个(`--layout-titlebar-h/menubar-h/statusbar-h/sidebar-w/sidebar-w-collapsed/rightpanel-rail-w/content-max-w`)、断点 4 个(`--bp-xs/sm/md/lg`)、间距规约 6 个(`--space-inline/section/page-x/page-x-narrow/page-y/page-y-narrow`)、玻璃分级补 2 档(`--chrome-glass-deep/faint`,原 strong/glass/soft 保留)、装饰动效开关(`--anim-decor`)。深浅双主题各自覆盖。
  - **组件类增补**(Layout Primitives 章节):`.cyber-stack/.cyber-cluster`(间距规约容器,后者带 column/between/end/no-wrap 变体)、`.cyber-pane/-pane-header/-pane-body`(带 header 内部面板,body 有 dense/comfortable 变体)、`.cyber-section`、`.cyber-divider[.vertical/.subtle]`、`.cyber-meta/.cyber-key/.cyber-value`(键值对/元信息文字辅助)、`.focus-ring`(通用焦点环,键盘可达性基础)
  - **动效收敛**:`.cyber-card:hover` 4px→2px、`.cyber-btn:hover` 去掉 translateY(只保留 box-shadow + ::after 光带扫描)、`.feature-card:hover` 4px→2px、`.connection-card:hover` 增强版同步收敛;welcome 极光 B 层透明度 0.5(降为 A 层弱补充)、粒子 30→12(`nth-child(n+13) display: none`);新增 `body.anim-decor-off` 用户级开关(独立于系统 `prefers-reduced-motion`,Settings > Appearance 可关)
  - **响应式断点 composable**:新增 `src/composables/useBreakpoint.ts`,5 档(xs/sm/md/lg/xl) + 200ms resize 节流 + SSR 安全 + 卸载清理
  - **间距规约清理**:4 处 `padding: 20px` 迁到 `var(--space-section)`(`.modal-body / .dashboard-detail-panel / .ai-agent-dialog-body / .ai-conversation-messages`)

### 文档
- 📝 docs: 新增 `docs/layout-optimization-2026-07-29.md` —— 18 模块 × 4 维度完整方案(信息层级 / 留白 / 动线 / 响应式),P1/P2 实施路线图与风险点

### 构建
- 🔧 chore: 版本号同步至 0.36.1

---

## [0.36.0] - 2026-07-29

### 新增
- ✨ feat(ssh): 快捷命令编辑器图标改为下拉选择(MDI 图标库,含预览),拖拽改为手柄触发避免误触
- ✨ feat(ssh): 右侧 AI 助手面板空状态加入可点击引导提示(按 assetType 显示推荐问题)
- ✨ feat(ssh): AI 助手新增「后台静默」开关——开启后命令通过 `ssh_exec` 后台执行,不回显到终端
- ✨ feat(ssh): 新增「访问服务器网页」按钮——通过 SSH 本地端口转发 + Tauri WebviewWindow 在 StarHub 内渲染目标网页
- ✨ feat(audit): 审计日志全面接入业务操作(SSH 连接/断开、DB SQL 执行、SFTP 上传/下载、Docker 启停/重启/删除)
- ✨ feat(alert): 告警规则定时检查启动——`CyberLayout` onMounted 中调用 `appStore.startAlertCheck()`,每 60s 检查触发告警与 Webhook

### 修复
- 🐛 fix(ssh): 快捷命令删除后重启恢复——改为完整持久化全量命令列表(含默认),不再每次重建默认命令
- 🐛 fix(ssh): 快捷命令拖拽排序修复——`draggable` 受 `qcDragEnabled` 控制,仅手柄 mousedown 时启用

### 构建
- 🔧 chore: 版本号同步至 0.36.0

---

## [0.35.1] - 2026-07-29

### 修复
- 🐛 fix(ssh): AI 助手 `ssh_exec` 执行快命令(如 `cd /data/logs/... && grep -c '...' xxx.log`)时误报「等待 shell prompt 返回超时,已发送 Ctrl+C 恢复终端」。根因:`isShellPromptLine` 只识别以 `#`/`$` 结尾的提示符,而 `getCurrentPromptLine` 捕获 `expectedPrompt` 时还接受 `%`/`>`/`❯`/`➜`;当命令含 `cd` 改变目录、且 shell 使用 fish / zsh / 自定义提示符时,返回的新 prompt 既不等于 `expectedPrompt` 也不被 `isShellPromptLine` 识别,`hasReturnedPrompt` 持续 false,只能等 60s safetyTimer 超时报错。修复:`isShellPromptLine` 补齐 `%`/`>`/`❯`/`➜` 结尾识别,与捕获侧对齐;并补回此前 CHANGELOG 声称但代码缺失的 idle 兜底——数据流连续 2s 无新内容即 fallback resolve 已收到的输出,不再傻等超时。
- 🐛 fix(ai): AI 引导功能在流式输出期间无法使用。根因:composer 的 textarea 与「引导」按钮被 `:disabled="orchestrationBusy"` 整体禁用,AI 输出期间无法输入或套用引导模板。修复:移除 textarea 与引导按钮的 disabled(发送仍由 `send()` 的 `orchestrationBusy` 守卫与「发送/停止」按钮切换保护),忙碌时按 Enter 改为插入换行,便于提前撰写下一条指令。

### 构建
- 🔧 chore: 版本号同步至 0.35.1。

---

## [0.35.0] - 2026-07-27

### 修复
- 🐛 fix(db): 索引管理器新建索引时报 MySQL Error 1091(`Can't DROP 'xxx_idx'; check that column/key exists`)。根因是 `generateBatchIndexDDL` 对所有 dirty 条目一律先生成 `DROP INDEX`,包括服务器上尚不存在的新索引;`IndexEdit` 新增 `isNew` 标记,新索引只发 `CREATE INDEX`,补 node --test 回归用例。

### 改进
- 🎨 style(home): 欢迎页全面重构 — 背景极光漂移 + 栅格遮罩 + 漂浮粒子;标题渐变流光与模糊入场;终端光标闪烁 kicker;标语打字机效果;资产指标数字滚动(easeOutCubic)+ 图标光晕呼吸;模块卡片 hover 光带扫过、图标旋转放大、箭头滑入;新手指引 / 最近使用按 `--i` 交错入场 + hover 平移。欢迎页样式全部收口到 `cyber.css` 的 `.welcome-*` / `.metric-card` / `.feature-card` 等全局组件类,走 token 并兼容深浅双主题与 prefers-reduced-motion。

### 构建
- 🔧 chore: 版本号同步至 0.35.0。

---

## [0.34.6] - 2026-07-24

### 修复
- 🐛 fix(db): 新建表选择 VARCHAR 但未配置长度时生成非法 SQL(MySQL Error 1064)。新建表对话框新增「长度/精度」列,支持 `255`、`10,2` 两种写法;VARCHAR/CHAR 缺省自动补 255,DECIMAL/NUMERIC 支持精度与小数位;非法 size 在前端直接拦截。
- 🐛 fix(db): 新建表 DDL 按方言生成 — PostgreSQL 使用双引号标识符,列/表注释拆为独立 `COMMENT ON` 语句;ClickHouse 可空列自动包装 `Nullable(T)`,补 `ENGINE = MergeTree()` 与 `ORDER BY`(主键列或 `tuple()`),并按方言提供类型与引擎下拉。DDL 生成统一收口到 `src/utils/ddlGenerator.ts` 的 `generateCreateTableDDL`(含 node --test 用例)。
- 🐛 fix(clickhouse): 表数据标签页无法行编辑。根因是 sidecar `ListColumns` 未查询 `is_in_primary_key`,列的 `key` 永远为空导致前端判定"无主键不可编辑";现把主键列标记为 `PRI`,前端据此放行 `ALTER TABLE ... UPDATE` mutation 批量保存。

### 国际化
- 🌐 i18n(redis): 右侧边栏 Dashboard / AI / Tools 标签接入 i18n(此前硬编码英文)。
- 🌐 i18n(redis): 补完 String / Hash / List / Set 编辑器与 RedisValueEditor 的汉化收尾 — 模板 `t()` 已全部接入,补 `StringEditor` 缺失的 `useI18n`(此前构建被它卡住)。

### 改进
- 🎨 style(home): 首页欢迎区统一优化 — 模块卡片改为紧凑行式(图标 + 标题 + 资产计数),最近工作改为列表行,按钮加 kbd 提示,标题走主渐变;欢迎页新增 `N` 快捷键新建连接(与按钮提示对应)。

### 构建
- 🔧 chore: 版本号同步至 0.34.6。

---

## [0.34.5] - 2026-07-23

### 修复
- 🐛 fix(multi-tab): 修复同一资产开多个标签页时第一个页面连接被断开、数据丢失的问题。根因是所有视图通过 `computed(() => route.params.id)` 跟踪全局路由,keep-alive 缓存的组件在切换 tab 时路由参数变化触发 watch 导致 `markStale()` 断开连接。修复方式:在组件 setup 时冻结路由参数,移除有害的 `watch(assetId)` / `watch(route.params.id)`。影响 RedisView、DbView(MySQL/PG/ClickHouse)、ElasticsearchView、DockerView、BrokerView、ExcelView 共 6 个视图。

### 构建
- 🔧 chore: 版本号同步至 0.34.5。

---

## [0.34.4] - 2026-07-22

### 修复
- 🐛 fix(redis): BigKey 扫描和内存分析空结果返回 `null` 导致前端崩溃 — Go sidecar `BigKeyScan` / `MemoryAnalysis` 的 nil slice 改为 `make([]T, 0)` 确保 JSON 序列化为 `[]`；前端 `invoke` 返回值增加 `?? []` 空值防御。
- 🐛 fix(redis): 内存分析 Go 循环变量 `a` 遮蔽方法接收者 `*RedisAdapter`，重命名为 `ag`。
- 🐛 fix(redis): 慢日志加载/重置失败仅 `console.error` 无用户反馈，改为组件内错误提示条。

### 国际化
- 🌐 i18n(redis): Redis 侧边栏（KeyBrowser）11 处硬编码文本全部接入中/英 i18n（Databases 标题、折叠/展开、搜索 placeholder、类型过滤、加载中、加载更多、空状态、删除、过期标记、keys 后缀）。
- 🌐 i18n(redis): Tools 面板 4 个 tab 标签（Pub/Sub / Slowlog / BigKey / Memory）接入 i18n。
- 🌐 i18n(redis): BigKey 扫描器全部界面文本接入 i18n（阈值标签、按钮、进度、表头、空状态）。
- 🌐 i18n(redis): 内存分析器全部界面文本接入 i18n（按钮、采样选项、表头、前缀、合计）。
- 🌐 i18n(redis): 慢日志查看器全部界面文本接入 i18n（Top N、刷新、表头、空状态、重置）。
- 🌐 i18n(redis): 修复 zh-CN `hashFieldRequired` 漏翻译（英文 → 中文）。

### 改进
- ⚡ perf(redis): 慢日志查看器新增自动刷新开关（10s 间隔）、loading 状态、重置前确认对话框、紧凑时间格式（MM-DD HH:mm:ss）、命令列 hover 显示完整命令。
- ⚡ perf(redis): BigKey 扫描中按钮显示 loading 旋转图标；内存分析中按钮显示 loading 状态。

### 构建
- 🔧 chore: 版本号同步至 0.34.4（package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md）。

---

## [0.34.3] - 2026-07-22

### 文档
- 📝 docs: AI 运维剧本引擎实施计划，版本号同步至 0.34.3。

---

## [0.34.2] - 2026-07-21

### 文档
- 📝 docs(spec): 新增「AI 运维剧本引擎」设计文档 `docs/superpowers/specs/2026-07-21-ai-playbook-engine-design.md` — 跨 SSH/DB/SFTP/Docker/本机/MCP 的多步自动化剧本:复用现有 AI runtime 三元组与确认门机制,AI 自然语言生成草稿(不直执 + 首跑保护),SQLite 三表(playbooks/playbook_runs/playbook_run_steps)持久化,结构化步骤回放;明确 YAGNI 剪枝(定时调度/并行 DAG/子剧本嵌套留 v2 接口)。

### 构建
- 🔧 chore: 版本号同步至 0.34.2(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.34.1] - 2026-07-21

### 样式
- 🎨 style(design-system): 面板/卡片/资产卡片/ZMODEM 传输条顶部高光改为液体流动灯带 — 青紫渐变(`--cyan` → `--purple`)左右流动并伴随轻微左右晃动,所有 `.cyber-panel` / `.cyber-card` / `.connection-card` / `.zmodem-transfer-bar` 统一生效;新增 `::after` 模糊光晕层增强霓虹感。

### 构建
- 🔧 chore: 版本号同步至 0.34.1(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.34.0] - 2026-07-21

### 新增
- ✨ feat(db): SQL 编辑器和表数据视图 WHERE 筛选条支持字段名模糊补全 — 解析 SQL 文本中的 FROM / JOIN / UPDATE / INSERT INTO 推断涉及表,结合已缓存列信息在 WHERE / AND / OR / ON / SET / BY / , / ( 等上下文后给出字段名建议;表浏览的 WHERE 输入条新增下拉模糊匹配当前表的列名。
- 🌐 i18n(db): WHERE 筛选列名快捷 chip 提示保持现有,无新增硬编码文案。
- ✅ test(utils): 新增 `extractFromTables` 单元测试,覆盖关键字提取、反引号、去重与顺序。

---

## [0.33.1] - 2026-07-21

### 修复
- 🐛 fix(ssh): 命令广播会话列表无名、命令未送达 — 后端 `ssh_get_sessions` 返回的 host/username 为空且无 title 字段,前端按 `sessionId/title` 取值全部 undefined,勾选集合坍缩成 1 个、广播写入全部静默失败;后端改为从会话配置返回真实 host/port/username,前端按 instanceId 反解资产名作为标题(同资产多 tab 加 #N 后缀),并过滤无 shell 通道的 exec-only 会话。
- 🐛 fix(ssh): 命令广播弹窗与通知文案硬编码英文,全部接入中/英 i18n,工具栏 tooltip 同步。

---

## [0.33.0] - 2026-07-20

### 新增
- ✨ feat(transfer): 全局传输任务条 TransferDock 支持拖动换位 — Pointer Events 手势(与 tab 拖出同一模式,规避 Windows `dragDropEnabled` 对 HTML5 DnD 的拦截),位置持久化到 localStorage,上半屏时展开面板自动翻转到 pill 下方,双击复位默认右下角;解决其遮挡 AI 助手发送按钮的问题。

### 修复
- 🐛 fix(sidecar): Redis SSL 开关实际仍走明文 — go-redis v9 仅在 `TLSConfig != nil` 时启用 TLS,原代码 `info.SSL` 为 true 反而赋 nil;改为 `&tls.Config{MinVersion: TLS1.2}`。
- 🐛 fix(sidecar): Excel/CSV 适配器互斥锁覆盖不全 — excelize.File 与 CSV 行集非 goroutine 安全,RPC 每请求一个 goroutine,Univer 自动保存并发写入会数据竞争甚至损坏文件;全部读写方法统一加锁。
- 🐛 fix(sidecar): Redis `Select` 无锁换 client,并发命令 use-after-close;加 `sync.RWMutex`。
- 🐛 fix(sidecar): Docker 容器日志 `bufio.Scanner` 64KB 行上限导致静默截断且不报错;上限提至 4MB 并上抛 `scanner.Err()`。
- 🐛 fix(sidecar): Docker/ES 全部调用无超时(`context.Background()`),daemon 挂死时 goroutine 只增不减;统一 30s `WithTimeout`(拉镜像等长操作 30 分钟),docker-over-SSH 补 `ResponseHeaderTimeout`。
- 🐛 fix(sidecar): 备份/Compose 子进程无超时、stderr 丢失(前端只见 `exit status 1`)、失败遗留半截文件;改 `CommandContext` + stderr 入错误信息 + 失败清理半成品。
- 🐛 fix(sidecar): RPC 单行超 10MB 直接杀死整个 sidecar 进程;上限提至 64MB,超限行消耗后回错误响应继续服务。
- 🐛 fix(sidecar): ES ScrollSearch 创建 2 分钟 scroll 上下文但从不 ClearScroll,高频使用耗尽 ES scroll 槽;响应返回前主动清理。
- 🐛 fix(sidecar): ClickHouse Ping 失败泄漏底层 conn;pool `Remove` 持锁关连接(网络 I/O)阻塞全部 Get,改为锁外 Close;Docker exec session 加 10 分钟空闲自动回收。
- 🐛 fix(ssh): `ssh exec` 输出与超时均无上限且全程持 session 锁 — AI/前端发 `yes` 类命令可致内存无限膨胀;输出 4MB 截断、超时 clamp 上限。
- 🐛 fix(sftp): `sftp_read`/`sftp_write` 整文件进内存经 IPC 传输且无大小限制;对齐 local 命令加上限,超限引导走 TransferManager 分块传输。
- 🐛 fix(alert): 告警 webhook reqwest 无超时且串行 await,一个挂死地址让整个 alert_check IPC 永久挂起;加 10s 超时并并发发送。
- 🐛 fix(sftp): TransferManager 任务表只增不减(慢性内存泄漏);终态任务滚动淘汰。浏览类 SFTP 操作(ls/stat/mkdir 等)复用缓存通道,不再每次完整 channel open + subsystem 协商。
- 🐛 fix(ssh): SSH 写入 unbounded channel 无背压,ZMODEM 大文件 + 慢网络下无限堆积;改 bounded channel 背压。端口转发移除时存量连接继续转发,现记录子任务 AbortHandle 一并 abort。
- 🐛 fix(sidecar-launcher): sidecar 崩溃后 tx 残留、后续调用永久失败只能重启应用;read_loop 加单行上限,崩溃后清空 tx 并支持惰性重连,消除 start 的 TOCTOU 竞态。
- 🐛 fix(mcp): stdio MCP 每次工具调用都 spawn + initialize + kill 子进程,且超时按行重置可被刷行绕过;按 server 缓存长驻 client,超时覆盖整个请求。
- 🐛 fix(ai): AI chat 每次请求重建 reqwest Client 丢连接池/TLS 复用;改共享实例。
- 🐛 fix(ssh): 持全局 sessions 锁内 await attempts 锁的锁内 await 反模式;hostkey 确认失败分支 pending 条目残留。均修正。
- 🐛 fix(layout): `<keep-alive>` 无 include/max,关闭标签页只移除 tab 记录,缓存组件永不卸载 — SSH 会话、xterm 实例、事件订阅、计时器全部泄漏;现 include 由打开 tab 驱动,关 tab 即真正 unmount 触发 `onBeforeUnmount` 清理,拖出独立窗口路径保留缓存不受影响。
- 🐛 fix(ssh): 终端 AI 输出缓冲 `dataBuffer` 无上限增长(清空函数无调用方);改 500 块环形缓冲,AI capture 读取逻辑同步适配。
- 🐛 fix(ssh): 命令广播弹窗背景为半透明 `--panel` 且无 backdrop-filter,终端内容透底导致文字几乎不可见;改用 `--panel-2` + blur(20px),阴影硬编码色改走 `--glow-soft` token。
- 🐛 fix(docker/db): Docker/Db 仪表盘在 keep-alive 失活后仍 30s 轮询;与 SshDashboard 统一抽 `usePolling` composable,失活暂停、激活恢复。
- 🐛 fix(db): DbView 表数据加载无竞态防护,快速翻页/排序时慢响应覆盖新状态;加 per-tab request token 只接受最新响应。

### 性能
- ⚡ perf(redis): KeyBrowser 模板内每次渲染对整个 key 列表重建 trie;改 per-db computed 缓存。
- ⚡ perf(transfer): SFTP 进度事件每发一次全量克隆任务 Map;改 reactive Map 原地变更,已完成任务保留最近 100 条滚动淘汰。
- ⚡ perf(ai): AI 会话 deep watch 流式期间每 token 全量深遍历 + 全量 JSON.stringify;改轻量 getter 跟踪;AiChat 滚动 watch 由全量 map+join 改为只跟踪末条消息长度。
- ⚡ perf(redis): RedisCli 输出数组无上限、大结果整 JSON 进 DOM;保留最近 200 行,单行超 4000 字符截断提示。

### 构建
- 🔧 chore: 版本号同步至 0.33.0(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.32.6] - 2026-07-20

### 修复
- 🐛 fix(layout): 修复标签页拖出独立窗口后白屏。
  - `src/lib/windowDetach.ts` 的 `buildDetachedUrl` 改为 `/?detach=1&...`,不再使用 `index.html?detach=1&...`。`createWebHistory` 对 `index.html` 路径不匹配任何路由,导致 CyberLayout 无法挂载、新窗口白屏。
  - `src/components/layout/CyberLayout.vue` 独立窗口初始化时 `await assetStore.fetchAssets()` 后再 `router.replace(detachedInfo.route)`。此前 fetchAssets 未等待,工作区组件(SshTerminal / DbView / DockerView 等)onMounted 时资产列表为空,会误判"资产已删除"把路由推回 `/`,造成工作区空白。

### 构建
- 🔧 chore: 版本号同步至 0.32.6(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.32.5] - 2026-07-20

### 文档
- 📝 docs: `AGENTS.md` 整体优化对齐 v0.32 实际代码 — 新增全文快速导航;目录结构由「目标形态」重写为实际快照(`src-tauri/src/commands/` 全量 command、`sidecar/adapters/` 含 broker/docker/excel/backup、`tests/` 等);第 5 节关键命令由过期占位(`cd src`、`hexhub-sidecar`)更正为仓库根实际 npm 脚本(`sidecar:build` / `tauri:dev` / `test:utils` 等)。
- 📝 docs: `AGENTS.md` 第 10 节踩坑详情正式替换为 `docs/踩坑记录.md` 主题索引 + 维护规则,补齐 0.32.4 记录但未实际落地的编辑;修正 §7.3 指向旧 10.7 节的悬空引用。
- 📝 docs: `AGENTS.md` 6.5 / 6.5.1 版本同步清单由「五处」更正为「七处」(补 `Cargo.lock` 与 `README.md`),发布检查清单同步更正。
- 📝 docs: `AGENTS.md` 4.3 Sidecar 依赖表去除 SQLite / SQL Server 的「go.mod 待补」过期标注(均已在 `go.mod`),补 Docker 依赖行;7.1 测试策略表对齐实际脚本;第 11 节由「MVP 任务优先级」更新为当前路线图(P0 已交付,P1+ 持续迭代)。

### 构建
- 🔧 chore: 版本号同步至 0.32.5(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.32.4] - 2026-07-20

### 文档
- 📝 docs: `AGENTS.md` 第 10 节「已知坑与注意事项」整体迁移至 `docs/踩坑记录.md`,原位置改为主题索引 + 维护规则,按需查阅。
- 📝 docs: `README.md` 纳入版本变更强制同步范围;`AGENTS.md` 6.5 / 6.5.1 的版本同步清单由「五处」更正为「七处」(补上此前遗漏的 `Cargo.lock` 与新增的 `README.md`)。
- 📝 docs: `README.md` 功能矩阵、当前版本区与路线图同步至 v0.32.4 实际状态(PostgreSQL / SQLite / SQL Server、SSH 端口转发与分屏、SFTP 拖拽传输与断点续传、Docker Compose、数据库备份恢复、审计与告警等)。

### 构建
- 🔧 chore: 版本号同步至 0.32.4(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md / README.md)。

---

## [0.32.3] - 2026-07-20

### 修复
- 🐛 fix(app): 标签页拖拽后的 click 屏蔽由定时器改为事件驱动的一次性 capture 吞听器 — 定时器方案在 click 派发被事件循环延迟时会提前失效(偶发拖拽结束后误切换 activeTab);现于 window capture 阶段吞掉拖拽紧随的那次 click,并以 `pointerdown` once 监听兜底撤掉,时序确定无误伤(`CyberLayout.vue`)。

---

## [0.32.2] - 2026-07-20

### 修复
- 🐛 fix(app): Windows 上标签页无法拖出为独立窗口 — 根因是 `tauri.conf.json` 的 `dragDropEnabled: true`(SFTP / Excel 拖文件进窗依赖系统级拖放)在 Windows 上会拦截 HTML5 drag-and-drop(Tauri 官方文档明确说明),导致 v0.32.0 引入的 HTML5 DnD 拖拽手势在用户机器上完全失效。改用 Pointer Events + `setPointerCapture` 自实现拖拽手势,与系统拖放互不干扰,文件拖入与标签页拖出兼得;武装判定从「拖离 tab 条下方 64px」改为「离开 tab 条四向 24px 死区」,并支持 Esc 取消(`CyberLayout.vue`)。
- 🐛 fix(app): 拖拽可发现性 — 拖拽全程显示跟随光标的提示芯片(未武装态低调文案「拖离标签栏,以在独立窗口打开」,武装态高亮「松开以在独立窗口打开」),源 tab 拖动中轻微透明;`pointer capture` 会把拖拽后的 click 派发到源 tab,已做一次性屏蔽。

### 样式
- 🎨 style(design-system): `cyber.css` 的 `.tab-detach-hint` 拆分为基础态 + `.armed` 高亮态,新增 `body.tab-dragging` 拖拽中进行态(禁止文本选中 + 抓手光标);`.tab` 增加 `user-select: none` 与 `.dragging` 拖动中透明态。

---

## [0.32.1] - 2026-07-17

### 修复
- 🐛 fix(ssh): 危险命令确认框显示残缺命令 — 拦截逻辑只缓冲本地按下的可打印单字符,Tab 补全 / 方向键历史召回等 shell 本地回显不经过 `onData`,确认框只能显示残缺的按键序列(如 `rm -rf e`),而真正执行的是补全后的完整命令。改为回车时读取 xterm buffer 光标所在完整逻辑行(合并软换行)、剥离 shell 提示符后作为第一检测源,本地按键缓冲兜底,双源任一命中即拦截并展示完整命令(`TerminalPane.readCursorLine` + `SplitTerminal.readActiveCursorLine` + `commandGuard.stripShellPrompt`)。
- 🐛 fix(ssh): 粘贴 / IME 的多字符输入原先完全不计入命令缓冲,整块粘贴的危险命令回车会绕过检测;现剥离 bracketed-paste 标记与 ANSI 转义序列后计入缓冲。顺带修复:取消确认后再次回车仍能通过终端回显兜底拦截(原先清空缓冲后直接放行)。

### 测试
- ✅ test(utils): 新增 `tests/utils/commandGuard.test.mjs`,覆盖提示符剥离(bash / zsh / fish / PowerShell / oh-my-zsh)与补全、粘贴场景的风险检测。

---

## [0.32.0] - 2026-07-17

### 新功能
- ✨ feat(app): 标签页拖出为独立窗口 — 拖拽 tab 脱离主窗口生成精简外壳的 WebviewWindow(无 sidebar / tab 条 / 状态栏),支持送回主窗口;URL query 传递还原工作区所需的最小信息,`src/lib/windowDetach.ts` + `CyberLayout.vue` + `src-tauri/capabilities/default.json`(`detach-*` 窗口权限)。
- ✨ feat(transfer): 全局传输任务条 TransferDock — 右下角悬浮 pill 聚合所有 SFTP 上传/下载任务,展开面板支持限速、取消、清理已完成;取代原 SFTP 面板内嵌传输队列(`src/stores/transfer.ts` + `src/components/transfer/TransferDock.vue`,删除 `SftpTransferQueue.vue`)。

### 样式
- 🎨 style(design-system): `cyber.css` 新增 `.transfer-dock-*` / `.detached-*` / `.tab-detach-hint` 组件类,并集中补充告警 / 审计页样式。

### 文档
- 📝 docs: 新增《移动端适配方案》(iOS / Android / 小屏浏览器分阶段路线,评审中未实施)。

### 构建
- 🔧 chore: 版本号同步至 0.32.0(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md)。

---

## [0.31.2] - 2026-07-17

### 修复
- 🐛 fix(ssh): 修复 SSH 连接报 `u.value?.writeln is not a function`:`SshTerminal.vue` 在 v0.31.0 引入分屏时把 import 换成了 `SplitTerminal`,模板却仍写 `<TerminalPane>`,组件解析失败导致 ref 落到原生 DOM 元素上;模板改用 `<SplitTerminal>` 并接上 `@panes-change`(`src/components/ssh/SshTerminal.vue`)。
- 🐛 fix(ssh): `SplitTerminal.vue` 补充分屏布局样式(`.ssh-split-container/.ssh-split-pane/.ssh-split-divider`),保证终端 flex 高度链完整。
- 🐛 fix(app): 隐藏/后台标签页中 `requestAnimationFrame` 永不触发导致应用一直停在启动页,`App.vue` 在 `document.visibilityState === 'hidden'` 时退化为 `setTimeout` 翻转 `appReady`。
- 🐛 fix(dashboard): `SshDashboard.vue` 纯浏览器预览缺少 Tauri `invoke` 时按只读空态降级,不再显示原始 `TypeError` 红横幅(对齐 AGENTS.md 7.3 的降级约定)。

### 构建
- 🔧 chore: 版本号同步至 0.31.2(package.json / Cargo.toml / Cargo.lock / tauri.conf.json / CHANGELOG.md / AGENTS.md)。

---

## [0.31.1] - 2026-07-16

### 修复
- 🐛 fix(rust): 修复 `tauri_plugin_updater::init()` 在 2.10.x 中不存在导致的编译错误,改用 `Builder::new().build()`。
- 🐛 fix(ssh): 适配 russh 0.62.2 API 变更:
  - `Channel::make_writer()` / `Channel::wait()` 需要可变绑定。
  - `Handle::channel_open_direct_tcpip` 端口参数改为 `u32`。
  - `Handle::channel_forward_listen` 已重命名为 `Handle::tcpip_forward`。
  - `Handle` 改为 `Arc<Handle>` 存储以匹配新的类型要求。
- 🐛 fix(ssh): `SshHandler::new` 补全 `remote_forwards` 参数,修复远程端口转发绑定缺失。
- 🐛 fix(ssh): 远程端口转发申请失败时不再残留映射;移除远程转发时主动调用 `cancel_tcpip_forward`。

### 样式
- 🎨 style(ui): 统一页面视觉风格,修正与 Cyber Command Center 设计系统不一致的组件/颜色/间距。

---

## [0.31.0] - 2026-07-16

### 新功能
- ✨ feat(db): 数据库备份/恢复,sidecar 封装 mysqldump/pg_dump,支持备份列表管理(`sidecar/adapters/backup.go` + `backup_handlers.go`)。
- ✨ feat(docker): Docker Compose 支持,up/down/ps/logs/config/list 6 个 RPC(`sidecar/adapters/docker_compose.go`)。
- ✨ feat(ssh): SSH 终端分屏,支持水平/垂直分屏,多 pane 共享同一 SSH 会话(`src/components/ssh/SplitTerminal.vue`)。
- ✨ feat(audit): 操作历史与审计日志,SQLite 持久化,按类别/时间查询和统计(`src-tauri/src/commands/audit.rs` + `src/services/audit.ts`)。
- ✨ feat(alert): 告警系统,阈值规则 + Webhook 通知 + 冷却期(`src-tauri/src/commands/alert.rs` + `src/services/alert.ts`)。
- ✨ feat(ai): AI 成本统计,追踪每次对话 token 用量和估算花费,持久化到 localStorage。
- ✨ feat(ai): AI 截图识别,支持粘贴图片发送给 AI 解读,OpenAI 兼容多模态格式。

### 构建
- 🔧 chore: 版本号同步至 0.31.0(package.json / Cargo.toml / tauri.conf.json / CHANGELOG.md / AGENTS.md)。

---

## [0.30.1] - 2026-07-16

### 修复
- 🐛 fix(types): `src/services/ai.ts` 第 223 行 `tc: any` 替换为已有的 `RawToolCall` 接口,消除 strict 模式下的 `any` 类型。
- 🐛 fix(types): `src/services/db.ts` 中 ClickHouse 的 `clickhouseGetPartitions`/`clickhouseGetMergeTreeInfo`/`clickhouseGetTableStats` 返回值从 `unknown`/`unknown[]` 替换为具体的 `ClickHousePartition[]`/`ClickHouseMergeTreeInfo`/`ClickHouseTableStats`;ES 的 `esCreateIndex`/`esDeleteIndex` 替换为 `EsAcknowledgedResult`,`esIndexDocument`/`esUpdateDocument`/`esDeleteDocument` 替换为 `EsDocumentOperationResult`。新增类型定义在 `src/types/db.ts`。

### 重构
- 🔧 refactor(sftp): `src/services/sftp.ts` 所有裸 `invoke()` 调用统一用 `wrapInvokeError` 包装,catch 中生成 `[SFTP] <operation> 失败: <message>` 格式的用户可读错误。
- 🔧 refactor(docker): `src/services/docker.ts` 同样添加 `wrapInvokeError` 统一错误包装,保留 DEV 环境下的 mock 数据降级逻辑。

### 测试
- ✅ test: 新增 vitest + @vue/test-utils + jsdom 测试基础设施,配置 `vite.config.ts` 的 `test` 选项。
- ✅ test: 新增 `tests/utils/crypto.test.mjs`(9 项)、`tests/utils/ddlGenerator.test.mjs`(18 项)、`tests/utils/sqlHistory.test.mjs`(8 项)单元测试,覆盖加解密往返、DDL 生成、SQL 历史管理等核心工具函数。

---

## [0.30.0] - 2026-07-16

### 新功能
- ✨ feat(sidecar): 新增 SQLite 适配器(`sidecar/adapters/sqlite.go` + `sqlite_handlers.go`),使用 `modernc.org/sqlite` 纯 Go 驱动,实现完整 CRUD。
- ✨ feat(sidecar): 新增 SQL Server (MSSQL) 适配器(`sidecar/adapters/mssql.go` + `mssql_handlers.go`),使用 `microsoft/go-mssqldb` 驱动。
- ✨ feat(sidecar): 新增 Redis Pub/Sub 支持(`sidecar/adapters/redis_pubsub_handlers.go`),subscribe 阻塞收集消息、unsubscribe 取消订阅。
- ✨ feat(ssh): 新增 SSH 端口转发(本地/远程),支持 `add_local_forward`、`add_remote_forward`、`remove_forward`、`list_forwards` 命令。
- ✨ feat(ssh): 新增 SSH Config 文件导入,解析 `~/.ssh/config` 返回主机列表(Host/HostName/Port/User/IdentityFile/ProxyJump)。
- ✨ feat(ssh): 新增 SSH 危险命令拦截,`commandGuard.ts` 扩展 mkfs/chmod 777/iptables/fork 炸弹等规则,终端回车时检查并弹出确认弹窗。
- ✨ feat(updater): 新增应用自动更新服务(`src/services/updater.ts`),集成 `tauri-plugin-updater`,SettingsView 增加检查更新入口。

### 修复
- 🐛 fix(ui): `DbDashboard.vue` 对 clickhouse/elasticsearch/kafka/nsq 不再抛硬错误,改为由模板 v-else 分支显示友好提示。
- 🐛 fix(types): `src/types/asset.ts` 的 `DatabaseType` 已包含 `'sqlite'` 但 `src/types/db.ts` 不含,导致用户可创建 SQLite 资产但工作区无法处理。已同步添加 `'sqlite'` 和 `'mssql'`。
- 🐛 fix(docker): `sidecar/adapters/docker.go` 移除 `TODO(#33)`,不再将 `context.Context` 存储在 struct 字段中,改为方法内创建。
- 🐛 fix(docs): `AGENTS.md` 第 4.3 节技术栈表同步实际实现状态,SQLite/MSSQL 标注新增,Oracle/MongoDB/国产库标注规划中。

---

## [0.29.8] - 2026-07-16

### 修复
- 🐛 fix(ci): GitHub Actions Linux ARM64 构建因 `ports.ubuntu.com` 间歇性网络超时导致 `apt-get install` 失败(exit code 100)。为 `release.yml` 和 `linux-compat.yml` 的 apt 安装步骤增加 `Acquire::Retries` 配置和 3 次重试循环,并在完成后校验关键包 `libwebkit2gtk-4.1-dev` 是否真正安装成功。

---

## [0.29.7] - 2026-07-16

### 新功能
- ✨ feat(excel): 选中列去重到新 Sheet 时,末列自动添加「重复次数」列,标明每行在源数据中的出现次数。
- ✨ feat(csv): CSV 文件也支持选中列去重功能,去重结果(含「重复次数」列)直接覆盖当前 Sheet。

### 修复
- 🐛 fix(i18n): `copyTabTitle` 国际化 key 错误地放在 `ai` 命名空间下,导致标签页右键菜单在中文模式下显示英文回退。已移至 `layout` 命名空间。
- 🐛 fix(sidecar): `REQUIRED_METHODS` 启动握手校验遗漏了 `file.excel.*` 系列方法。旧版或缺失 Excel handler 的 sidecar 能通过校验,用户点保存时才报 `RPC error -32601: Method not found`。已补齐 5 个核心 Excel 方法。
- 🐛 fix(release): `Cargo.lock` 中 starhub 版本停留在 0.29.4,与 `Cargo.toml` 的 0.29.6 不同步,导致 `cargo test --locked` 在三平台 CI 全部失败。

### 构建
- 🔧 chore: `.gitignore` 新增 `src-tauri/target-*/` 过滤交叉编译产物。

---

## [0.29.6] - 2026-07-16

### 改进
- ✨ feat(ui): 统一右键菜单实现：`SftpPanel`、`TerminalPane` 接入公共 `ContextMenu`，支持边界翻转、键盘导航与 focus trap。
- ✨ feat(ui): SFTP 上传下拉菜单也收敛到公共 `ContextMenu`。

### 国际化
- 🌐 i18n: 移除 `ElasticsearchView` 与 `Redis KeyBrowser` 菜单中的 Emoji，全部文案走 i18n。
- 🌐 i18n: `CyberLayout` 标签页右键菜单、`AssetTree` 分组菜单、`ColumnListDialog`、`DbView` 补齐 i18n key，移除硬编码中文 fallback。

### 样式
- 🎨 style(design-system): 公共 `ContextMenu` 增加 `max-height`、滚动条样式与选区自动滚入视野。

### 测试
- ✅ test(frontend): `vue-tsc --noEmit` 与 `npm run build` 通过。

---

## [0.29.5] - 2026-07-16

### 修复
- 🐛 fix(ui): 修复 Vuetify 主题切换弃用警告，改为 `theme.change()`。
- 🐛 fix(i18n): 补充 `common.new` 与 `user.menu` 等多语言键，消除运行时 fallback 警告。
- 🐛 fix(ui): 浅色主题状态色加深，提升可访问性对比度。

### 改进
- ⚡ perf(ui): 优化标题栏窗口控制按钮点击区域，减少误触。
- ✨ feat(ui): 侧边栏分组空状态增加“添加连接”引导。
- ✨ feat(ui): 标签页标题长名称截断优化，关闭按钮始终可见。
- ✨ feat(ui): 快速启动栏时间戳可读性提升，增加 tooltip 与折叠。
- ✨ feat(ui): AI 工作区输入引导与执行计划卡固定，避免长对话后操作区被顶走。
- ✨ feat(ui): 状态栏响应式折叠，增加连接细分 tooltip。
- ✨ feat(ui): ProductIcon 增加品牌图标兜底与可访问性标签。

### 样式
- 🎨 style(design-system): 右键菜单增强视觉层级、快捷键提示、危险操作分隔、子菜单 hover 反馈与动画。
- 🎨 style(design-system): 启动动画点号节奏调整为 3 步，减少跳格感。

### 测试
- ✅ test(ui): 1280×800 真实浏览器回归验证右键菜单、空状态、标签页、AI 工作区与控制台无新增 error。

---

## [0.29.4] - 2026-07-15

### 修复
- 🐛 fix(ssh): SSH 交互终端在建链时使用 xterm 的真实行列数申请远端 PTY，并通过终端读循环可靠处理后续尺寸变化，避免长命令按错误列数重绘后覆盖提示符。

### 测试
- ✅ test(ssh): Rust 单元测试覆盖 PTY 尺寸默认值、前端传值与异常范围收敛，42 项测试全部通过。
- ✅ test(frontend): `npm run build` 通过（`vue-tsc --noEmit` + Vite production build）。

---

## [0.29.3] - 2026-07-14

### 修复
- 🐛 fix(release): 精确同步 StarHub 自身的 Cargo lockfile 版本,恢复 `serde_derive_internals` 的真实锁定版本,避免发布任务因不存在的依赖版本中止。

---

## [0.29.2] - 2026-07-14

### 修复
- 🐛 fix(release): GitHub Release 发布步骤递归匹配 artifact 内的 `deb/`、`rpm/`、`appimage/` 与 `nsis/` 子目录,确保七个跨平台安装包都能自动上传。

---

## [0.29.1] - 2026-07-14

### 修复
- 🐛 fix(release): Windows 与 Linux Release 任务在运行 Rust 测试前先生成目标平台 Sidecar,避免 Tauri build script 因缺少 `starhub-sidecar-<target-triple>` 提前失败。

---

## [0.29.0] - 2026-07-14

### 功能
- ✨ feat(ai): SSH 工作区 AI 与独立 AI Agent 新增 `sftp_list`、`sftp_stat`、`sftp_upload`、`sftp_download` 工具;上传读取本机文件、下载写入本机目录均逐次确认,并复用现有断点传输队列等待任务完成后再释放连接。
- ✨ feat(ai): AI 侧边栏最近对话从 3 条扩展为最多 10 条并始终可见,支持恢复会话、单条删除确认及同步清理本地历史。
- ✨ feat(mcp): AI 设置新增 stdio、Streamable HTTP 与兼容 SSE 三类 MCP Server,完成 initialize 生命周期、分页 tools/list、tools/call、Streamable HTTP 向旧 SSE 回退与动态 Function Calling 注册。
- ✨ feat(ai): 发送区新增提问引导,按 Agent、`#` 工作区、目标/限制/验收三步组织需求,并提供排障、安全变更、SFTP 与 MCP 快捷模板。

### 安全
- 🔐 security(mcp): MCP 环境变量与 HTTP Header 值仅保存到系统 Keyring;外部工具每次调用都进入人工确认区,旧 SSE endpoint 限制为配置 URL 同源。
- 🔐 security(sftp): AI SFTP 单次最多处理 20 个显式路径,本机上传与下载写入禁止绕过确认;SSH 断开时同步释放 TransferManager 持有的 SFTP 通道。

### 样式
- 🎨 style(design-system): 新增 `.ai-mcp-*` MCP 设置卡、`.ai-composer-guide*` 提问引导和 `.ai-recent-delete` 最近对话删除交互类。

### 测试
- ✅ test(mcp): Rust 测试覆盖 JSON-RPC id / error 解析、MCP 配置反序列化及真实 stdio Server 的工具发现与调用。
- ✅ test(ui): 应用内 Browser 在 1280×800 验证最近对话常驻/删除取消、MCP 三类传输配置卡、发送引导展开与模板填入,console 无新增 error。
- ✅ test(frontend): `npm run build` 通过（`vue-tsc --noEmit` + Vite production build）,Rust fmt、check 与测试通过。

### 构建
- 🔧 chore(release): 新增 tag 触发的多平台 Release 流水线,构建 Windows x86_64 NSIS EXE 与 Linux x86_64/ARM64 DEB、RPM、AppImage,校验后统一上传 GitHub Release。

---

## [0.28.10] - 2026-07-14

### 修复
- 🐛 fix(ai): AI 工作区在页面 / 标签切换时保存并恢复消息滚动位置;停留在底部的会话继续跟随新消息,正在回看历史时保持原阅读位置。
- 🐛 fix(ssh): 全局 AI 的 SSH 直连改为 exec-only 会话,不再为一次性命令额外申请 PTY、启动远端登录 shell 或运行 shell 初始化脚本,避免与随后手动打开的 SSH 终端争用服务器资源。

### 可观测性
- 🔧 chore(ssh): SSH 建链日志增加认证耗时、总耗时和交互 / exec-only 模式,便于继续区分网络认证慢与远端 shell 启动慢。

### 测试
- ✅ test(ai): 新增滚动锚点单元测试,覆盖页面切换后的历史位置恢复、贴底跟随和内容缩短时的边界裁剪。

---

## [0.28.9] - 2026-07-14

### 修复
- 🐛 fix(ai): Planner 注入有界多轮历史并在重试/重新规划时去掉重复当前请求;顺序 Executor 继承已完成步骤的结论,避免跨轮追问和同一计划后续步骤丢失上下文。
- 🐛 fix(ai): `runAgent` 在追加流式 assistant 占位前复制请求消息快照,不再把空 assistant 消息发送给 OpenAI 兼容接口。

### 功能
- ✨ feat(ai): `#SSH` / `#DB` / `#Docker` / `#Excel` / `#LOCAL` 改为当前对话内可见、可清除的粘性上下文;模块引用在绑定时固化为当时的具体资产,不会因新增资产静默扩大范围,新对话和应用重启撤销工具绑定。
- ✨ feat(ai): 最近 30 个正式 AI 会话各保存最多 60 条、120000 字符的用户/助手文本,工具参数与工具输出不落盘;最近对话入口可按原 instanceId 重新打开恢复后的会话。

### 测试
- ✅ test(ai): 新增 Node 内置测试覆盖 Planner 多轮上下文、上下文裁剪、流式快照、持久化脱敏、顺序步骤结果传递与粘性 `#` 资产边界。

---

## [0.28.8] - 2026-07-14

### 修复
- 🐛 fix(ci): RPM 审计不再因 Ubuntu `rpm2cpio` 在完整输出 payload 后返回非零状态而误判失败;仍保留告警,并继续强制校验 `cpio` 解包、可执行权限、静态 Sidecar、版本、架构和依赖元数据。

---

## [0.28.7] - 2026-07-14

### 修复
- 🐛 fix(ai): 连接工作区 AI 助手把当前待确认操作固定到输入区上方,不再要求用户回翻历史工具卡;StarHub AI 的当前执行计划改为排在消息流末端,长对话后规划选项仍在最新内容附近可直接操作。
- 🐛 fix(linux): 外部文件打开在 `xdg-open` 缺失时回退到 `gio open`;Linux 密钥存储优先使用持久化 Secret Service,无桌面密钥环时降级到内核 Keyutils。
- 🐛 fix(browser): Vite 真实布局回归使用页面生命周期内的内存资产 CRUD,新建测试连接不再因缺少 Tauri IPC 进入全局错误页。

### 构建
- 🔧 chore(linux): Linux CI 固定 Ubuntu 22.04 最低构建基线,以原生 x86_64 / ARM64 runner 同时生成 AppImage、DEB 与 RPM,并校验包架构、sidecar 静态链接和执行权限、DEB/RPM 依赖元数据及主程序动态库缺口。
- 🔧 chore(sidecar): 跨架构构建不再错误执行目标平台二进制,Unix 输出与 Tauri 三元组副本统一补可执行权限;Go sidecar 继续以静态 ELF 随三类 Linux 包分发。
- 🔧 chore(network): Rust HTTP 客户端切换到 rustls,移除 Linux 运行时对系统 OpenSSL 动态库的额外依赖。
- 🔧 chore(ci): 新增 Linux 包审计脚本与 GitHub Actions 双架构兼容流水线。

### 测试
- ✅ test(linux): WSL Ubuntu 22.04 原生 Rust 37 项测试全部通过,覆盖 `xdg-open` → `gio open` 回退与现有 SSH/SFTP/Keyring 回归。
- ✅ test(package): Ubuntu 22.04 x86_64 实际生成 AppImage、DEB、RPM;AppImage 关键 GUI 库从包内解析,DEB/RPM 版本、架构、依赖元数据及静态 Sidecar 均已核对。
- ✅ test(ui): 应用内 Browser 在 1280×800 与 2048×1214 长对话场景验证 SSH AI 操作坞及 StarHub AI 规划选项;批准/拒绝/选项交互正常,console 无新增 error。
- ✅ test(frontend): `npm run build` 通过（`vue-tsc --noEmit` + Vite production build）,Rust fmt 与 Clippy 通过。

---

## [0.28.6] - 2026-07-14

### 修复
- 🐛 fix(ssh): SSH 终端底部安全区改为施加在 xterm 根元素上，使 FitAddon 在计算可用行数时真正扣除 32px；移除无效的终端外边距及 viewport/screen 巨大 padding，解决连续输出后提示符紧贴底部边框的问题。

### 样式
- 🎨 style(design-system): 新增 `.terminal-container-bottom-safe` 可选终端安全区类，SSH 启用后终端外壳继续填满工作区，底部文字保持一个间距节奏单位。

### 测试
- ✅ test(ui): 应用内 Browser 在 1280×800 浅色主题下通过 `mockLines=64` 复现并回归，提示符到底部边框距离由 6.4px 增至 33.5px；14px/15px 字号切换均保持安全区，console 无新增 error。
- ✅ test(frontend): `npm run build` 通过（`vue-tsc --noEmit` + Vite production build）。

---

## [0.28.5] - 2026-07-14

### 修复
- 🐛 fix(docker): Docker 日志页面「Refresh」和「1000 lines」按钮字体溢出--`.action-btn-sm` 固定 22px 宽度不适合带文字的按钮,在 `.logs-toolbar` 作用域内覆写为 `width: auto`。

---

## [0.28.4] - 2026-07-14

### 修复
- 🐛 fix(layout): Linux/Wayland 窗口拖拽兜底——在 `data-tauri-drag-region` 基础上,新增 `mousedown` 监听主动调用 `startDragging()`,修复某些 Wayland 合成器(如旧版 Mutter)上 `data-tauri-drag-region` 不生效导致窗口无法拖动的问题。仅 Linux 生效,Windows/macOS 不受影响。
- 🐛 fix(layout): `onMounted` 中补充 `isMac` 平台检测(原 `isMac` 声明后从未赋值,导致快捷键修饰键在 macOS 上始终显示 Ctrl)。

---

## [0.28.3] - 2026-07-13

### 修复
- 🐛 fix(ssh): 私钥导入前增加 `sanitize_key` 预处理,自动剥离 UTF-8 BOM 并将 CRLF 统一为 LF,修复 Windows Notepad 等编辑器保存的私钥文件因编码问题导致 `[KEY_PARSE] character encoding invalid` 的报错。
- 🎨 fix(ssh): 私钥文件选择对话框精简 `accept` 属性,移除 `text/plain` 等 MIME 类型和裸文件名匹配,改为仅 `.pem,.key,.ppk` 扩展名,加快 Windows 通用文件对话框冷启动。

---

## [0.28.2] - 2026-07-13

### 修复
- 🐛 fix(layout): 自定义标题栏添加 `data-tauri-drag-region` 属性，修复 Linux (WebKit2GTK) 窗口无法拖动的问题；Windows 端 `-webkit-app-region: drag` 保留兼容。

---

## [0.28.1] - 2026-07-13

### 修复
- 🐛 fix(db): MySQL 表格右键动作读取完整 Univer Shift 行选区；复制 INSERT 生成覆盖所有选中行的多值语句，删除按全部选中行主键组合一次批量 DELETE 并显示实际行数与完整审计详情。

### 测试
- ✅ test(db): 覆盖 Univer 表头偏移、反向 Shift 选区、越界裁剪与行下标去重；严格 TypeScript 检查与生产构建验证批量复制/删除事件契约。

---

## [0.28.0] - 2026-07-13

### 新增
- ✨ feat(sftp): SSH 连接新增 SFTP 启动策略：默认自动诊断并在标准 subsystem 异常时探测常见 `sftp-server` 可执行路径后受控降级，同时提供“仅标准 subsystem”和“指定远端程序”模式。
- ✨ feat(sftp): 自定义启动模式支持配置远端 Unix 绝对路径；客户端对路径做长度、控制字符和绝对路径校验，并使用 POSIX 安全引用执行，避免把配置值拼成任意 shell 命令。

### 修复
- 🐛 fix(sftp): 建链阶段读取 SSH channel request 的真实 `Success/Failure`，持续收集远端 stderr、exit status、exit signal 和提前关闭状态，不再把 `/usr/lib/openssh/sftp-server` 不存在等服务端错误误报成协议初始化 Timeout。
- 🐛 fix(sftp): SFTP 建链错误在工作区和通知详情中完整展示；自动诊断或直接执行降级失败时，同时返回标准 subsystem、探测与降级三段原始诊断。

### 样式
- 🎨 style(sftp): 完整诊断使用可换行滚动的等宽错误区；SSH 连接弹窗增加高内容量滚动链，避免自定义 SFTP 路径字段把标题顶出视口。

### 测试
- ✅ test(sftp): 新增远端 stderr/exit status 保留、路径安全校验、POSIX 引用和自动探测命令回归；Rust 全量测试、Clippy、前端生产构建及 1280×800/800×600 真实浏览器回归通过。

---

## [0.27.0] - 2026-07-13

### 新增
- ✨ feat(docker): Docker Exec 改为可持续读写、支持窗口尺寸同步的交互式 TTY 会话，进入容器内可用的 `bash` / `ash` / `sh`，保留原生提示符、命令历史、Tab 补全、Ctrl 组合键与交互程序体验；一次性 Exec 继续供 AI 工具调用。

### 样式
- 🎨 style(asset-tree): 数据库与消息产品类型徽章统一为 64px 宽度，消除 `MYSQL`、`ES`、`REDIS`、`CLICKHOUSE` 等标签长度不同造成的资产名称错位。
- 🎨 style(ssh): 自定义快捷命令弹窗改用设计系统 token 与集中式组件类，修复浅色主题下标题、说明、只读默认命令和输入框文字过淡的问题。

### 测试
- ✅ test(docker): 新增 TTY 输入输出、长轮询停止唤醒与终端尺寸归一化测试。

### 构建
- 🔧 chore(release): Windows release 打包通过，生成 v0.27.0 主程序、NSIS 安装 EXE 与 MSI 安装包。

---

## [0.26.4] - 2026-07-13

### 修复
- 🐛 fix(ssh): OpenSSH 私钥内部 comment 按 RFC 4251 保留任意字节，不再因 Windows 工具生成的非 UTF-8 注释触发 `[KEY_PARSE] character encoding invalid`；同时兼容 UTF-8 BOM 与带 BOM 的 UTF-16 私钥文件，并在导入时拒绝误选的公钥或未知格式。

### 性能
- ⚡ perf(ssh): Select Key 改用 Tauri 原生文件对话框，首次直接打开 `~/.ssh`、同一会话复用上次目录，并通过受限异步命令读取不超过 2MB 的私钥；浏览器预览继续保留隐藏 file input 降级路径。

### 依赖
- ⬆️ upgrade(ssh): `russh` 升级到 0.62.2，使用 `ring` 加密后端并接入支持二进制 OpenSSH comment 的新版 key 实现。

### 测试
- ✅ test(ssh): 私钥回归覆盖非 UTF-8 OpenSSH comment、UTF-8 BOM、UTF-16 LE 和误选公钥；前端类型检查与生产构建通过。
- ✅ test(ui): 应用内 Browser 以 1280×800 回归 SSH 私钥认证切换、按钮文案、文件 input 降级属性、弹窗关闭/重开和 console，布局无横向溢出且无新增 error。

---

## [0.26.3] - 2026-07-13

### 新增
- ✨ feat(sftp): SSH 连接配置新增 SFTP 超时，默认 30 秒、可配置 5–300 秒；通道打开、协议初始化及后续请求统一使用该值。

### 修复
- 🐛 fix(ssh): SSH 连接清理改为按尝试代次失效，失败后在同一窗口修正私钥或连接参数即可立即重试，不再被上一次的取消标记持续拦截；旧连接的异步清理也不会误删新连接通道。
- 🐛 fix(ssh): 编辑连接完整回填认证方式、MFA 和 SFTP 超时，字段变化后立即清除已经失效的测试失败提示，重新打开弹窗时强制使用全新表单状态。

### 性能
- ⚡ perf(startup): Tauri 原生窗口预设深色背景，HTML 与 Vue 路由加载阶段共用轻量启动画面；主题 CSS 提前加载，Google Fonts 改为非阻塞加载，消除启动阶段的长时间白屏。

### 样式
- 🎨 style(design-system): 新增 `.cyber-number-input` 与 `.app-startup-*`，分别统一紧凑数字输入和启动状态页视觉。

### 测试
- ✅ test(ssh): 新增同一会话连接重试代次与 SFTP 超时默认值/边界回归测试；Rust 全量测试、Clippy、前端类型检查和生产构建通过。
- ✅ test(ui): 应用内 Browser 以 1280×800 回归启动画面与 SSH 编辑表单，验证默认/自定义 SFTP 超时、弹窗重开状态和 console。

---

## [0.26.2] - 2026-07-13

### 修复
- 🐛 fix(docker): Docker Exec 输出改用官方多路复用读取器,并在命令已退出但 attach 连接未发送 EOF 时主动收尾;上下文超时也会关闭阻塞连接,避免输入 `ls` 等命令后终端永久卡住。

### 测试
- ✅ test(docker): 新增多路复用 stdout/stderr、原始流、exec 已退出但连接未关闭及阻塞读取超时的 sidecar 回归测试;Go 全量测试与 `go vet` 通过。

---

## [0.26.1] - 2026-07-13

### 修复
- 🐛 fix(ai): 新版 StarHub AI 工作区识别模型回复中的 `<think>` 思考过程并默认收起,支持点击展开/再次收起,同时兼容流式输出期间尚未闭合的标签。

### 文档与测试
- ✅ test(ai): 前端 TypeScript 与生产构建通过,应用内 Browser 回归思考过程默认收起、点击展开及再次收起状态。

---

## [0.26.0] - 2026-07-13

### 新增
- ✨ feat(ai): 新增显式 `#LOCAL` / `#本机` 本轮授权,StarHub AI 可直接获取本机系统信息、列出目录、读取路径元数据与经确认的文本正文,并执行文本写入、目录创建、文件复制、路径移动和删除。
- ✨ feat(ai): 新增跨平台本机 Shell 工具,Windows 使用非交互 PowerShell,macOS / Linux 使用 POSIX `/bin/sh`;支持工作目录、1–120 秒超时、退出码、stdout / stderr 与 512 KiB 输出截断。
- ✨ feat(ai): AI Agent 与自定义 Skill 作用域新增 `LOCAL`,全局 # 补全、快捷授权和 Planner 上下文同步识别本机能力。

### 安全
- 🔧 chore(security): 本机能力仅在当前请求显式包含 `#LOCAL` / `#本机` 时注册给模型;文件正文读取会提示内容将交给 AI Provider,所有文件系统写操作均强制人工确认。
- 🔧 chore(security): 本机 Shell 复用命令白名单和系统级危险规则,补充 PowerShell 只读命令预设及一次性旧配置迁移,增加 PowerShell、CMD 与 macOS 磁盘/关机/递归删除检测;白名单匹配改为跨平台大小写不敏感,高危命令无法用白名单绕过。

### 文档与测试
- 📝 docs(ai): 技术方案、架构图与 Agent 指引同步 `#LOCAL` 的跨平台 IPC、安全边界和工具矩阵。
- ✅ test(ai): Rust 本机模块测试覆盖系统信息、非交互 Shell 和临时文本文件写入/读取/删除闭环;`cargo clippy -D warnings`、前端 TypeScript 与生产构建通过;应用内 Browser 以 1280px 真实视口回归 #LOCAL 快捷授权、输入补全、本机确认卡、Skill 作用域与 PowerShell 白名单迁移,console 无 error。

---

## [0.25.0] - 2026-07-13

### 新增
- ✨ feat(ai): StarHub AI 可在当前对话中直接操作本轮通过 `#` 授权的 SSH、关系型数据库、Redis、Elasticsearch、Docker 与 Excel 工作区,无需打开或切换业务标签页。
- ✨ feat(ai): Planner 可为专职步骤创建仅本计划有效的临时 Agent,并将彼此独立的连续步骤调度为并行 Agent 批次;共享状态、写操作和存在依赖的步骤仍顺序执行。
- ✨ feat(ai): 全局计划卡新增直连操作确认区,提供批准、拒绝及白名单未命中时的“批准并加入白名单”,首次 SSH 主机指纹也在同一安全链路确认。

### 更改
- 🎨 style(ai): 计划步骤新增“临时 / 并行”状态徽标,结构化问题选项改为可点击单选卡,Planner 与 Executor 不再要求用户输入 A/B/C 或序号。
- 📝 docs(ai): 同步技术方案与架构图中的无标签直连运行时、短生命周期连接、结构化选择和临时/并行 Agent 调度说明。
- ✅ test(ai): 增加仅开发态生效的全局 AI 编排回归场景,覆盖点击选项、临时/并行状态与直连确认卡。

### 修复
- 🐛 fix(ai): 真实布局回归修复计划卡在消息流中被 flex 压缩的问题,选项与确认卡不再存在于 DOM 却被面板裁掉。

### 安全
- 🔧 chore(ai): `#` 引用成为全局直连工具的硬授权边界;命令白名单、强制确认与高危规则继续复用工作区安全门,Excel 与 Elasticsearch 写操作同样需要人工确认。

### 测试
- ✅ test(ai): 前端 TypeScript 检查与生产构建通过;应用内 Browser 以 1280px 宽真实视口回归 AI 工作区、点击选项、临时/并行计划状态和直连确认卡,确认页面无横向溢出且 console 无新增 error。

---

## [0.24.0] - 2026-07-13

### 新增
- ✨ feat(docker): Docker Exec 改用与 SSH 工作区一致的 xterm 终端,支持终端内直接输入、上下键命令历史、`cd` 工作目录保持、快捷命令、搜索、清屏、复制粘贴与全局字号设置。
- ✅ test(docker): 增加仅开发态生效的 Docker 工作区 mock 路径,覆盖容器、镜像、仪表盘和 Exec 命令输出,用于无 Docker/Tauri 环境下的真实布局回归。

### 更改
- 🎨 style(docker): Exec 复用 SSH 终端工具栏与设计 token;进入 Exec 时自动收起 Docker 容器侧栏并移除重复详情标题,为终端释放有效宽度,侧栏仍可一键展开。
- 🎨 style(design-system): 新增 `.terminal-font-size-indicator`、`.terminal-action-divider`、`.terminal-search-*`、`.terminal-quick-*`、`.docker-exec-*` 共用组件类。

### 修复
- 🐛 fix(docker): 清屏改用 ANSI 擦屏并重置当前输入,避免 xterm `clear()` 保留当前行后出现重复提示符。

### 测试
- ✅ test(ui): 前端类型检查与生产构建通过;应用内 Browser 以 1280×800 回归 Docker Exec 快捷命令、手动输入、`cd`、搜索、清屏、左右侧栏和右侧面板,终端工具栏无溢出、页面无横向滚动且 console 无新增 error。

---

## [0.23.0] - 2026-07-13

### 新增
- ✨ feat(ai): AI 侧边栏全面升级 — 视觉分层、健康状态指示器、空状态引导
- ✨ feat(ai): 侧边栏 AI 分组添加快捷入口："快速提问"和"分析当前工作区"
- ✨ feat(ai): 侧边栏新增最近对话摘要（最近 3 条），支持点击恢复
- ✨ feat(ai): Agent 支持收藏/取消收藏，收藏的 Agent 置顶显示
- ✨ feat(ai): 新增全局快捷键 `Ctrl+J`，一键聚焦 AI 工作区
- ✨ feat(ai): 侧边栏"分析当前工作区"按钮点击后自动填入分析 prompt

### 更改
- 🎨 style(ai): AI 分组头新增渐变标题、独立分层分隔线和健康状态文字
- 🎨 style(ai): 侧边栏 AI 区域新增 ~290 行 CSS 组件类（快捷操作、最近对话、收藏星标、空状态引导）
- 🎨 style(css): `cyber.css` 新增 `.ai-group-divider`、`.ai-health-dot`、`.ai-quick-actions`、`.ai-recent-*`、`.ai-empty-guide` 等全套 AI 侧边栏视觉 token

### 修复
- 🐛 fix(ai): 修复 `favorited` 字段在旧数据迁移时丢失的问题

---

## [0.22.1] - 2026-07-13

### 修复
- 🐛 fix(ai): AI agent maxSteps 默认值从 8 提高到 20，解决复杂多步任务超出限制报错的问题

---

## [0.22.0] - 2026-07-13

### 新增
- ✨ feat(docker): 新增容器 Exec 功能 — 在容器详情面板中增加 Exec 标签页，支持在运行中的容器内执行任意 shell 命令，提供终端风格的命令输入与输出历史展示
- ✨ feat(docker): Go sidecar 实现 `docker.exec` RPC handler，通过 Docker Engine API 的 ContainerExecCreate + ContainerExecAttach 正确解析多路复用协议输出

### 修复
- 🐛 fix(docker): 修复打开 Docker 标签页后切换到其他页面时连接失败的错误通知仍然残留的问题；移除 connect() 错误处理中冗余的 notify 弹窗，UI 错误卡片已充分呈现；同时将 disconnect 流程改为显式 await 以消除竞态
- 🐛 fix(es): Elasticsearch 查询结果默认展示格式从 Table 改为 JSON，更符合 ES REST API 使用习惯

---

## [0.21.1] - 2026-07-11

### 修复
- 🐛 fix(ai): 修复长对话中 AI 工具调用卡片被纵向 flex 布局压缩，导致 SSH 命令内容与 `ssh_exec_confirmed` 批准/拒绝按钮存在于 DOM 但不可见的问题；消息流子项现在保持完整内容高度并由外层统一滚动。

### 测试
- ✅ test(ui): 使用真实 Vite 页面 mock SSH 普通命令与 `ssh_exec_confirmed` 等待确认态，在 1280×800 视口验证命令完整显示、确认按钮可见可点击且消息流正常滚动。

---

## [0.21.0] - 2026-07-11

### 新增
- ✨ feat(ssh-ai): AI 命令等待命令行交互时扩展中英文密码、确认和安装器提示识别;确认类提示提供“是/否”快捷按钮,密码输入自动聚焦、保持遮罩且从工具输出中脱敏,不会进入 AI 上下文。

### 修复
- 🐛 fix(ai): 修复 AI SSH/DB/Docker 确认对话框不弹出的响应式更新问题 — confirmFn 状态变更后强制替换 toolCalls 数组引用并 await nextTick,确保 Vue 正确渲染批准/拒绝按钮。
- 🐛 fix(ai): 修复 `ssh_exec_confirmed` 等确认卡片展开后未重新滚动、批准/拒绝按钮被输入区遮挡的问题;同时补齐流式回复、工具结果和错误内容增长时的跟随滚动,用户向上阅读时不会被普通内容更新强制拉回底部。
- 🐛 fix(ai): 修复 DB / Redis / Elasticsearch / Docker 重试时追加空用户消息的问题,现在会准确重发最后一条用户请求。
- 🐛 fix(ai): 停止或新建会话时主动拒绝并清理待确认 Promise,避免 SSH / DB / Redis / Elasticsearch / Docker 的旧 AI 任务永久悬挂。

### 测试
- ✅ test(ai): 前端类型检查与生产构建通过;静态回归确认卡片状态监听、重试消息重建、待确认任务释放和 SSH 交互输入分支。

---

## [0.20.0] - 2026-07-10

### 新增
- ✨ feat(ai): 全局 AI 改为 **Planner Agent → Execution Agent** 两阶段编排。Planner 先提交结构化计划,每个步骤绑定负责 Agent;信息不足或存在关键分支时暂停执行并给出 2–4 个互斥选项,用户选择后重新规划并继续。
- ✨ feat(ai): AI 工作区新增计划卡片、步骤状态、当前 Agent 徽章和逐 Agent 回复署名;支持停止当前执行步骤,计划状态完整覆盖规划中、等待选择、执行中、完成、失败和停止。
- ✨ feat(ai): 全局 AI 增加 StarHub 应用工具注册表,覆盖能力发现、授权资产列表/打开、已打开标签查询/切换、设置与新建连接入口;真实 SSH / DB / Docker / Excel 操作继续由对应工作区 AI 和原有安全闸门执行。
- ✨ feat(ai): `#` 工作区引用细化到具体资产,自动生成 `#SSH-测试服务器`、`#DB-测试环境`、`#Docker-生产集群` 等候选;模块级 `#SSH` / `#DB` 等引用继续保留。
- ✨ feat(ai): Skills 在原有本地创建基础上支持外部导入 `.json` / `.md` / `.markdown` / `SKILL.md`,兼容单条、数组和 `{ skills: [] }` 包格式,校验 256 KB 上限、必填字段、作用域与重复项。

### 修复
- 🐛 fix(ssh-ai): `ssh_exec_confirmed` 执行 `cat > /home/work/update_domain` 会等待 stdin 直到 60 秒超时。现于确认和下发前拒绝无输入的 `cat` 重定向、不完整 heredoc、编辑器/分页器、持续日志和其他交互命令,并提示使用完整 heredoc 或 `printf`;合法 heredoc、管道和普通 `cat` 不受影响。
- 🐛 fix(ssh-ai): 移除“输出静默 2 秒即判定成功”的危险兜底,避免 `sleep`、服务重启和包安装停顿时 AI 提前发送下一条命令;改为记录执行前真实 prompt + 通用 prompt 识别。超时、停止、新会话会发送 Ctrl+C 恢复共享 PTY,并拒绝并发命令覆盖未完成捕获。
- 🐛 fix(ai): 强制确认和高风险工具调用不再显示无效的“加入白名单”按钮;只有 `whitelist-miss` 才允许加入。
- 🐛 fix(ai): 工具卡片从 shrink-to-fit 改为整栏宽度,命令使用独立的可换行/滚动代码区,修复截图中命令卡片被压成窄条看不清的问题。
- 🐛 fix(ai): 纯浏览器布局回归没有 Tauri runtime 时,AI Keyring 读取降级为“未配置 API Key”,不再暴露 `invoke undefined` 错误。

### 测试
- ✅ test(ai): 前端类型检查与生产构建通过;SSH 交互命令预检覆盖 5 个关键用例并验证在确认/执行前拒绝。
- ✅ test(ui): 应用内 Browser 以 1280×800 回归完整 `CyberLayout`、AI Planner 状态卡、当前 Agent、Skills 自建/导入入口和错误降级;关键容器无横向溢出,浏览器 console 无 error。

---

## [0.19.7] - 2026-07-10

### 修复
- 🐛 fix(ai): 修复「AI 工具卡片里长命令/路径看不清」。根因:之前用 `word-break: break-all` 让字符在窄 panel 里 wrap 成 5-7 行,既不美观也不便于阅读;`tool-result` 的 `max-height: 160px` 也太矮,大文件输出得来回翻。修复:`.tool-summary` 命令/路径改成**单行 + 横向 scroll**,`.tool-result` 输出同时支持竖向 + 横向 scroll 并把 max-height 提到 280px,`.msg-content.tool-content pre` 加横向 scroll 兜底长行,配 thin scrollbar 视觉。

### 优化
- 🎨 style(layout): 右侧面板默认宽度 380→480px,min 300→320px,max 500→600px。AI 助手场景下 `cat /path/.../config.toml | head -50` 这类长命令 + 多行输出需要更多横向空间,1280 宽窗口里默认 380 会被截掉 200+ px。`RightPanelHandle` 双击重置宽度同步到 480。

---

## [0.19.6] - 2026-07-10

### 修复
- 🐛 fix(ssh): v0.19.5 引入的 idle fallback 没真正生效 —— `maybeResolvePromptCapture` 只在 `handleTerminalOctets` 收到新 chunk 时被调用,**命令输出完 + prompt 返回 + 之后无新数据时永远不会再被触发**,AI 一直"思考中"。修复:`PromptCapture` 加 `idleTimer`,每个 chunk 进来时重置 2s 计时器,2s 内没新数据就主动调一次 `maybeResolvePromptCapture`,让 idle fallback 真正能跑。覆盖管道命令(`cat | head -50`)、自定义 PS1、fish 等 `isShellPromptLine` 漏掉的场景。

---

## [0.19.5] - 2026-07-10

### 修复
- 🐛 fix(ai): 修复「用户连续点发送」导致的三个连锁问题 ——
  1. AI 助手对话框错位:重复点击让 message 数组被并发 push,布局混乱;
  2. 工具调用报 `[Error] Superseded by a newer AI command`:第二次 send 的 `pwd` 抢占第一次 send 还没收口的 `promptCapture`;
  3. LLM API 报 `HTTP 400 invalid params, tool call result does not follow tool call (2013)`:两个 `runAgent` 并发跑,旧轮还在 background push tool 消息,新轮又 push user + assistant(tool_calls),messages 顺序错乱,LLM 校验失败。
  
  修复:`ai` store 新增 `instanceId` 级 `in-flight` promise map,新一轮 `runAgent` 进入时先 `await` 旧轮 abort + finally 收尾;同时 6 个 view(`SshTerminal` / `DbView` / `RedisView` / `DockerView` / `ElasticsearchView` / `ExcelView`)的 `onAiSend` 入口立刻设 `session.loading = true` + `if (loading) return` 守卫,UI 立刻切到停止按钮挡住重复点击;`SshTerminal.onAiRetry` 同样加守卫。

- 🐛 fix(ssh): AI 工具执行报「等待 shell prompt 返回超时」但实际命令已结束。根因:当命令输出很大 / shell prompt 不在 `isShellPromptLine` 正则覆盖的格式里时,`hasReturnedPrompt` 永远 false,只能等 10 分钟 safetyTimer。修复:`AI_PROMPT_CAPTURE_SAFETY_MS` 从 10 分钟降到 60 秒;新增 idle 兜底 — 如果 hasReturnedPrompt 持续 false 但数据流已停 2s,直接 fallback resolve 已收到的内容。

### 优化
- 🎨 style(ai): `AiChat` 消息布局 —
  - `.msg.user` 由 `flex-direction: row-reverse` 改为 `row + align-self: flex-end + max-width: 86%`,用户消息整体靠右、限宽,头像在左、内容在右;
  - 全部消息内容用标准 `overflow-wrap: anywhere` 替代非标准 `word-break: break-word`,在窄 panel / 长 URL / 长单词下也能正常断行;
  - `.tool-call` / `.tool-summary` / `.tool-result` / `.think-body pre` 同步加固 wrap 行为。

---

## [0.19.4] - 2026-07-10

### 修复
- 🐛 fix(ai): 「停止」按钮真正生效,`stopAgent` 立即设 `loading=false` + `error='已停止'`,不再卡在"思考中"。
- 🐛 fix(ai): `runAgent` 加 300 秒全局超时,防止 SSE hang 住整个会话。
- 🐛 fix(ai): `<think>...</think>` 标签块可点击折叠/展开,默认收起。
- 🐛 fix(ai): 工具栏新增「重试最后一条消息」按钮,顶部错误条的重试按钮保留。
- 🐛 fix(ai): `AiChat` 内容区扩宽,移除冗余缩进。
- 🐛 fix(layout): 右侧面板最小宽度从 200px 提到 300px,防止窄 panel 下 AI 消息气泡被压成竖线。

---

## [0.19.3] - 2026-07-10

### 新增
- ✨ feat(ssh): SSH QUICK 快速命令支持自定义 — 每个连接可添加/编辑/删除自己的自定义命令,并通过拖拽调整顺序。默认 6 个常用命令保留,自定义命令按资产 ID 分开存储在 localStorage。

---

## [0.19.2] - 2026-07-10

### 修复
- 🐛 fix(sftp): 修复密钥文件连接时 SFTP 报错「Session not found」,catch 块误调 `ssh_disconnect` 删除了终端正在使用的 session;现只在独立 session 时才断开

---

## [0.19.1] - 2026-07-10

### 修复
- 🐛 fix(docker): 关闭 Docker / 数据库 tab 时通知中心误报「Docker 连接失败」。根因是 `<transition mode="out-in">` 的 leave 动画 (~200ms) 期间,DockerView 尚未真正 unmount,但 Docker daemon 不存在会让 `dockerService.dockerConnect` 立即返回错误 → catch 块里旧的 `viewDisposed` 还是 false → 误以为是新 view 的失败并弹通知。改用 `connectStale` 标志,在路由变化 (`watch(assetId)`) 时立即标记 in-flight 连接为 stale,不再等 leave 动画结束后的 `onBeforeUnmount`。同时统一修复 RedisView / DbView 同样的模式。

---

## [0.19.0] - 2026-07-10

### 新增
- ✨ feat(ai): 左侧资产树新增 AI 一级类型和独立 AI Command Workspace,支持多个 AI Agent 的新建、编辑、复制、删除与独立标签会话。
- ✨ feat(ai): AI Agent 支持绑定内置 / 自定义 Skills,通过 `@Agent` 路由角色与协作提示,通过 `#SSH` / `#DB` / `#Docker` / `#Excel` 逐轮授权资产上下文并列出或打开对应工作区。
- ✨ feat(ai): Agent 编辑器新增 Ops、Data、Change Guard 预设;Provider、API Key、模型、全局 Skills 与命令白名单统一复用「设置 → AI 助手」。

### 修复
- 🐛 fix(ssh): Windows Credential Manager 按 UTF-16 编码后限制单条 credential blob,导致 OpenSSH RSA 私钥保存时报 2560 上限;长凭据改用带版本清单的分代 Keyring 分片,兼容旧格式读取并在更新 / 删除时清理旧分片。
- 🐛 fix(ai): SSH、数据库、Docker、Excel 与独立 Agent 的 AI 空状态按连接类型显示正确示例,不再统一误提示“查磁盘使用情况”。
- 🐛 fix(ai): 修复 Agent getter 写回响应式数组造成的递归更新;纯浏览器预览无法调用 Tauri Keyring 时设置页降级为空 API Key,避免 ErrorBoundary 接管。

### 优化
- 🎨 style(ai): 新增 Agent 工作区、角色侧栏、@/# 补全、工具调用状态与 Agent 配置弹窗的 Cyber Command Center 组件样式,并补充键盘与 `aria-label` 可访问性。
- 🔒 security(ai): 全局 AI 仅能访问本轮通过 `#` 显式授权的模块资产;真实命令、SQL、容器和表格写操作仍交给具体工作区的确认、白名单与高危拦截流程。
- 🔧 chore(rust): 清理 AI 响应错误构造与外部文件打开函数的既有 clippy 告警,恢复 `cargo clippy --all-targets -- -D warnings` 质量闸门。

### 测试
- ✅ test(ssh): 用户提供的 OpenSSH 私钥通过 `russh` 解码验证;Windows 原生 Keyring 完成超限占位凭据写入、分片读回和删除实测。
- ✅ test(ui): 1280×800 真实 `CyberLayout` 浏览器回归覆盖 AI 分组、右键设置、新增 Agent、Agent 预设、独立对话页和 @/# 自动补全;将真实布局回归流程写入 `AGENTS.md` 强制执行。

---

## [0.18.2] - 2026-07-10

### 新增
- ✨ feat(db): Elasticsearch 新增 Address URL 连接方式,支持直接填写 `http://host:9200` / `https://host:9243`,同时兼容 Host / Port 模式。
- ✨ feat(ai): AI 助手新增 SKILLS 配置,内置运维排障、性能分析、日志分析、安全变更、数据洞察技能包,支持自定义 Skill 并按 SSH / DB / Docker / Excel 注入系统提示。

### 优化
- ⚡ perf(ai): SSH AI 命令执行从固定秒数等待改为监听 shell prompt 返回后收集输出,避免长命令提前截断或短命令输出漏采。

### 修复
- 🐛 fix(docker): Docker SSH 隧道复用已信任 Host Key 时锁定对应 Host Key 算法,避免终端与 sidecar 因协商到不同公钥类型而误报 `host key mismatch`;连接失败卡片新增重新校验并更新 SSH 主机密钥入口,确认后自动重连 Docker;关闭 Docker 页面后丢弃迟到的连接失败并清理本页 session。
- 🐛 fix(connection): SSH、数据库、Redis 与 Docker 页面关闭或切换资产时立即废弃进行中的连接尝试,迟到的成功会主动断开,迟到的失败不再弹通知。
- 🎨 style(ai): 修复 Docker 右侧 AI 助手面板宽高约束与长工具调用内容换行,避免聊天区、输入区或右栏挤压溢出。

---

## [0.18.1] - 2026-07-10

### 修复
- 🐛 fix(db): MySQL / PostgreSQL / ClickHouse 数据结果 Univer 单元格写入真实细边框,并在 workbook snapshot 中显式开启 `showGridlines` / `gridlinesColor`;浅色主题网格线对比度提高,避免白底数据区看不到纵横网格线。

---

## [0.18.0] - 2026-07-09

### 新增
- ✨ feat(db): 新增 PostgreSQL 完整连接、Schema/表/字段/索引浏览、SQL 与数据编辑，并增加连接 IP、当前 SQL、慢语句、缓存命中率等可钻取监控。
- ✨ feat(broker): 新增 Kafka 与 NSQ 连接测试、资产入口、产品图标、主题一致的节点/Topic/Channel 状态仪表盘。
- ✨ feat(docker): Docker 新增本地 Socket、TCP、复用现有 SSH 资产三种连接方式；SSH 支持跳板机与 `Unix-Over-Nc` / `Unix-Over-Nc-Sudo`，严格复用已信任 Host Key。
- ✨ feat(dashboard): MySQL、PostgreSQL、Redis、SSH、Docker 指标统一增加实时折线/环图和明细钻取；连接数显示客户端 IP 与当前 SQL，慢查询显示具体语句。

### 修复
- 🐛 fix(db): Univer 数据刷新改为内部可写、用户编辑命令精确拦截，消除刷新时错误弹出的 `sheets-ui.permission.dialog.alert`。
- 🐛 fix(clickhouse): `system.tables.total_rows` / comment 等可空字段统一 `coalesce`，修复 `NULL to int64`；侧栏按真实 ClickHouse 类型展示品牌图标。
- 🐛 fix(db): 审核 MySQL、PostgreSQL、ClickHouse、Redis、Elasticsearch 元数据路径，对可空标量采用 SQL `COALESCE` 或 Go 指针字段，并加入回归测试。

### 优化
- ⚡ perf(excel): 打开工作簿时从 XLSX XML 一次性建立稀疏公式索引，读取 Sheet 不再逐单元格调用 `GetCellFormula`，显著改善跨 Sheet VLOOKUP 工作簿加载卡顿。
- 🎨 style(design-system): 增加产品品牌图标、仪表盘图表/明细表、消息队列状态页和 Docker 连接协议切换组件类。

### 测试
- ✅ test(build): Go 全量测试、TypeScript strict/Vite 构建、Rust `cargo check` 与 Windows Tauri 打包通过。

---

## [0.17.5] - 2026-07-09

### 修复
- 🐛 fix(db): 数据网格线 `--gridline` alpha 0.22 在深色背景 `#101822` 上几乎不可见 — 提高到 0.42(深色主题)/ 0.28(浅色主题),让单元格边界清晰可辨。

---

## [0.17.4] - 2026-07-09

### 文档
- 📝 docs: 重写 README 反映 v0.17.x 全貌。原先 README 停留在 v0.12.0,与实际版本严重脱节。本次重写补齐功能矩阵(数据库 8 类适配器、SSH ZMODEM、Excel 工具、设计系统)、v0.13.x ~ v0.17.3 完整版本说明、技术栈表格、快捷键、打包产物、设计系统简介、文档索引、安全提示、贡献规范与路线图。

---

## [0.17.3] - 2026-07-09

### 修复
- 🐛 fix(db): VARCHAR/TEXT 列里长得像数字的字符串(例如 `'1111'`)被 Univer 识别为 FORCE_STRING 候选,显示绿色警告角 + hover 弹"此数字以文本形式存储"。通过 preset 配置 `sheets.disableForceStringAlert: true` + `disableForceStringMark: true` 关闭,数据库语义下不再需要 Excel 式的强类型警告。

### 新增
- ✨ feat(db): Excel 导出支持全量数据 + WHERE 联动 + 分批拉取 + 进度条 + 通知中心:
  * 表浏览:按 offset 分批拉 `db_mysql_get_table_data`,自动联动 WHERE / columnFilters / ORDER BY;
  * SQL 编辑器:复用 `lastSql` 去掉末尾 LIMIT 重新执行;
  * SQL 结果 tab:已在内存,直接灌入;
  * > 5000 行弹确认 dialog 显示条数;
  * Teleport 进度遮罩显示 current/total + 百分比 + 目标文件;
  * 通知中心带数据源、行数、SQL、目标路径、耗时。

---

## [0.17.2] - 2026-07-09

### 修复
- 🐛 fix(db): 刷新 / 翻页 / 排序时 `setValues` / `setColumnWidth` 触发 Univer 的 Workbook Edit permission 拦截并弹出"sheets-ui.permission.dialog.alert"权限警告;新增 `withEditableBypass` 在程序化写入时临时打开 editable,写完按 props.editable 恢复,用户视觉上仍是 read-only。
- 🐛 fix(db): 数据网格线颜色用 `--line-2`(`rgba(122,156,185,0.18)`)在深色背景上几乎不可见;新增专门的 `--gridline` token,深色模式 `rgba(93,214,214,0.22)`、浅色模式 `rgba(30,45,62,0.22)`,跟面板分隔线形成层次。

---

## [0.17.1] - 2026-07-09

### 优化
- 🎨 style(db): 数据库结果网格表头只显示字段名,字段类型 / 排序符号不再拼接在表头里,改为 hover tooltip 展示类型、可空、键、默认值与备注;排序方向通过单元格底色与文字色传递。
- 🎨 style(db): Univer 网格强制开启行/列分割线,颜色走 `--line-2` 与 StarHub 设计系统一致;数据单元格按数字右对齐 / 文本左对齐,字号、内边距与表头对齐成统一网格节奏。
- ⚡ perf(db): 列宽按纯字段名 + 数据样本计算,避免去掉类型后列宽过窄。

### 测试
- ✅ test(build): TypeScript strict + Vite production build 通过。

---

## [0.17.0] - 2026-07-09

### 新增
- ✨ feat(ssh): SSH PTY 输出改为原始字节事件,增加 `ssh_write_binary` 与 `zmodem.js` Sentry,支持远端 `rz` 选择本地文件发送、远端 `sz` 接收并保存,并提供传输状态与进度交互。
- ✨ feat(dashboard): DB / SSH / Docker 指标卡支持点击钻取,展示完整值、指标解释、构成与实时明细;统一增加弹层动画和 hover 反馈。
- ✨ feat(db): 数据库字段首行悬停显示字段类型、可空、键、默认值与备注;通知中心记录更新/删除明细、主键条件和可复制 SQL。

### 修复
- 🐛 fix(excel): Sheet 切换复用同一 Univer Workbook/Canvas 实例并优先读取前端缓存,不再每次访问 Sidecar 后销毁重建;修复切换卡顿。
- 🐛 fix(excel): 收窄 Workbench flex 覆盖选择器,避免误伤 Ribbon 内部 `.univer-grid`,恢复被折叠为省略号的完整工具按钮;移除顶部重复筛选按钮。
- 🐛 fix(db): 分页、排序、刷新、整列选择和保存后改为原地更新网格,保留滚动位置并用 loading 遮罩反馈;列头跟随系统主题并显示升降序状态。
- 🐛 fix(db): MySQL 仪表盘按当前数据库统计表数量与数据/索引容量,修正 InnoDB 缓冲池命中率与页大小口径,完整大数字可在详情中查看。
- 🐛 fix(db): 普通字符串不再标记为 Univer `FORCE_STRING`,移除数字文本绿色告警角和 `sheets-ui.info.*` 泄漏,并补齐兼容中文 locale。
- 🐛 fix(ssh): 顶部纯图标按钮补齐悬停文案,Quick 命令区增加分组、间距、换行与交互动效。

### 测试
- ✅ test(excel): Vite dev mock 注入 190 行、3 个 Sheet,实测完整 Ribbon 30+ 工具按钮、单 Workbench 原地切换和画布铺满 SheetBar。
- ✅ test(build): TypeScript strict、Vite production build、`cargo fmt --check`、`cargo check` 与 Rust 13 个单元测试通过。

---

## [0.16.0] - 2026-07-09

### 新增
- ✨ feat(db): MySQL / ClickHouse 表数据、SQL 编辑器结果和独立查询结果统一切换为 Univer Canvas 网格。支持冻结字段名/类型首行、自适应列宽、数字/布尔/JSON/NULL 语义渲染、滚动选择与列头排序。
- ✨ feat(db): 有主键的数据表可直接编辑、粘贴和填充单元格,改动沿用 dirty 集合与 `Ctrl/Cmd+S` 批量保存;保留服务端分页、WHERE/字段筛选、刷新、CSV/Excel 导出和右键行操作。

### 优化
- ⚡ perf(db): 数据库 Univer 网格按需异步加载,非数据库页面不创建实例;共享 `src/lib/univer.ts` 的 StarHub canvas 主题映射。
- 🎨 style(design-system): 新增数据库 Univer 容器与列操作工具类,复用 `.univer-host` 高度链和 Excel 留白修复约束。

### 测试
- ✅ test(db): Vite mock 注入 80 行混合类型数据,实测容器 1222×590、有效 canvas 1222×589,无下方留白;验证直接编辑、dirty 计数、批量保存事件、列头排序与筛选弹层。
- ✅ test(build): TypeScript strict 检查与 Vite 生产构建通过。

---

## [0.15.1] - 2026-07-09

### 修复
- 🐛 fix(redis): 普通关键词自动转换为 Redis glob 包含匹配,修复 Pattern 输入后只做精确匹配、后续游标中的 Key 无法检索的问题;仍支持 `*`、`?`、`[]` 高级 Pattern。
- 🐛 fix(redis): 选中 DB、刷新或搜索时自动连续执行 `SCAN` 直到游标结束,无需反复点击 Load more;切换 DB 或快速改关键词时通过请求 token 丢弃过期响应。

### 测试
- ✅ test(redis): TypeScript 严格类型检查与 Vite 生产构建通过,并校验普通关键词、显式 glob 与空关键词的 Pattern 归一化结果。

---

## [0.15.0] - 2026-07-09

### 新增
- ✨ feat(excel): Excel 打开时由 Sidecar 一次返回全部 Sheet 快照,前端以完整 Univer 工作簿加载,跨 Sheet 引用可以参与公式依赖计算。导入公式写入 Univer 的 `f` 字段而非普通文本 `v`,`=VLOOKUP(D2,q区县!$B$1:$D$3178,2,FALSE)` 等公式现在会显示计算结果并保留原公式。
- ✨ feat(excel): 接通 Office 风格自动填充的数据同步。双击填充柄、拖拽填充柄、`Ctrl+D`、`Ctrl+R`、`Ctrl+Enter` 产生的公式会保留相对/绝对引用并批量写回 Sidecar,不再被计算结果覆盖成静态值。

### 测试
- ✅ test(excel): 增加整本工作簿读取测试,覆盖多 Sheet 顺序、跨 Sheet `VLOOKUP` 原公式保留和引用表数据完整性;Vite 多 Sheet mock 实测公式计算及 A2:A9 双击/快捷键填充。

---

## [0.14.15] - 2026-07-09

### 修复
- 🐛 fix(excel): 彻底修复 Excel 数据区下方留白。Vite 实测确认 StarHub 的 Univer 挂载容器 `.univer-grid` 与 Univer 0.25.1 全局 `display: grid` 工具类同名,导致 504px 容器被自动拆成 290px + 214px 两行,Workbench 只占第一行。挂载容器改名为 `.univer-host`,避开全局类污染,数据画布现在会完整铺到 Sheet 标签栏。
- 🐛 fix(excel): 纯 Vite 开发环境不再调用 Tauri Webview 拖放 API,便于使用浏览器 mock 数据排查 Excel 布局。

---

## [0.14.14] - 2026-07-09

### 修复
- 🐛 fix(excel): 继续修 Excel 视图下方留白(v0.14.13 的 grid 模板兜底只让数据多 1 行+2 列,远不够)。v0.14.14 直接放弃 grid 兜底,改用 flexbox 强制撑开 `[data-u-comp="workbench-layout"]` → 中间 section → `[data-range-selector]` 的整条高度链。`UniverGrid.vue` 给 `workbench-layout`、`.univer-grid`、中间 section、`data-range-selector` 分别加 `display: flex` / `flex-direction: column|row` / `flex: 1 1 0` / `min-height: 0`,让 canvas 的 mountPoint 直接填满到 StarHub 状态栏上方,不依赖 Tailwind 任意值 grid 模板。

---

## [0.14.13] - 2026-07-09

### 修复
- 🐛 fix(excel): 修复 Excel 视图下方大面积留白。Univer 0.25.1 用 Tailwind 任意值语法写的 grid 模板类(`univer-grid-cols-[auto_1fr_auto]`、`univer-grid-rows-[100%]`、`univer-grid-rows-[auto_1fr]`、`univer-grid-rows-[auto_1fr_auto]`)在 `@univerjs/design` 编译产物里被 Tailwind JIT 漏掉,导致 `Workbench` 两层 grid 退化成单行单列,`[data-range-selector]` 拿不到 `1fr` 那行的高度,只能缩到 canvas 自身的内容高度(约 10 行)。`UniverGrid.vue` 增加 `:deep()` 兜底,把缺失的 `grid-template-*` 与右侧栏 `z-index: 100` 补回去,canvas 现在能跟着窗口撑满到 Sheet 标签条上方。

---

## [0.14.12] - 2026-07-09

### 优化
- ⚡ perf(excel): `UniverGrid` 把 `requestUniverResize` 从「`MutationObserver` 持续监听 `attributes:style`」改为「轻量 `MutationObserver` 仅等 `[data-range-selector]` 出现 → 立刻切换为 `ResizeObserver` 监听 mountPoint 尺寸变化」。`ResizeObserver` 的初始回调顺带校准一次,处理引擎 `_previousWidth/_previousHeight` 缓存导致首次挂载尺寸错位的旧 bug。比持续监听 style 更省 CPU,也避免了父层尺寸变化时 style 抖动引起的多余回调。

---

## [0.14.11] - 2026-07-08

### 优化
- ⚡ perf(excel): `UniverGrid` 把"等 Univer 画布挂载 + 强制引擎重测尺寸"从 `setInterval(50ms)` 轮询改为 `MutationObserver`,DOM 真正变化才触发回调,画布尺寸对齐就立刻 disconnect。比之前省 CPU,且对齐响应更快。

---

## [0.14.10] - 2026-07-08

### 修复
- 🐛 fix(home): 修复首页右上角内容溢出。收紧工作区与空 tab 最近使用条的 flex 边界,并让首页指标、能力卡片和最近工作网格按容器宽度自动换列,避免长文件名或多列卡片把右侧顶出窗口。

---

## [0.14.9] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 v0.14.8 收缩 `UniverGrid` 外层容器导致数据画布不显示、Sheet 标签栏上浮的问题;恢复外层 flex 占位让 SheetBar 固定在底部,并将工作簿尾行从一整屏改为少量自适应缓冲,避免底部继续出现大段空白网格。

---

## [0.14.8] - 2026-07-08

### 修复
- 🐛 fix(excel): `UniverGrid` 外层容器改为按 Univer 实际 `[data-range-selector]` 区域高度收缩,同时移除外层网格兜底背景,避免数据区下方继续铺满整页。

---

## [0.14.7] - 2026-07-08

### 修复
- 🐛 fix(excel): `UniverGrid` 恢复按当前视口高度补齐底部网格,并给工作区底层增加 Excel 网格背景兜底,避免数据末尾到 Sheet 标签栏之间露出大块纯白留白。
- 🐛 fix(redis): Redis key 读取遇到已过期/已删除 key 时不再返回 RPC `-32603`,而是转换为可读的“Key 已不存在或已过期”状态;hash/set/zset/list 预览限制为 1000 条采样,避免大 key 查询一次性拉全量导致卡顿。
- 🐛 fix(redis): 修复 Redis 切换 DB 后 `SCAN` 偶发扫不到 key 的问题。原实现通过连接池执行 `SELECT db`,只改变了池中单条连接的 DB,后续 `SCAN/GET/TYPE` 可能落到其他仍在旧 DB 的连接;现在切 DB 会重建 Redis client 连接池,确保 `DBSIZE`、Key 列表和读取都在同一个 DB。
- ⚡ perf(redis): Redis key 浏览器单次 SCAN 页面从 500 下调到 120,降低远程 Redis 上 `SCAN + TYPE + TTL` 批量查询的瞬时压力。

---

## [0.14.6] - 2026-07-08

### 修复
- 🐛 fix(excel): 将 `UniverGrid` 数据下方的尾部空白网格从一个视口高度缩小为固定 2 行,避免滚到底部后仍显示过长空白网格。

---

## [0.14.5] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 滚到底部仍露出大块空白的问题。`UniverGrid` 不再只按真实数据行 + 5 行 buffer 结束画布,而是在数据后补一个视口高度的网格尾部,用 `D:/中汇豪泰/执行结果11/导出_2026-07-03.xlsx` 这类 1 表头 + 100 行真实数据文件滚动到底时仍保持 Excel 网格背景。
- 🎨 style(excel): Excel 工作区主题从 StarHub 青色暗色面板调整为 Office Excel 绿色标题栏 + 浅色 Ribbon / 网格 / 选区,Univer canvas 主题同步读取 `--excel-*` token,AI 表头样式也改为 Excel 绿。
- 🐛 fix(chrome): 标题栏最小化 / 最大化 / 关闭按钮改用 MDI 图标并固定窗口控件宽度,提高默认可见性,避免右上角按钮在缩窄或主题切换时消失。

---

## [0.14.4] - 2026-07-08

### 修复
- 🐛 fix(excel): 彻底修复 Excel 页面数据下方大面积留白 -- 根因是 Univer Engine 的 `resize()` 方法会缓存上次测量的尺寸(`_previousWidth`/`_previousHeight`),当尺寸未变时跳过 resize,导致画布在 300ms 延迟挂载后尺寸不正确且无法自动修正。修复:1) `requestUniverResize` 改为轮询方式(每 50ms 检查一次,最多 1.5s),等待画布挂载后直接重置引擎尺寸缓存(`_previousWidth = -1`)强制重新测量,若仍不匹配则直接调用 `resizeBySize()` 设置正确尺寸;2) `renderWorkbook` 在创建 Univer 实例前等待容器有非零高度(ResizeObserver + 500ms 超时兜底),避免 0 高度挂载;3) `disposeWorkbook` 清理容器 innerHTML 防止残留 DOM 干扰下次渲染;4) 移除 CSS 中的调试边框(lime/cyan outline);5) `[data-u-comp="workbench-layout"]` 增加 `height: 100% !important` 确保工作区填满容器。

---

## [0.14.3] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 页面大面积留白 -- Univer Engine 的 ResizeObserver 使用 `requestIdleCallback` 延迟画布 resize,导致画布尺寸长时间不正确。修改 `@univerjs/engine-render` 编译产物(ES + CJS),将 `requestIdleCallback` 替换为 `requestAnimationFrame` 使画布在下一帧立即 resize;同时增强 `UniverGrid.vue` 的 `requestUniverResize`,增加多次延迟触发(100ms/350ms/600ms)覆盖 Univer 300ms 延迟挂载,并直接检测 canvas 与容器尺寸是否匹配来强制触发 resize。

---

## [0.14.2] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 页面大面积留白根因 -- `UniverGrid.vue` 的所有 `:deep()` CSS 选择器(如 `.univer-workbench`、`.univer-sheet-canvas` 等)使用的是 Univer 旧版类名,在 Univer 0.25.1 中不存在(改用了 Tailwind 工具类 + `data-u-comp` 属性),导致全部深色主题覆盖 CSS 失效。修复:1) 通过 Univer 官方主题系统注入 `starhubTheme`(覆盖 `gray.800`/`gray.900` 为 `#0d1420`/`#080d14`),传入 `darkMode: true`;2) CSS 选择器全部替换为 `[data-u-comp="workbench-layout"]`、`[data-range-selector]`、`[data-u-comp="render-canvas"]` 等属性选择器;3) 移除 330 行对 canvas 渲染元素的无效 CSS(行/列头、单元格、选区等由画布引擎绘制,无法用 CSS 覆盖);4) `requestUniverResize` 从 dispatch `window.resize`(Univer 不监听)改为短暂修改容器尺寸触发 Engine 的 `ResizeObserver`;5) `VISIBLE_MIN_ROWS` 从 24 提升到 40。

---

## [0.14.1] - 2026-07-08

### 修复
- 🐛 fix(excel): 在 v0.14.0 重写基线上补齐真正的自控网格渲染,`ExcelGrid` 明确绘制公式栏、列头、字段名第 1 行、全部数据行和视口补齐空白网格行,避免 Excel 工作区只画到第 10 行后露出整块白底。
- 🔧 chore(release): 同步 package / Cargo / Tauri / lock / AGENTS 到 v0.14.1,修正 v0.14.0 后遗留的版本源不一致。

---

## [0.13.11] - 2026-07-08

### 修复
- 🐛 fix(excel): 重写 Excel 页面中间工作区,`ExcelView` 不再使用 Univer 画布渲染网格,改为 `ExcelToolbar + ExcelGrid` 自控布局;网格明确渲染公式栏、列头、字段名第 1 行、数据行和填满视口的空白网格行,按 `store.rowData.length` 铺出 100 行数据,避免第三方画布只画到第 10 行后露出整块白底。

---

## [0.13.10] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复含 100 行数据的 Excel 仍只画到第 11 行、下方大面积纯白的问题。`UniverGrid` 之前按最后一个非空单元格推断 `rowCount`,会把 Excel 中真实存在但内容为空的数据行从渲染层裁掉;现在 `rowCount` 改为按 `store.rowData.length + 表头 + buffer` 渲染,sidecar 读到多少数据行就画多少行网格,空数据行也保留行号和网格线。

---

## [0.13.9] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Univer 工作区底部仍出现大块纯白留白的问题。上一版只裁掉了数据源尾部空行,但前端又把 Univer 容器高度按内容裁短,导致水平滚动条停在上方、Sheet 标签栏前露出外层白底;现在 Univer 容器始终占满 Excel 工作区,`rowCount` 同时按真实数据末行和当前视口可容纳行数兜底,窗口尺寸变化时自动重建 workbook 并触发 Univer resize。

---

## [0.13.8] - 2026-07-08

### 修复
- 🐛 fix(excel): 修复 Excel 视图大面积留白 —— `sidecar/adapters/excel.go` 的 `ReadSheet` 用 `excelize.GetRows` 直接拿整张 sheet 的物理 row,会把"曾经编辑过但已清空"的行也一并返回,前端 `store.rowData` 一次性收到 100 行(其中 90 行空白),导致状态栏显示 `100/100`、Univer 渲染远超真实数据量的画布。修复:`ReadSheet` 增加 `trimTrailingEmptyRows` 裁掉数据区尾部所有 cell 为空的行,`totalRows` 也按裁剪后的真实数据行数返回;前端 `stores/excel.ts#loadData` 加双保险再裁一次;`UniverGrid#lastNonEmptyDataIndex` 改用更稳健的 null-safe 判断;新增 Go 单测 `TestReadSheetTrimsTrailingBlankRows` 锁定行为

---

## [0.13.7] - 2026-07-08

### 改进
- 🔧 chore(brand): 移除死代码旧 Logo `src/assets/logo.png`(旧版小星星 + "starhub" 文字 logo,代码侧已统一引用 `logo-star.png`,新文件并存易混淆),保持仓库图标资产单一事实来源
- 🔧 chore(release): 同步 5 处版本号 0.13.6 → 0.13.7

---

## [0.13.6] - 2026-07-08

### 文档
- 📝 docs(agents): AGENTS.md 新增 10.6 节「应用图标管理」,记录图标 3 个独立位置(打包图标 / 标题栏 / 前端引用)、换 Logo 标准流程 7 步、以及 v0.13.2~v0.13.5 踩过的 5 个坑(JPEG 伪装 PNG / CSS 几何 Logo / Tauri 构建缓存 / SVG 手动嵌入 / Windows 图标缓存)

---

## [0.13.5] - 2026-07-07

### 修复
- 🐛 fix(brand): 标题栏 Logo 还是 CSS 画的旧 S 轨道图标,桌面快捷方式/任务栏图标还是旧设计;CyberLayout titlebar 从 CSS 几何 Logo 改为 `<img>` 引用 `logo-star.png`(H1 星星设计);用 `tauri icon` 从 `H1-text-below-transparent.png` 重新生成全套打包图标(ICO/ICNS/PNG/iOS/Android/Store Logo),确保 exe / 快捷方式 / 托盘全部统一为新星星 Logo

---

## [0.13.4] - 2026-07-07

### 修复
- 🐛 fix(brand): H1-text-below-real.png 无透明通道(Format24bppRgb,米黄色背景),生成的 icon.ico/icon.png 也无透明背景,导致 exe 图标显示为带背景的方形;用 LockBits 将背景色(R≈254 G≈251 B≈238,容差40)设为 Alpha=0(83.6% 像素透明),重新生成全套图标(ICO/ICNS/PNG/iOS/Android);icon.ico MD5 从 062E0003 变为 2DC50447(57934 bytes)

---

## [0.13.3] - 2026-07-07

### 修复
- 🐛 fix(excel): UniverGrid `rowCount` 包含 `containerRows`(容器可容纳行数+5)导致数据少时画布出现大量空行留白;移除 `containerRows`,rowCount 改为 `max(数据行+5, 5)`;新增 `applyContainerHeight()` 让 Univer 容器高度自适应到内容(`min(行数×22+表头, 父容器高度)`),ResizeObserver 改为监听父容器避免循环触发
- 🐛 fix(brand): `icon.svg` / `icon-source.svg` 仍为旧 "S 轨道" 设计,`tauri icon` 不生成 SVG;改为以 `icon.png` base64 嵌入 SVG `<image>` 保持一致;重新生成 `icon.icns`

---

## [0.13.2] - 2026-07-07

### 改进
- 🎨 style(brand): 应用 Logo 更换为 H1-text-below 设计,从 `icons/_candidates/H1-text-below.png`(JPEG 伪装 .png,先用 .NET System.Drawing 转真 PNG)用 `tauri icon` 重新生成全套打包图标(ICO/ICNS/PNG/iOS/Android/Store Logo);CyberLayout titlebar 内 HTML logo 从 CSS 几何轨道风改为 `<img>` 引用实际图标

---

## [0.13.1] - 2026-07-07

### 修复
- 🐛 fix(excel): UniverGrid `rowCount` 未考虑容器实际高度,数据少的表格在下方出现大范围纯空白;改为 `max(数据行+buffer, 30, 容器可容纳行数+5)`

---

## [0.13.0] - 2026-07-07

### 新增
- ✨ feat(motion): 新增 Motion System 交互动画基础设施,在 `cyber.css` 追加弹性曲线 token(`--ease-back` / `--ease-spring` / `--ease-back-strong`)与时长 token(`--dur-fast` / `--dur-mid` / `--dur-slow`);提供路由切换(`.cyber-route-*`)、Tab 增删(`.cyber-tab-*`)、列表过渡(`.cyber-list-*`)、弹窗入场(`.cyber-dialog-*`)、欢迎页 stagger(`.cyber-stagger`)、数字 pop(`.cyber-count-pop`)、骨架屏(`.cyber-skeleton`)、按钮 press 微缩等组件类;尊重 `prefers-reduced-motion` 无障碍降级

### 改进
- 🎨 style(layout): `CyberLayout` 路由切换包 `<Transition name="cyber-route" mode="out-in">`(fade + slide + scale + blur 弹性入场),Tab 栏包 `<TransitionGroup name="cyber-tab">`(滑入滑出 + FLIP 移动),欢迎页元素按 `--i` 交错入场,状态栏资产计数变化时 `.cyber-count-pop` 弹跳反馈
- 🎨 style(asset): `AssetTree` 收藏 / SSH / DB / Docker / Excel 五个分组的 v-for 包 `<TransitionGroup name="cyber-list">`,资产增删有滑入滑出过渡
- 🎨 style(dialog): `GlobalDialogHost` 与设置弹窗的 `v-dialog` transition 从 `dialog-bottom-transition` 换成 `cyber-dialog`(弹性 scale + fade + 上浮)
- 🎨 style(hover): `.cyber-card` / `.connection-card` / `.feature-card` / `.recent-card` hover 上抬加深(translateY -4px) + 轻微放大(scale 1.008) + 光晕增强

---

## [0.12.3] - 2026-07-07

### 改进
- 🎨 style(brand): 应用图标更换为 `H1-text-below`,通过 `tauri icon` 从 `icons/_candidates/H1-text-below.png` 重新生成全套打包图标(Windows ICO / Store Logo、macOS ICNS、各尺寸 PNG、iOS AppIcon、Android mipmap);源文件实为 JPEG 伪装 .png 扩展名,先用 .NET System.Drawing 转成真 PNG 再生成

---

## [0.12.2] - 2026-07-07

### 修复
- 🐛 fix(db): 修复 `src-tauri/src/db/mod.rs` 中 `key_id` 被 `sqlx::query().bind(key_id)` move 后又在 `keyring::store(key_id, ...)` 复用导致的 `E0382 use of moved value` 编译错误,改为 `&key_id` 借用
- 🐛 fix(ssh): 去掉 `src-tauri/src/ssh/session.rs` resize 函数中多余的 `let mut ch`,消除 `unused_mut` 警告
- 🐛 fix(build): 修复 `vue-tsc --noEmit` 类型检查阻断打包的两处错误 —— `KeyBrowser.vue` 补 `onBeforeUnmount` import;`AiChat.vue` 用 `idx` 替换未定义的 `msgKey` 作为 v-for key

### 改进
- 🔧 chore(release): 同步 Tauri / Rust / package.json 三处版本号到 0.12.2,修复此前 `Cargo.toml` 与 `tauri.conf.json` 仍停留在 0.12.0、与 `package.json`(0.12.1)不一致的问题
- 📝 docs(agents): 在 AGENTS.md 第 6.5 节明确「每次更新代码必须同步更新版本号」的硬约束,并将发布检查清单扩展为覆盖 `package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `CHANGELOG.md` / `AGENTS.md` 五处

---

## [0.12.1] - 2026-07-07

### 改进
- 🎨 style(brand): 重新设计应用 Logo 与 `StarHub` 字标,采用手绘插画风格(奶油底 + 粉色 / 芥末黄 / 鼠尾草绿水彩 + 圆润手写体),告别几何轨道风
- 🎨 style(brand): 全套打包图标资源(Windows `.ico` / macOS `.icns` / Linux PNG / iOS / Android / Windows Store)替换为新版 Logo,exe 安装包与系统托盘同步更新

---

## [0.12.0] - 2026-07-03

### 新增
- ✨ feat(excel): Excel 工作区封装 Univer Sheets,接入开源 preset 能力集(公式、格式、筛选、排序、查找替换、数据验证、条件格式、超链接、批注、表格、绘图/附件等),保留 StarHub 自有删除重复项与按选中列去重到新 Sheet 功能
- ✨ feat(excel): 固定 Univer 与 Univer Presets 上游源码到 `vendor/`,并新增 `src/lib/univer.ts` 作为 StarHub 本地封装入口,便于后续按上游源码调整适配逻辑

### 改进
- 🎨 style(excel): 用 Univer 原生表格画布替换自研网格渲染层,保留 StarHub 工具栏、SheetBar、AI 助手与状态栏作为外层工作台
- 🐛 fix(excel): Univer 网格按「数据最后一行 + 20 行 buffer」渲染 sheet,数据下方不再留出与文件总行数等高的全空白画布,大表格下视觉留白显著减少;store 仍保留文件全部原始行,保存时不会丢数据

---

## [0.11.7] - 2026-06-26

### 改进
- 🎨 style(light-theme): 将浅色主题主色调整为低饱和钢蓝/灰绿,降低白底下青色高亮的刺激感
- 🎨 style(db): 统一数据库图标、类型徽章、DB 表单与数据表格选中态为低饱和视觉 token
- 🎨 style(brand): 生成并提交新版 StarHub 几何轨道 Logo 打包图标资源,用于 exe / 安装包 / 系统图标

---

## [0.11.6] - 2026-06-26

### 改进
- 🎨 style(ui): 调整全局暗色主题为低饱和控制台色调,降低青色/紫色光晕强度并统一主框架、资产树与命令面板视觉层次
- 🎨 style(brand): 优化应用 Logo 与 StarHub 字标,使用几何标识和 Orbitron 字体增强品牌质感
- 🎨 style(ux): 统一资产打开交互,单击优先激活已有标签,右键/标签栏加号保留新标签多开能力并恢复 Docker 资产入口
- 📝 docs(readme): 刷新 README 到 v0.11.6 功能、快捷键与打包说明
- 🔧 chore(release): 同步 Tauri 与 Rust 包版本到 0.11.6

---

## [0.11.5] - 2026-06-26

### 修复
- 🐛 fix(ssh): 修复终端 Ctrl+V 粘贴可能被浏览器/xterm 默认事件重复处理的问题

---

## [0.11.4] - 2026-06-26

### 新增
- ✨ feat(excel): 增加原生打开模式,可一键交给系统 Office Excel / 默认表格程序编辑当前文件

### 改进
- 🎨 style(excel): Excel 工作区切换为 Office 风格标题栏、Ribbon、公式栏、网格与 Sheet 标签

---

## [0.11.3] - 2026-06-26

### 改进
- 🎨 style(ui): 各业务侧边栏支持拖拽伸缩,拖到阈值以下自动收起

---

## [0.11.2] - 2026-06-23

### 修复
- 🐛 fix(excel): 本地列头筛选支持勾选多个值组合过滤
- 🐛 fix(excel): 新建 Excel 连接时支持直接拖入 .xlsx/.xls/.csv 文件填充路径
- ⚡ perf(redis): Redis Key 列表扫描批量获取 TYPE/TTL,减少远程连接下的串行往返
- 🐛 fix(redis): 修复 Key Browser Pattern 筛选参数未传入后端的问题,输入后自动刷新筛选结果
- 🐛 fix(db): 修复首次进入 MySQL/ClickHouse 标签页未恢复上次选中数据库的问题
- 🐛 fix(db): 表格单元格编辑确认后立即回显待保存值,保存成功后同步刷新当前页数据

---

## [0.11.1] - 2026-06-18

### 改进
- 🎨 style(db): 单元格编辑器弹窗改为居中显示,避免底部按钮被遮挡

---

## [0.11.0] - 2026-06-18

### 新增
- ✨ feat(db): 数据库选择记忆功能 — 记住上次展开和选中的数据库,下次进入自动恢复

### 修复
- 🐛 fix(db): 修复数据库表格双击单元格报错的问题(event 对象未正确传入)

---

## [0.10.9] - 2026-06-18

### 新增
- ✨ feat(db): 数据库表格双击单元格弹出编辑器弹窗,支持查看完整长文本内容、编辑和一键复制,替代原来截断在窄格子里的行内编辑

### 修复
- 🐛 fix(redis): 修复 Redis KeyBrowser 侧栏折叠后展开按钮不可见的问题,与 DbView/DockerView 保持一致的折叠交互

---

## [0.10.8] - 2026-06-18

### 修复
- 🐛 fix(ui): 修复 MySQL、Docker、Excel 等视图右侧面板点击收起/展开把手无响应的问题,原因是把手事件直接写全局 store 状态而非通过 v-model 更新视图本地状态

---

## [0.10.5] - 2026-06-18

### 新增
- ✨ feat(ui): 欢迎页与模块卡片新增右键菜单,支持就地新建连接、打开命令面板、设置与布局切换

### 改进
- 🎨 style(ui): 右键菜单补齐键盘导航与选中态,统一弹窗关闭/返回路径并优化禁用按钮和窄屏表单底部布局

### 修复
- 🐛 fix(ui): 修复 Ctrl/Cmd+K 搜索快捷键未注册、输入框/弹窗中全局快捷键误触发底层 tab 的问题
- 🐛 fix(ui): 纯 Web dev 环境下 Tauri window/asset 调用降级,避免页面验证时进入错误边界或刷控制台错误

---

## [0.10.4] - 2026-06-18

### 修复
- 🐛 fix(db): 修复 MySQL 新建表失败被当作成功、SQL 执行失败无提示、表格编辑保存后数据不刷新的交互问题
- 🐛 fix(db): 表格数据页新增刷新入口,手写 DDL/DML 成功后自动刷新表列表或已打开表数据
- 🐛 fix(db): 表格 CSV 导出入口补齐执行反馈,导出内容复制到剪贴板

---

## [0.10.3] - 2026-06-17

### 修复
- 🐛 fix(ssh): SFTP 侧边栏等待终端通道 ready 后再初始化,避免 SSH 已连接但文件面板一直停在连接中,需要手动回车才显示目录

---

## [0.10.2] - 2026-06-17

### 修复
- 🐛 fix(ui): 修复缩小窗口后右上角最大化和关闭按钮被标题栏内容挤出不可见的问题
- 🐛 fix(excel): 修复按选中列去重到新 Sheet 后保存按钮不可用,导致新 Sheet 无法写回原文件的问题
- 🐛 fix(excel): 表头筛选弹框新增每个值的出现次数统计

---

## [0.10.1] - 2026-06-17

### 修复
- 🐛 fix(redis): 修复切换 DB 后 KeyBrowser 可能抢在 `SELECT` 完成前扫描,导致 key 偶发不显示的问题
- 🐛 fix(redis): 修复 Redis `SCAN` 空页但 cursor 未结束时误显示空列表的问题,并对增量加载结果去重
- 🐛 fix(redis): 修复跨 DB 同名 key 复用旧编辑 tab、重复点击 key 不刷新内容导致数据不显示的问题
- 🐛 fix(redis): Redis Stream key 支持读取并以 JSON 文本展示

---

## [0.10.0] - 2026-06-17

### 新增
- ✨ feat(excel): 删除重复项新增按选中列去重并输出到新 Sheet,保留原表数据
- ✨ feat(excel): 表头筛选菜单新增总行、非空、空白与 Distinct Count 计数
- ✨ feat(excel-ai): AI 助手支持按指定列或当前选中列去重并输出到新 Sheet,重复列值只保留首次出现的整行数据

---

## [0.9.0] - 2026-06-17

### 新增
- ✨ feat(excel-ai): AI 助手接入高级 Excel 工具,支持批量区域写入、公式填充、表头重命名、查找替换、Sheet 新增/删除/重命名/切换、表头样式和写入自动筛选
- ✨ feat(excel): 支持 Ctrl/Cmd + 单元格右下角填充柄拖拽,把源单元格批量赋值到目标区域
- ✨ feat(sidecar): Excel/CSV sidecar 新增 `writeHeaders`;Excel 新增 `styleHeader`,用于 AI 修改表头和保存表头样式

---

## [0.8.0] - 2026-06-17

### 新增
- ✨ feat(excel): Excel 右侧接入 AI 助手,支持读取当前表上下文、读取数据、写单元格、插入/删除行列、排序、筛选、冻结、去重与保存,工具执行后表格实时更新
- ✨ feat(excel): 表头显示导入文件第一行字段名,并新增 WPS/Excel 风格列头筛选入口
- ✨ feat(excel): 支持拖拽 `.xlsx/.xls/.csv` 文件到 Excel 视图后直接导入打开
- ✨ feat(excel): 单元格支持鼠标拖拽框选、Shift 扩展选择、Ctrl/Cmd 非连续多选和右键保留选区

### 修复
- 🐛 fix(excel): Ribbon「数据」「视图」改为可切换工具页,避免看起来无法点击
- 🐛 fix(ssh): MFA/2FA 终端右侧 SFTP 复用已验证 SSH session,不再二次登录导致无法使用
- 🐛 fix(ssh): 移除 SSH 300 秒空闲断线配置,并禁止 MFA/2FA 会话自动重连反复弹验证码

---

## [0.7.1] - 2026-06-17

### 修复
- 🐛 fix(excel): 修复 ExcelView 打开成功后更新 `lastUsedAt` 触发 watcher 循环重开,导致页面一直显示加载中的问题

---

## [0.7.0] - 2026-06-16

### 新增
- ✨ feat(csv): CSV 文件作为 ExcelView 一等编辑体验接入 — 打开后按单 Sheet 工作簿展示,支持单元格编辑、保存、插入/删除行列、排序、查找替换、删除重复项、复制粘贴、撤销/重做和本地冻结视图
- ✨ feat(sidecar): CSV sidecar 补齐 `readSheet/writeCells/insertRows/deleteRows/insertCols/deleteCols/sortRows/findReplace/removeDuplicates` 等 sheet-like RPC,并在启动握手中校验关键 CSV 方法

### 修复
- 🐛 fix(excel): 删除重复行按最大列宽补齐尾部空单元格后再生成去重 key,避免 `a` 和 `a,` 被误判为不同记录
- 🐛 fix(csv): CSV 读取允许可变列数(`FieldsPerRecord = -1`)并在前端展示时按最大列宽补齐,避免短行/长行文件打开失败或列错位

### 测试
- ✅ test(sidecar): 增加 CSV 可变列读取、写入保存、插删行列、排序、查找替换和删除重复项测试

---

## [0.6.0] - 2026-06-16

### 新增
- ✨ feat(excel): Excel 模块升级为工作簿编辑体验 — 新增 Ribbon 工具区、名称框、公式栏、底部选区统计、Sheet 新建/删除/重命名、右键菜单、Ctrl+C/V/X、Shift 扩展选区、撤销/重做、冻结表头/首列/窗格、自动筛选、排序与查找替换
- ✨ feat(sidecar): Excel sidecar 新增 `insertRows/deleteRows/insertCols/deleteCols/sortRows/findReplace/freezePanes/autoFilter` RPC,结构性编辑可真实写入内存工作簿并等待保存

### 修复
- 🐛 fix(excel): 修复单元格编辑写回行号偏移错误,避免编辑第一条数据时覆盖第 1 行表头
- 🐛 fix(excel): 筛选视图下编辑单元格会映射回原始行号,避免写错文件行
- 🐛 fix(excel): 公式单元格读取时保留 `=FORMULA` 文本,写入 `=` 开头内容时使用 Excel 公式而不是普通字符串

### 测试
- ✅ test(sidecar): 增加 Excel 写入偏移、公式读取、插删行列、查找替换与排序回归测试

---

## [0.5.2] - 2026-06-15

### 修复
- 🐛 fix(sidecar): release 构建强制同步最新 Sidecar 到 Tauri target 目录,避免运行时优先加载历史二进制
- 🐛 fix(db): Sidecar 启动时校验协议版本和关键 RPC 方法,彻底避免点击表后才出现 `Method not found`
- ✅ test(sidecar): 增加数据库关键方法注册回归测试

---

## [0.5.1] - 2026-06-15

### 安全
- 🔧 refactor(security): 资产密码、私钥、跳板机凭据与 AI API Key 迁移到系统 Keyring,SQLite/localStorage 只保留引用
- 🐛 fix(db): MySQL/ClickHouse 动态标识符统一转义,补齐查询迭代错误检查

### 修复
- 🐛 fix(sidecar): stdin/stdout 读写拆分,支持按请求 ID 并发关联响应并增加 120 秒超时
- 🐛 fix(sftp): 取消或失败传输仍会发送终态事件并清理取消令牌
- 🐛 fix(startup): 数据库与 Sidecar 在窗口可用前完成初始化,消除首次加载竞态
- 🐛 fix(build): Sidecar 构建脚本跨平台化,仅 Windows release 使用 `windowsgui`

### 改进
- ⚡ perf(frontend): Vue/Vuetify、CodeMirror、xterm 拆分为独立缓存 chunk
- ✅ test(ci): 增加 RPC 并发/大消息、SQL 标识符测试及前端/Rust/Go 质量工作流
- 🔧 chore(rust): 全量 `cargo fmt`,清除 `clippy -D warnings` 问题

---

## [0.5.0] - 2026-06-12

### 新增
- ✨ feat(db): 新增 ClickHouse 数据库连接支持 — Go sidecar 28 个 RPC 方法(23 个 MySQL 对齐 + 3 个特有元数据)、Rust 透传、前端复用 DbView.vue
- ✨ feat(home): Quick Actions 4 张卡片接入点击(SSH/数据库/Docker/AI) — 资产数为 0 时弹新建 dialog,有多条时跳最近一条,单条直接开
- ✨ feat(home): 完全空态欢迎卡 — 零资产时显示「欢迎使用 StarHub」+ 渐变标题 + 双 CTA 按钮
- ✨ feat(layout): 顶栏 ⌘K/Ctrl+K 快捷键聚焦搜索框(之前 kbd 提示是装饰,按了没反应)
- ✨ feat(layout): 顶栏搜索实时下拉 — 输入时显示前 8 个匹配资产,↑↓/Enter 选中,Esc 关闭
- ✨ feat(layout): 头像下拉菜单新增「数据库」「Docker」快捷入口,带 Esc 关闭支持
- ✨ feat(dialog): NewConnectionDialog 新增 `initialType` prop — 从顶栏菜单/Quick Action 进入时跳过 type 选择页,直达对应配置
- ✨ feat(error): 全局 ErrorBoundary 组件 — 任意子组件渲染错误时显示友好错误页(重置视图/复制堆栈/重新加载),避免整页白屏
- ✨ feat(settings): SettingsView 补 2 个 tab:「通用」(启动行为/最大 tab 数/关闭确认,localStorage 持久化)、「关于」(版本/GitHub/许可证/检查更新占位)
- ✨ feat(welcome): 欢迎页 CAPABILITIES 卡片接入点击(SSH/数据库/Docker) — 有同类资产跳最近一条,0 资产弹新建 dialog(预设类型);数据库/Docker P1 升 P0;移除 AI 助手卡片;移除「测试连接」按钮
- 🌐 i18n: 新增 `home.recent / assets / quickActions / emptyWelcome / tryAi / subtitle / settings.general* / about*` 等 key,中英文同步
- ✨ feat(ssh): **新增 `ssh_exec` Tauri 命令** — 在已有 SSH 会话上跑任意命令,自动管理 channel、超时、EOF,给仪表盘拉系统指标用
- ✨ feat(dashboard): **HomeView 仪表盘全部接入真实数据** — 顶部 4 张统计卡(总资产/SSH/数据库/Docker)、SVG 自绘资产类型分布环图、近 7 天使用频次柱状图、数据库子类型分布、收藏统计
- ✨ feat(dashboard): 新组件 `StatCard` / `charts/DonutChart` / `charts/BarChart` — 纯 SVG/CSS 自绘,不引入 ECharts
- ✨ feat(dashboard): SshDashboard 改真实数据 —— `cat /proc/meminfo` / `cat /proc/loadavg` / `nproc` / `df -P` / `uname -a` / `hostname` / `cat /proc/uptime` 并发采集,前端在 `utils/sshMetrics.ts` 解析
- ✨ feat(dashboard): DockerDashboard 改真实数据 —— `docker_list_containers` + `docker_list_images` 真实 RPC,运行/暂停/停止数从 `state` 字段实时统计
- ✨ feat(dashboard): DbDashboard 改真实数据 —— Redis 走 `redisInfo` + `redisDBSize` 解析(版本/内存/键数/命中率/ops),MySQL 跑 `SHOW GLOBAL STATUS` + `SHOW GLOBAL VARIABLES` + `information_schema.tables` 解析连接数/慢查询/缓冲池命中率/表数/数据大小
- ✨ feat(util): `utils/assetStats.ts` —— 从 asset 数组派生 6 类指标(类型分桶/收藏/7 天活跃/标签云/数据库子类型),纯函数无副作用
- ✨ feat(util): `utils/sshMetrics.ts` —— 解析 `/proc/meminfo`、`/proc/loadavg`、`df -P`、`uname -a`、`/proc/uptime` 的纯函数集合
- ✨ feat(util): `utils/dbMetrics.ts` —— 解析 Redis INFO 文本 / MySQL `SHOW STATUS` QueryResult 的纯函数集合
- 🌐 i18n: 新增 `home.stat* / activityTitle / typeDistribution / last7Days / dbBreakdown / justNow / minutesAgo / ...` 等 18 个 key,中英文同步

### 修复
- 🐛 fix(layout): 顶栏搜索框 kbd 提示对应的快捷键 ⌘K 全局监听,按了无效
- 🐛 fix(home): Quick Actions 4 张卡片原本无 `@click`,看着像入口实际点不动
- 🐛 fix(home): 第三节标题误写为「搜索」,实际是 Quick Actions
- 🐛 fix(welcome): 欢迎页「数据库」/「Docker」CAPABILITIES 卡片原标 disabled-card 无点击
- 🐛 fix(asset): **删除连接报错「Asset not found」** —— 路由 params.id 是 instanceId 而非 assetId,旧判断 `=== target.id` 永远为 false,导致删完 tab 路由不跳回,tab 渲染时资产不存在抛错;改用 `tabsToRemove.some(t => t.id === route.params.id)` 精确匹配
- 🐛 fix(tab): SshTerminal / DbView / DockerView mount 时若 asset 不存在,自动 router.push('/'),避免卡在空 tab 触发 ErrorBoundary
- 🐛 fix(dashboard): **SshDashboard / DockerDashboard / DbDashboard 三个单资产仪表盘指标全是 mock 数据** —— 现已全部改接真实 RPC,具体见上方「新增」中三条 feat(dashboard)
- 🐛 fix(home): HomeView 主页内容过单薄,只展示最近 6 张资产卡,看起来像假数据;现已扩充为 6 段(统计/分析/数据库分布/最近/全部/快捷操作),全部基于真实 assetStore
- 🐛 fix(asset-tree): **点击侧边栏 db 资产完全无反应** —— `connectToAsset()` 里有 `if (asset.type !== 'ssh') return`,db/docker 被直接吞掉;现 db 走 addTab + 路由到 `db-mysql` / `db-redis`(复用 `openInNewTab` 的现成逻辑)
- 🐛 fix(db-view): **MySQL 数据库树形菜单一次性并行加载所有 db 的所有表** —— 连接成功后立即 `loadAllTables()` 并行调 `mysqlListTables` 给每个 db,在企业内网几十上百个 db 的场景下,既慢又容易因为某个无权限 db 拖垮整次连接;现改为**懒加载** —— 只预加载第一个非系统 db,其他 db 保持收起+未加载,等用户点 toggle 时再单独 `loadTablesForDb`
- 🐛 fix(db-view): **DbView 多个 catch 块只 console.warn 不通知用户** —— 报错用户看不见,就感觉"没反应";现 connect / list databases / load tables 失败都会通过 `useNotifyStore` 弹 toast;树上 db 加载失败时,inline 显示错误消息 + 重试按钮(不弹 toast,避免反复点的时候太吵)
- 🎨 style(ssh): SSH 表单认证方式改为 4 颗互斥 chip 单选组(密码 / 私钥 / 密码+私钥 / MFA/2FA),新增 `.auth-chip` 通用样式(走 `--cyan` token),MFA 详情折叠区并入右列与 chip 联动;旧 `usePasswordAuth` / `useKeyAuth` / `mfaEnabled` 三 bool 同时保留向后兼容
- 🎨 style(design-system): cyber.css 新增 `.auth-chip` / `.auth-chip-group`(互斥单选胶囊),复用已有的 `--cyan` + `--hover-cyan` + `--focus-cyan` token,可被 DB/Redis 等认证方式复用
- 🐛 fix(ssh): **MFA 模式下点「测试连接」会卡 6 分钟才报错** —— 后端 `test_ssh_connection` 用局部 `pending_kb` map,前端 `ssh_kb_response` 走全局 `manager.pending_kb`,通道对不上,server 端 oneshot 等满 360s 才超时;改为测试连接也走全局 `pending_kb`(测试结束统一清理防 map 膨胀),前端在表单里挂一个临时 `KbInteractiveDialog` 监听 `ssh:kb-interactive:<testId>` 弹密码
- 🎨 style(design-system): cyber.css 新增 `.auth-chip` / `.auth-chip-group`(互斥单选胶囊),复用已有的 `--cyan` + `--hover-cyan` + `--focus-cyan` token,可被 DB/Redis 等认证方式复用

---

## [0.4.0] - 2026-06-10

### 新增
- ✨ feat(elasticsearch): 新增 Elasticsearch 完整支持 — Go sidecar 19 个 RPC 方法、Rust 透传、前端 ElasticsearchView.vue 四 Tab 视图(概览/搜索/索引/导入导出)
- ✨ feat(elasticsearch): DSL 查询编辑器 + 表格/JSON 双视图搜索结果 + 索引字段映射树形展示 + 集群健康仪表板

---

## [0.3.0] - 2026-06-06

### 新增
- ✨ feat(asset): 资产管理 CRUD — 完整对接 SQLite，新建/编辑/删除/收藏/搜索
- ✨ feat(ssh): 跳板机 (ProxyJump) 支持 — 通过跳板机连接目标主机，跳板机独立认证
- ✨ feat(ssh): 私钥「从剪贴板粘贴」按钮 — 支持从 Vault / 1Password 复制私钥
- ✨ feat(ai): AI 助手基础集成 — 支持 Claude / GPT，自然语言对话界面
- 🐛 fix(sidecar): Sidecar 路径解析 — 使用 current_exe() 替代 current_dir()，兼容开发和打包环境
- 🐛 fix(sidecar): Go Sidecar 编译目标修复 — GOOS=windows GOARCH=amd64
- ✨ feat(sftp): 文件操作 — 列目录、上传、下载、删除、重命名、新建目录
- ✨ feat(sftp): 断点续传支持
- ✨ feat(sftp): 文件搜索（glob 模式）
- ✨ feat(sftp): 权限修改（chmod 对话框）
- ✨ feat(sftp): 文件预览（文本 + 图片）
- ✨ feat(sftp): 右键上下文菜单
- ✨ feat(sftp): 面包屑路径导航
- ✨ feat(ssh): 终端 / SFTP 分栏可拖拽（默认 65:35,记忆到 localStorage,双击重置）
- ✨ feat(layout): 标签页右键菜单 + Ctrl/Cmd+W 关闭 + 鼠标中键关闭

### 修复
- 🐛 fix(ssh): 「测试连接」按钮不可用 —— 后端缺少 `test_ssh_connection` 命令
- 🐛 fix(sftp): 冷启动首次进入 SSH 标签,SFTP 报 "Session not found" —— SftpBrowser 等待 SSH connected=true 后再发 sftpList
- 🐛 fix(sftp): SFTP 缩窄后文件名列被压扁消失 —— name 列改为 `minmax(140px, 1fr)`,并加上 resize handle

### 改进
- 🎨 style(design-system): SSH 表单 host/port 比例收紧(端口固定 90px)
- 🎨 style(layout): 顶部"+"按钮克制化、状态栏增加 SFTP 计数、欢迎页 4 卡 + P0/P1 chip
- 🎨 style(layout): 状态栏时钟改 1s 间隔 HH:MM:SS,标签页关闭按钮默认半透明

---

## [0.2.0] - 2026-06-04

### 立项
- 🎉 **项目正式立项**(StarHub)
- 完成产品定位与目标用户分析
- 完整功能列表(280+ 子功能,带 P0/P1/P2/P3 优先级)

### 架构
- ✅ 整体架构定稿:5 层分层 + 三进程模型(Tauri 主进程 / WebView / Go Sidecar)
- ✅ 技术选型定稿:**Tauri 2 + Vue 3 + Rust + Go**
- ✅ 数据库驱动决策:Go Sidecar(从原 Node.js 升级,理由:静态二进制、PG/Redis 生态更强、与 Rust 同编译型语言)
- ✅ 通信协议:stdio JSON-RPC(Rust ↔ Go)
- ✅ 选型对比完成:Tauri vs Electron、Go vs Node、Go DB 驱动生态
- ✅ 数据模型:SQLite + 系统 Keyring
- ✅ 安全设计:三层信任边界、CSP、Keyring、审计日志
- ✅ 跨平台打包:Win/macOS/Linux + 代码签名
- ✅ MVP 周期 3-4 月、3 人团队、成本 40-50 万

### 文档
- 📋 技术方案文档 v0.2(14 章,49012 字节)
- 📐 架构图 HTML v0.2(10 章节,48303 字节)
  - 分层架构图、进程模型图、Mermaid 流程图
  - 三大数据流示例(SQL 查询、SSH 命令、AI 排障)
  - 模块卡片、数据模型 ER 图、路线图时间线
  - 性能指标、团队配置、风险与对策

### 工程
- MIT License 开源
- 仓库地址:https://github.com/dabaicai001/star-dsh-desktop

---

## 历史

- **v0.1 (2026-06-04)** — 初版,Sidecar 选用 Node.js(后改为 Go)
- **v0.0** — 内部调研
