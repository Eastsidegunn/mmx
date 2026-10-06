use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const A: &str = "flowchart LR\n    A --> B\n";
const B: &str = "flowchart LR\n    A --> B\n    B --> C\n";
const C: &str = "flowchart LR\n    A --> B\n    B --> C\n    C --> D\n";

struct Server {
    child: Child,
    addr: SocketAddr,
    dir: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn tempdir() -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "serve-test-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir(&dir).unwrap();
    dir
}

fn start(source: &str) -> Server {
    let dir = tempdir();
    std::fs::write(dir.join("d.mmd"), source).unwrap();
    start_dir(dir, &[])
}

fn start_dir(dir: PathBuf, extra: &[&str]) -> Server {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .args(["serve", "d.mmd"])
        .args(extra)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut url = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut url)
        .unwrap();
    assert!(url.starts_with("http://"), "server failed: {url:?}");
    let addr = url.trim().trim_start_matches("http://").parse().unwrap();
    Server { child, addr, dir }
}

fn request(addr: SocketAddr, method: &str, path: &str, body: Option<&Value>) -> (u16, Vec<u8>) {
    let body = body.map(Value::to_string).unwrap_or_default();
    let content_type = if method == "POST" {
        "Content-Type: application/json\r\n"
    } else {
        ""
    };
    raw_request(addr, &format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        addr.port(), body.len()
    ))
}

fn raw_request(addr: SocketAddr, wire: &str) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream.write_all(wire.as_bytes()).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response.windows(4).position(|x| x == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&response[..split]);
    let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, response[split + 4..].to_vec())
}

fn get_json(addr: SocketAddr, path: &str) -> Value {
    let (status, body) = request(addr, "GET", path, None);
    assert_eq!(status, 200);
    serde_json::from_slice(&body).unwrap()
}

fn post(addr: SocketAddr, source: &str, note: &str) -> Value {
    let (status, body) = request(
        addr,
        "POST",
        "/turn",
        Some(&json!({"source":source,"note":note})),
    );
    assert_eq!(status, 200);
    serde_json::from_slice(&body).unwrap()
}

fn file_json(dir: &Path, name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(dir.join(name)).unwrap()).unwrap()
}

fn sse_connect(addr: SocketAddr) -> BufReader<TcpStream> {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .write_all(
            format!(
                "GET /events HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
                addr.port()
            )
            .as_bytes(),
        )
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.contains("200 OK"), "{line}");
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if line == "\r\n" {
            break;
        }
    }
    reader
}

fn sse_next(reader: &mut BufReader<TcpStream>) -> Value {
    let mut line = String::new();
    let mut event = None;
    loop {
        line.clear();
        reader.read_line(&mut line).unwrap();
        if let Some(data) = line.strip_prefix("data: ") {
            event = Some(serde_json::from_str(data.trim()).unwrap());
        }
        if line == "\n" {
            if let Some(event) = event {
                return event;
            }
        }
    }
}

#[test]
fn fixed_routes_and_traversal() {
    let s = start(A);
    let (status, page) = request(s.addr, "GET", "/", None);
    assert_eq!(status, 200);
    let page = String::from_utf8(page).unwrap();
    assert!(page.contains("<mmx-editor>"));
    assert!(page.contains("<title>mmx cockpit</title>"));
    assert!(page.contains("const translations = {"));
    assert!(page.contains("const requestedLang = new URLSearchParams(location.search).get('lang')"));
    assert!(page.contains("you: 'You'"));
    // The embedded locale table deliberately retains non-ASCII translations.
    assert!(page.contains("you: '나'"));
    // The language switch is a query string on the same route.
    for query in ["/?lang=ko", "/?lang=en"] {
        let (status, _) = request(s.addr, "GET", query, None);
        assert_eq!(status, 200, "{query}");
    }
    let (status, script) = request(s.addr, "GET", "/editor.js", None);
    assert_eq!(status, 200);
    assert!(String::from_utf8(script).unwrap().contains("MmxEditor"));
    assert_eq!(request(s.addr, "GET", "/../Cargo.toml", None).0, 404);
}

