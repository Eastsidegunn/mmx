//! MMX-003 integration tests use a local, in-process Rhizome double.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const A: &str = "flowchart LR\n    A --> B\n";
const B: &str = "flowchart LR\n    A --> B\n    B --> C\n";
const C: &str = "flowchart LR\n    A --> B\n    B --> C\n    C --> D\n";

#[derive(Clone, Copy)]
enum IntentMode {
    Accept,
    FailFirst,
    RejectTwo,
    RejectHttpFirst,
}

#[derive(Clone)]
struct Seen {
    path: String,
    content_type: String,
    body: Vec<u8>,
}

struct Fake {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fake {
    fn start(listener: TcpListener, workspace: &'static str, mode: IntentMode) -> Self {
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let seen_thread = Arc::clone(&seen);
        let stop_thread = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let mut intents = 0;
            while !stop_thread.load(Ordering::Relaxed) {
                let (stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("fake accept: {error}"),
                };
                let mut stream = stream;
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap().to_owned();
                let mut content_type = String::new();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-type") {
                            content_type = value.trim().to_owned();
                        }
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                drop(reader);
                let (status, response) = match path.as_str() {
                    "/v1/workspace" => (200, workspace.as_bytes().to_vec()),
                    "/v1/blob" => {
                        let id = format!("sha256:{}", mmx::state::hex_sha256(&body));
                        (
                            200,
                            json!({"blobId":id,"mediaType":content_type,"size":body.len()})
                                .to_string()
                                .into_bytes(),
                        )
                    }
                    "/v1/intent" => {
                        intents += 1;
                        if matches!(mode, IntentMode::FailFirst) && intents == 1 {
                            (500, b"error".to_vec())
                        } else if matches!(mode, IntentMode::RejectTwo) && intents <= 2 {
                            (
                                200,
                                br#"{"Accepted":false,"Reason":"goal is terminal"}"#.to_vec(),
                            )
                        } else if matches!(mode, IntentMode::RejectHttpFirst) && intents == 1 {
                            (400, br#"{"Reason":"invalid target"}"#.to_vec())
                        } else {
                            (200, br#"{"Accepted":true}"#.to_vec())
                        }
                    }
                    _ => (404, b"missing".to_vec()),
                };
                seen_thread.lock().unwrap().push(Seen {
                    path: path.clone(),
                    content_type,
                    body,
                });
                if path == "/v1/workspace" {
                    write!(stream, "HTTP/1.1 {status} Test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n", response.len()).unwrap();
                    stream.write_all(&response).unwrap();
                    stream.write_all(b"\r\n0\r\n\r\n").unwrap();
                } else {
                    write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        response.len()
                    )
                    .unwrap();
                    stream.write_all(&response).unwrap();
                }
            }
        });
        Self {
            addr,
            seen,
            stop,
            worker: Some(worker),
        }
    }

    fn snapshot(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn wait_for(&self, predicate: impl Fn(&[Seen]) -> bool) -> Vec<Seen> {
        let start = Instant::now();
        loop {
            let seen = self.snapshot();
            if predicate(&seen) {
                return seen;
            }
            assert!(
                start.elapsed() < Duration::from_secs(9),
                "timed out; {} requests",
                seen.len()
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}

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

fn dir() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mmx003-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&dir).unwrap();
    std::fs::write(dir.join("d.mmd"), A).unwrap();
    dir
}

fn start(dir: PathBuf, rhizome: SocketAddr, bind: &str) -> Server {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .args([
            "serve",
            "d.mmd",
            "--rhizome",
            &format!("http://{rhizome}"),
            "--bind",
            bind,
        ])
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut url = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut url)
        .unwrap();
    assert!(url.starts_with("http://"), "server did not start: {url:?}");
    Server {
        child,
        addr: url.trim().trim_start_matches("http://").parse().unwrap(),
        dir,
    }
}

fn request(addr: SocketAddr, method: &str, path: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", addr.port(), body.len()).unwrap();
    stream.write_all(body).unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    let status = String::from_utf8_lossy(&response[..split])
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, response[split + 4..].to_vec())
}

fn turn(server: &Server) -> Value {
    let body = json!({"source":B}).to_string();
    let (status, response) = request(server.addr, "POST", "/turn", body.as_bytes());
    assert_eq!(status, 200);
    serde_json::from_slice(&response).unwrap()
}

fn intents(seen: &[Seen]) -> Vec<Value> {
    seen.iter()
        .filter(|request| request.path == "/v1/intent")
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect()
}

