# AI 桌面自动化(computer-use)— 设计文档

- 日期:2026-08-28
- 目标版本:v0.104.0(Phase 1)
- 状态:草案(待评审)

## 1. 背景与目标

### 1.1 需求

用户已确认方向:**让 AI 操作本机任意第三方桌面应用**(通用 computer-use),而非仅操作 StarHub 自身窗口。典型场景:

- AI 帮用户在某个没有 CLI/API 的桌面软件里完成重复操作(点按钮、填表单、导出文件);
- 运维场景联动:AI 在 SSH/数据库里查到结论后,操作本机的运维客户端(如打开某个 GUI 工具、粘贴结果);
- 与 AI 浏览器互补:浏览器管网页,桌面自动化管原生应用。

### 1.2 能力分层

| 层 | 能力 | 风险 | 本期 |
|---|---|---|---|
| L1 感知 | 屏幕截图、窗口枚举、前台窗口查询 | 只读 | ✅ Phase 1 |
| L2 基础操作 | 鼠标移动/点击/滚动、键盘输入/按键、窗口聚焦 | 写操作 | ✅ Phase 1 |
| L3 语义操作 | UI 元素树(UIA)读取、按语义定位元素再操作 | 写操作 | ❌ Phase 3 |

L1+L2 已足够支撑「截图 → 看图 → 点坐标 → 打字」的 computer-use 闭环;L3 是体验升级(从猜坐标到找控件),单独分期。

### 1.3 Phase 1 范围(用户已确认)

- **仅 Windows**(主力平台,生态最成熟);macOS / Linux 留 Phase 2,架构上预留平台抽象。
- L1 + L2 全部能力。
- 审批、审计、安全边界一次配齐。

## 2. 现状与先例

本仓库已有一条完全同构的能力链路(AI 浏览器),本方案照抄其模式:

1. **Rust 主进程**持有底层能力:`src-tauri/src/browser/`(BrowserManager)+ `src-tauri/src/commands/browser.rs`(Tauri Command);
2. **工具桥**:`packages/starhub/tools`(StarHub 本地插件,不在上游)用 `ctx.tools.register(defineTool(...))` 注册 `browser_*` 工具,执行体经 SDK stdio JSON-RPC 双向 request(`starhub/tool.execute`,参数 `{ sessionId, name, args }`)桥回 Rust 主进程;
3. **宿主路由**:`src-tauri/src/harness/mod.rs` 把 `starhub/tool.execute` 交给 `tools::execute_bridge_request`,再按工具名分发(`harness/tools.rs` 全局工具、`harness/domain.rs` 域工具,`browser_*` 在 Rust 内直接执行);
4. **审批**:`packages/starhub/approval-bridge` 在 `tools/pre-execute` 上按只读/风险分级升级为 ask,桥到前端确认卡;`browser_eval` 是「恒确认 + hard」档先例;
5. **审计**:`harness/events.rs` 按工具名前缀映射审计事件(`browser_*` → `browser.action`),落审计库并推前端事件。

桌面自动化与浏览器唯一的架构差异:**没有「拥有会话的前端面板」**——浏览器有独立窗口,桌面是整个屏幕。因此 `desktop_*` 工具全部在 Rust 主进程直接执行(与 `browser_*` 同档),不经前端面板分发,也不新增 Tauri Command 暴露面(capabilities 零改动)。

## 3. 总体架构

```
AI 会话(dsh)
  │ ctx.tools.register(desktop_*)        packages/starhub/tools(新增条目)
  │ starhub/tool.execute {sessionId,name,args}
  ▼
Rust 主进程 harness/mod.rs → tools::execute_bridge_request
  │ name 以 "desktop_" 开头 → 新增 desktop 分发(domain.rs 同款 match)
  ▼
src-tauri/src/desktop/            新增模块(对标 src/browser/)
  ├── mod.rs        DesktopManager:平台抽象 trait + Windows 实现
  ├── windows.rs    Win32 实现:窗口枚举 / 聚焦 / 前台查询
  ├── input.rs      enigo 封装:键鼠注入、坐标校验
  └── capture.rs    screenshots 封装:全屏/指定窗口截图 → PNG 落缓存目录
```

