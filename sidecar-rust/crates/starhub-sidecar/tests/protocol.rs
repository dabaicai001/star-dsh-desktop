//! Protocol integration: spawn the real sidecar binary and speak the
//! newline-delimited JSON-RPC 2.0 protocol over its stdio, exercising the
//! same frame shapes the TypeScript bridge (`JsonRpcLineTransport`) sends.
//!
//! The SSH/SFTP methods resolve their target asset from the store the binary
//! was started with (`STARHUB_ASSETS_FILE`), so the tests point it at a
//! throwaway file — no real SSH server is contacted; the covered paths are
//! the ones that answer before any network I/O (asset resolution, status
//! query, abort acknowledgement).
//!
//! The DB/Redis/ES/Docker methods additionally need a Go sidecar to talk to;
//! `spawn_with_fake_go_sidecar` points `STARHUB_GO_SIDECAR` at a wrapper that
//! runs the Python protocol double shipped in `starhub-domain-db`, so the
//! whole chain (binary → registry → block_on → GoSidecar → fake Go sidecar)
//! is exercised without a real MySQL/Redis/ES/Docker.

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
        Self::spawn_inner(None)
    }

    /// Spawn with a seeded asset store and the fake Go sidecar wired in.
    fn spawn_with_fake_go_sidecar(assets: &str) -> Self {
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("starhub-domain-db")
            .join("tests")
            .join("fixtures")
            .join("fake-go-sidecar.py")
            .canonicalize()
            .expect("fake Go sidecar fixture resolves");
        let (program, args) = python_interpreter();
        let wrapper = write_wrapper(&fixture, &program, &args);
        Self::spawn_inner(Some((assets.to_string(), wrapper)))
    }

    fn spawn_inner(config: Option<(String, PathBuf)>) -> Self {
        let unique = format!(
            "starhub-sidecar-it-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let assets = dir.join("assets.json");
        let seeded = config
            .as_ref()
            .map(|(assets, _)| assets.clone())
            .unwrap_or_else(|| r#"{"assets":[]}"#.to_string());
        std::fs::write(&assets, seeded).expect("seed assets file");
        let mut command = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"));
        command
            .env("STARHUB_ASSETS_FILE", &assets)
            // 空串 = 内存密钥存储:测试不碰任何真实密钥环
            .env("STARHUB_SECRETS_FILE", "")
            .env("STARHUB_KNOWN_HOSTS_FILE", dir.join("known-hosts.json"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some((_, wrapper)) = &config {
            command.env("STARHUB_GO_SIDECAR", wrapper);
        }
        let child = command.spawn().expect("sidecar binary spawns");
        Self { child, _dir: dir }
    }

    /// Send one request line and read the matching response line.
    ///
    /// Frames without an `id` (sidecar notifications — domain events, UI-action
    /// intents) are skipped: a domain-event notification is flushed *before*
    /// the response of the request that caused it, so a naive "next line" read
    /// would consume the notification and hang. The TypeScript peer
    /// (`JsonRpcLineTransport`) demultiplexes by id; this does the same.
    fn roundtrip(&mut self, request: &str) -> String {
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(request.as_bytes()).expect("write request");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush request");
        read_response(&mut self.child)
    }

    /// Send a raw line without expecting a response.
    fn send(&mut self, line: &str) {
        let stdin = self.child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(line.as_bytes()).expect("write line");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush line");
    }
}

/// Read frames until the next response (a frame carrying `id`), skipping
/// sidecar notifications (domain events, UI-action intents).
///
/// The sidecar flushes a request's notifications *before* its response, so a
/// one-line read would consume the notification instead. The TypeScript peer
/// (`JsonRpcLineTransport`) demultiplexes by id; this helper mirrors that.
fn read_response(child: &mut Child) -> String {
    let stdout = child.stdout.as_mut().expect("stdout piped");
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read response");
        assert!(
            line.ends_with('\n'),
            "response frames are newline-terminated"
        );
        let frame = line.trim_end().to_string();
        let parsed: serde_json::Value = serde_json::from_str(&frame).expect("frame parses");
        if parsed.get("id").is_some() {
            return frame;
        }
        // Notification frame (no id): keep reading for the response.
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self._dir);
    }
}

/// 找一个 Python 解释器(契约测试的假 Go sidecar 是 Python 脚本)。
fn python_interpreter() -> (String, Vec<String>) {
    for candidate in ["python", "python3"] {
        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
        {
            return (candidate.to_string(), Vec::new());
        }
    }
    // 兜底:仓库 venv(test-sftp/.venv),相对本 crate 的位置固定
    let venv = if cfg!(target_os = "windows") {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-sftp/.venv/Scripts/python.exe")
    } else {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-sftp/.venv/bin/python")
    };
    (
        venv.canonicalize()
            .expect("a python interpreter is available for the contract tests")
            .display()
            .to_string(),
        Vec::new(),
    )
}

/// 写一个启动包装:把「解释器 + fixture 脚本」包成单个可执行路径,
/// 这样 `STARHUB_GO_SIDECAR`(单程序路径)就能承载「python script.py」。
fn write_wrapper(fixture: &std::path::Path, program: &str, _args: &[String]) -> PathBuf {
    let unique = format!(
        "starhub-go-wrapper-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).expect("wrapper dir");
    let path = dir.join(if cfg!(target_os = "windows") {
        "fake-go-sidecar.cmd"
    } else {
        "fake-go-sidecar.sh"
    });
    let body = if cfg!(target_os = "windows") {
        format!(
            "@echo off\r\n\"{program}\" \"{}\" %*\r\n",
            fixture.display()
        )
    } else {
        format!(
            "#!/bin/sh\nexec \"{program}\" \"{}\" \"$@\"\n",
            fixture.display()
        )
    };
    std::fs::write(&path, body).expect("write wrapper");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("wrapper executable");
    }
    path
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
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-1","method":"starhub/capabilities"}"#);
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
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-2","method":"starhub/capabilities"}"#);
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

// ---------- DB / Redis / ES / Docker 方法面(M1 第 5 步) ----------

/// 资产库:mysql / redis / es / docker 各一条(假 Go sidecar 提供连接与结果)。
const DB_ASSETS: &str = r#"{
  "assets": [
    { "id": "mysql-1", "type": "db", "name": "mysql",
      "config": { "dbType": "mysql", "host": "db.internal", "port": 3306,
                  "username": "root", "password": "pw", "database": "app" } },
    { "id": "redis-1", "type": "db", "name": "redis",
      "config": { "dbType": "redis", "host": "r.internal", "port": 6379, "redisDb": 3 } },
    { "id": "es-1", "type": "db", "name": "es",
      "config": { "dbType": "elasticsearch", "host": "es.internal", "port": 9200 } },
    { "id": "docker-1", "type": "docker", "name": "docker",
      "config": { "dockerTransport": "socket" } }
  ]
}"#;

#[test]
fn capabilities_lists_the_db_method_surface() {
    let mut sidecar = Sidecar::spawn();
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"cap-db","method":"starhub/capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods: Vec<&str> = value["result"]["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .map(|m| m.as_str().expect("method name"))
        .collect();
    for expected in [
        "db_query",
        "redis_exec",
        "es_list_indices",
        "es_cluster_health",
        "es_get_mapping",
        "es_search",
        "es_get_document",
        "es_count",
        "es_index_document",
        "es_delete_document",
        "es_delete_index",
        "docker_list_containers",
        "docker_logs",
        "docker_inspect",
        "docker_exec",
    ] {
        assert!(
            methods.contains(&expected),
            "missing {expected}: {methods:?}"
        );
    }
}

/// 全链路 roundtrip:真二进制 → 方法注册 → block_on → GoSidecar → 假 Go sidecar。
/// 断言的是模型可读文本(契约),不是内部结构。
#[test]
fn db_methods_roundtrip_through_the_real_binary() {
    let mut sidecar = Sidecar::spawn_with_fake_go_sidecar(DB_ASSETS);

    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-1","method":"db_query","params":{"assetId":"mysql-1","sql":"SELECT * FROM users"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(
        value["result"]["text"],
        "列: id, name\nid=1 | name=alice\nid=2 | name=bob"
    );

    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-2","method":"redis_exec","params":{"assetId":"redis-1","command":"GET key","db":15}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"]["text"], "cached-value");

    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-3","method":"es_list_indices","params":{"assetId":"es-1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(
        value["result"]["text"],
        "logs-2026 | 12 | 48kb | green\nmetrics | 3 | 12kb | yellow"
    );

    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-4","method":"docker_exec","params":{"assetId":"docker-1","container":"web","command":"echo hi"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"]["text"], "container-output");

    // 工具族不匹配 → 软错误(Ok 文本):mysql 资产上调 ssh_exec
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-5","method":"ssh_exec","params":{"assetId":"mysql-1","command":"ls"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"]["text"]
        .as_str()
        .unwrap()
        .contains("不是 SSH 资产"));

    // SELECT 拦截 → 软错误(不触网)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"db-6","method":"redis_exec","params":{"assetId":"redis-1","command":"SELECT 15"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"]["text"]
        .as_str()
        .unwrap()
        .contains("SELECT 切库不会保留"));
}

