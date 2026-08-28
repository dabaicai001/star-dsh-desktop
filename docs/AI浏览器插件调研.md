# AI 浏览器插件调研(内嵌于 Tauri,不外开浏览器)

> 变更记录
> - 2026-08-29 初稿:需求解读、候选方案对比、推荐架构、落地路线与风险。
> - 2026-08-29 定稿并落地(v0.103.0):采用方案 A,窗口形态按需求调整为
>   **独立无痕 Tauri 窗口**(非主窗口内子 webview),M1+M2+M3 一次交付,
>   实现细节见 3.5 节;同源修复「主窗口关闭时其余窗口不跟随关闭」。

## 1. 需求解读

让 AI 助手具备「操作浏览器」的能力,关键约束:

1. **浏览器必须内嵌在 Tauri 应用内**(独立 Tauri 窗口),禁止外开 Chrome/Edge 等独立浏览器进程窗口;
2. **无痕模式**(InPrivate / nonPersistent / ephemeral,不共用主界面登录态);
3. 用户全程可见 AI 的每一个操作;
4. AI 通过 Function Calling 全权驱动:导航、点击、输入、滚动、读取页面内容、截图、任意 JS;
5. 与 StarHub 现有体系一致:工具经 `packages/starhub/tools` 桥注册,风险分级走 `approval-bridge`,不改 DSH 内核。

## 2. 候选方案对比

### 方案 A:Tauri 原生子 Webview + JS 注入 / CDP(推荐)

Tauri 2(wry)支持**同一窗口内嵌多个 webview**:`tauri::webview::WebviewBuilder` 构造子视图,`window.add_child(webview, position, size)` 贴到主窗口指定区域。这个子 webview 就是「应用内浏览器」,加载任意 URL,React 侧提供地址栏/前进后退/标签条。

**AI 控制通道(两层,按平台能力自动降级):**

| 层 | 平台 | 机制 | 能力 |
|---|---|---|---|
| 增强层 | Windows(WebView2) | `ICoreWebView2.CallDevToolsProtocolMethod`(真 CDP),经 `webview.with_webview()` + `webview2-com` crate | Runtime.evaluate(awaitPromise/returnByValue)、DOM 查询、Input.dispatchMouseEvent/insertText、Page.captureScreenshot、Network 拦截 —— 等同 Playwright 内核 |
| 兜底层 | macOS(WKWebView)/ Linux(WebKitGTK)/ Windows 兜底 | `webview.eval(js)` 注入脚本,结果经 `window.__TAURI_INTERNALS__.invoke('browser_tool_result', …)` oneshot 回传 | 点击/填表/滚动/DOM 提取均可做;截图在 macOS/Linux 需借助 CDP 缺席时的替代(见风险节) |

- **优点**:零新增渲染引擎,安装包体积不变(复用系统 webview);站点兼容性 = 系统 webview(Windows 上是 Edge Chromium,兼容性极好);与现有 `web_gateway`(SSH 出口代理)天然衔接,可直接浏览内网站点。
- **缺点**:跨平台控制 API 不统一,需抽象一层 `BrowserBackend` trait(CdpBackend / EvalBackend);eval 回传要自己做异步桥。

### 方案 B:内嵌 CEF(Chromium Embedded Framework)

社区有 `cef-rs` 与实验性 tauri-cef 集成,得到完整 Chromium + 全套 CDP。

- **优点**:三平台行为完全一致,CDP 全家桶,可直接对接 Playwright/chromiumoxide。
- **缺点**:安装包 +100MB 起步(冲击「DEB/RPM/Windows < 35MB」的性能目标);打包、签名、跨平台构建复杂度高;维护成本大。**不推荐**作为首选。

### 方案 C:Playwright / headless Chromium

- headless 模式不可见,不满足「在 Tauri 里看到并操作浏览器」;headed 模式即外开浏览器,被需求明确禁止。且需随包分发 Chromium(~150MB)。**排除**,仅记录为「不可见批量执行任务」的远期补充选项。

### 方案 D:Servo 等可嵌入引擎

成熟度不足以承载真实站点,**排除**。

## 3. 推荐架构(方案 A)

