//! Local HTTP cockpit for a diagram. The protocol deliberately uses only
//! fixed routes and the standard library, including long lived SSE sockets.

use std::hash::BuildHasher;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{publish, run_render_bytes, sibling, state, PrevSource, RenderJob, TurnOutcome};

pub const POLL_INTERVAL_MS: u64 = 300;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

struct Shared {
    input: PathBuf,
    seq: u64,
    epoch: u64,
    by: String,
    note: Option<String>,
    observed_mtime: Option<SystemTime>,
    observed_hash: String,
    pending_hash: Option<String>,
    subscribers: Vec<mpsc::Sender<u64>>,
    publisher: Option<publish::Publisher>,
}

#[derive(Deserialize)]
struct TurnInput {
    source: String,
    note: Option<String>,
    base_seq: Option<u64>,
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
    host: Option<String>,
    origin: Option<String>,
    content_type: Option<String>,
}

pub fn run(
    input: PathBuf,
    addr: &str,
    allow_external: bool,
    rhizome: Option<String>,
    bind: Option<String>,
) -> Result<()> {
    let publisher = publish::start(rhizome, bind)?;
    let addresses: Vec<SocketAddr> = addr
        .to_socket_addrs()
        .with_context(|| format!("invalid listen address {addr}"))?
        .collect();
    anyhow::ensure!(
        !addresses.is_empty(),
        "no listen address resolved for {addr}"
    );
    if !allow_external {
        anyhow::ensure!(
            addresses.iter().all(|address| address.ip().is_loopback()),
            "non-loopback listen address requires --allow-external"
        );
    }
    let listener = TcpListener::bind(addresses.as_slice())
        .with_context(|| format!("cannot listen on {addr}"))?;
    let bytes =
        std::fs::read(&input).with_context(|| format!("cannot read {}", input.display()))?;
    let hash = state::hex_sha256(&bytes);
    let state_path = sibling(&input, "state.json");
    let baseline = !state_path.exists();
    let job = job(&input, if baseline { "serve" } else { "agent" }, None);
    let result = run_render_bytes(&job, &bytes)?;
    let (by, note) = if result.outcome == TurnOutcome::NoOp {
        let diff: Value = read_json(&job.out_diff).unwrap_or(Value::Null);
        (
            diff["by"].as_str().unwrap_or("serve").to_owned(),
            diff["note"].as_str().map(str::to_owned),
        )
    } else {
        (job.by.clone(), None)
    };
    let shared = Arc::new(Mutex::new(Shared {
        input,
        seq: 0,
        epoch: random_epoch(),
        by,
        note,
        observed_mtime: modified_time(&job.input),
        observed_hash: hash,
        pending_hash: None,
        subscribers: Vec::new(),
        publisher,
    }));
    if result.outcome == TurnOutcome::Ok {
        enqueue(
            &shared.lock().unwrap_or_else(|e| e.into_inner()),
            &job,
            0,
            &bytes,
        );
    }
    let poll_shared = Arc::clone(&shared);
    thread::spawn(move || poll(poll_shared));

    let url = format!("http://{}", listener.local_addr()?);
    println!("{url}");
    std::io::stdout().flush()?;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let shared = Arc::clone(&shared);
                thread::spawn(move || {
                    if let Err(error) = handle(stream, shared) {
                        eprintln!("mmx serve: {error:#}");
                    }
                });
            }
            Err(error) => eprintln!("mmx serve: accept: {error}"),
        }
    }
    Ok(())
}

fn job(input: &Path, by: &str, note: Option<String>) -> RenderJob {
    let out_state = sibling(input, "state.json");
    RenderJob {
        input: input.to_path_buf(),
        by: by.to_owned(),
        note,
        prev: PrevSource::Default(out_state.clone()),
        out_svg: sibling(input, "svg"),
        out_diff: sibling(input, "diff.json"),
        out_state,
        print_if_changed: false,
    }
}

fn modified_time(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn random_epoch() -> u64 {
    std::collections::hash_map::RandomState::new().hash_one(0u64)
}

fn poll(shared: Arc<Mutex<Shared>>) {
    loop {
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
        let mtime = modified_time(&shared.input);
        if shared.observed_mtime == mtime && shared.pending_hash.is_none() {
            continue;
        }
        let bytes = match std::fs::read(&shared.input) {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("mmx serve: poll: {error}");
                continue;
            }
        };
        let hash = state::hex_sha256(&bytes);
        shared.observed_mtime = mtime;
        if shared.observed_hash == hash {
            shared.pending_hash = None;
            continue;
        }
        if shared.pending_hash.as_ref() != Some(&hash) {
            shared.pending_hash = Some(hash);
            continue;
        }
        shared.pending_hash = None;
        let job = job(&shared.input, "agent", None);
        match run_render_bytes(&job, &bytes) {
            Ok(result) => {
                shared.observed_hash = hash;
                if result.outcome == TurnOutcome::NoOp {
                    continue;
                }
                shared.seq += 1;
                shared.by = "agent".to_owned();
                shared.note = None;
                let seq = shared.seq;
                if result.outcome == TurnOutcome::Ok {
                    enqueue(&shared, &job, seq, &bytes);
                }
                shared.subscribers.retain(|tx| tx.send(seq).is_ok());
            }
            Err(error) => eprintln!("mmx serve: render external change: {error:#}"),
        }
    }
}

