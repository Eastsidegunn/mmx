//! MMX-004 integration tests use a chunked local Rhizome double.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const FIRST: &[u8] = b"flowchart LR\n A --> B\n";
const SECOND: &[u8] = b"flowchart LR\n A --> C\n";
const DIFF_ONE: &[u8] = br#"{"by":"human","step":1}"#;
const DIFF_TWO: &[u8] = br#"{"by":"human","step":2}"#;

struct Fake {
    addr: SocketAddr,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Fake {
    fn start(workspace: Value, blobs: HashMap<String, Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fake accept: {error}"),
                };
                // The listener is nonblocking for the shutdown poll; accepted
                // streams inherit that on macOS, so force blocking reads back.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let Some(path) = line.split_whitespace().nth(1).map(str::to_owned) else {
                    continue;
                };
                loop {
                    line.clear();
                    if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                drop(reader);
                let (status, body) = if path == "/v1/workspace" {
                    (200, workspace.to_string().into_bytes())
                } else if let Some(id) = path.strip_prefix("/v1/blob/") {
                    blobs
                        .get(id)
                        .map_or((404, b"missing".to_vec()), |bytes| (200, bytes.clone()))
                } else {
                    (404, b"missing".to_vec())
                };
                let header = format!(
                    "HTTP/1.1 {status} Test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:X}\r\n",
                    body.len()
                );
                let _ = stream
                    .write_all(header.as_bytes())
                    .and_then(|()| stream.write_all(&body))
                    .and_then(|()| stream.write_all(b"\r\n0\r\n\r\n"));
            }
        });
        Self {
            addr,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.worker.take().unwrap().join();
    }
}

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "mmx004-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn pull(&self, fake: &Fake, bind: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_mmx"))
            .args([
                "pull",
                "d.mmd",
                "--rhizome",
                &format!("http://{}", fake.addr),
                "--bind",
                bind,
            ])
            .current_dir(&self.0)
            .output()
            .unwrap()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn blob(bytes: &[u8], blobs: &mut HashMap<String, Vec<u8>>) -> String {
    let id = format!("sha256:{}", mmx::state::hex_sha256(bytes));
    blobs.insert(id.clone(), bytes.to_vec());
    id
}

fn turn(seq: u64, goal: &str, mmd: &str, diff: &str) -> Value {
    json!({
        "kind":"mmx-turn",
        "goalId":goal,
        "summary":format!("turn {seq} by human: added 1, removed 0, changed 0; diff={diff}; mmd={mmd}")
    })
}

fn workspace(goals: &[&str], deliverables: Vec<Value>) -> Value {
    json!({
        "revision":1,
        "body":{
            "missions": goals.iter().map(|id| json!({"id":id})).collect::<Vec<_>>(),
            "tasks":[],
            "deliverables":deliverables
        }
    })
}

fn fixture() -> (HashMap<String, Vec<u8>>, Vec<Value>) {
    let mut blobs = HashMap::new();
    let first = blob(FIRST, &mut blobs);
    let second = blob(SECOND, &mut blobs);
    let diff_one = blob(DIFF_ONE, &mut blobs);
    let diff_two = blob(DIFF_TWO, &mut blobs);
    let turns = vec![
        turn(1, "goal-1", &first, &diff_one),
        turn(2, "goal-1", &second, &diff_two),
    ];
    (blobs, turns)
}

#[test]
fn mmx004_p1_latest_turn_writes_mmd_and_pulled_diff() {
    let (blobs, turns) = fixture();
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 2 by human"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
    assert_eq!(
        std::fs::read(dir.0.join("d.pulled.diff.json")).unwrap(),
        DIFF_TWO
    );
}

#[test]
fn mmx004_p2_repeated_pull_keeps_bytes_and_mtime() {
    let (blobs, turns) = fixture();
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let first = dir.pull(&fake, "goal-1");
    assert!(first.status.success(), "{first:?}");
    let mmd = dir.0.join("d.mmd");
    let diff = dir.0.join("d.pulled.diff.json");
    let before = [mmd.clone(), diff.clone()].map(|path| {
        (
            std::fs::read(&path).unwrap(),
            std::fs::metadata(path).unwrap().modified().unwrap(),
        )
    });
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("already up to date (turn 2)"));
    for (path, (bytes, mtime)) in [mmd, diff].iter().zip(before) {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(path).unwrap().modified().unwrap(), mtime);
    }
}

