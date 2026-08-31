# scrcpy-server 来源与校验(Provenance)

Android 直播的 H.264 通道(server 端,经 adb 推送到设备运行)。

| 项 | 值 |
|---|---|
| 项目 | [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)(Apache-2.0) |
| 版本 | v2.7 |
| 来源 | https://github.com/Genymobile/scrcpy/releases/download/v2.7/scrcpy-server-v2.7 |
| 大小 | 71,200 字节 |
| SHA-256 | `a23c5659f36c260f105c022d27bcb3eafffa26070e7baa9eda66d01377a1adba` |
| 校验依据 | 官方 release 附件 `SHA256SUMS.txt`(2026-08-30 拉取时核对一致) |
| 协议锚点 | `src-tauri/src/android/mod.rs` 的 `SCRCPY_SERVER_VERSION` 必须与此版本一致(server 校验首参) |

升级步骤:下载新版本 `scrcpy-server-vX.Y` → 用官方 SHA256SUMS.txt 核对 →
覆盖本文件旁的 `scrcpy-server` → 同步 `SCRCPY_SERVER_VERSION` 与本表 →
按 scrcpy 对应版本的 `server/src/.../Options.java` 复核启动参数键名与帧元协议
(哑字节 / 设备名 64B / codec meta 12B / 帧头 12B,flag bit62=keyframe、
bit63=config)。