fn handle(mut stream: TcpStream, shared: Arc<Mutex<Shared>>) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let request = match read_request(&stream) {
        Ok(request) => request,
        Err(error) => {
            send(
                &mut stream,
                400,
                "text/plain; charset=utf-8",
                error.to_string().as_bytes(),
            )?;
            return Ok(());
        }
    };
    let port = stream.local_addr()?.port();
    let allowed = |value: &str| {
        [
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
            format!("http://[::1]:{port}"),
        ]
        .contains(&value.to_owned())
    };
    if !request
        .host
        .as_deref()
        .is_some_and(|host| allowed(&format!("http://{host}")))
    {
        send(
            &mut stream,
            403,
            "text/plain; charset=utf-8",
            b"forbidden host",
        )?;
        return Ok(());
    }
    if request
        .origin
        .as_deref()
        .is_some_and(|origin| !allowed(origin))
    {
        send(
            &mut stream,
            403,
            "text/plain; charset=utf-8",
            b"forbidden origin",
        )?;
        return Ok(());
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/") => send(
            &mut stream,
            200,
            "text/html; charset=utf-8",
            include_str!("serve_page.html").as_bytes(),
        )?,
        ("GET", "/editor.js") => send(
            &mut stream,
            200,
            "application/javascript; charset=utf-8",
            include_str!("../editor/mmx-editor.js").as_bytes(),
        )?,
        ("GET", "/state") => {
            let result = state_value(&shared.lock().unwrap_or_else(|e| e.into_inner()));
            send_result(&mut stream, result)?;
        }
        ("POST", "/turn") if !request.content_type.as_deref().is_some_and(valid_json_type) => {
            send(
                &mut stream,
                415,
                "text/plain; charset=utf-8",
                b"application/json required",
            )?;
        }
        ("POST", "/turn") => match serde_json::from_slice::<TurnInput>(&request.body) {
            Ok(turn) => {
                let result = {
                    let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
                    apply_turn(&mut guard, turn)
                };
                match result {
                    Ok((status, value)) => send(
                        &mut stream,
                        status,
                        "application/json; charset=utf-8",
                        &serde_json::to_vec(&value)?,
                    )?,
                    Err(error) => send(
                        &mut stream,
                        500,
                        "text/plain; charset=utf-8",
                        error.to_string().as_bytes(),
                    )?,
                }
            }
            Err(error) => send(
                &mut stream,
                400,
                "text/plain; charset=utf-8",
                error.to_string().as_bytes(),
            )?,
        },
        ("GET", "/events") => events(stream, shared)?,
        _ => send(&mut stream, 404, "text/plain; charset=utf-8", b"not found")?,
    }
    Ok(())
}

fn valid_json_type(value: &str) -> bool {
    let mut parts = value.split(';');
    if !parts
        .next()
        .is_some_and(|part| part.trim().eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    parts.all(|part| {
        part.trim().split_once('=').is_some_and(|(key, value)| {
            key.trim().eq_ignore_ascii_case("charset") && !value.trim().is_empty()
        })
    })
}

fn read_limited_line<R: BufRead>(
    reader: &mut R,
    line: &mut String,
    remaining: usize,
) -> Result<usize> {
    let count = reader
        .by_ref()
        .take((remaining as u64) + 1)
        .read_line(line)?;
    anyhow::ensure!(count > 0, "unexpected end of request headers");
    anyhow::ensure!(count <= remaining, "request headers too large");
    anyhow::ensure!(line.ends_with('\n'), "incomplete request headers");
    Ok(count)
}

fn read_request(stream: &TcpStream) -> Result<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let first_bytes = read_limited_line(&mut reader, &mut line, MAX_HEADER_BYTES)?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    anyhow::ensure!(
        parts.len() == 3 && (parts[2] == "HTTP/1.1" || parts[2] == "HTTP/1.0"),
        "invalid request line"
    );
    let method = parts[0].to_owned();
    let path = parts[1].to_owned();
    let mut header_bytes = first_bytes;
    let mut length = 0usize;
    let mut host = None;
    let mut origin = None;
    let mut content_type = None;
    loop {
        line.clear();
        header_bytes += read_limited_line(&mut reader, &mut line, MAX_HEADER_BYTES - header_bytes)?;
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse()?;
            } else if key.eq_ignore_ascii_case("host") {
                host = Some(value.trim().to_owned());
            } else if key.eq_ignore_ascii_case("origin") {
                origin = Some(value.trim().to_owned());
            } else if key.eq_ignore_ascii_case("content-type") {
                content_type = Some(value.trim().to_owned());
            }
        }
    }
    anyhow::ensure!(length <= MAX_BODY_BYTES, "request body too large");
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        path,
        body,
        host,
        origin,
        content_type,
    })
}

