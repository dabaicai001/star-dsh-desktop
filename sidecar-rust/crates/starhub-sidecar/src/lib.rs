//! StarHub Rust sidecar library: wire types, method registry, and built-in
//! methods for the stdio JSON-RPC protocol shared with the TypeScript
//! bridge (`JsonRpcLineTransport` framing).
//!
//! The binary entry lives in `main.rs`; domain modules register their
//! methods through [`MethodRegistry`] and are covered by the same unit
//! suites without a transport.

pub mod jsonrpc;
pub mod methods;
pub mod registry;
