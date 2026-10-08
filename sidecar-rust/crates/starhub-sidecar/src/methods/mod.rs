//! Built-in methods available before any domain module is extracted.
//!
//! `ping` is the liveness probe the bridge uses after spawn; the capability
//! report is the seed of the model-facing `starhub_list_capabilities` tool —
//! it reads the live registry so the inventory can never drift from the
//! registered method surface.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};

use crate::jsonrpc::RpcError;
use crate::registry::{MethodRegistry, SIDECAR_PROTOCOL_VERSION};

/// Liveness probe.
pub fn ping(_params: &Value) -> Result<Value, RpcError> {
    Ok(json!({ "pong": true, "protocol": SIDECAR_PROTOCOL_VERSION }))
}

/// Registry inventory report.
pub fn capabilities(registry: &MethodRegistry) -> Result<Value, RpcError> {
    Ok(json!({
        "protocol": SIDECAR_PROTOCOL_VERSION,
        "methods": registry.method_names(),
    }))
}

/// Build the registry with the built-in methods.
///
/// The capability report reads the live registry through a weak self
/// reference; dispatch only runs while the caller holds the strong `Arc`,
/// so the upgrade cannot fail in practice.
pub fn registry_with_builtins() -> Arc<MethodRegistry> {
    Arc::new_cyclic(|weak| {
        let mut registry = MethodRegistry::new();
        registry.register("ping", ping);
        let handle: Weak<MethodRegistry> = weak.clone();
        registry.register("starhub_list_capabilities", move |_params| {
            let registry = handle.upgrade().expect("registry alive during dispatch");
            capabilities(&registry)
        });
        registry
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonrpc::InboundFrame;

    #[test]
    fn ping_reports_protocol() {
        let registry = registry_with_builtins();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(result["pong"], true);
        assert_eq!(result["protocol"], SIDECAR_PROTOCOL_VERSION);
    }

    #[test]
    fn capabilities_reports_the_live_method_table() {
        let registry = registry_with_builtins();
        let frame = InboundFrame::parse(r#"{"jsonrpc":"2.0","id":2,"method":"starhub_list_capabilities"}"#)
            .expect("parses");
        let (_, outcome) = registry.dispatch(&frame).expect("outcome");
        let result = outcome.expect("ok");
        assert_eq!(result["methods"], serde_json::json!(["ping", "starhub_list_capabilities"]));
    }
}
