//! Wire types for the newline-delimited JSON-RPC 2.0 stdio protocol.
//!
//! The framing is byte-compatible with the TypeScript peer
//! `JsonRpcLineTransport` (`packages/sdk/protocol/src/transport.ts`): one
//! JSON value per `\n`-terminated UTF-8 line. A frame carrying both `id` and
//! `method` is a request; `id` alone is a response (the sidecar never sends
//! one); `method` alone is a notification. Malformed lines are ignored, not
//! fatal — the peer contract keeps the process alive across garbage input.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol version string carried by every frame.
pub const JSONRPC_VERSION: &str = "2.0";

/// JSON-RPC error codes used by the sidecar.
///
/// `-32601` and `-32603` mirror the TypeScript peer's mapping (missing
/// handler, handler failure); `-32602` covers parameter-shape rejection so
/// domain handlers can report schema mismatch distinctly from internal
/// failure.
pub mod error_codes {
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

/// Request or notification identifier (string or number, per JSON-RPC 2.0).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RpcId {
    Text(String),
    Number(i64),
}

/// A structured error payload.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    /// Build an error with the standard code set and no data.
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None }
    }

    /// Method-not-found (`-32601`).
    pub fn method_not_found(method: &str) -> Self {
        Self::new(error_codes::METHOD_NOT_FOUND, format!("method not found: {method}"))
    }

    /// Invalid parameters (`-32602`).
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(error_codes::INVALID_PARAMS, message)
    }

    /// Internal handler failure (`-32603`).
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(error_codes::INTERNAL_ERROR, message)
    }
}

/// One inbound frame, classified by which members it carries.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct InboundFrame {
    #[serde(default = "default_jsonrpc")]
    pub jsonrpc: String,
    #[serde(default)]
    pub id: Option<RpcId>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
}

fn default_jsonrpc() -> String {
    JSONRPC_VERSION.to_string()
}

/// Classification of an inbound frame per the protocol contract.
#[derive(Debug, Clone, PartialEq)]
pub enum FrameKind {
    /// `id` + `method`: expects exactly one response frame.
    Request { id: RpcId, method: String, params: Option<Value> },
    /// `method` without `id`: one-way, never answered.
    Notification { method: String, params: Option<Value> },
    /// `id` without `method`: a response to a request the sidecar sent.
    Response { id: RpcId },
    /// Neither `id` nor `method`: unusable, ignored.
    Ignorable,
}

impl InboundFrame {
    /// Parse one line; `None` when the line is not a JSON object.
    pub fn parse(line: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(line).ok()?;
        if !value.is_object() {
            return None;
        }
        serde_json::from_value(value).ok()
    }

    /// Classify this frame; `jsonrpc` must equal `"2.0"` for a usable frame.
    pub fn kind(&self) -> FrameKind {
        if self.jsonrpc != JSONRPC_VERSION {
            return FrameKind::Ignorable;
        }
        match (&self.id, &self.method) {
            (Some(id), Some(method)) => FrameKind::Request {
                id: id.clone(),
                method: method.clone(),
                params: self.params.clone(),
            },
            (None, Some(method)) => FrameKind::Notification {
                method: method.clone(),
                params: self.params.clone(),
            },
            (Some(id), None) => FrameKind::Response { id: id.clone() },
            (None, None) => FrameKind::Ignorable,
        }
    }
}

/// One outbound response frame.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct OutboundResponse {
    pub jsonrpc: String,
    pub id: RpcId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl OutboundResponse {
    /// Build a success response.
    pub fn ok(id: RpcId, result: Value) -> Self {
        Self { jsonrpc: JSONRPC_VERSION.to_string(), id, result: Some(result), error: None }
    }

    /// Build an error response.
    pub fn fail(id: RpcId, error: RpcError) -> Self {
        Self { jsonrpc: JSONRPC_VERSION.to_string(), id, result: None, error: Some(error) }
    }

    /// Serialize to the single-line wire form (no trailing newline).
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("response frames are always serializable")
    }
}

/// One outbound notification frame (no `id`, never answered).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct OutboundNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl OutboundNotification {
    /// Build a notification.
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self { jsonrpc: JSONRPC_VERSION.to_string(), method: method.into(), params }
    }

    /// Serialize to the single-line wire form (no trailing newline).
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("notification frames are always serializable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_request_notification_and_response() {
        let request = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"a":1}}"#)
            .expect("request parses");
        assert_eq!(
            request.kind(),
            FrameKind::Request { id: RpcId::Number(1), method: "ping".into(), params: Some(json!({"a":1})) }
        );

        let notification =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","method":"starhub/exec.abort","params":{"id":"x"}}"#)
                .expect("notification parses");
        assert_eq!(
            notification.kind(),
            FrameKind::Notification { method: "starhub/exec.abort".into(), params: Some(json!({"id":"x"})) }
        );

        let response = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":"r-1","result":{"ok":true}}"#)
            .expect("response parses");
        assert_eq!(response.kind(), FrameKind::Response { id: RpcId::Text("r-1".into()) });
    }

    #[test]
    fn ignores_malformed_and_wrong_version_frames() {
        assert!(InboundFrame::parse("not json").is_none());
        assert!(InboundFrame::parse("[1,2,3]").is_none(), "non-object JSON is not a frame");
        assert!(InboundFrame::parse("").is_none());
        let wrong_version = InboundFrame::parse(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#)
            .expect("parses as JSON");
        assert_eq!(wrong_version.kind(), FrameKind::Ignorable);
        let empty = InboundFrame::parse("{}").expect("parses as JSON");
        assert_eq!(empty.kind(), FrameKind::Ignorable);
    }

    #[test]
    fn response_line_roundtrips() {
        let ok = OutboundResponse::ok(RpcId::Text("r-1".into()), json!({"pong": true}));
        let line = ok.to_line();
        assert!(!line.contains('\n'), "one frame per line");
        let parsed: OutboundResponse = serde_json::from_str(&line).expect("roundtrip");
        assert_eq!(parsed, ok);
        assert!(parsed.error.is_none());

        let fail = OutboundResponse::fail(RpcId::Number(7), RpcError::method_not_found("nope"));
        let line = fail.to_line();
        let parsed: OutboundResponse = serde_json::from_str(&line).expect("roundtrip");
        assert_eq!(parsed.error.expect("error present").code, error_codes::METHOD_NOT_FOUND);
        assert!(parsed.result.is_none());
    }

    #[test]
    fn notification_line_omits_absent_params() {
        let line = OutboundNotification::new("starhub/domain-event", None).to_line();
        assert_eq!(line, r#"{"jsonrpc":"2.0","method":"starhub/domain-event"}"#);
        let with_params = OutboundNotification::new("starhub/domain-event", Some(json!({"k":"v"})));
        let line = with_params.to_line();
        assert!(line.contains(r#""params":{"k":"v"}"#));
    }

    #[test]
    fn params_may_be_any_json_shape() {
        let array_params =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"x","params":[1,2]}"#)
                .expect("parses");
        match array_params.kind() {
            FrameKind::Request { params, .. } => assert_eq!(params, Some(json!([1, 2]))),
            other => panic!("expected request, got {other:?}"),
        }
    }
}