#[test]
fn mmx004_p3_ignores_other_binding_even_with_higher_seq() {
    let (mut blobs, mut turns) = fixture();
    let other = blob(b"wrong goal", &mut blobs);
    let other_diff = blob(b"{}", &mut blobs);
    turns.push(turn(9, "goal-2", &other, &other_diff));
    let fake = Fake::start(workspace(&["goal-1", "goal-2"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("turn 2"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
}

#[test]
fn mmx004_p4_no_turns_and_missing_bind_fail() {
    let fake = Fake::start(
        workspace(
            &["goal-1"],
            vec![json!({"kind":"other","goalId":"goal-1","summary":"turn 8 by human: ignore"})],
        ),
        HashMap::new(),
    );
    let dir = Dir::new();
    let empty = dir.pull(&fake, "goal-1");
    assert_eq!(empty.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&empty.stderr).contains("no turns published for goal-1"));
    let missing = dir.pull(&fake, "goal-absent");
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("goal-absent"));
}

#[test]
fn mmx004_p4_skips_malformed_summary_and_warns() {
    let (blobs, mut turns) = fixture();
    turns.push(json!({"kind":"mmx-turn","goalId":"goal-1","summary":"turn 99 broken"}));
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("turn 2"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("warning"));
}

#[test]
fn mmx004_p5_local_diff_is_untouched() {
    let (blobs, turns) = fixture();
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let local = dir.0.join("d.diff.json");
    std::fs::write(&local, b"local conversation").unwrap();
    assert!(dir.pull(&fake, "goal-1").status.success());
    assert_eq!(std::fs::read(local).unwrap(), b"local conversation");
    assert_eq!(
        std::fs::read(dir.0.join("d.pulled.diff.json")).unwrap(),
        DIFF_TWO
    );
}

#[test]
fn mmx004_mission_binding_uses_mission_id() {
    let (blobs, mut turns) = fixture();
    let mission_turn = turns.pop().unwrap();
    let mut mission_turn = mission_turn;
    mission_turn.as_object_mut().unwrap().remove("goalId");
    mission_turn["missionId"] = json!("mission-1");
    turns.push(mission_turn);
    let mut board = workspace(&["goal-1"], turns);
    board["body"]["tasks"] = json!([{"id":"mission-1"}]);
    let fake = Fake::start(board, blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "mission-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("turn 2"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
}

#[test]
fn mmx004_unreachable_board_exits_one() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let dir = Dir::new();
    let output = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .args([
            "pull",
            "d.mmd",
            "--rhizome",
            &format!("http://{addr}"),
            "--bind",
            "goal-1",
        ])
        .current_dir(&dir.0)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Rhizome unavailable"));
}

#[test]
fn mmx004_serve_restart_last_entry_wins_over_max_seq() {
    // seq restarts at 0 per serve process; the board's registration order is
    // the truth. A later entry with a smaller seq is the current state.
    let mut blobs = HashMap::new();
    let first = blob(FIRST, &mut blobs);
    let second = blob(SECOND, &mut blobs);
    let diff_one = blob(DIFF_ONE, &mut blobs);
    let diff_two = blob(DIFF_TWO, &mut blobs);
    let turns = vec![
        turn(5, "goal-1", &first, &diff_one),
        turn(0, "goal-1", &second, &diff_two),
    ];
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 0"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
    assert_eq!(
        std::fs::read(dir.0.join("d.pulled.diff.json")).unwrap(),
        DIFF_TWO
    );
}

#[test]
fn mmx004_missing_blob_candidate_falls_back_with_warning() {
    // A turn whose blobs 404 (e.g. a hostile or garbage registration) must
    // not block the turns registered before it.
    let (blobs, mut turns) = fixture();
    let ghost = format!("sha256:{}", "a".repeat(64));
    turns.push(turn(9, "goal-1", &ghost, &ghost));
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 2"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("skipping turn 9"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
}

#[test]
fn mmx004_tampered_blob_candidate_falls_back() {
    // Blob bytes that do not hash to their id are rejected, with fallback.
    let (mut blobs, mut turns) = fixture();
    let bogus_id = format!("sha256:{}", mmx::state::hex_sha256(b"claimed content"));
    blobs.insert(bogus_id.clone(), b"tampered content".to_vec());
    turns.push(turn(9, "goal-1", &bogus_id, &bogus_id));
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 2"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("mismatched content"));
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
}

#[test]
fn mmx004_all_candidates_broken_exits_one() {
    let mut blobs = HashMap::new();
    let diff_one = blob(DIFF_ONE, &mut blobs);
    let ghost = format!("sha256:{}", "b".repeat(64));
    let fake = Fake::start(
        workspace(&["goal-1"], vec![turn(1, "goal-1", &ghost, &diff_one)]),
        blobs,
    );
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("no retrievable turns"));
}

#[test]
fn mmx004_missing_pulled_diff_is_repaired() {
    // Idempotence requires BOTH files to match; a missing sidecar re-pulls.
    let (blobs, turns) = fixture();
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    assert!(dir.pull(&fake, "goal-1").status.success());
    std::fs::remove_file(dir.0.join("d.pulled.diff.json")).unwrap();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 2"));
    assert_eq!(
        std::fs::read(dir.0.join("d.pulled.diff.json")).unwrap(),
        DIFF_TWO
    );
    assert_eq!(std::fs::read(dir.0.join("d.mmd")).unwrap(), SECOND);
}

#[test]
fn mmx004_uppercase_hex_blob_id_is_malformed() {
    let (blobs, mut turns) = fixture();
    let upper = format!("sha256:{}", "A".repeat(64));
    turns.push(turn(9, "goal-1", &upper, &upper));
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("pulled turn 2"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("malformed"));
}

#[test]
fn mmx004_control_chars_in_actor_are_sanitized() {
    let (mut blobs, mut turns) = fixture();
    let third = blob(b"flowchart LR\n A --> D\n", &mut blobs);
    let diff_three = blob(b"{}", &mut blobs);
    turns.push(json!({
        "kind":"mmx-turn",
        "goalId":"goal-1",
        "summary":format!(
            "turn 3 by evil\u{1b}[2J\rname: added 1, removed 0, changed 0; diff={diff_three}; mmd={third}"
        )
    }));
    let fake = Fake::start(workspace(&["goal-1"], turns), blobs);
    let dir = Dir::new();
    let output = dir.pull(&fake, "goal-1");
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("pulled turn 3 by evil?[2J?name"),
        "{stdout}"
    );
}