// ---------- Desktop 方法面(M1 第 6 步) ----------

#[test]
fn capabilities_lists_the_desktop_method_surface() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":"cap-desktop","method":"starhub/capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods: Vec<&str> = value["result"]["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .map(|m| m.as_str().expect("method name"))
        .collect();
    for expected in [
        "desktop_list_templates",
        "desktop_build_template",
        "desktop_create_sandbox",
        "desktop_sandbox_status",
        "desktop_pause_sandbox",
        "desktop_resume_sandbox",
        "desktop_destroy_sandbox",
        "desktop_commit_sandbox",
        "desktop_sandbox_replay",
        "desktop_screenshot",
        "desktop_list_windows",
        "desktop_get_foreground_window",
        "desktop_focus_window",
        "desktop_click",
        "desktop_double_click",
        "desktop_move_mouse",
        "desktop_scroll",
        "desktop_drag",
        "desktop_type",
        "desktop_press_key",
        "desktop_exec",
        "desktop_request_user_action",
    ] {
        assert!(
            methods.contains(&expected),
            "missing {expected}: {methods:?}"
        );
    }
}

/// Desktop 方法面 roundtrip(不触 Docker 的分支):模板清单走 JSON 存储,
/// 空沙箱状态走实例清单——两条都不需要 Go sidecar / Docker daemon。
#[test]
fn desktop_methods_roundtrip_through_the_real_binary() {
    let unique = format!(
        "starhub-sidecar-desktop-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let assets = dir.join("assets.json");
    std::fs::write(&assets, br#"{"assets":[]}"#).expect("seed assets file");
    let sandbox = dir.join("sandbox.json");
    let mut command = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"));
    command
        .env("STARHUB_ASSETS_FILE", &assets)
        .env("STARHUB_SECRETS_FILE", "")
        .env("STARHUB_KNOWN_HOSTS_FILE", dir.join("known-hosts.json"))
        .env("STARHUB_SANDBOX_FILE", &sandbox)
        .env("STARHUB_SETTINGS_FILE", dir.join("settings.json"))
        .env("STARHUB_CACHE_DIR", dir.join("cache"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("sidecar binary spawns");

    fn roundtrip(child: &mut Child, request: &str) -> String {
        let stdin = child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(request.as_bytes()).expect("write request");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush request");
        read_response(child)
    }

    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"d-1","method":"desktop_list_templates","params":{}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    let text = value["result"]["text"].as_str().unwrap();
    assert!(text.contains("模板名 | 镜像状态 | 创建时间"), "{text}");
    assert!(text.contains("ubuntu-desktop | 未构建"), "{text}");

    // 模板已播种落盘(持久化:重启后仍在)
    let persisted = std::fs::read_to_string(&sandbox).expect("sandbox file written");
    assert!(persisted.contains("ubuntu-desktop"), "{persisted}");

    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"d-2","method":"desktop_sandbox_status","params":{}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"]["text"], "当前没有运行中的沙箱实例");

    // 未授权写操作:硬错误(不触 Docker)
    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"d-3","method":"desktop_screenshot","params":{"sandboxId":"ghost"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("没有沙箱授权"));

    drop(child.stdin.take());
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- Browser 方法面(M1 第 6 步) ----------

#[test]
fn capabilities_lists_the_browser_method_surface() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":"cap-browser","method":"starhub/capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods: Vec<&str> = value["result"]["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .map(|m| m.as_str().expect("method name"))
        .collect();
    for expected in [
        "browser_open",
        "browser_navigate",
        "browser_back",
        "browser_forward",
        "browser_reload",
        "browser_state",
        "browser_extract",
        "browser_click",
        "browser_type",
        "browser_press_key",
        "browser_select_option",
        "browser_scroll",
        "browser_screenshot",
        "browser_eval",
        "browser_decide",
        "browser_auto",
    ] {
        assert!(
            methods.contains(&expected),
            "missing {expected}: {methods:?}"
        );
    }
}

/// Browser 方法面 roundtrip:参数契约(软错误)先于引擎提示返回;
/// 未知方法仍是 -32601。
#[test]
fn browser_methods_roundtrip_through_the_real_binary() {
    let mut sidecar = Sidecar::spawn_with_fake_go_sidecar(DB_ASSETS);

    // 合法参数 → 引擎未就绪提示(M3 落地前的确定性应答)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-1","method":"browser_open","params":{"url":"example.com"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"]["text"].as_str().unwrap().contains("M3"));

    // 非法参数 → 软错误(与 Tauri 版文案一致)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-2","method":"browser_click","params":{"id":"12a"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"]["text"].as_str().unwrap().contains("纯数字"));

    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":"b-3","method":"browser_navigate","params":{}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["result"]["text"]
        .as_str()
        .unwrap()
        .contains("url 不能为空"));
}

#[test]
fn capabilities_lists_the_android_method_surface() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":"cap-android","method":"starhub/capabilities"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let methods: Vec<&str> = value["result"]["methods"]
        .as_array()
        .expect("methods array")
        .iter()
        .map(|m| m.as_str().expect("method name"))
        .collect();
    for expected in [
        "android_list_devices",
        "android_connect",
        "android_disconnect",
        "android_device_status",
        "android_replay",
        "android_wireless",
        "android_screenshot",
        "android_current_app",
        "android_ui_tree",
        "android_tap",
        "android_double_tap",
        "android_swipe",
        "android_scroll",
        "android_type",
        "android_press_key",
        "android_launch_app",
        "android_open_live",
        "android_pull",
        "android_push",
        "android_exec",
        // 桥命令(非工具方法,契约 §2.2):对端是 bridge 插件
        "starhub/capabilities",
        "starhub/open.asset",
        "starhub/focus.tool",
        "starhub/live.snapshot",
        // UI 面(M2):工作台命令 `ui.<tauriCommand>`,经 bridge 的 invoke 端点
        "ui.get_assets",
        "ui.create_asset",
        "ui.update_asset",
        "ui.delete_asset",
        // B 组交互会话(connId 面):SSH 终端 + SFTP 面板
        "ui.ssh_connect",
        "ui.ssh_write",
        "ui.ssh_write_binary",
        "ui.ssh_resize",
        "ui.ssh_disconnect",
        "ui.ssh_get_sessions",
        "ui.ssh_exec",
        "ui.ssh_kb_response",
        "ui.ssh_hostkey_response",
        "ui.ssh_bastion_response",
        "ui.ssh_get_trusted_host_key",
        "ui.test_ssh_connection",
        "ui.ssh_open_web_window",
        "ui.sftp_ensure_session",
        "ui.sftp_home_dir",
        "ui.sftp_list",
        "ui.sftp_stat",
        "ui.sftp_mkdir",
        "ui.sftp_remove",
        "ui.sftp_rename",
        "ui.sftp_start_upload",
        "ui.sftp_start_download",
        "ui.sftp_pause_transfer",
        "ui.sftp_resume_transfer",
        "ui.sftp_cancel_transfer",
        "ui.sftp_retry_transfer",
        "ui.sftp_set_speed_limit",
        "ui.sftp_clear_transfers",
        "ui.sftp_list_transfers",
        "ui.sftp_reveal_local",
        // C 组数据面连接(connId 面,经 Go sidecar 转发)
        "ui.db_mysql_connect",
        "ui.db_mysql_execute",
        "ui.db_mysql_update_rows",
        "ui.db_clickhouse_execute",
        "ui.db_postgres_connect",
        "ui.db_sqlite_test",
        "ui.db_mssql_disconnect",
        "ui.db_redis_scan",
        "ui.db_redis_set",
        "ui.db_es_search",
        "ui.db_es_create_index",
        "ui.docker_connect",
        "ui.docker_exec_session_write",
        "ui.docker_prune_images",
        "ui.broker_test",
        "ui.broker_overview",
    ] {
        assert!(
            methods.contains(&expected),
            "missing {expected}: {methods:?}"
        );
    }
    // 方法面总数:12(ssh/sftp + 全局)+ 15(db)+ 22(desktop)+ 20(android)+ 16(browser)
    // + 4 桥命令 + 4 UI 面(资产 CRUD)+ 30 UI 面 B 组(交互会话)
    // + 86 UI 面 C 组(数据面连接)= 209
    assert_eq!(methods.len(), 209, "方法面总数: {methods:?}");
}

/// Android 方法面 roundtrip(不触设备的分支):未授权写操作硬错误;
/// `android_replay` 空清单走 JSON 帧存储;未知方法 -32601。
#[test]
fn android_methods_roundtrip_through_the_real_binary() {
    let unique = format!(
        "starhub-sidecar-android-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let assets = dir.join("assets.json");
    std::fs::write(&assets, br#"{"assets":[]}"#).expect("seed assets file");
    let mut command = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"));
    command
        .env("STARHUB_ASSETS_FILE", &assets)
        .env("STARHUB_SECRETS_FILE", "")
        .env("STARHUB_KNOWN_HOSTS_FILE", dir.join("known-hosts.json"))
        .env("STARHUB_SANDBOX_FILE", dir.join("sandbox.json"))
        .env("STARHUB_SETTINGS_FILE", dir.join("settings.json"))
        .env("STARHUB_CACHE_DIR", dir.join("cache"))
        .env(
            "STARHUB_ANDROID_FRAMES_FILE",
            dir.join("android-frames.json"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("sidecar binary spawns");

    fn roundtrip(child: &mut Child, request: &str) -> String {
        let stdin = child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(request.as_bytes()).expect("write request");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush request");
        read_response(child)
    }

    // 未授权写操作:硬错误(不触 adb)
    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"a-1","method":"android_tap","params":{"x":1,"y":2}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("没有设备授权"));

    // 空回放:走 JSON 帧存储(本机无 adb 也能答)
    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"a-2","method":"android_replay","params":{"serial":"nope"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"]["text"], "设备 nope 没有回放帧");

    // 未知工具:-32601
    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"a-3","method":"android_nope","params":{}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32601);

    drop(child.stdin.take());
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- 桥命令面(M1 第 7 步:契约 §2.2) ----------

/// 读接下来的 N 行(通知 + 响应都可能占行)。
fn read_lines(sidecar: &mut Sidecar, count: usize) -> Vec<String> {
    let stdout = sidecar.child.stdout.as_mut().expect("stdout piped");
    let mut reader = BufReader::new(stdout);
    let mut lines = Vec::with_capacity(count);
    for _ in 0..count {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read line");
        lines.push(line.trim_end().to_string());
    }
    lines
}

#[test]
fn open_asset_predicts_the_action_and_notifies_the_bridge() {
    let mut sidecar = Sidecar::spawn();
    let stdin = sidecar.child.stdin.as_mut().expect("stdin piped");
    stdin
        .write_all(br#"{"jsonrpc":"2.0","id":"oa-1","method":"starhub/open.asset","params":{"assetId":"a1","tool":"terminal"}}"#)
        .expect("write request");
    stdin.write_all(b"\n").expect("write newline");
    stdin.flush().expect("flush request");
    // 因果顺序:意图通知在响应之前
    let lines = read_lines(&mut sidecar, 2);
    let notification: serde_json::Value =
        serde_json::from_str(&lines[0]).expect("notification parses");
    assert_eq!(notification["method"], "starhub/domain-event");
    assert_eq!(notification["params"]["event"], "starhub://open-asset");
    assert_eq!(notification["params"]["payload"]["assetId"], "a1");
    assert_eq!(notification["params"]["payload"]["tool"], "terminal");
    assert_eq!(notification["params"]["payload"]["action"], "opened");
    let response: serde_json::Value = serde_json::from_str(&lines[1]).expect("response parses");
    assert_eq!(response["id"], "oa-1");
    assert_eq!(response["result"]["ok"], true);
    assert_eq!(response["result"]["action"], "opened");

    // 同一 (资产, 工具) 第二次 = focus
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"oa-2","method":"starhub/focus.tool","params":{"assetId":"a1","tool":"terminal"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["result"]["action"], "focused");
}

#[test]
fn focus_tool_requires_the_tool_parameter() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"ft-1","method":"starhub/focus.tool","params":{"assetId":"a1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("缺少 tool"));
}

#[test]
fn live_snapshot_reports_the_contract_views() {
    let mut sidecar = Sidecar::spawn();
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"ls-1","method":"starhub/live.snapshot"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    let result = &value["result"];
    assert!(result["sessions"].is_array(), "{response}");
    assert!(result["transfers"].is_array(), "{response}");
    assert!(result["recentExecs"].is_array(), "{response}");
    assert!(result["taskTrails"].is_array(), "{response}");
}

#[test]
fn a_domain_tool_success_emits_the_ai_origin_event_first() {
    let unique = format!(
        "starhub-sidecar-event-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    let dir = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let assets = dir.join("assets.json");
    std::fs::write(&assets, br#"{"assets":[]}"#).expect("seed assets file");
    let mut command = Command::new(env!("CARGO_BIN_EXE_starhub-sidecar-rust"));
    command
        .env("STARHUB_ASSETS_FILE", &assets)
        .env("STARHUB_SECRETS_FILE", "")
        .env("STARHUB_KNOWN_HOSTS_FILE", dir.join("known-hosts.json"))
        .env(
            "STARHUB_ANDROID_FRAMES_FILE",
            dir.join("android-frames.json"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("sidecar binary spawns");

    fn roundtrip(child: &mut Child, request: &str) -> String {
        let stdin = child.stdin.as_mut().expect("stdin piped");
        stdin.write_all(request.as_bytes()).expect("write request");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush request");
        read_response(child)
    }

    /// 读接下来的 N 行(事件通知占行,响应紧随其后)。
    fn read_lines(child: &mut Child, count: usize) -> Vec<String> {
        let stdout = child.stdout.as_mut().expect("stdout piped");
        let mut reader = BufReader::new(stdout);
        let mut lines = Vec::with_capacity(count);
        for _ in 0..count {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read line");
            lines.push(line.trim_end().to_string());
        }
        lines
    }

    // android_replay 是不触设备的域工具:成功 → AI 起源事件 + recentExecs
    let stdin = child.stdin.as_mut().expect("stdin piped");
    stdin
        .write_all(
            br#"{"jsonrpc":"2.0","id":"ev-1","method":"android_replay","params":{"serial":"nope"}}"#,
        )
        .expect("write request");
    stdin.write_all(b"\n").expect("write newline");
    stdin.flush().expect("flush request");
    let lines = read_lines(&mut child, 2);
    let value: serde_json::Value = serde_json::from_str(&lines[0]).expect("frame parses");
    assert_eq!(value["method"], "starhub/domain-event");
    assert_eq!(value["params"]["event"], "starhub/domain.event");
    assert_eq!(value["params"]["payload"]["kind"], "android.action");
    assert_eq!(value["params"]["payload"]["origin"], "ai");
    assert_eq!(
        value["params"]["payload"]["summary"],
        "android_replay: 设备 nope"
    );
    assert!(value["params"]["payload"]["assetId"].is_null());
    let value: serde_json::Value = serde_json::from_str(&lines[1]).expect("response parses");
    assert_eq!(value["id"], "ev-1");
    assert_eq!(value["result"]["text"], "设备 nope 没有回放帧");

    // recentExecs 无资产上下文时为空(绑定后才写缓存)
    let response = roundtrip(
        &mut child,
        r#"{"jsonrpc":"2.0","id":"ev-2","method":"starhub/live.snapshot"}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(
        value["result"]["recentExecs"].as_array().map(Vec::len),
        Some(0)
    );

    drop(child.stdin.take());
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------- UI 面(M2):工作台命令 ui.<tauriCommand> ----------

/// UI 面资产 CRUD 的真二进制 roundtrip:建 → 列 → 改 → 删,并断言 snake_case
/// 线形状(工作台 `RustAsset`)与敏感字段不回流。
#[test]
fn ui_asset_crud_roundtrips_through_the_real_binary() {
    let mut sidecar = Sidecar::spawn();
    let created = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-1","method":"ui.create_asset","params":{"id":"a1","type":"ssh","name":"验收机","config":{"host":"10.0.0.1","port":22,"username":"root","password":"s3cret"},"groupId":2,"tags":["prod"],"favorite":true}}"#);
    let value: serde_json::Value = serde_json::from_str(&created).expect("response parses");
    assert!(value["error"].is_null(), "{created}");
    assert_eq!(value["result"]["id"], "a1");
    assert_eq!(value["result"]["group_id"], 2);
    assert_eq!(value["result"]["key_id"], "asset:a1");
    assert_eq!(value["result"]["favorite"], true);
    assert!(
        value["result"]["config"].get("password").is_none(),
        "敏感字段不应回流"
    );
    assert!(value["result"]["created_at"].as_i64().expect("ts") > 0);

    let listed = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-2","method":"ui.get_assets"}"#);
    let value: serde_json::Value = serde_json::from_str(&listed).expect("response parses");
    let items = value["result"].as_array().expect("array");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "验收机");
    assert!(!listed.contains("s3cret"), "清单不得带密钥");

    let updated = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-3","method":"ui.update_asset","params":{"id":"a1","type":"ssh","name":"新名","config":{"host":"10.0.0.2"}}}"#);
    let value: serde_json::Value = serde_json::from_str(&updated).expect("response parses");
    assert_eq!(value["result"]["name"], "新名");
    assert_eq!(value["result"]["favorite"], false, "未传的 favorite 归缺省");

    let deleted = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"u-4","method":"ui.delete_asset","params":{"id":"a1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&deleted).expect("response parses");
    assert_eq!(value["result"]["ok"], true);
    let listed = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-5","method":"ui.get_assets"}"#);
    let value: serde_json::Value = serde_json::from_str(&listed).expect("response parses");
    assert_eq!(value["result"].as_array().map(Vec::len), Some(0));

    // 删除后域工具按「资产不存在」报错(存储确实空了)
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-6","method":"ssh_exec","params":{"assetId":"a1","command":"ls"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(
        value["error"]["message"]
            .as_str()
            .expect("message")
            .contains("资产不存在"),
        "{response}"
    );
}

/// UI 面参数校验:Excel 类型已删、缺 id,都是 -32602。
#[test]
fn ui_asset_methods_validate_parameters() {
    let mut sidecar = Sidecar::spawn();
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-7","method":"ui.create_asset","params":{"id":"a1","type":"excel","name":"x"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
    assert!(value["error"]["message"]
        .as_str()
        .expect("message")
        .contains("不支持的资产类型"));
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"u-8","method":"ui.delete_asset","params":{}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602);
    assert!(value["error"]["message"]
        .as_str()
        .expect("message")
        .contains("缺少 id"));
}

/// UI 面 B 组(交互会话)真二进制 roundtrip:会话不存在 / 无写通道 / 无待应答
/// 三条不触网路径,错误码与文案与 Tauri command 逐字一致。
#[test]
fn ui_ssh_methods_roundtrip_through_the_real_binary() {
    let mut sidecar = Sidecar::spawn();

    // 空会话表:ssh_get_sessions 返回空数组
    let response =
        sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"b-1","method":"ui.ssh_get_sessions"}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"], serde_json::json!([]));

    // 会话不存在:SFTP 浏览面硬错误(文案与 Tauri 版一致)
    for (id, method) in [
        ("b-2", "ui.sftp_list"),
        ("b-3", "ui.sftp_stat"),
        ("b-4", "ui.sftp_home_dir"),
        ("b-5", "ui.sftp_ensure_session"),
        ("b-6", "ui.sftp_mkdir"),
        ("b-7", "ui.sftp_remove"),
        ("b-8", "ui.sftp_rename"),
    ] {
        let response = sidecar.roundtrip(&format!(
            r#"{{"jsonrpc":"2.0","id":"{id}","method":"{method}","params":{{"id":"ghost","path":"/tmp","from":"/a","to":"/b"}}}}"#
        ));
        let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
        assert_eq!(value["error"]["code"], -32603, "{response}");
        assert_eq!(
            value["error"]["message"], "Session not found",
            "{method}: {response}"
        );
    }
    // resize 同样按会话定位
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-9","method":"ui.ssh_resize","params":{"id":"ghost","cols":80,"rows":24}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["message"], "Session not found", "{response}");

    // 无写通道时写操作静默成功(由 ssh:close 事件告知前端,与 Tauri 版一致)
    let response = sidecar
        .roundtrip(r#"{"jsonrpc":"2.0","id":"b-10","method":"ui.ssh_write","params":{"id":"ghost","data":"ls\n"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(
        value["result"].is_null(),
        "Result<(), String> 的形状是 null"
    );

    // 断开会话幂等;断开未知会话不发 registry.sync(无多余通知帧)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-11","method":"ui.ssh_disconnect","params":{"id":"ghost"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"].is_null(), "{response}");

    // 无待应答的三条回复通道:文案逐字保持
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-12","method":"ui.ssh_kb_response","params":{"id":"ghost","responses":["123456"]}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(
        value["error"]["message"], "No pending kb prompt for session ghost",
        "{response}"
    );
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-13","method":"ui.ssh_hostkey_response","params":{"id":"ghost","allowed":true,"persist":false}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(
        value["error"]["message"], "No pending hostkey prompt for session ghost",
        "{response}"
    );
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-14","method":"ui.ssh_bastion_response","params":{"id":"ghost","selection":""}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(
        value["error"]["message"], "No pending bastion prompt for session ghost",
        "{response}"
    );

    // 空 known_hosts:受信任主机密钥为 null
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-15","method":"ui.ssh_get_trusted_host_key","params":{"host":"10.0.0.1","port":22}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(value["result"].is_null(), "{response}");

    // 传输任务表:空清单 / 清除 0 条 / 未知任务的暂停与取消幂等
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"b-16","method":"ui.sftp_list_transfers","params":{"id":"ghost"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["result"], serde_json::json!([]));
    let response = sidecar.roundtrip(r#"{"jsonrpc":"2.0","id":"b-17","method":"ui.sftp_clear_transfers","params":{"id":"ghost"}}"#);
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["result"], 0);
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-18","method":"ui.sftp_pause_transfer","params":{"id":"ghost","transferId":"t1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-19","method":"ui.sftp_cancel_transfer","params":{"id":"ghost","transferId":"t1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    // resume / retry 对未知任务是硬错误(不能假装成功)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-20","method":"ui.sftp_resume_transfer","params":{"id":"ghost","transferId":"t1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603, "{response}");
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-21","method":"ui.sftp_retry_transfer","params":{"id":"ghost","transferId":"t1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603, "{response}");

    // 窗口类动作显式降级(不是 -32601 的晦涩错误)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-22","method":"ui.ssh_open_web_window","params":{"sessionId":"ghost","assetName":"x"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603, "{response}");
    assert!(value["error"]["message"]
        .as_str()
        .expect("message")
        .contains("M3"));

    // 参数校验:-32602,文案与 A 组一致
    for (id, request) in [
        (
            "b-23",
            r#"{"jsonrpc":"2.0","id":"b-23","method":"ui.ssh_write","params":{"data":"x"}}"#,
        ),
        (
            "b-25",
            r#"{"jsonrpc":"2.0","id":"b-25","method":"ui.sftp_start_upload","params":{"id":"s1","remoteDir":"/tmp"}}"#,
        ),
        (
            "b-26",
            r#"{"jsonrpc":"2.0","id":"b-26","method":"ui.ssh_hostkey_response","params":{"id":"s1","allowed":true}}"#,
        ),
    ] {
        let response = sidecar.roundtrip(request);
        let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
        assert_eq!(value["error"]["code"], -32602, "{id}: {response}");
        assert!(
            value["error"]["message"]
                .as_str()
                .expect("message")
                .starts_with("缺少"),
            "{id}: {response}"
        );
    }
    // 二进制写通道的字节越界是独立的参数错误
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"b-24","method":"ui.ssh_write_binary","params":{"id":"s1","data":[300]}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32602, "{response}");
    assert!(
        value["error"]["message"]
            .as_str()
            .expect("message")
            .contains("data 必须是字节数组"),
        "{response}"
    );
}

/// UI 面 C 组(数据面连接)真二进制 roundtrip:接假 Go sidecar,验两种参数形态
/// (Wrapped 拆封 / Flat 平铺)、参数白名单与 broker kind 白名单文案。
#[test]
fn ui_db_methods_roundtrip_through_the_real_binary() {
    let mut sidecar = Sidecar::spawn_with_fake_go_sidecar(DB_ASSETS);

    // Wrapped:connect 把配置包在 params 里,必须拆封后转发
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"c-1","method":"ui.db_mysql_connect","params":{"params":{"host":"db.internal","port":3306,"username":"root"}}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert!(
        value["result"]["connId"]
            .as_str()
            .is_some_and(|id| id.starts_with("mysql-conn-")),
        "{response}"
    );

    // Flat:连接面命令平铺转发(假 sidecar 的 *.disconnect 回 {ok:true})
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"c-2","method":"ui.db_mysql_disconnect","params":{"connId":"mysql-conn-1"}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    assert_eq!(value["result"]["ok"], true);

    // docker.listContainers 的罐头答案(证明平铺参数原样到达 Go sidecar)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"c-3","method":"ui.docker_list_containers","params":{"connId":"docker-conn-1","all":false}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(value["error"].is_null(), "{response}");
    let items = value["result"].as_array().expect("array");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "web");

    // 参数白名单:缺 connId / 缺 sql / 缺 params 信封都是 -32602
    for (id, request) in [
        (
            "c-4",
            r#"{"jsonrpc":"2.0","id":"c-4","method":"ui.db_mysql_disconnect","params":{}}"#,
        ),
        (
            "c-5",
            r#"{"jsonrpc":"2.0","id":"c-5","method":"ui.db_mysql_execute","params":{"connId":"c1"}}"#,
        ),
        (
            "c-6",
            r#"{"jsonrpc":"2.0","id":"c-6","method":"ui.db_redis_connect","params":{}}"#,
        ),
        (
            "c-7",
            r#"{"jsonrpc":"2.0","id":"c-7","method":"ui.docker_exec_session_write","params":{"connId":"c1","sessionId":"s1"}}"#,
        ),
    ] {
        let response = sidecar.roundtrip(request);
        let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
        assert_eq!(value["error"]["code"], -32602, "{id}: {response}");
        assert!(
            value["error"]["message"]
                .as_str()
                .expect("message")
                .starts_with("缺少"),
            "{id}: {response}"
        );
    }

    // broker kind 白名单:文案与 Tauri 版逐字一致
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"c-8","method":"ui.broker_test","params":{"kind":"rabbit","params":{}}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert_eq!(value["error"]["code"], -32603, "{response}");
    assert_eq!(value["error"]["message"], "unsupported broker: rabbit");

    // 白名单内的 kind 走到 Go sidecar(假 sidecar 不实现 broker.*,错误里带 RPC 名)
    let response = sidecar.roundtrip(
        r#"{"jsonrpc":"2.0","id":"c-9","method":"ui.broker_overview","params":{"kind":"kafka","params":{"host":"b"}}}"#,
    );
    let value: serde_json::Value = serde_json::from_str(&response).expect("response parses");
    assert!(
        value["error"]["message"]
            .as_str()
            .expect("message")
            .contains("broker.kafka.overview"),
        "{response}"
    );
}