fn send(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        415 => "Unsupported Media Type",
        _ => "Internal Server Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)?;
    Ok(())
}

fn send_result(stream: &mut TcpStream, value: Result<Value>) -> Result<()> {
    match value {
        Ok(value) => send(
            stream,
            200,
            "application/json; charset=utf-8",
            &serde_json::to_vec(&value)?,
        ),
        Err(error) => send(
            stream,
            500,
            "text/plain; charset=utf-8",
            error.to_string().as_bytes(),
        ),
    }
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn state_value(shared: &Shared) -> Result<Value> {
    let source = String::from_utf8_lossy(&std::fs::read(&shared.input)?).into_owned();
    let state_path = sibling(&shared.input, "state.json");
    let state = if state_path.exists() {
        read_json(&state_path)?
    } else {
        Value::Null
    };
    let svg = std::fs::read_to_string(sibling(&shared.input, "svg")).unwrap_or_default();
    Ok(json!({
        "source": source, "svg": svg,
        "nodes": state.get("nodes").cloned().unwrap_or_else(|| json!({})),
        "edges": state.get("edges").cloned().unwrap_or_else(|| json!([])),
        "seq": shared.seq, "epoch": shared.epoch, "by": shared.by, "note": shared.note,
    }))
}

fn apply_turn(shared: &mut Shared, turn: TurnInput) -> Result<(u16, Value)> {
    // All /turn handlers and the poller hold the same lock while writing and
    // rendering. The source file is replaced atomically for outside readers.
    if turn.base_seq.is_some_and(|base| base != shared.seq) {
        return Ok((
            409,
            json!({"exit":1,"conflict":true,"seq":shared.seq,"state":state_value(shared)?}),
        ));
    }
    if std::fs::read(&shared.input)? != turn.source.as_bytes() {
        crate::emit::write_atomic(&shared.input, turn.source.as_bytes())?;
        shared.observed_hash = state::hex_sha256(turn.source.as_bytes());
        shared.observed_mtime = modified_time(&shared.input);
        shared.pending_hash = None;
    }
    let job = job(&shared.input, "human", turn.note.clone());
    let result = run_render_bytes(&job, turn.source.as_bytes())?;
    if result.outcome == TurnOutcome::NoOp {
        return Ok((200, json!({"exit": 0, "noop": true})));
    }
    shared.seq += 1;
    shared.by = "human".to_owned();
    shared.note = turn.note;
    let seq = shared.seq;
    if result.outcome == TurnOutcome::Ok {
        enqueue(shared, &job, seq, turn.source.as_bytes());
    }
    shared.subscribers.retain(|tx| tx.send(seq).is_ok());
    let diff = read_json(&job.out_diff)?;
    if result.outcome == TurnOutcome::ParseError {
        return Ok((200, json!({"exit": 2, "diff": diff})));
    }
    let state = state_value(shared)?;
    let mut state = state;
    let svg = state
        .as_object_mut()
        .and_then(|object| object.remove("svg"))
        .unwrap_or(Value::Null);
    Ok((
        200,
        json!({"exit": 0, "state": state, "diff": diff, "svg": svg}),
    ))
}

// MMX-003: copy all three artifacts at the commit point before another turn can replace them.
fn enqueue(shared: &Shared, job: &RenderJob, seq: u64, mmd: &[u8]) {
    let Some(publisher) = &shared.publisher else {
        return;
    };
    match publish::Turn::read(job, seq, mmd) {
        Ok(turn) => publisher.enqueue(turn),
        Err(error) => eprintln!("mmx serve: cannot queue Rhizome turn: {error:#}"),
    }
}

fn events(mut stream: TcpStream, shared: Arc<Mutex<Shared>>) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let seq = {
        let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.subscribers.push(tx);
        (shared.seq, shared.epoch)
    };
    let (seq, epoch) = seq;
    if !write_sse(&mut stream, b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")? { return Ok(()); }
    if !write_event(&mut stream, seq, epoch)? {
        return Ok(());
    }
    loop {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(seq) => {
                if !write_event(&mut stream, seq, epoch)? {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !write_sse(&mut stream, b": keep-alive\n\n")? {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn write_event(stream: &mut TcpStream, seq: u64, epoch: u64) -> Result<bool> {
    write_sse(
        stream,
        format!("data: {{\"seq\":{seq},\"epoch\":{epoch}}}\n\n").as_bytes(),
    )
}

fn write_sse(stream: &mut TcpStream, bytes: &[u8]) -> Result<bool> {
    match stream.write_all(bytes) {
        Ok(()) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