#[test]
fn initial_state_is_stable_baseline() {
    let s = start(A);
    let (status, first) = request(s.addr, "GET", "/state", None);
    let (_, second) = request(s.addr, "GET", "/state", None);
    assert_eq!(status, 200);
    assert_eq!(first, second);
    let value: Value = serde_json::from_slice(&first).unwrap();
    let state = file_json(&s.dir, "d.state.json");
    assert_eq!(value["source"], A);
    assert_eq!(value["nodes"], state["nodes"]);
    assert_eq!(value["edges"], state["edges"]);
    assert_eq!(value["by"], "serve");
    assert!(value["svg"].as_str().unwrap().contains("<svg"));
}

#[test]
fn human_turn_writes_diff_and_state() {
    let s = start(A);
    let result = post(s.addr, B, "add");
    assert_eq!(result["exit"], 0);
    assert!(result["svg"].as_str().unwrap().contains("<svg"));
    assert!(result["state"].get("svg").is_none());
    assert_eq!(
        result["diff"]["nodes"]["added"],
        json!([{"id":"C","label":"C","shape":"Rectangle"}])
    );
    assert_eq!(std::fs::read_to_string(s.dir.join("d.mmd")).unwrap(), B);
    let diff = file_json(&s.dir, "d.diff.json");
    assert_eq!(diff["by"], "human");
    assert_eq!(diff["note"], "add");
    let state = get_json(s.addr, "/state");
    assert_eq!(
        mmx::state::hex_sha256(state["source"].as_str().unwrap().as_bytes()),
        file_json(&s.dir, "d.state.json")["source_sha256"]
    );
    assert_eq!(state["nodes"], file_json(&s.dir, "d.state.json")["nodes"]);
    assert_eq!(state["by"], "human");
    assert_eq!(state["note"], "add");
}

#[test]
fn parse_error_keeps_last_valid_artifacts() {
    let s = start(A);
    let svg = std::fs::read(s.dir.join("d.svg")).unwrap();
    let state = std::fs::read(s.dir.join("d.state.json")).unwrap();
    let bad = "flowchart LR\n    --> B\n";
    let result = post(s.addr, bad, "error");
    assert_eq!(result["exit"], 2);
    assert_eq!(result["diff"]["error"]["kind"], "parse");
    assert_eq!(result["diff"]["error"]["line"], 2);
    assert_eq!(std::fs::read_to_string(s.dir.join("d.mmd")).unwrap(), bad);
    assert_eq!(std::fs::read(s.dir.join("d.svg")).unwrap(), svg);
    assert_eq!(std::fs::read(s.dir.join("d.state.json")).unwrap(), state);
    assert_eq!(post(s.addr, B, "recover")["exit"], 0);
    assert_eq!(
        mmx::state::hex_sha256(
            get_json(s.addr, "/state")["source"]
                .as_str()
                .unwrap()
                .as_bytes()
        ),
        file_json(&s.dir, "d.state.json")["source_sha256"]
    );
}

#[test]
fn noop_preserves_diff_bytes() {
    // Identical source with no note (or a whitespace note) stays a no-op;
    // a real note makes it a turn instead.
    let s = start(A);
    post(s.addr, B, "first turn");
    let diff = std::fs::read(s.dir.join("d.diff.json")).unwrap();
    for empty in ["", "   "] {
        let result = post(s.addr, B, empty);
        assert_eq!(result["exit"], 0);
        assert_eq!(result["noop"], true);
        assert_eq!(std::fs::read(s.dir.join("d.diff.json")).unwrap(), diff);
    }
}

#[test]
fn note_only_turn_is_a_real_turn() {
    // A note with zero diagram changes is a turn — the
    // human asking a question. It bumps seq and lands in diff.json.
    let s = start(A);
    post(s.addr, B, "first turn");
    let before = get_json(s.addr, "/state");
    // Non-ASCII notes are kept here to exercise UTF-8 HTTP handling.
    let result = post(s.addr, B, "이 흐름 맞아?");
    assert_eq!(result["exit"], 0, "{result}");
    assert_ne!(result["noop"], true, "{result}");
    assert_eq!(
        result["state"]["seq"].as_u64().unwrap(),
        before["seq"].as_u64().unwrap() + 1
    );
    assert_eq!(result["state"]["note"], "이 흐름 맞아?");
    assert_eq!(result["diff"]["nodes"]["added"], json!([]));
    let diff = file_json(&s.dir, "d.diff.json");
    assert_eq!(diff["by"], "human");
    assert_eq!(diff["note"], "이 흐름 맞아?");
    // Identical bytes: no text change to hunt for, and the file untouched.
    assert_eq!(diff["source_changed"], false);
    assert_eq!(std::fs::read_to_string(s.dir.join("d.mmd")).unwrap(), B);
}