- **依赖选型**:`screenshots`(三平台截图)、`enigo`(三平台键鼠)、`windows-rs`(EnumWindows / GetForegroundWindow / SetForegroundWindow / GetWindowRect)。全部为主流维护中 crate,符合「优先用维护中的依赖而非手写」原则。
- **平台抽象**:`DesktopManager` 定义 trait,Phase 1 只提供 Windows 实现;macOS(AX/CGEvent)/ Linux(X11)在 Phase 2 加同 trait 的新实现,工具层不变。
- **确认语义**:tools 插件不做确认,分级全部落在 approval-bridge(见 §5)。

## 4. Phase 1 工具清单

工具命名沿用 `desktop_` 前缀;描述文案风格对齐现有工具(说明风险与确认行为)。

### 4.1 L1 感知(只读,自动放行)

| 工具 | 参数 | 返回 |
|---|---|---|
| `desktop_screenshot` | `windowId?` | 全屏(或指定窗口)截图 PNG 落应用缓存目录,返回路径+尺寸;与 `browser_screenshot` 同档:留档用,不回灌模型上下文 |
| `desktop_list_windows` | — | 可见顶层窗口列表:`[{id, title, processName, pid, rect, isMinimized}]`,按 z-order 排序 |
| `desktop_get_foreground_window` | — | 当前前台窗口的 id/title/processName/rect |

截图是否回灌模型上下文(图像输入)取决于模型多模态能力,Phase 1 先落盘留档,与浏览器一致;Phase 2 再评估接 `read_image` 式回灌。

### 4.2 L2 基础操作(写操作,全部需确认)

| 工具 | 参数 | 说明 |
|---|---|---|
| `desktop_focus_window` | `windowId` | 聚焦指定窗口(置前台);软确认档(对标 `browser_open`) |
| `desktop_click` | `x, y, button?` | 在屏幕坐标单击(left/right/middle,默认 left) |
| `desktop_double_click` | `x, y` | 双击 |
| `desktop_move_mouse` | `x, y` | 移动指针(用于 hover 触发) |
| `desktop_scroll` | `x, y, direction, amount?` | 在坐标处滚动 |
| `desktop_drag` | `fromX, fromY, toX, toY` | 拖拽 |
| `desktop_type` | `text` | 向当前焦点输入文本(Unicode) |
| `desktop_press_key` | `key` | 按键:Enter/Tab/Escape/方向键/组合键(`Ctrl+S` 语法,对齐 `browser_press_key` 的命名约定) |

坐标约定:**统一使用物理像素**(与 `desktop_screenshot` 输出一致,AI 看着截图给的坐标可直接用),Rust 侧内部完成 DPI 换算。这是最容易踩的坑,见 §7.1。

### 4.3 工具描述内置的安全提示

参照 `ssh_exec`/`db_query` 的写法,description 里明确:「所有写操作都会请求用户确认」「坐标基于最近一次 desktop_screenshot,界面变化后需重新截图」。

## 5. 安全模型

桌面操作的风险高于一切现有域(AI 面对的是用户真实桌面,点错即真实损失),采用**最严默认**:

### 5.1 审批分级(approval-bridge 扩展)

| 档 | 工具 | 语义 |
|---|---|---|
| 只读自动放行 | `desktop_screenshot` / `desktop_list_windows` / `desktop_get_foreground_window` | 与 `browser_state`/`browser_extract` 同档 |
| 软确认(never 全访问策略可放行) | `desktop_focus_window` | 非破坏 but 改变用户界面状态 |
| **恒确认 + hard** | 其余全部写操作(click/type/press_key/scroll/drag/move/double_click) | 对齐 `browser_eval` 档:每次调用都弹确认卡,确认卡上展示目标坐标/文本与目标窗口标题 |

确认卡信息增强:审批请求 payload 里附带「最近一次截图路径 + 目标坐标标记」,让用户确认时能看到 AI 要点哪里。具体渲染放 Phase 1 前端小改(approval 卡片复用现有组件,desktop 工具附加缩略图)。

### 5.2 全局开关

设置 → AI 助手新增「桌面自动化」总开关(默认**关**):关闭时 `desktop_*` 工具不注册进 tools 清单(模型根本看不到),避免默认扩大攻击面。开关状态存现有设置存储。

### 5.3 审计

- `harness/events.rs` 新增前缀映射:`desktop_*` → `desktop.action`,摘要含坐标/按键/目标窗口标题(脱敏:不记 `desktop_type` 的文本内容,只记长度,防密码类输入落审计库);
- 每次写操作自动先截屏留档(操作前快照),路径入审计记录,支持事后回放核对。

### 5.4 明确不做的

