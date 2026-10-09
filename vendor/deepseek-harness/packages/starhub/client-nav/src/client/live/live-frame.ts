/**
 * 直播帧的线上解析(去 Tauri 化 M3):sidecar 帧出口的二进制帧头与 H.264
 * 描述集构造。纯函数,单测覆盖——组件只负责把结果喂给 WebCodecs / canvas。
 *
 * 线上格式(与 `sidecar-rust/crates/starhub-live/src/frames.rs` 逐字节对齐):
 *
 * ```text
 * [u8 kind][u8 flags][u32 payload_len BE][payload…]
 * ```
 *
 * `kind`:`1` = PNG 截图(轮询模式),`2` = H.264 annexb 包(scrcpy 模式)。
 * `flags` 仅 H.264 有意义:bit0 = 关键帧、bit1 = 配置包(SPS/PPS)。
 */

/** PNG 截图帧(轮询模式)。 */
export const FRAME_PNG = 1
/** H.264 annexb 包(scrcpy 模式)。 */
export const FRAME_H264 = 2

/** H.264 标志位(与 Rust 侧同名常量一致)。 */
export const FLAG_KEYFRAME = 1
export const FLAG_CONFIG = 2

/** 帧头长度:1B kind + 1B flags + 4B payload len BE。 */
export const FRAME_HEADER_BYTES = 6

/** 解析出来的一帧。 */
export interface LiveFrame {
  readonly kind: number
  readonly flags: number
  readonly payload: Uint8Array
}

/**
 * 解析一个二进制 WS 消息的帧头。
 * @param bytes - 一条完整的二进制消息。
 * @returns 帧类型/标志/载荷;头部不齐或长度不符时返回 null(调用方丢弃该消息)。
 */
export function parseLiveFrame(bytes: Uint8Array): LiveFrame | null {
  if (bytes.byteLength < FRAME_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(2, false)
  if (length !== bytes.byteLength - FRAME_HEADER_BYTES) return null
  return {
    kind: bytes[0] as number,
    flags: bytes[1] as number,
    payload: bytes.subarray(FRAME_HEADER_BYTES),
  }
}

/** annexb 起始码长度(3 字节 00 00 01 或 4 字节 00 00 00 01)。 */
function startCodeLength(bytes: Uint8Array, at: number): number {
  if (at + 3 <= bytes.byteLength && bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1) {
    return 3
  }
  if (
    at + 4 <= bytes.byteLength
    && bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 0 && bytes[at + 3] === 1
  ) {
    return 4
  }
  return 0
}

/** NAL 类型(取首字节的低 5 位)。 */
function nalType(bytes: Uint8Array, at: number): number {
  return (bytes[at] as number) & 0x1f
}

/**
 * 从 SPS/PPS NAL 构造 WebCodecs 的 `avcC` 描述集。
 *
 * `VideoDecoder.configure({description})` 需要的是 MP4 里的 `avcC` 盒内容,
 * 而 scrcpy 送的是 annexb 裸 NAL,因此在这里转一次:盒头 + profile/compat/level
 * + 长度前缀位数 + SPS/PPS(各自带 2 字节长度前缀)。这是浏览器播放 scrcpy 流的
 * 唯一必要转码,缺了它 `configure` 直接抛 `NotSupportedError`。
 *
 * @param sps - 序列参数集 NAL(不含起始码)。
 * @param pps - 图像参数集 NAL(不含起始码)。
 * @returns avcC 盒内容;SPS/PPS 形态异常时返回 null。
 */
export function buildAvcDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array | null {
  if (sps.byteLength < 4 || pps.byteLength < 1) return null
  const profile = sps[1] as number
  const compatibility = sps[2] as number
  const level = sps[3] as number
  const out = new Uint8Array(11 + 2 + sps.byteLength + 1 + 2 + pps.byteLength)
  const view = new DataView(out.buffer)
  out[0] = 1 // configurationVersion
  out[1] = profile
  out[2] = compatibility
  out[3] = level
  out[4] = 0xff // lengthSizeMinusOne = 3(4 字节长度前缀) + 全保留位
  out[5] = 0xe1 // numOfSequenceParameterSets = 1 + 保留位
  view.setUint16(6, sps.byteLength, false)
  out.set(sps, 8)
  let at = 8 + sps.byteLength
  out[at] = 1 // numOfPictureParameterSets = 1
  at += 1
  view.setUint16(at, pps.byteLength, false)
  out.set(pps, at + 2)
  return out
}

/**
 * 从一串 annexb 负载里提取 SPS / PPS(配置包通常两者都在同一个载荷里)。
 * @param payload - annexb 字节(可含多个 NAL)。
 * @returns SPS 与 PPS(都不含起始码);缺任一个返回 null。
 */
export function extractParameterSets(payload: Uint8Array): { sps: Uint8Array; pps: Uint8Array } | null {
  let sps: Uint8Array | null = null
  let pps: Uint8Array | null = null
  let at = 0
  while (at < payload.byteLength) {
    const prefix = startCodeLength(payload, at)
    if (prefix === 0) break
    const start = at + prefix
    let end = payload.byteLength
    for (let scan = start; scan + 3 <= payload.byteLength; scan += 1) {
      if (startCodeLength(payload, scan) !== 0) {
        end = scan
        break
      }
    }
    if (end <= start) break
    const type = nalType(payload, start)
    if (type === 7 && sps === null) sps = payload.subarray(start, end)
    else if (type === 8 && pps === null) pps = payload.subarray(start, end)
    at = end
  }
  if (sps === null || pps === null) return null
  return { sps, pps }
}

/**
 * 把面板上的指针坐标映射成设备物理像素。
 *
 * 视频按 `object-fit: contain` 排布,直接拿 CSS 坐标除宽高比会把信箱边距算进
 * 去,点击偏移随窗口尺寸漂移。这里按内容矩形反算(与 Tauri 直播页的
 * `contentRect()` 同算法)。
 *
 * @param clientX - 指针在视口里的横坐标。
 * @param clientY - 指针在视口里的纵坐标。
 * @param rect - 画面元素的内容矩形(CSS 像素,已按 contain 收窄)。
 * @param size - 画面真实像素尺寸(帧的 width/height)。
 * @returns 设备物理像素坐标。
 */
export function mapPointerToDevice(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0 || size.width <= 0 || size.height <= 0) {
    return { x: 0, y: 0 }
  }
  return {
    x: Math.round(((clientX - rect.left) * size.width) / rect.width),
    y: Math.round(((clientY - rect.top) * size.height) / rect.height),
  }
}

/**
 * 按 `object-fit: contain` 算出内容矩形。
 * @param box - 容器矩形(CSS 像素)。
 * @param size - 内容真实像素尺寸。
 * @returns contain 后的内容矩形(居中)。
 */
export function contentRect(
  box: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (size.width <= 0 || size.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: box.left, top: box.top, width: 0, height: 0 }
  }
  const contentAspect = size.width / size.height
  const boxAspect = box.width / box.height
  const width = contentAspect > boxAspect ? box.width : box.height * contentAspect
  const height = contentAspect > boxAspect ? box.width / contentAspect : box.height
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  }
}