#[test]
fn mmx003_s1_three_blobs_and_intent_for_turn() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-123"}],"tasks":[]}}"#,
        IntentMode::Accept,
    );
    let server = start(dir(), fake.addr, "goal-123");
    let reply = turn(&server);
    assert_eq!(reply["exit"], 0);
    assert!(reply.get("rhizome").is_none());
    assert!(reply.get("sourceRef").is_none());
    let seen = fake.wait_for(|seen| intents(seen).len() >= 2);
    let published = intents(&seen);
    assert!(published[0]["summary"]
        .as_str()
        .unwrap()
        .starts_with("turn 0 by serve:"));
    let intent = &published[1];
    assert_eq!(intent["Kind"], "deliverable.register");
    assert_eq!(intent["GoalID"], "goal-123");
    assert!(intent.get("MissionID").is_none());
    assert_eq!(intent["deliverableKind"], "mmx-turn");
    assert_eq!(intent["actor"], "mmx-serve");
    let blobs: Vec<_> = seen
        .iter()
        .filter(|request| request.path == "/v1/blob")
        .collect();
    assert!(blobs.len() >= 6);
    let three = &blobs[3..6];
    assert_eq!(
        three
            .iter()
            .map(|request| request.content_type.as_str())
            .collect::<Vec<_>>(),
        [
            "image/svg+xml",
            "application/json",
            "text/plain; charset=utf-8"
        ]
    );
    let ids: Vec<_> = three
        .iter()
        .map(|request| format!("sha256:{}", mmx::state::hex_sha256(&request.body)))
        .collect();
    assert_eq!(intent["sourceRef"], ids[0]);
    let summary = intent["summary"].as_str().unwrap();
    assert!(summary.starts_with("turn 1 by human: added 2, removed 0, changed 0;"));
    assert!(summary.contains(&format!("diff={}; mmd={}", ids[1], ids[2])));
    assert_eq!(three[2].body, B.as_bytes());
    let state = request(server.addr, "GET", "/state", &[]).1;
    let state: Value = serde_json::from_slice(&state).unwrap();
    assert!(state.get("rhizome").is_none());
    assert!(state.get("sourceRef").is_none());
    let turn_reply = turn(&server);
    assert_eq!(turn_reply["noop"], true);
    assert!(turn_reply.get("rhizome").is_none());
    let bad = json!({"source":"flowchart LR\n    --> B\n"}).to_string();
    let (_, bad_reply) = request(server.addr, "POST", "/turn", bad.as_bytes());
    let bad_reply: Value = serde_json::from_slice(&bad_reply).unwrap();
    assert_eq!(bad_reply["exit"], 2);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(intents(&fake.snapshot()).len(), 2);
}

#[test]
fn mmx003_s2_retry_reuploads_same_blob_ids() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[],"tasks":[{"id":"mission-9"}]}}"#,
        IntentMode::FailFirst,
    );
    let server = start(dir(), fake.addr, "mission-9");
    fake.wait_for(|seen| !intents(seen).is_empty());
    assert_eq!(turn(&server)["exit"], 0);
    thread::sleep(Duration::from_millis(200));
    assert_eq!(
        intents(&fake.snapshot()).len(),
        1,
        "wake bypassed retry delay"
    );
    let seen = fake.wait_for(|seen| intents(seen).len() >= 2);
    let intent = intents(&seen);
    assert_eq!(intent[0], intent[1]);
    assert_eq!(intent[1]["MissionID"], "mission-9");
    assert!(intent[1].get("GoalID").is_none());
    let blobs: Vec<_> = seen
        .iter()
        .filter(|request| request.path == "/v1/blob")
        .collect();
    // >= 6: after the retry succeeds the worker immediately publishes the
    // queued next turn, so a snapshot may already contain its blobs (flake
    // seen under load). Order is deterministic: 0..3 attempt one, 3..6 retry.
    assert!(blobs.len() >= 6, "expected at least 6 blob posts, got {}", blobs.len());
    // MMX-003: retrying all three content-addressed POSTs is safe and proves identical IDs.
    for index in 0..3 {
        assert_eq!(
            mmx::state::hex_sha256(&blobs[index].body),
            mmx::state::hex_sha256(&blobs[index + 3].body)
        );
    }
}