```
┌─ React 浏览器面板(DSH 插件,slots.inject 注入功能页/overlay)
│    地址栏 / 导航按钮 / 页面视口占位 rect
│         │  Tauri command:browser_panel_sync(rect, visible)
├─ Rust 主进程 src-tauri/src/browser/
│    ├── mod.rs        面板生命周期(创建/移动/隐藏子 webview)
│    ├── backend.rs    BrowserBackend trait:navigate/click/type/eval/screenshot/dom
│    ├── cdp.rs        Windows:webview2-com → CallDevToolsProtocolMethod
│    └── eval_bridge.rs 跨平台兜底:注入脚本 + invoke oneshot 回传
├─ AI 工具(packages/starhub/tools 新增 browser_* 定义,走现有 starhub/tool.execute 桥)
│    browser_navigate / browser_click / browser_type / browser_scroll
│    browser_extract(结构化 DOM 摘要)/ browser_screenshot / browser_eval(高危,需确认)
└─ 复用:approval-bridge(风险分级确认卡)、web_gateway(内网/SSH 出口访问)
```

### 3.1 AI 如何「看见」页面

参照 browser-use / chrome-devtools-mcp 的通行做法,双通道:

1. **DOM 序列化脚本**(注入,跨平台一致):遍历 DOM,过滤不可见元素,给可交互元素(a/button/input/[role] 等)分配递增序号 `data-sh-bid`,输出「编号 + 标签 + 文本 + 关键属性」的紧凑文本树。AI 点击/输入时只需回传序号,避免让模型生成脆弱 CSS 选择器。
2. **截图**(视觉模型):Windows 走 CDP `Page.captureScreenshot`;macOS 走 `WKWebView.takeSnapshot`(需在 wry 层补暴露,属最小 vendor 补丁或 eval 退化为不截图);Linux WebKitGTK 有 `webkit_web_view_get_snapshot`,同样需要薄封装。MVP 可先只在 Windows 提供截图工具,其余平台工具降级为「仅 DOM 文本」。

### 3.2 AI 如何「动手」

- `browser_navigate(url)`:子 webview 直接 `navigate`。
- `browser_click(id)` / `browser_type(id, text)` / `browser_scroll(dir|selector)`:按序号定位元素,注入 JS 分发事件;Windows 增强为 CDP `Input.dispatchMouseEvent/insertText`(更接近真实输入,能过更多站点的机器人检测)。
- `browser_eval(js)`:**高危工具**,走 approval-bridge 强制确认卡。

### 3.3 安全隔离(重点)

子 webview 加载的是**任意外部网页**,必须与 StarHub 主界面特权面隔离:

1. 子 webview **不注入主界面的初始化脚本**,IPC 命令白名单仅暴露 `browser_*` 少量命令(capabilities 按 webview label 收窄,项目已有 detach-* 窗口的先例);
2. Cookie/登录态用 WebView2 独立 user data folder(或共享,做成设置项);
3. 导航到敏感操作(表单提交、支付域)前的动作确认复用现有审批体系;
4. 代理访问内网时沿用 web_gateway 的 URL 形态,不另开特权通道。

### 3.4 与现有代码的结合点

| 结合点 | 位置 | 用法 |
|---|---|---|
| 工具桥 | `packages/starhub/tools`(starhub/tool.execute) | 新增 browser_* 工具定义,零新机制 |
| 审批 | `packages/starhub/approval-bridge` | 写操作(navigate 外的一切)分级为 ask |
| UI 注入 | `packages/starhub/client-nav` 的 `slots.inject('shell.overlay' / 功能页)` | 浏览器面板作为新 overlay/页签,已有 5 处 overlay 先例 |
| 内网访问 | `src-tauri/src/ssh/web_gateway.rs` | 浏览器面板 URL 支持 `http://127.0.0.1:<port>/__proxy__/…` 形态 |
| Tauri 权限 | `src-tauri/capabilities/` | 新增 browser 子 webview 的收窄权限集 |

## 4. 落地路线(建议)

