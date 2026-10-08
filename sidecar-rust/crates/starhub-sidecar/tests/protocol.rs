//! Protocol integration: spawn the real sidecar binary and speak the
//! newline-delimited JSON-RPC 2.0 protocol over its stdio, exercising the
//! same frame shapes the TypeScript bridge (`JsonRpcLineTransport`) sends.
//!
//! The SSH/SFTP methods resolve their target asset from the store the binary
//! was started with (`STARHUB_ASSETS_FILE`), so the tests point it at a
//! throwaway file — no real SSH server is contacted; the covered paths are
//! the ones that answer before any network I/O (asset resolution, status
//! query, abort acknowledgement).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Sidecar {
    child: Child,
    /// Temp dir kept alive for the child's lifetime.
    _dir: PathBuf,
}

impl Sidecar {
    /// Spawn the binary with an empty asset store in a throwaway directory.
    fn spawn() -> Self {
        let unique = format!(
            "starhub-sidecar-it-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let assets = dir.join("assets.json");
        std::fs::write(&assets, br#"{"assets":[]}"#).expect("seed assets file");
        let child = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"))
            .env("STARHUB_ASSETS_FILE", &assets)
            // 空串 = 内存密钥存储:测试不碰任何真实密钥环
            .env("STARHUB_SECRETS_FILE", "")
            .env("STARHUB_KNOWN_HOSTS_FILE", dir.join("known-hosts.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("sidecar binary spawns");
        Self { child, _dir: dir }
    }

    /// Send one request line and read the next response line.
    fn roundtrip(&mut self, request: &str) -> String {
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(request.as_bytes()).expect("write request");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush request");
        let stdout = self.child.stdout.as_mut().expect("stdout piped");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read response");
        assert!(
            line.ends_with('\n'),
            "response frames are newline-terminated"
        );
        line.trim_end().to_string()
    }

    /// Send a raw line without expecting a response.
    fn send(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(line.as_bytes()).expect("write line");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush line");
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self._dir);
    }
}

#[test]
fn ping_roundtrip_over_stdio() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["jsonrpc"], "2.0");
    assert_eq!(value["id"], 1);
    assert_eq!(value["result"]["pong"], true);
    let protocol = value["result"]["protocol"]
        .as_str()
        .expect("protocol string");
    assert!(
        protocol.starts_with("starhub-sidecar-rust/"),
        "protocol: {protocol}"
    );
}

#[test]
fn capabilities_lists_registered_methods() {
    let mut sidecar = Sidecar::spawn();
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-1","method":"starhub_list_capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods = value["result"]["methods"]
        .as_array()
        .expect("methods array");
    assert!(
        methods.iter().any(|m| m == "ping"),
        "ping registered: {methods:?}"
    );
    assert!(methods.iter().any(|m| m == "starhub_list_capabilities"));
}

#[test]
fn unknown_method_returns_32601_and_process_survives() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32601);
    // The process is still alive: the next request is answered.
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["result"]["pong"], true);
}

#[test]
fn malformed_lines_are_ignored_without_a_response() {
    let mut sidecar = Sidecar::spawn();
    // Malformed lines produce no frame; the well-formed request after them
    // is answered normally, proving the loop never broke.
    sidecar.send("not json at all");
    sidecar.send("[1,2,3]");
    sidecar.send("{}");
    sidecar.send(r#"{"jsonrpc":"1.0","id":99,"method":"ping"}"#);
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["id"], 4);
    assert_eq!(value["result"]["pong"], true);
}

#[test]
fn notifications_are_consumed_silently() {
    let mut sidecar = Sidecar::spawn();
    sidecar.send(r#"{"jsonrpc":"2.0","method":"starhub/exec.abort","params":{"execId":"x"}}"#);
    // The following request must be the first answered frame.
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["id"], 5);
}

#[test]
fn string_and_number_ids_are_echoed_verbatim() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"abc-123","method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["id"], "abc-123");
}

// ---------- SSH / SFTP 方法面(M1 第 4 步) ----------

#[test]
fn capabilities_lists_the_ssh_sftp_method_surface() {
    let mut sidecar = Sidecar::spawn();
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-2","method":"starhub_list_capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods: Vec<&str> = value["result"]["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .map(|m| m.as_str().expect("method name"))
        .collect();
    for expected in [
        "ping",
        "starhub_list_capabilities",
        "starhub_list_assets",
        "bind_asset_context",
        "ssh_exec",
        "ssh_exec_background",
        "ssh_wait_task",
        "ssh_session_status",
        "sftp_list",
        "sftp_stat",
        "sftp_upload",
        "sftp_download",
    ] {
        assert!(
            methods.contains(&expected),
            "missing {expected}: {methods:?}"
        );
    }
}

#[test]
fn ssh_exec_without_asset_or_binding_is_invalid_params() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":10,"method":"ssh_exec","params":{"command":"ls"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
    let message = value["error"]["message"].as_str().expect("message");
    assert!(message.contains("bind_asset_context"), "{message}");
}

#[test]
fn ssh_exec_with_unknown_asset_reports_the_asset_store_error() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":11,"method":"ssh_exec","params":{"assetId":"ghost","command":"ls"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603);
    assert_eq!(value["error"]["message"], "资产不存在: ghost");
}

#[test]
fn ssh_session_status_answers_before_any_connection() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":12,"method":"ssh_session_status","params":{"assetId":"ghost"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    let text = value["result"]["text"].as_str().expect("text");
    assert!(text.contains("SSH 会话未建立(资产 ghost)"), "{text}");
}

#[test]
fn sftp_methods_resolve_the_asset_before_touching_the_network() {
    let mut sidecar = Sidecar::spawn();
    for (index, method) in ["sftp_list", "sftp_stat", "sftp_upload", "sftp_download"]
        .into_iter()
        .enumerate()
    {
        let response = sidecar.roundtrip(&format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"{method}","params":{{"assetId":"ghost","path":"/tmp"}}}}"#,
            id = 20 + index
        ));
        let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
        assert_eq!(value["error"]["code"], -32603, "{method}: {response}");
        assert_eq!(value["error"]["message"], "资产不存在: ghost", "{method}");
    }
}

#[test]
fn list_assets_reports_the_seeded_store() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":13,"method":"starhub_list_assets"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    // 空资产库:契约是 JSON 数组字符串
    assert_eq!(value["result"]["text"], "[]");
}

#[test]
fn exec_abort_notification_is_consumed_and_acknowledges_unknown_ids() {
    let mut sidecar = Sidecar::spawn();
    // 通知形态:无声应答,下一条请求必须是第一个被应答的帧
    sidecar.send(r#"{"jsonrpc":"2.0","method":"starhub/exec.abort","params":{"execId":"gone"}}"#);
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":14,"method":"ping"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["id"], 14);

    // 请求形态(对端想确认时):未知 exec_id 按未中断返回,不是错误
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":15,"method":"starhub/exec.abort","params":{"execId":"gone"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["result"]["aborted"], false);

    // 缺 execId:参数形状错误
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":16,"method":"starhub/exec.abort","params":{}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
}

#[test]
fn bind_asset_context_rejects_unknown_assets_and_missing_params() {
    let mut sidecar = Sidecar::spawn();
    // 缺 sessionId
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":17,"method":"bind_asset_context","params":{"assetId":"ghost"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("sessionId"));

    // 资产不存在:硬错误(与 load_asset_config 的旧文案一致)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":18,"method":"bind_asset_context","params":{"assetId":"ghost","sessionId":"s1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603);
    assert_eq!(value["error"]["message"], "资产不存在: ghost");
}