#[test]
fn unpolled_agent_edit_conflicts_instead_of_overwrite() {
    // The poller needs two identical sightings (~600ms) before an external
    // edit becomes a turn. A human submit in that window used to overwrite
    // the agent's file silently (base_seq cannot catch it: seq is unmoved).
    let s = start(A);
    post(s.addr, B, "first turn");
    let agent_edit = "flowchart TD\n    A --> B\n    B --> AGENT_NEW\n";
    std::fs::write(s.dir.join("d.mmd"), agent_edit).unwrap();
    let (status, body) = request(
        s.addr,
        "POST",
        "/turn",
        Some(&json!({"source":B,"note":"one question","base_seq":1})),
    );
    assert_eq!(status, 409, "{}", String::from_utf8_lossy(&body));
    let conflict: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(conflict["conflict"], true);
    // The agent's edit survives on disk.
    assert_eq!(
        std::fs::read_to_string(s.dir.join("d.mmd")).unwrap(),
        agent_edit
    );
}

#[test]
fn sse_external_and_turn_broadcast_without_poll_duplicate() {
    let s = start(A);
    let mut reader = sse_connect(s.addr);
    assert_eq!(sse_next(&mut reader)["seq"], 0);
    std::fs::write(s.dir.join("d.mmd"), B).unwrap();
    let start = Instant::now();
    assert_eq!(sse_next(&mut reader)["seq"], 1);
    assert!(start.elapsed() <= Duration::from_millis(1500));
    std::fs::write(s.dir.join("d.mmd"), C).unwrap();
    assert_eq!(sse_next(&mut reader)["seq"], 2);
    let state = get_json(s.addr, "/state");
    assert_eq!(
        mmx::state::hex_sha256(state["source"].as_str().unwrap().as_bytes()),
        file_json(&s.dir, "d.state.json")["source_sha256"]
    );
    let before = state["seq"].as_u64().unwrap();
    assert_eq!(post(s.addr, A, "human")["exit"], 0);
    assert_eq!(sse_next(&mut reader)["seq"], before + 1);
    assert_eq!(get_json(s.addr, "/state")["seq"], before + 1);
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(650)))
        .unwrap();
    let mut line = String::new();
    let read = reader.read_line(&mut line);
    assert!(
        read.is_err(),
        "duplicate event unexpectedly arrived: {line:?}"
    );
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(post(s.addr, "flowchart LR\n    --> B\n", "bad")["exit"], 2);
    assert_eq!(sse_next(&mut reader)["seq"], before + 2);
}

#[test]
fn bind_is_loopback_by_default_and_rejects_external() {
    let s = start(A);
    assert!(s.addr.ip().is_loopback());
    let output = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .args(["serve", "d.mmd", "--addr", "0.0.0.0:0"])
        .current_dir(&s.dir)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--allow-external"));
}

#[test]
fn concurrent_turns_are_serialized() {
    let s = start(A);
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = [B, C]
        .into_iter()
        .map(|source| {
            let barrier = Arc::clone(&barrier);
            let addr = s.addr;
            std::thread::spawn(move || {
                barrier.wait();
                post(addr, source, "concurrent")
            })
        })
        .collect();
    barrier.wait();
    for handle in handles {
        assert_eq!(handle.join().unwrap()["exit"], 0);
    }
    let source = std::fs::read_to_string(s.dir.join("d.mmd")).unwrap();
    assert!(source == B || source == C);
    let state = get_json(s.addr, "/state");
    assert_eq!(state["source"], source);
    let hash = mmx::state::hex_sha256(source.as_bytes());
    assert_eq!(file_json(&s.dir, "d.state.json")["source_sha256"], hash);
}

