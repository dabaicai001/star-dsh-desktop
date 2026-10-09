# 去 Tauri 化 M3:直播/接管面板化清单

> 配套 `docs/StarHub去Tauri化-迁移立项设计.md` §八 M3「面板化」与
> `docs/去Tauri化-M2-命令映射清单.md`(M2 已完成:工作台命令面 240 个 `ui.*`
> 方法 + iframe 搬入壳内主面板)。
>
> M3 目标:**直播/接管从「Tauri 独立窗口」变成「dsh 壳内面板 + 本地 WS 帧通道」**,
> 三个帧源(browser / Android / 沙箱桌面)逐个落地,延迟/画质实测过门槛。

## 一、形态确认(先钉死,别再问)

Tauri 时代直播/接管是**窗口面**:`WebviewWindow` + custom protocol
(`android-live://` / `sandbox-live://`)+ 自包含 HTML 页。舍弃 Tauri 后窗口栈
整体消亡,能力由三件套承接(**零 vendor 改动**):

```
源(browser / Android / 沙箱)──push_frame──▶ 帧枢纽 FrameHub
                                             │ broadcast + 环形重放
                                             ▼
                             本地 WS server(127.0.0.1 + 一次性 token)
                                             │ bridge 的 registerUpgrade 代理
                                             ▼
                                  dsh 壳内面板(canvas / img + 手势)
```

| Tauri 直播窗口面 | sidecar 帧出口 |
|---|---|
| `android-live://localhost/<serial>/*` | `ws://127.0.0.1:<port>/live/android:<serial>?token=…` |
| `GET frame.png`(轮询) | 二进制帧 `kind=1`(PNG)推送 |
| `GET video?since=`(scrcpy 增量) | 二进制帧 `kind=2`(H.264)推送 + 关键帧重放 |
| `POST /input` + `POST /takeover` | WS 文本消息 `{"t":"input"}` / `{"t":"takeover"}` |
| `live` / `scrcpy` 两张注册表 | `FrameHub` 的通道表 |
| 关窗口 → 停泵 + 回收 scrcpy | 最后一个订阅者离开即关通道(源自行回收) |

## 二、线上协议(新 crate `starhub-live` 钉死)

### 2.1 二进制帧

```
[u8 kind][u8 flags][u32 payload_len BE][payload…]
```

- `kind`:`1` = PNG 截图(轮询模式),`2` = H.264 annexb 包(scrcpy 模式);
- `flags`:仅 H.264 有意义——bit0 = 关键帧、bit1 = 配置包(SPS/PPS);
- 头部固定 6 字节,长度字段封顶 4MB(防畸形长度撑爆内存)。

与 Tauri 的 `video` 端点(`[u64 base][记录…]` + `since` 游标)不同:那边是
HTTP 拉取,这边是 WS 推送 + 「迟到者从最近可独立解码的帧重放」,语义等价
(新订阅者拿到关键帧),少一轮游标协商。

### 2.2 文本消息(JSON)

| 方向 | 消息 | 语义 |
|---|---|---|
| 服务端 → 客户端 | `{"t":"meta","mode","width","height","vw","vh","error","takeover"}` | 首屏 + 元数据变化(scrcpy 就绪即从 `frames` 升 `scrcpy`) |
| 服务端 → 客户端 | `{"t":"ack",…}` / `{"t":"error","error"}` / `{"t":"pong"}` | 应答 |
| 客户端 → 服务端 | `{"t":"ping"}` | 保活 |
| 客户端 → 服务端 | `{"t":"takeover","active":true}` | 接管开关(写帧枢纽) |
| 客户端 → 服务端 | `{"t":"input","action":{…}}` | 人工操作;**未接管直接回 `not in takeover`**(423 语义逐字保持) |
| 客户端 → 服务端 | `{"t":"close"}` | 主动断开 |

`action` 形状与 Tauri 直播页 POST /input 的 body **逐字对应**
(`{"type":"tap","x","y"}` / `swipe` + `ms` 钳制 50–5000 / `key` / `text`)。

### 2.3 鉴权(风险 R3 的落地)

- WS server **只绑 127.0.0.1**,绝不对局域网暴露;
- URL query 带**一次性 token**(`/live/<channel>?token=<t>`),握手时经
  `accept_hdr_async` 回调取出并**立即消费**;浏览器 `WebSocket` 不能带头,
  所以 token 只能走 query;
- 令牌兑换出的通道必须与路径声明的通道一致(防拿 A 通道令牌订阅 B 通道);
- 真正的 GUI 鉴权由 bridge 的 upgrade 路由负责——它持 token,不向下游泄露。

## 三、施工顺序

