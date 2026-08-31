# StarHub Android 实体机直连(adb)— 设计文档

- 日期:2026-08-30
- 目标版本:v0.107.0
- 状态:已拍板,随 v0.107.0 落地

## 1. 定位与拍板

让 AI 直接操作**实体 Android 手机**。用户拍板:

1. 通道用 **adb**(开发者模式),不做 Android-in-Docker(KVM/binder 内核模块在
   Docker Desktop 下不可用,见 2026-08-28 桌面设计 §7 之外的新调研);
2. **不动现有沙箱桌面**(Ubuntu 容器沙箱原样保留),Android 是独立新功能;
3. 与沙箱桌面一样要有**直播窗口**(围观/接管);
4. 用户没有 adb 时:工具报错文本给出安装引导,并允许 AI 用本机工具
   (pwsh/bash)代为安装(winget/brew/apt 装 platform-tools)。

### 1.1 为什么 adb 是唯一主通道

Docker 容器共享宿主内核,Android 依赖 binder/ashmem 内核驱动,两条容器路线
(redroid 需宿主内核模块;docker-android 模拟器需 /dev/kvm)在 Windows/macOS
Docker Desktop 下均不可用。adb 是纯用户态工具,三平台通吃、零手机端安装、
能力完整(截屏/触控/输入/shell/App 管理)。替代方案(无障碍代理 APK、
scrcpy、Appium)要么底层仍是 adb,要么能力子集且更脆——见会话调研结论。

## 2. 总体架构

```
AI 会话(dsh)
  │ android_* 工具(starhub/tools 新增条目,BRIDGED_TOOLS)
  │ starhub/tool.execute {sessionId,name,args}
  ▼
Rust 主进程 harness → tools.rs 分发(ANDROID_TOOLS 前缀集)
  ▼
src-tauri/src/android/mod.rs     新增模块(单文件,~1000 行)
  ├── adb 二进制解析:settings(android.adb_path)→ STARHUB_ADB_PATH 环境变量
  │   → PATH → 各平台常见安装位置;全部缺失时报错文本带安装引导
  ├── AndroidManager:session → 设备任务级授权(60 分钟,对齐沙箱)、
  │   接管互斥集、直播帧缓存(std::sync::Mutex,供 custom protocol 同步读)
  ├── 控制通道:adb shell input tap/swipe/text/keyevent、exec-out screencap、
  │   dumpsys、monkey(启动 App)
  └── 直播:register_uri_scheme_protocol("android-live") 供页面与帧;
      后台 pump 任务周期性 screencap;接管输入经 std mpsc 队列回 pump 执行

直播窗口(Tauri WebviewWindow,label android-live-<serial8>)
  └── android-live://localhost/<serial>/index.html(协议处理器内置 HTML)
      ├── GET  /<serial>/frame.jpg   最新帧(pump 缓存,无新鲜度直接回旧帧)
      ├── POST /<serial>/input       接管输入(tap/swipe/key)→ mpsc 队列
      └── POST /<serial>/takeover    接管开关(互斥 AI 写操作)
```

复用(零改动):工具桥、审批分级框架、审计落库(tools.rs 收口)、回放表结构、
任务级授权模型、窗口能力收窄姿势(label 不匹配任何 capability = 无 app
command 权限,与 sandbox-live 同款)。

## 3. adb 二进制供给(用户拍板:引导安装 + AI 可代装)

解析顺序,首个命中即用(结果缓存进 AndroidManager):

1. settings 表 `android.adb_path`(未来设置页可写;本期预留);
2. 环境变量 `STARHUB_ADB_PATH`;
3. PATH 查找(`where adb` / `which adb`);
4. 平台常见位置:
   - Windows:`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`、
     `C:\platform-tools\adb.exe`
   - macOS:`~/Library/Android/sdk/platform-tools/adb`
   - Linux:`~/Android/Sdk/platform-tools/adb`、`/usr/bin/adb`

全部缺失时报错文本含三平台安装命令(winget / brew / apt),并提示「AI 可用
本机 pwsh/bash 工具代为安装 platform-tools」。**不做自动下载**(引入网络下载
+ 解压供应链风险,收益被 AI 代装覆盖)。

## 4. 工具清单

### 4.1 发现与管理

| 工具 | 说明 | 审批 |
|---|---|---|
| `android_list_devices` | `adb devices -l` 解析:serial/状态/型号;unauthorized 提示用户在手机上点允许 | 只读放行 |
| `android_connect` | 绑定设备(serial 可省=单设备自动选);探测型号/分辨率;**确认即任务级授权(60 分钟)** | 软确认 |
| `android_disconnect` | 撤销本会话授权(不碰设备) | 只读放行 |
| `android_device_status` | 型号/Android 版本/分辨率/当前前台 Activity | 授权内放行 |
| `android_replay` | 该设备的操作回放帧(动作/时间/截图路径) | 只读放行 |

### 4.2 感知(授权内放行)

`android_screenshot`(`exec-out screencap -p` → PNG 落缓存目录 → read_image
回灌,坐标系基准);`android_current_app`(dumpsys mCurrentFocus + wm size)。

### 4.3 操作(授权内放行,接管互斥;每次写前自动截屏留档)

| 工具 | adb 映射 |
|---|---|
| `android_tap` / `android_double_tap` | `input tap x y`(×2) |
| `android_swipe` | `input swipe x1 y1 x2 y2 durationMs`(拖拽/滑动) |
| `android_scroll` | 方向+像素量 → 以坐标为中心的 swipe |
| `android_type` | 纯 ASCII:`input text`(% 与空格转义);含非 ASCII:ADBKeyBoard 广播 `am broadcast -a ADB_INPUT_TEXT --es msg`,未装时返回安装引导。文本不进审计(只记长度) |
| `android_press_key` | 白名单映射 KEYCODE_*(back/home/recents/enter/del/tab/方向/音量/电源等),拒绝组合键 |
| `android_launch_app` | `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`(包名字符集校验) |

