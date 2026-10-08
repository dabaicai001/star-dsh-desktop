//! Method registry: name → handler dispatch with the protocol's error mapping.
//!
//! Handlers are pure functions of the params value so the domain modules can
//! be tested without a transport; the async domains (ssh/browser/android)
//! will register through a runtime shim without changing this surface.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use crate::jsonrpc::{InboundFrame, RpcError, RpcId};

/// Error codes re-exported for handler authors.
pub use crate::jsonrpc::error_codes;

/// A registered method handler.
///
/// Returns the response `result` on success, or an [`RpcError`] that becomes
/// the response `error` verbatim. Handlers must not panic: the stdio loop
/// treats a panic as a process-level fault.
pub type MethodHandler = Box<dyn Fn(&Value) -> Result<Value, RpcError> + Send + Sync + 'static>;

/// Registry of JSON-RPC methods exposed by the sidecar.
pub struct MethodRegistry {
    handlers: BTreeMap<String, MethodHandler>,
}

impl fmt::Debug for MethodRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MethodRegistry").field("methods", &self.method_names()).finish()
    }
}

impl Default for MethodRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MethodRegistry {
    /// Build an empty registry.
    pub fn new() -> Self {
        Self { handlers: BTreeMap::new() }
    }

    /// Register a method; a duplicate name replaces the prior handler.
    pub fn register<F>(&mut self, name: impl Into<String>, handler: F)
    where
        F: Fn(&Value) -> Result<Value, RpcError> + Send + Sync + 'static,
    {
        self.handlers.insert(name.into(), Box::new(handler));
    }

    /// Sorted method names (the `starhub_list_capabilities` seed).
    pub fn method_names(&self) -> Vec<String> {
        self.handlers.keys().cloned().collect()
    }

    /// Whether a method is registered.
    pub fn contains(&self, name: &str) -> bool {
        self.handlers.contains_key(name)
    }

    /// Dispatch one inbound frame.
    ///
    /// Notifications and responses produce no outbound frame (`None`); a
    /// request produces exactly one. An unknown request method yields
    /// `-32601`; a handler error yields its own code (default `-32603`).
    pub fn dispatch(&self, frame: &InboundFrame) -> Option<(RpcId, Result<Value, RpcError>)> {
        match frame.kind() {
            crate::jsonrpc::FrameKind::Request { id, method, params } => {
                let params = params.unwrap_or(Value::Null);
                let outcome = match self.handlers.get(&method) {
                    Some(handler) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        handler(&params)
                    })) {
                        Ok(result) => result,
                        Err(_) => Err(RpcError::internal(format!("handler panicked: {method}"))),
                    },
                    None => Err(RpcError::method_not_found(&method)),
                };
                Some((id, outcome))
            }
            _ => None,
        }
    }
}

/// Sidecar protocol/schema version, reported by `ping`.
pub const SIDECAR_PROTOCOL_VERSION: &str = "starhub-sidecar-rust/0.1.0";

/// Convenience: the standard `ping` handler result.
pub fn ping_result() -> Value {
    serde_json::json!({
        "pong": true,
        "protocol": SIDECAR_PROTOCOL_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::FrameKind;

    fn registry() -> MethodRegistry {
        let mut registry = MethodRegistry::new();
        registry.register("ping", |_params| Ok(ping_result()));
        registry.register("echo", |params| {
            params.get("text").cloned().ok_or_else(|| RpcError::invalid_params("missing text"))
        });
        registry.register("boom", |_params| Err(RpcError::internal("kaboom")));
        registry.register("panic", |_params| panic!("handler must not escape"));
        registry
    }

    #[test]
    fn dispatch_returns_result_for_registered_method() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).expect("parses");
        let (id, outcome) = registry.dispatch(&frame).expect("request yields an outcome");
        assert_eq!(id, crate::jsonrpc::RpcId::Number(1));
        assert_eq!(outcome.expect("ok"), ping_result());
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let error = outcome.expect_err("unknown method");
        assert_eq!(error.code, error_codes::METHOD_NOT_FOUND);
        assert!(error.message.contains("nope"));
    }

    #[test]
    fn handler_error_passes_through_verbatim() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":3,"method":"boom"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let error = outcome.expect_err("handler error");
        assert_eq!(error.code, error_codes::INTERNAL_ERROR);
        assert_eq!(error.message, "kaboom");
    }

    #[test]
    fn invalid_params_error_is_distinct() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":4,"method":"echo","params":{}}"#)
            .expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let error = outcome.expect_err("missing param");
        assert_eq!(error.code, error_codes::INVALID_PARAMS);
    }

    #[test]
    fn missing_params_arrive_as_null_and_handlers_may_ignore_them() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#).expect("parses");
        assert!(matches!(frame.kind(), FrameKind::Request { params: None, .. }));
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        assert!(outcome.is_ok());
    }

    #[test]
    fn panicking_handler_becomes_internal_error_not_a_crash() {
        let registry = registry();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":6,"method":"panic"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let error = outcome.expect_err("panic contained");
        assert_eq!(error.code, error_codes::INTERNAL_ERROR);
        assert!(error.message.contains("panic"));
    }

    #[test]
    fn notifications_and_responses_produce_no_outcome() {
        let registry = registry();
        let notification =
            InboundFrame::parse(r#"{"jsonrpc":"2.0","method":"starhub/exec.abort","params":{"id":"x"}}"#)
                .expect("parses");
        assert!(registry.dispatch(&notification).is_none());
        let response = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":9,"result":1}"#).expect("parses");
        assert!(registry.dispatch(&response).is_none());
    }

    #[test]
    fn method_names_are_sorted_and_stable() {
        let registry = registry();
        let names = registry.method_names();
        assert_eq!(names, vec!["boom", "echo", "panic", "ping"]);
        assert!(registry.contains("ping"));
        assert!(!registry.contains("absent"));
    }
}
