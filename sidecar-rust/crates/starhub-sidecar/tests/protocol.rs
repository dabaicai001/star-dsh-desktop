//! Protocol integration: spawn the real sidecar binary and speak the
//! newline-delimited JSON-RPC 2.0 protocol over its stdio, exercising the
//! same frame shapes the TypeScript bridge (`JsonRpcLineTransport`) sends.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

struct Sidecar {
    child: Child,
}

impl Sidecar {
    fn spawn() -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("sidecar binary spawns");
        Self { child }
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
        assert!(line.ends_with('\n'), "response frames are newline-terminated");
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
    let protocol = value["result"]["protocol"].as_str().expect("protocol string");
    assert!(protocol.starts_with("starhub-sidecar-rust/"), "protocol: {protocol}");
}

#[test]
fn capabilities_lists_registered_methods() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-1","method":"starhub_list_capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods = value["result"]["methods"].as_array().expect("methods array");
    assert!(methods.iter().any(|m| m == "ping"), "ping registered: {methods:?}");
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