#[test]
fn truncated_headers_do_not_spin() {
    let s = start(A);
    let mut stream = TcpStream::connect(s.addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        stream,
        "GET /state HTTP/1.1\r\nHost: localhost:{}\r\nX-Cut: yes",
        s.addr.port()
    )
    .unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut reply = Vec::new();
    stream.read_to_end(&mut reply).unwrap();
    assert!(String::from_utf8_lossy(&reply).contains("400 Bad Request"));
    assert_eq!(request(s.addr, "GET", "/state", None).0, 200);
}

#[test]
fn unterminated_large_header_is_bounded() {
    let s = start(A);
    let mut stream = TcpStream::connect(s.addr).unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let prefix = format!(
        "GET / HTTP/1.1\r\nHost: localhost:{}\r\nX-Large: ",
        s.addr.port()
    );
    stream.write_all(prefix.as_bytes()).unwrap();
    for _ in 0..48 {
        if stream.write_all(&vec![b'a'; 64 * 1024]).is_err() {
            break;
        }
    }
    drop(stream);
    assert_eq!(request(s.addr, "GET", "/state", None).0, 200);
}

#[test]
fn content_type_origin_and_host_checks() {
    let s = start(A);
    let body = json!({"source":B}).to_string();
    let make = |extra: &str| {
        format!(
            "POST /turn HTTP/1.1\r\nHost: localhost:{}\r\n{extra}Content-Length: {}\r\n\r\n{body}",
            s.addr.port(),
            body.len()
        )
    };
    assert_eq!(
        raw_request(s.addr, &make("Content-Type: text/plain\r\n")).0,
        415
    );
    assert_eq!(
        raw_request(
            s.addr,
            &make(
                "Content-Type: application/json; charset=utf-8\r\nOrigin: http://evil.example\r\n"
            )
        )
        .0,
        403
    );
    assert_eq!(
        raw_request(
            s.addr,
            &make(&format!(
                "Content-Type: application/json\r\nOrigin: http://localhost:{}\r\n",
                s.addr.port()
            ))
        )
        .0,
        200
    );
    assert_eq!(
        raw_request(s.addr, "GET /state HTTP/1.1\r\nHost: evil.example\r\n\r\n").0,
        403
    );
}

#[test]
fn stale_base_seq_conflicts_without_write() {
    let s = start(A);
    assert_eq!(post(s.addr, B, "first")["exit"], 0);
    let body = json!({"source":C,"base_seq":0}).to_string();
    let wire = format!("POST /turn HTTP/1.1\r\nHost: localhost:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", s.addr.port(), body.len());
    let (status, reply) = raw_request(s.addr, &wire);
    assert_eq!(status, 409);
    let value: Value = serde_json::from_slice(&reply).unwrap();
    assert_eq!(value["conflict"], true);
    assert_eq!(value["seq"], 1);
    assert_eq!(value["state"]["source"], B);
    assert_eq!(std::fs::read_to_string(s.dir.join("d.mmd")).unwrap(), B);
}

#[test]
fn restart_changes_epoch_and_keeps_state() {
    let first = start(A);
    let old_epoch = sse_next(&mut sse_connect(first.addr))["epoch"]
        .as_u64()
        .unwrap();
    let second = start_dir(first.dir.clone(), &[]);
    let new_epoch = sse_next(&mut sse_connect(second.addr))["epoch"]
        .as_u64()
        .unwrap();
    assert_ne!(old_epoch, new_epoch);
    assert_eq!(get_json(second.addr, "/state")["epoch"], new_epoch);
    assert_eq!(
        get_json(second.addr, "/state")["nodes"],
        file_json(&second.dir, "d.state.json")["nodes"]
    );
}

#[test]
fn loopback_alias_and_external_override() {
    let base = start(A);
    let local = start_dir(base.dir.clone(), &["--addr", "localhost:0"]);
    assert!(local.addr.ip().is_loopback());
    assert_eq!(request(local.addr, "GET", "/state", None).0, 200);
    let external = start_dir(
        base.dir.clone(),
        &["--addr", "0.0.0.0:0", "--allow-external"],
    );
    assert_eq!(request(external.addr, "GET", "/state", None).0, 200);
}

// ---- Turn log, `mmx wait`, `mmx note` with a live serve ----