1. ✅ **帧枢纽底座 + Android 帧源**(本批):新 crate `starhub-live`
   (`frames` / `hub` / `ws` / `android` 四模块),sidecar 侧
   `live_runtime.rs` + `methods/ui_live.rs`,**6 个新方法**,方法面
   240 → **246**。
   - `ui.live_open`(开通道 + 端点 + 首个令牌)/ `ui.live_token`(补发)/
     `ui.live_status` / `ui.live_close` / `ui.live_list`;
   - 桥命令 `starhub/live.endpoint`(端点 + 路径前缀,给 bridge 的
     `registerUpgrade` 用);
   - Android 帧源从 `src-tauri/src/android/mod.rs` 的直播窗口面**零改动级**
     平移:scrcpy-server v2.7 推送 → `adb forward` → `app_process` 启动 →
     12B 帧元头解析 → 帧枢纽;轮询泵 400ms 兜底;接管输入经通道 mpsc 顺序
     `adb shell input`;失败原因写进通道元数据 `error`(面板展示,直播降级);
   - **两个 seam 改指帧枢纽**:`LiveLauncher` → `HubLiveLauncher`(模型面
     `android_open_live` 因此真的开通道,不再只发通知);`TakeoverState` →
     `HubTakeoverState`(域名工具执行点与面板读同一处,取代 Tauri 的
     `MemoryTakeover` 内存集合);
   - `ui.android_ui_open_live` 从「显式降级」变为**真开通道**(用户点按钮 =
     审批表达,与 Tauri 版 `ui_open_live` 同口径);
   - 环境变量:`STARHUB_LIVE_PORT`(0 = 内核分配)、`STARHUB_LIVE_DISABLED`、
     `STARHUB_SCRCPY_SERVER`(M4 provisioning 落盘后由 bridge 注入)。
2. ⬜ **browser 帧源**:CDP `Page.startScreencast` / 截图流 → 帧枢纽
   (引擎层随本批从 `src-tauri/src/browser` 平移,`starhub-domain-browser`
   增加 `BrowserEngine` seam)。
3. ⬜ **沙箱桌面帧源**:容器内 scrot/xdotool 编排 → 帧枢纽(复用 desktop 域
   已有的 `exec::ui_lifecycle` 授权模型)。
4. ⬜ **bridge 出口(TS 侧)**:`webServer.registerUpgrade` 把
   `ws://127.0.0.1:<port>/live/<channel>` 以带鉴权的 path 暴露给 GUI,
   令牌经 `ui.live_token` 现取现用。
5. ⬜ **`starhub-live` client 插件面板(TS 侧)**:canvas(WebCodecs 解码
   H.264)/ img(PNG)双模 + 手势输入 + 接管开关 + 模式徽章。
6. ⬜ **实测**:三类帧源的延迟/画质记录(交互延迟 ≤ 现窗口方案 1.5×,R2)。

## 四、三条不变量(与 Tauri 直播窗口逐字对齐)

1. **接管互斥**:接管开启期间 AI 写操作一律拒绝(不撤销授权)——域名工具的
   执行点经 `TakeoverState` seam 读帧枢纽,文案
   「用户正在直播窗口中接管设备操作,请稍后重试(接管不撤销授权)」不变;
2. **最后一位走即关**:最后一个订阅者离开 = 关窗口,源(泵 / scrcpy 子进程 /
   adb forward)当场回收,不泄漏;
3. **降级要说清**:scrcpy 不可用 / adb 缺失 / scrcpy-server 资源缺失等原因
   写进通道元数据 `error`,面板原样展示,直播走截图轮询兜底(与 Tauri 的
   meta 端点同语义)。

## 五、验收口径

- 每个 `ui.live_*` 方法一个 roundtrip 契约测试(`protocol.rs` 同纪律:
  单行 JSON、参数白名单、错误码、文案逐字);
- **真 WS 客户端端到端**:`live_frame_channel_roundtrips_through_the_real_binary`
    spawn 真二进制 → `ui.android_ui_open_live` 开通道 → 带令牌握手 → 收 meta
   → 未接管拒输入 → 接管后受理 → 令牌复用即拒 → 断开后通道关闭;
- `npm run verify:bridge-compat` 新增第 14 节:**93 → 105 项全绿**
  (Node 内置全局 `WebSocket` 走同一条链,不引第三方依赖);
- `cargo test`(sidecar-rust 全 workspace):新 crate **18 例** + sidecar lib
  **128 例** + protocol 集成 **34 例** 全绿;`cargo clippy` 对新代码零警告
  (`jsonrpc.rs` / `registry.rs` 的既有 fmt 漂移按纪律还原,不混入本批);
- `src-tauri` 仍 `cargo check` 通过(域 crate 的文本改动不破坏 Tauri 侧编译)。

## 六、契约变更登记(必须记)

| 契约 | 变化 | 理由 |
|---|---|---|
| 模型面 `android_open_live` 结果文本 | 「直播**窗口**已打开」→「直播**面板**已打开」;「**窗口内**勾选接管」→「**面板内**勾选接管」 | 承载物从窗口变成壳内面板;其余逐字不变 |
| `ui.android_ui_open_live` 返回 | 从「硬错误(指明 M3)」变为 `{endpoint, token, channel}` | M3 本批真开通道 |
| `starhub/android.takeover` 桥命令 | 仍受理(写帧枢纽),但主路径变成 WS `{"t":"takeover"}` | 少一次进程间往返;兼容旧 bridge |

## 七、仍挂着的事

- **`ui.alert_test_webhook` 降级**:要不要单独开一个「给 sidecar 加 reqwest」
  的小提交(`reqwest 0.12.28` 已在本地 registry 缓存里,离线可装)。
- **`npm run cargo:test`(src-tauri 全量)**:机器内存耗尽在链接阶段,
  `cargo check` / `check --tests` 均通过;建议内存宽裕时补跑。
- **凭据迁移(§六/R7)**:Tauri SQLite + Keyring → sidecar JSON + dsh credentials,
  native keyring 有意延后。