- 不做窗口白名单(Phase 2 再评估;Phase 1 靠恒确认兜住);
- 不尝试突破 UIPI / 安全桌面(见 §7.2):提权窗口操作失败就如实报错,不注入不降权。

## 6. 分发与路由改动点

| 文件 | 改动 |
|---|---|
| `src-tauri/src/desktop/` | 新增模块(§3) |
| `src-tauri/src/harness/tools.rs` 或 `domain.rs` | `execute_*` 分发新增 `"desktop_*"` 分支,调用 DesktopManager |
| `src-tauri/src/harness/events.rs` | 审计映射加 `desktop_` 前缀 |
| `vendor/deepseek-harness/packages/starhub/tools/src/index.ts` | `BRIDGED_TOOLS` 追加 §4 的工具定义(StarHub 本地包,不动上游内核) |
| `vendor/deepseek-harness/packages/starhub/approval-bridge/src/index.ts` | 新增 desktop 分级表与确认卡 payload 扩展 |
| 前端设置页 | 「桌面自动化」总开关 + 审批卡截图缩略图(StarHub 工作台侧,走插件槽位) |
| `capabilities/` | **零改动**(不经 Tauri Command) |

## 7. 已知坑与对策

### 7.1 DPI 缩放(最高危坑)

Windows 高分屏下「截图像素 ≠ 鼠标坐标」:截图是物理像素,`SendInput`/`enigo` 的坐标系取决于进程的 DPI awareness。对策:

1. 应用 manifest 声明 **Per-Monitor V2 DPI aware**(检查 `tauri.conf.json` 的 Windows manifest,没有则补),使 Win32 坐标即物理像素;
2. `DesktopManager` 内部仍保留 `physical ↔ logical` 换算层,单元测试覆盖 125%/150% 缩放;
3. 工具描述写死「坐标基于最近一次截图的物理像素」。

### 7.2 UIPI 与安全桌面

- 目标应用以管理员身份运行而 StarHub 未提权时,`SendInput` 会被 UIPI 静默吞掉。对策:操作后读回前台窗口/截图验证,失败报「目标窗口可能以管理员身份运行」;
- UAC 安全桌面、锁屏界面**无法自动化**,如实报错,不绕过。

### 7.3 坐标时效性

AI 基于截图给坐标,期间窗口可能移动/缩放。对策:`desktop_click` 执行前可选校验「目标坐标仍落在原窗口 rect 内」(带上次截图的窗口 id),不在则报错要求重新截图。

### 7.4 输入文本安全

`desktop_type` 可能输入密码等敏感内容:审计只记长度不记内容(§5.3);确认卡上展示文本(用户确认即知情)。

## 8. 测试

| 层 | 内容 |
|---|---|
| Rust 单测(`cargo test`) | DPI 换算、窗口枚举过滤(不可见/工具窗口)、坐标边界校验、按键语法解析(`Ctrl+Shift+S`) |
| 手动验证矩阵 | 100%/125%/150% 缩放 × (记事本/资源管理器/提权记事本) × 全部写工具,核对审计记录与操作前快照 |
| 回归 | `npm run cargo:check`、`npm run cargo:test`、vendor 侧 `pnpm typecheck`(tools/approval-bridge 改动) |

桌面自动化无头不可测的部分(真实键鼠注入)不进 CI,用手动矩阵 + 踩坑记录沉淀。

## 9. 分阶段 Roadmap

| 阶段 | 内容 | 版本 |
|---|---|---|
| Phase 1(本期) | Windows L1+L2、审批/审计/总开关、DPI 处理 | v0.104.0 |
| Phase 2 | macOS(AX 授权引导)/ Linux(X11;Wayland 声明受限)、截图回灌多模态、窗口白名单 | 视 Phase 1 反馈 |
| Phase 3 | L3 语义元素树(Windows UIA 先行):`desktop_element_tree` / 按语义定位点击 | 视反馈 |

## 10. 文档同步义务(落地时)

- `docs/技术方案.md` 加桌面自动化章节;`docs/架构图.html` 补模块;
- `AGENTS.md` 目录结构补 `src-tauri/src/desktop/`;技术栈表补 screenshots/enigo/windows-rs;
- 已知坑(DPI/UIPI)沉淀 `docs/踩坑记录.md` + `docs/已知坑索引.md`;
- CHANGELOG `[未发布]` 补条目,升次版本(新功能)。

---

*草案,评审意见请直接批注;确认后进入实施,实施计划另出 plan 文档。*