fn mmx_cmd(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn wait_returns_when_human_posts_to_serve() {
    let s = start(A);
    assert!(s.dir.join("d.serve.json").exists());
    let mut wait = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(&s.dir)
        .args(["wait", "d.mmd", "--timeout", "20"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // A direct file edit under a live serve belongs to the agent: serve's
    // poller renders it, and wait must neither render it nor return.
    std::fs::write(s.dir.join("d.mmd"), C).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while get_json(s.addr, "/state")["seq"] != 1 {
        assert!(Instant::now() < deadline, "poller never rendered the edit");
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(700));
    assert!(wait.try_wait().unwrap().is_none(), "wait returned early");
    assert_eq!(file_json(&s.dir, "d.diff.json")["by"], "agent");

    assert_eq!(post(s.addr, B, "please review")["exit"], 0);
    let out = wait.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{out:?}");
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.lines().count(), 1, "{text}");
    let diff: Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(diff["by"], "human");
    assert_eq!(diff["note"], "please review");
    assert_eq!(diff["edges"]["removed"].as_array().unwrap().len(), 1);
}

#[test]
fn serve_reflects_external_note() {
    let s = start(A);
    let mut reader = sse_connect(s.addr);
    assert_eq!(sse_next(&mut reader)["seq"], 0);
    let out = mmx_cmd(&s.dir, &["note", "d.mmd", "agent memo"]);
    assert!(out.status.success(), "{out:?}");
    assert_eq!(sse_next(&mut reader)["seq"], 1);
    let state = get_json(s.addr, "/state");
    assert_eq!(state["seq"], 1);
    assert_eq!(state["by"], "agent");
    assert_eq!(state["note"], "agent memo");
    // Exactly one event for it.
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(900)))
        .unwrap();
    let mut line = String::new();
    assert!(
        reader.read_line(&mut line).is_err(),
        "duplicate event: {line:?}"
    );
}

#[test]
fn base_seq_taken_before_external_note_is_stale() {
    let s = start(A);
    let seq = get_json(s.addr, "/state")["seq"].as_u64().unwrap();
    assert!(mmx_cmd(&s.dir, &["note", "d.mmd", "agent first"])
        .status
        .success());
    // Immediately, before serve's poller has had a chance to fold it in.
    let (status, body) = request(
        s.addr,
        "POST",
        "/turn",
        Some(&json!({"source":A,"note":"human question","base_seq":seq})),
    );
    assert_eq!(status, 409, "{}", String::from_utf8_lossy(&body));
}

#[test]
fn history_lists_turns_across_restart() {
    let first = start(A);
    assert_eq!(post(first.addr, B, "one")["exit"], 0);
    assert!(mmx_cmd(&first.dir, &["note", "d.mmd", "answer"])
        .status
        .success());
    assert_eq!(
        post(first.addr, "flowchart LR\n    --> B\n", "broken")["exit"],
        2
    );
    let second = start_dir(first.dir.clone(), &[]);
    let history = get_json(second.addr, "/history");
    let entries = history["entries"].as_array().unwrap();
    let by: Vec<&str> = entries.iter().map(|e| e["by"].as_str().unwrap()).collect();
    // Turns from before the restart, from both serve and the CLI. (The
    // restart's own render of the still-broken file may add one more.)
    assert_eq!(by[..4], ["serve", "human", "agent", "human"]);
    assert_eq!(entries[1]["note"], "one");
    assert_eq!(entries[1]["summary"]["nodes_added"], 1);
    assert_eq!(entries[1]["summary"]["edges_added"], 1);
    assert_eq!(entries[1]["summary"]["error"], Value::Null);
    assert_eq!(entries[2]["note"], "answer");
    assert_eq!(entries[2]["summary"]["nodes_added"], 0);
    assert!(entries[3]["summary"]["error"].is_string());
    assert!(entries[1]["at"].as_u64().unwrap() <= entries[2]["at"].as_u64().unwrap());
    // Same Host protection as the other routes.
    assert_eq!(
        raw_request(
            second.addr,
            "GET /history HTTP/1.1\r\nHost: evil.example\r\n\r\n"
        )
        .0,
        403
    );
    let (status, page) = request(second.addr, "GET", "/", None);
    assert_eq!(status, 200);
    assert!(String::from_utf8(page).unwrap().contains("/history"));
}
