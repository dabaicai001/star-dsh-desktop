// @vitest-environment jsdom
/**
 * 直播帧线上解析(去 Tauri 化 M3):帧头、H.264 参数集提取、avcC 描述集构造、
 * 指针坐标映射。全部纯函数——线上格式与 `sidecar-rust/crates/starhub-live/
 * src/frames.rs` 逐字节对齐,两侧任一改动都必须同步,否则面板静默黑屏。
 */
import { describe, expect, it } from 'vitest'
import {
  buildAvcDescription,
  contentRect,
  extractParameterSets,
  FLAG_CONFIG,
  FLAG_KEYFRAME,
  FRAME_HEADER_BYTES,
  FRAME_H264,
  FRAME_PNG,
  mapPointerToDevice,
  parseLiveFrame,
} from '../src/client/live/live-frame.ts'

/** 组一帧线上消息(与 Rust 侧 encode_frame 同布局)。 */
function frame(kind: number, flags: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload.length)
  bytes[0] = kind
  bytes[1] = flags
  new DataView(bytes.buffer).setUint32(2, payload.length, false)
  bytes.set(payload, FRAME_HEADER_BYTES)
  return bytes
}

describe('parseLiveFrame', () => {
  it('round-trips kind, flags and payload', () => {
    const parsed = parseLiveFrame(frame(FRAME_PNG, 0, [1, 2, 3, 4]))
    expect(parsed).not.toBeNull()
    expect(parsed?.kind).toBe(FRAME_PNG)
    expect(parsed?.flags).toBe(0)
    expect(Array.from(parsed?.payload ?? [])).toEqual([1, 2, 3, 4])
  })

  it('keeps the H.264 keyframe/config flags', () => {
    const parsed = parseLiveFrame(frame(FRAME_H264, FLAG_KEYFRAME | FLAG_CONFIG, [0, 0, 1]))
    expect(parsed?.flags).toBe(3)
  })

  it('rejects a short header and a lying length field', () => {
    expect(parseLiveFrame(new Uint8Array(5))).toBeNull()
    const lying = frame(FRAME_PNG, 0, [1, 2])
    new DataView(lying.buffer).setUint32(2, 99, false)
    expect(parseLiveFrame(lying)).toBeNull()
  })
})

describe('H.264 parameter sets', () => {
  /** 一个 annexb 配置包:起始码 + SPS(type 7)+ 起始码 + PPS(type 8)。 */
  const configPayload = [
    0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0xd0,
    0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
  ]

  it('extracts SPS and PPS without their start codes', () => {
    const sets = extractParameterSets(new Uint8Array(configPayload))
    expect(sets).not.toBeNull()
    expect(Array.from(sets?.sps ?? [])).toEqual([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0xd0])
    expect(Array.from(sets?.pps ?? [])).toEqual([0x68, 0xce, 0x3c, 0x80])
  })

  it('builds an avcC description WebCodecs accepts', () => {
    const sets = extractParameterSets(new Uint8Array(configPayload))
    const description = buildAvcDescription(sets!.sps, sets!.pps)
    expect(description).not.toBeNull()
    // configurationVersion / profile / compatibility / level
    expect(Array.from(description!.subarray(0, 4))).toEqual([1, 0x42, 0xe0, 0x1e])
    // lengthSizeMinusOne = 3(4 字节长度前缀)
    expect(description![4]! & 0x03).toBe(3)
    // 一个 SPS + 一个 PPS
    expect(description![5]! & 0x1f).toBe(1)
    const spsLength = new DataView(description!.buffer).getUint16(6, false)
    expect(spsLength).toBe(sets!.sps.byteLength)
    const ppsCountAt = 8 + spsLength
    expect(description![ppsCountAt]).toBe(1)
  })

  it('returns null when either parameter set is missing', () => {
    expect(extractParameterSets(new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]))).toBeNull()
    expect(buildAvcDescription(new Uint8Array([0x67, 0x42]), new Uint8Array())).toBeNull()
  })
})

describe('pointer mapping', () => {
  it('computes the contain content rect (letterboxing excluded)', () => {
    // 1080×2400 的设备画面放进 400×800 的盒子:按宽度铺满,上下留边
    const rect = contentRect({ left: 0, top: 0, width: 400, height: 800 }, { width: 1080, height: 2400 })
    expect(rect.width).toBeCloseTo(360)
    expect(rect.height).toBeCloseTo(800)
    expect(rect.left).toBeCloseTo(20)
    expect(rect.top).toBeCloseTo(0)
  })

  it('maps a pointer on the content rect to device pixels', () => {
    const rect = contentRect({ left: 0, top: 0, width: 360, height: 800 }, { width: 1080, height: 2400 })
    // 内容矩形中心 → 设备中心
    expect(mapPointerToDevice(180, 400, rect, { width: 1080, height: 2400 })).toEqual({ x: 540, y: 1200 })
    // 左上角 → 设备左上角
    expect(mapPointerToDevice(rect.left, rect.top, rect, { width: 1080, height: 2400 })).toEqual({ x: 0, y: 0 })
  })

  it('maps a pointer inside a letterbox back into the device frame', () => {
    // 盒子比内容宽(竖向留边在左右):指针落在左侧留边里也要能算出设备坐标
    const rect = contentRect({ left: 0, top: 0, width: 800, height: 400 }, { width: 1080, height: 2400 })
    expect(rect.width).toBeCloseTo(180)
    expect(rect.left).toBeCloseTo(310)
    expect(mapPointerToDevice(310, 200, rect, { width: 1080, height: 2400 })).toEqual({ x: 0, y: 1200 })
  })

  it('degenerate rects report the origin instead of NaN', () => {
    expect(mapPointerToDevice(10, 10, { left: 0, top: 0, width: 0, height: 0 }, { width: 1080, height: 2400 }))
      .toEqual({ x: 0, y: 0 })
    expect(contentRect({ left: 0, top: 0, width: 100, height: 100 }, { width: 0, height: 0 }).width).toBe(0)
  })
})
