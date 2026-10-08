//! StarHub Rust sidecar entry: newline-delimited JSON-RPC 2.0 over stdio.
//!
//! One JSON value per `\n`-terminated UTF-8 line, matching the TypeScript
//! peer `JsonRpcLineTransport`. Requests are answered with exactly one
//! response frame; notifications and responses are consumed silently;
//! malformed lines are ignored without killing the process. stdin EOF ends
//! the process with status 0. Diagnostics go to stderr only — stdout is the
//! protocol channel.

use std::io::{BufRead, Write};

use starhub_sidecar::jsonrpc::{InboundFrame, OutboundResponse};

fn main() {
    let registry = starhub_sidecar::methods::registry_with_builtins();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("starhub-sidecar-rust: stdin read error: {error}");
                break;
            }
        };
        let Some(frame) = InboundFrame::parse(&line) else {
            continue; // malformed line: ignored per protocol contract
        };
        let Some((id, outcome)) = registry.dispatch(&frame) else {
            continue; // notification or response: nothing to answer
        };
        let response = match outcome {
            Ok(result) => OutboundResponse::ok(id, result),
            Err(error) => OutboundResponse::fail(id, error),
        };
        if writeln!(out, "{}", response.to_line()).is_err() {
            break; // stdout closed: peer is gone
        }
        if out.flush().is_err() {
            break;
        }
    }
}