| 里程碑 | 内容 | 规模预估 |
|---|---|---|
| M1 MVP | 子 webview 面板(React 地址栏 + Rust add_child);eval 兜底实现 navigate/click/type/scroll/extract;工具桥接入 6 个 browser_* 工具;审批分级 | 1–2 周 |
| M2 Windows 增强 | webview2-com CDP 后端:真实输入事件、Page.captureScreenshot、awaitPromise eval | 3–5 天 |
| M3 感知增强 | DOM 序列化脚本打磨(iframe/Shadow DOM/可访问性树合并)、macOS/Linux 截图薄封装、设置项(共享 Cookie、默认搜索引擎) | 1 周 |
| M4(可选) | 多标签、下载管理(复用 main.rs 已有 on_download 模式)、会话录制回放 | 视需求 |

## 3.5 实现定稿(v0.103.0,M1+M2+M3 一次交付)

与 3 节推荐架构的差异:窗口形态由「主窗口内子 webview 面板」改为**独立无痕
WebviewWindow**(`ai-browser` label,`incognito(true)`,wry 0.55 三平台原生支持
InPrivate / nonPersistent DataStore / ephemeral WebContext),AI 不占用主界面,
用户可全程观察;地址栏等浏览器 chrome 不做(AI 全权驾驶,用户只观察)。

| 层 | 落点 |
|---|---|
| 窗口/生命周期 | `src-tauri/src/browser/mod.rs`(ensure_window 幂等创建/聚焦;窗口销毁时 BrowserManager 收口在途 eval) |
| 注入脚本 | `src-tauri/src/browser/script.rs`(编号元素 DOM 序列化,Shadow DOM / 同源 iframe 递归;click/type/select/scroll/pressKey 原语;eval 结果经 `browser_internal_result` IPC oneshot 回传) |
| Windows CDP(M2) | `src-tauri/src/browser/cdp.rs`(`ICoreWebView2.CallDevToolsProtocolMethod` 异步回调:Runtime.evaluate awaitPromise+returnByValue、Page.captureScreenshot、Input.dispatchMouseEvent/insertText/dispatchKeyEvent 可信输入;失败自动回退 IPC/JS 注入) |
| macOS 截图(M3) | `src-tauri/src/browser/snapshot_macos.rs`(WKWebView takeSnapshot → TIFF → NSBitmapImageRep → PNG) |
| Linux 截图(M3) | `src-tauri/src/browser/snapshot_linux.rs`(WebKitGTK get_snapshot → cairo Surface → PNG;webkit2gtk 与 wry 锁死 =2.0.2) |
| Tauri Command | `commands/browser.rs::browser_internal_result`(ai-browser 窗口唯一放行的命令,见 `capabilities/browser.json` + `permissions/commands.toml` 的 `browser-eval-result`) |
| 工具桥 | `packages/starhub/tools` BRIDGED_TOOLS +14 个 browser_*;`harness/tools.rs` BROWSER_TOOLS 进程内分发(不依赖前端窗口存活) |
| 审批分级 | `packages/starhub/approval-bridge`:观察类(state/extract/screenshot/scroll/back/forward/reload)放行;动作类(open/navigate/click/type/press_key/select_option)软 ask;`browser_eval` 恒 ask 且 hard(never 全访问也不放行) |
| 关窗联动修复 | `main.rs` on_window_event:main CloseRequested 时销毁其余全部窗口(detach-*/ai-browser/screenshot-overlay),解决孤儿窗口悬挂 |

截图落盘为 PNG 文件返回路径(dsh 工具结果是文本通道,图像回灌模型待后续接
attachment 体系);`starhub_list_capabilities` 同步登记 browser 域。

## 5. 风险与注意事项

1. **wry 子 webview 的跨平台一致性**:三平台均支持 child webview,但定位/缩放(高分屏)行为有差异,面板 resize 同步逻辑要早测;
2. **截图能力不对称**:Windows CDP 截图开箱即用,macOS/Linux 需要 wry 层薄补丁(属 AGENTS.md 允许的「扩展点无法表达 + 改动最小」情形,须注释标注上游补丁);
3. **eval 异步回传**需自行实现 invoke oneshot 桥,注意页面导航中途的 pending 请求要超时清理;
4. **反爬/机器人检测**:eval 注入的 JS 点击在部分站点无效,这是 M2 引入 CDP 真实输入事件的主要动机;
5. **体积红线**:全程不引入 CEF/Playwright,守住 <35MB 安装包目标;
6. 本调研结论若进入实施,按 AGENTS.md 第 12.2 节同步 `docs/技术方案.md`(新增浏览器域)、`docs/架构图.html` 与技术栈表。