#[test]
fn mmx003_s3_down_then_flush_without_local_impact() {
    let reserved = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reserved.local_addr().unwrap();
    let mut server = start(dir(), addr, "goal-offline");
    let mut stderr = BufReader::new(server.child.stderr.take().unwrap());
    let mut warning = String::new();
    stderr.read_line(&mut warning).unwrap();
    assert!(warning.contains("Rhizome unavailable"));
    assert_eq!(turn(&server)["exit"], 0);
    assert_eq!(
        std::fs::read_to_string(server.dir.join("d.mmd")).unwrap(),
        B
    );
    let state: Value =
        serde_json::from_slice(&request(server.addr, "GET", "/state", &[]).1).unwrap();
    assert_eq!(state["seq"], 1);
    let mut sse = TcpStream::connect(server.addr).unwrap();
    sse.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    write!(
        sse,
        "GET /events HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
        server.addr.port()
    )
    .unwrap();
    let mut reader = BufReader::new(sse);
    let mut event = String::new();
    for _ in 0..8 {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        if line.starts_with("data: ") {
            event = line;
            break;
        }
    }
    assert!(event.contains("\"seq\":1"));
    drop(reserved);
    let fake = Fake::start(
        TcpListener::bind(addr).unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-offline"}],"tasks":[]}}"#,
        IntentMode::Accept,
    );
    let start = Instant::now();
    let seen = fake.wait_for(|seen| intents(seen).len() >= 2);
    assert!(start.elapsed() <= Duration::from_secs(6));
    assert_eq!(intents(&seen).len(), 2);
    drop(server);
}

#[test]
fn mmx003_s4_missing_binding_and_partial_flags_fail() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-other"}],"tasks":[]}}"#,
        IntentMode::Accept,
    );
    let dir = dir();
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_mmx"))
            .args(["serve", "d.mmd"])
            .args(args)
            .current_dir(&dir)
            .output()
            .unwrap()
    };
    let url = format!("http://{}", fake.addr);
    let missing = run(&["--rhizome", &url, "--bind", "goal-absent"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("goal-absent"));
    for args in [vec!["--rhizome", &url], vec!["--bind", "goal-other"]] {
        let output = run(&args);
        assert_eq!(output.status.code(), Some(1));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn mmx003_chunked_workspace_does_not_match_substrings() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-12"}],"tasks":[]}}"#,
        IntentMode::Accept,
    );
    let dir = dir();
    let output = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .args([
            "serve",
            "d.mmd",
            "--rhizome",
            &format!("http://{}", fake.addr),
            "--bind",
            "goal-1",
        ])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("goal-1"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn mmx003_tasks_binding_uses_mission_id_without_prefix() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[],"tasks":[{"id":"task-42"}]}}"#,
        IntentMode::Accept,
    );
    let _server = start(dir(), fake.addr, "task-42");
    let seen = fake.wait_for(|seen| !intents(seen).is_empty());
    assert_eq!(intents(&seen)[0]["MissionID"], "task-42");
    assert!(intents(&seen)[0].get("GoalID").is_none());
}

#[test]
fn mmx003_rejection_drops_turn_and_logs_reason_once() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-7"}],"tasks":[]}}"#,
        IntentMode::RejectTwo,
    );
    let mut server = start(dir(), fake.addr, "goal-7");
    assert_eq!(turn(&server)["exit"], 0);
    let body = json!({"source":C}).to_string();
    assert_eq!(
        request(server.addr, "POST", "/turn", body.as_bytes()).0,
        200
    );
    let seen = fake.wait_for(|seen| intents(seen).len() >= 3);
    assert_eq!(intents(&seen).len(), 3);
    assert!(intents(&seen)[2]["summary"]
        .as_str()
        .unwrap()
        .starts_with("turn 2 by human:"));
    server.child.kill().unwrap();
    server.child.wait().unwrap();
    let mut stderr = String::new();
    server
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr.matches("goal is terminal").count(), 1, "{stderr}");
}

#[test]
fn mmx003_http_4xx_drops_turn_and_keeps_queue_moving() {
    let fake = Fake::start(
        TcpListener::bind("127.0.0.1:0").unwrap(),
        r#"{"revision":1,"body":{"missions":[{"id":"goal-8"}],"tasks":[]}}"#,
        IntentMode::RejectHttpFirst,
    );
    let mut server = start(dir(), fake.addr, "goal-8");
    assert_eq!(turn(&server)["exit"], 0);
    let seen = fake.wait_for(|seen| intents(seen).len() >= 2);
    assert!(intents(&seen)[1]["summary"]
        .as_str()
        .unwrap()
        .starts_with("turn 1 by human:"));
    server.child.kill().unwrap();
    server.child.wait().unwrap();
    let mut stderr = String::new();
    server
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr.matches("invalid target").count(), 1, "{stderr}");
}
