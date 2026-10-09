//! 二进制帧编解码 + H.264 环形缓冲(直播/接管帧出口的线上格式)。
//!
//! 线上格式(每个 WS 二进制消息):
//!
//! ```text
//! [u8 kind][u8 flags][u32 payload_len BE][payload…]
//! ```
//!
//! - `kind`:`1` = PNG 截图(轮询模式)、`2` = H.264 annexb 包(scrcpy 模式);
//! - `flags`:仅 H.264 有意义——bit0 = 关键帧、bit1 = 配置包(SPS/PPS);
//! - 头部固定 6 字节,长度字段封顶 4MB(防畸形长度撑爆内存)。
//!
//! 与 Tauri 直播窗口的 `video` 端点(`[u64 base][记录…]`)不同:那边是 HTTP
//! 拉取 + `since` 游标,这边是 WS 推送 + 「新订阅者从最近可独立解码的帧重放」,
//! 语义等价(迟到者拿到关键帧),少一次游标协商。

/// PNG 截图帧(轮询模式)。
pub const MSG_PNG: u8 = 1;
/// H.264 annexb 包(scrcpy 模式)。
pub const MSG_H264: u8 = 2;

/// H.264:关键帧(可独立解码)。
pub const FLAG_KEYFRAME: u8 = 1;
/// H.264:配置包(SPS/PPS,必须紧随关键帧之前)。
pub const FLAG_CONFIG: u8 = 2;

/// 帧头长度:1B kind + 1B flags + 4B payload len BE。
pub const FRAME_HEADER_LEN: usize = 6;
/// 单帧载荷上限(4MB)。
pub const MAX_FRAME_PAYLOAD: usize = 4 << 20;
/// 环形缓冲字节上限(2Mbps × ~10s GOP ≈ 2.5MB,留余量;与 Tauri 版一致)。
pub const RING_CAP_BYTES: usize = 8 << 20;

/// 编码一帧线上消息。
pub fn encode_frame(kind: u8, flags: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
    out.push(kind);
    out.push(flags);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// 解码一帧线上消息;长度字段非法 / 超限 / 与实际不符时返回 None。
pub fn decode_frame(bytes: &[u8]) -> Option<(u8, u8, &[u8])> {
    if bytes.len() < FRAME_HEADER_LEN {
        return None;
    }
    let kind = bytes[0];
    let flags = bytes[1];
    let len = u32::from_be_bytes(bytes[2..6].try_into().ok()?) as usize;
    if len > MAX_FRAME_PAYLOAD || bytes.len() - FRAME_HEADER_LEN != len {
        return None;
    }
    Some((kind, flags, &bytes[FRAME_HEADER_LEN..]))
}

/// 环形缓冲里的一个条目(已编码的线上消息)。
#[derive(Debug, Clone)]
struct RingEntry {
    kind: u8,
    flags: u8,
    encoded: Vec<u8>,
}

impl RingEntry {
    /// 这一帧能否「独立解码」:PNG 每帧自含;H.264 只有关键帧自含。
    fn self_contained(&self) -> bool {
        self.kind != MSG_H264 || self.flags & FLAG_KEYFRAME != 0
    }
}

/// 有界环形缓冲:超限从头部丢弃;记录最后一个「可独立解码」条目的位置,
/// 供迟到订阅者重放。
#[derive(Debug, Default)]
pub struct PacketRing {
    entries: std::collections::VecDeque<RingEntry>,
    bytes: usize,
}

impl PacketRing {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, kind: u8, flags: u8, encoded: Vec<u8>) {
        self.bytes += encoded.len();
        self.entries.push_back(RingEntry {
            kind,
            flags,
            encoded,
        });
        while self.bytes > RING_CAP_BYTES {
            let Some(front) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(front.encoded.len());
        }
    }

    /// 当前缓冲字节数。
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// 条目数。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 从「最近一个可独立解码的条目」开始的全部条目(PNG 每一帧都自含;
    /// H.264 以关键帧为界)。空环返回空 Vec。
    pub fn replay(&self) -> Vec<Vec<u8>> {
        let start = self
            .entries
            .iter()
            .rposition(RingEntry::self_contained)
            .unwrap_or(0);
        self.entries
            .iter()
            .skip(start)
            .map(|entry| entry.encoded.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_and_validation() {
        let encoded = encode_frame(MSG_H264, FLAG_KEYFRAME, b"\x00\x00\x00\x01payload");
        let (kind, flags, payload) = decode_frame(&encoded).unwrap();
        assert_eq!(kind, MSG_H264);
        assert_eq!(flags, FLAG_KEYFRAME);
        assert_eq!(payload, b"\x00\x00\x00\x01payload");

        assert!(decode_frame(&encoded[..5]).is_none(), "头部不齐");
        assert!(
            decode_frame(&encoded[..encoded.len() - 1]).is_none(),
            "长度不符"
        );
        let mut lying = encode_frame(MSG_PNG, 0, b"abc");
        lying[2] = 0xff;
        assert!(decode_frame(&lying).is_none(), "长度字段超限");
    }

    #[test]
    fn ring_drops_oldest_and_replays_from_keyframe() {
        let mut ring = PacketRing::new();
        ring.push(
            MSG_H264,
            FLAG_CONFIG,
            encode_frame(MSG_H264, FLAG_CONFIG, b"sps"),
        );
        ring.push(
            MSG_H264,
            FLAG_KEYFRAME,
            encode_frame(MSG_H264, FLAG_KEYFRAME, b"idr"),
        );
        ring.push(MSG_H264, 0, encode_frame(MSG_H264, 0, b"p1"));
        ring.push(MSG_H264, 0, encode_frame(MSG_H264, 0, b"p2"));
        // 关键帧之后有 3 条(含关键帧);config 包不在重放范围内
        let replay = ring.replay();
        assert_eq!(replay.len(), 3);
        assert_eq!(decode_frame(&replay[0]).unwrap().2, b"idr");
        assert!(ring.bytes() > 0);
    }

    #[test]
    fn ring_replays_only_the_latest_self_contained_frame() {
        let mut ring = PacketRing::new();
        ring.push(MSG_PNG, 0, encode_frame(MSG_PNG, 0, b"frame-1"));
        ring.push(MSG_PNG, 0, encode_frame(MSG_PNG, 0, b"frame-2"));
        let replay = ring.replay();
        assert_eq!(replay.len(), 1, "PNG 每帧自含,只需最新一帧");
        assert_eq!(
            decode_frame(&replay[0]).unwrap().2,
            b"frame-2",
            "迟到者拿到的是最新帧"
        );
    }

    #[test]
    fn ring_evicts_beyond_cap() {
        let mut ring = PacketRing::new();
        let big = vec![7u8; 64 << 10];
        for _ in 0..200 {
            ring.push(
                MSG_H264,
                FLAG_KEYFRAME,
                encode_frame(MSG_H264, FLAG_KEYFRAME, &big),
            );
        }
        assert!(ring.bytes() <= RING_CAP_BYTES, "字节上限生效");
        assert!(ring.bytes() > RING_CAP_BYTES / 2, "且不会退化成空");
    }
}
