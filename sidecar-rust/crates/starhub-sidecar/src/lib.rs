//! StarHub Rust sidecar library: wire types, method registry, built-in
//! methods, and the domain runtimes for the stdio JSON-RPC protocol shared
//! with the TypeScript bridge (`JsonRpcLineTransport` framing).
//!
//! The binary entry lives in `main.rs`; domain modules register their
//! methods through [`MethodRegistry`] and are covered by the same unit
//! suites without a transport.
//!
//! Module map (M1 of the drop-Tauri migration):
//!
//! | module | contents |
//! |---|---|
//! | [`jsonrpc`] | wire types (frames, ids, errors, notifications) |
//! | [`registry`] | name → handler dispatch with the protocol's error mapping |
//! | [`methods`] | built-ins (`ping`, capabilities) + domain registration |
//! | [`runtime`] | SSH/SFTP session lifecycle shared by the `ssh_*` / `sftp_*` methods |
//! | [`db_runtime`] | Go sidecar client shared by the `db_*` / `es_*` / `docker_*` methods |
//! | [`assets`] | asset store (JSON file + secret-store seam) |
//! | [`bindings`] | session → asset bindings (subagent parent chain) |
//! | [`session_registry`] | assetId → session attachment view (`registry.sync`) |
//! | [`known_hosts_store`] | TOFU host-key policy over a JSON file |

pub mod assets;
pub mod bindings;
pub mod db_runtime;
pub mod jsonrpc;
pub mod known_hosts_store;
pub mod methods;
pub mod registry;
pub mod runtime;
pub mod session_registry;
