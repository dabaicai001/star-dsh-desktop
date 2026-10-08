//! StarHub DB/Redis/ES/Docker domain, extracted from the retired Tauri shell.
//!
//! Two layers, both host-agnostic:
//!
//! - [`go_sidecar`] is the stdio JSON-RPC client for the Go sidecar
//!   (`sidecar/starhub-sidecar`, the adapter process that owns every database
//!   and middleware driver). Moved verbatim from `src-tauri/src/sidecar`; the
//!   only change is that the host no longer passes a `tauri::AppHandle` —
//!   process lifetime is owned by whoever holds the manager.
//! - [`executors`] are the model-facing tool bodies (`db_query`, `redis_exec`,
//!   `es_*`, `docker_*`): connect → execute → format → disconnect, with the
//!   result text formats preserved verbatim (they are a contract with the
//!   model, same as the SSH domain).
//!
//! Asset resolution (which connection parameters to use) stays with the host:
//! the Tauri shell reads SQLite + Keyring, the sidecar reads its own asset
//! store. Both feed the same `config: &Value` shape into the executors.

pub mod executors;
pub mod go_sidecar;

pub use executors::{
    check_tool_asset_type, connect_sidecar, docker_params, execute_db_query, execute_docker,
    execute_es, execute_redis, format_query_result,
};
pub use go_sidecar::{fake_go_sidecar_command, GoSidecar};