### 4.4 直播(软确认)

`android_open_live`:打开(或重建)直播独立窗口。窗口内自带「围观 ⇄ 接管」
开关;接管开启期间 AI 写操作一律拒绝(不撤销授权),窗口销毁自动释放并停
pump。帧率约 1-2 fps(screencap 轮询;H.264 scrcpy 升级留 Phase 2)。

### 4.5 万能钥匙(恒确认 hard 档)

`android_exec`:`adb shell <cmd>`,真实设备上的任意命令,每次确认,任何预设
不静默放行(对齐 desktop_exec 档位的更严格变体——实体机不可销毁)。

## 5. 安全模型(与沙箱的关键差异)

| 维度 | 沙箱桌面 | Android 实体机 |
|---|---|---|
| 底座 | 一次性实例,用完即焚 | **真实设备,误操作是真实后果** |
| 授权 | create_sandbox 确认 = 任务授权 | android_connect 确认 = 任务授权(同 60 分钟) |
| 万能钥匙 | desktop_exec 恒确认 hard | android_exec 恒确认 hard |
| 接管 | noVNC 双向 | 直播页内开关;**用户也可以直接拿起手机操作**(物理接管无法互斥,AI 从截图感知界面变化自行适应) |
| 回放 | sandbox_replay_frames | android_replay_frames(同构:写操作前自动截屏) |
| 审计 | desktop_type 只记长度 | android_type 只记长度(同款凭据防御) |

明确不做:不读写设备文件系统(sadb pull/push 留真实需求)、不装/卸 App
(android_exec 可达但有确认卡)、不解锁屏(锁屏密码永远用户自己输)。

## 6. 改动点清单

| 位置 | 改动 |
|---|---|
| `src-tauri/src/android/mod.rs` | 新增(§2 全部) |
| `src-tauri/src/main.rs` | `mod android` + `manage(AndroidManager)` + `register_uri_scheme_protocol("android-live")` |
| `src-tauri/src/harness/tools.rs` | ANDROID_TOOLS 分发分支 + list_capabilities 加 android 域 |
| `src-tauri/src/harness/events.rs` | android_* → android.action;type 记长度/exec 记命令/坐标类记坐标 |
| `src-tauri/src/db/schema.rs` | android_replay_frames 表 + 索引 |
| `packages/starhub/tools/src/index.ts` | BRIDGED_TOOLS 追加 §4 全部工具 |
| `packages/starhub/approval-bridge/src/index.ts`(+测试) | android_* 入 STARHUB_DOMAIN_TOOLS;connect/open_live 软确认;exec 恒确认 hard |
| `capabilities/` | 零改动(直播窗口 label 不匹配任何 capability) |
| 文档 | 技术方案 §、架构图、AGENTS.md、踩坑记录、CHANGELOG |

## 7. 已知坑与对策

1. **exec-out 二进制安全**:旧版 adb(<1.0.41)在 Windows 上 exec-out 会把
   \n 改写为 \r\n,PNG 损坏。对策:校验 PNG magic;失败做一次 \r\n→\n 修复
   重试;仍失败报「升级 platform-tools」。
2. **input text 转义**:toybox sh + input 双重转义——% 是 input 的格式符
   (%s 空格、%% 字面量),单引号包壳防 sh 展开;非 ASCII 一律走
   ADBKeyBoard(input text 只认 ASCII)。
3. **unauthorized 状态**:手机首次接电脑要点「允许 USB 调试」;
   list_devices 看到 unauthorized 必须在结果里明说,connect 拒绝并引导。
4. **无线调试**:Android 11+ `adb pair` + `adb connect`,本期不封工具,
   用户在手机上开无线调试后由 AI 经 android_exec 之外的引导文案说明
   (配对码只能用户输)——Phase 2 再封 android_pair。
5. **直播帧率**:screencap 单次 300-500ms,pump 间隔 400ms,实得 1-2 fps;
   观察 AI 操作足够,接管手感偏钝——页面上明示帧率,Phase 2 换 scrcpy
   server(H.264,需要 bundling scrcpy-server jar + MSE 解码)。
6. **分辨率/旋转**:wm size 在 connect 时探测;旋转后坐标系变化,AI 侧约定
   「界面变化后重新截图」与沙箱一致;直播页按帧 naturalWidth 做坐标缩放,
   天然免疫。
7. **多设备**:serial 全白名单校验([A-Za-z0-9._:-]+),connect 后授权只覆盖
   该 serial;多设备时必须显式 serial。

## 8. 测试

- Rust 单测:devices 输出解析、KEYCODE 映射、input text 转义、PNG 修复、
  scroll→swipe 换算、包名/serial 白名单;
- vendor:approval-bridge risk-gate 规格补 android 用例;`tsc -b` 双聚合;
- 手动矩阵(真机):连机 → 截图回灌 → 点开一个 App → 中文输入(ADBKeyBoard)
  → 直播围观/接管互斥 → 回放完整性 → 断线报错文案。

## 9. Roadmap

| 阶段 | 内容 |
|---|---|
| v0.107.0(已交付) | adb 全链路 + 授权/审批/审计/回放;直播窗口双模:**scrcpy H.264**(bundled server v2.7,SHA256 钉死,WebCodecs 解码)+ screencap 轮询兜底;`android_wireless` 无线配对封装;设置页 adb 路径;设备文件传输(pull/push) |
| Phase 3(未做) | 无障碍代理 APK(无开发者模式场景,adb 替代通道) |
