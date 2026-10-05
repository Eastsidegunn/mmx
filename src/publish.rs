//! MMX-003 Rhizome delivery. Network work stays on one disposable worker thread.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use crate::RenderJob;

const TIMEOUT: Duration = Duration::from_secs(3);
const RETRY: Duration = Duration::from_secs(5);
const QUEUE_LIMIT: usize = 100;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

pub struct Turn {
    seq: u64,
    by: String,
    svg: Vec<u8>,
    diff: Vec<u8>,
    mmd: Vec<u8>,
}

pub struct Publisher {
    queue: Arc<Mutex<Queue>>,
    wake: SyncSender<()>,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Turn>,
    in_flight: bool,
}

impl Publisher {
    pub fn enqueue(&self, turn: Turn) {
        let mut queue = self.queue.lock().unwrap_or_else(|error| error.into_inner());
        if queue.pending.len() + usize::from(queue.in_flight) >= QUEUE_LIMIT {
            queue.pending.pop_front();
            eprintln!("mmx serve: Rhizome queue full; dropped oldest turn");
        }
        queue.pending.push_back(turn);
        drop(queue);
        let _ = self.wake.try_send(());
    }
}

impl Turn {
    pub fn read(job: &RenderJob, seq: u64, mmd: &[u8]) -> Result<Self> {
        Ok(Self {
            seq,
            by: job.by.clone(),
            svg: read(&job.out_svg)?,
            diff: read(&job.out_diff)?,
            mmd: mmd.to_vec(),
        })
    }
}

fn read(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))
}

#[derive(Clone)]
pub(crate) struct Client {
    addr: SocketAddr,
    host: String,
    bind: String,
    kind: Option<BindingKind>,
}

#[derive(Clone, Copy)]
pub(crate) enum BindingKind {
    Goal,
    Mission,
}

pub(crate) enum RequestError {
    Unavailable(std::io::Error),
    Invalid(anyhow::Error),
}

enum DeliveryError {
    Retry(anyhow::Error),
    Drop(String),
}

fn classify_status(status: u16, endpoint: &str, body: &[u8]) -> DeliveryError {
    let reason = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value["Reason"].as_str().map(str::to_owned));
    let message = match reason {
        Some(reason) => format!("{endpoint} returned HTTP {status}: {reason}"),
        None => format!("{endpoint} returned HTTP {status}"),
    };
    if status >= 500 || status == 408 || status == 429 {
        DeliveryError::Retry(anyhow!(message))
    } else {
        DeliveryError::Drop(message)
    }
}

fn request_failure(error: RequestError) -> DeliveryError {
    match error {
        RequestError::Unavailable(error) => DeliveryError::Retry(error.into()),
        RequestError::Invalid(error) => {
            DeliveryError::Drop(format!("invalid Rhizome response: {error:#}"))
        }
    }
}

pub(crate) fn workspace_kind(body: &[u8], bind: &str) -> Result<Option<BindingKind>> {
    let value: Value = serde_json::from_slice(body).context("invalid workspace JSON")?;
    // The live contract nests the projection under "body" (envelope
    // {revision, body:{missions, tasks, ...}}); MMX-003 live S5 caught a
    // flat-shape assumption here that the fakes had mirrored.
    let root = if value.get("body").is_some() {
        &value["body"]
    } else {
        &value
    };
    for (field, kind) in [
        ("missions", BindingKind::Goal),
        ("tasks", BindingKind::Mission),
    ] {
        if let Some(entries) = root[field].as_array() {
            if entries
                .iter()
                .any(|entry| entry["id"].as_str() == Some(bind))
            {
                return Ok(Some(kind));
            }
        }
    }
    Ok(None)
}

pub fn start(url: Option<String>, bind: Option<String>) -> Result<Option<Publisher>> {
    let (url, bind) = match (url, bind) {
        (None, None) => return Ok(None),
        (Some(url), Some(bind)) => (url, bind),
        _ => bail!("--rhizome and --bind must be supplied together"),
    };
    let mut client = Client::new(&url, bind)?;
    let unavailable = match client.request("GET", "/v1/workspace", None, &[]) {
        Ok((200, body)) => {
            match workspace_kind(&body, &client.bind) {
                Ok(Some(kind)) => client.kind = Some(kind),
                Ok(None) => bail!("Rhizome binding {} not found in workspace", client.bind),
                Err(error) => {
                    eprintln!("mmx serve: Rhizome workspace cannot be validated: {error:#}")
                }
            }
            client.kind.is_none()
        }
        Ok((status, _)) => {
            eprintln!("mmx serve: Rhizome workspace returned HTTP {status}; turns will retry");
            true
        }
        Err(RequestError::Unavailable(error)) => {
            eprintln!("mmx serve: Rhizome unavailable; turns will retry: {error:#}");
            true
        }
        Err(RequestError::Invalid(error)) => {
            eprintln!("mmx serve: Rhizome workspace cannot be validated: {error:#}");
            true
        }
    };
    let (tx, rx) = mpsc::sync_channel(1);
    let queue = Arc::new(Mutex::new(Queue::default()));
    let worker_queue = Arc::clone(&queue);
    thread::spawn(move || {
        let mut failing = unavailable;
        let mut retry_at = None;
        let mut last_drop_reason = None::<String>;
        loop {
            let pending = !worker_queue
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pending
                .is_empty();
            let wait = if pending {
                retry_at.map_or(Duration::ZERO, |at: Instant| {
                    at.saturating_duration_since(Instant::now())
                })
            } else {
                Duration::from_secs(60)
            };
            match rx.recv_timeout(wait) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if retry_at.is_some_and(|at| Instant::now() < at) {
                continue;
            }
            retry_at = None;
            loop {
                let turn = {
                    let mut queue = worker_queue
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    let turn = queue.pending.pop_front();
                    queue.in_flight = turn.is_some();
                    turn
                };
                let Some(turn) = turn else { break };
                let result = client.deliver(&turn);
                let mut queue = worker_queue
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                queue.in_flight = false;
                match result {
                    Ok(()) => {
                        if failing {
                            eprintln!("mmx serve: Rhizome publishing recovered");
                            failing = false;
                        }
                    }
                    Err(DeliveryError::Retry(error)) => {
                        queue.pending.push_front(turn);
                        if !failing {
                            eprintln!("mmx serve: Rhizome publishing failed: {error:#}");
                            failing = true;
                        }
                        retry_at = Some(Instant::now() + RETRY);
                        break;
                    }
                    Err(DeliveryError::Drop(reason)) => {
                        if last_drop_reason.as_deref() != Some(&reason) {
                            eprintln!("mmx serve: Rhizome turn dropped: {reason}");
                            last_drop_reason = Some(reason);
                        }
                    }
                }
            }
        }
    });
    Ok(Some(Publisher { queue, wake: tx }))
}

impl Client {
    pub(crate) fn new(url: &str, bind: String) -> Result<Self> {
        let authority = url
            .strip_prefix("http://")
            .ok_or_else(|| anyhow!("--rhizome must be an http:// loopback URL"))?
            .trim_end_matches('/');
        anyhow::ensure!(!authority.contains('/'), "--rhizome URL must have no path");
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| anyhow!("--rhizome URL needs a port"))?;
        anyhow::ensure!(
            host == "127.0.0.1" || host == "localhost",
            "--rhizome must use 127.0.0.1 or localhost"
        );
        let port: u16 = port.parse().context("invalid --rhizome port")?;
        let addr = ("127.0.0.1", port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| anyhow!("invalid Rhizome address"))?;
        Ok(Self {
            addr,
            host: format!("{host}:{port}"),
            bind,
            kind: None,
        })
    }

    fn deliver(&mut self, turn: &Turn) -> std::result::Result<(), DeliveryError> {
        if self.kind.is_none() {
            let (status, body) = self
                .request("GET", "/v1/workspace", None, &[])
                .map_err(request_failure)?;
            if status != 200 {
                return Err(classify_status(status, "workspace", &body));
            }
            self.kind = workspace_kind(&body, &self.bind)
                .map_err(|error| DeliveryError::Drop(format!("invalid workspace: {error:#}")))?;
            if self.kind.is_none() {
                return Err(DeliveryError::Drop(format!(
                    "Rhizome binding {} not found in workspace",
                    self.bind
                )));
            }
        }
        // MMX-003: retries upload all blobs again; Rhizome's content-addressed POST is idempotent.
        let svg = self.blob("image/svg+xml", &turn.svg)?;
        let diff = self.blob("application/json", &turn.diff)?;
        let mmd = self.blob("text/plain; charset=utf-8", &turn.mmd)?;
        let d: Value = serde_json::from_slice(&turn.diff)
            .map_err(|error| DeliveryError::Drop(format!("invalid diff: {error}")))?;
        let count = |section: &str, field: &str| d[section][field].as_array().map_or(0, Vec::len);
        // The note is the whole point of a zero-change turn; carry it in the
        // summary. ';' and control chars are stripped so the segment format
        // (and mmx pull's parser) stays unambiguous.
        let note = d["note"].as_str().map_or(String::new(), |note| {
            let cleaned: String = note
                .chars()
                .map(|c| if c == ';' || c.is_control() { ' ' } else { c })
                .take(80)
                .collect();
            let cleaned = cleaned.trim();
            if cleaned.is_empty() {
                String::new()
            } else {
                format!("; note={cleaned}")
            }
        });
        let summary = format!(
            "turn {} by {}: added {}, removed {}, changed {}{note}; diff={diff}; mmd={mmd}",
            turn.seq,
            turn.by,
            count("nodes", "added") + count("edges", "added"),
            count("nodes", "removed") + count("edges", "removed"),
            count("nodes", "changed") + count("edges", "changed"),
        );
        let binding = if matches!(self.kind, Some(BindingKind::Mission)) {
            json!({"MissionID":self.bind})
        } else {
            json!({"GoalID":self.bind})
        };
        let mut intent = json!({
            "Kind":"deliverable.register",
            "deliverableKind":"mmx-turn",
            "summary":summary,
            "sourceRef":svg,
            "actor":"mmx-serve",
        });
        intent
            .as_object_mut()
            .unwrap()
            .extend(binding.as_object().unwrap().clone());
        let body = serde_json::to_vec(&intent)
            .map_err(|error| DeliveryError::Drop(format!("cannot encode intent: {error}")))?;
        let (status, response) = self
            .request("POST", "/v1/intent", Some("application/json"), &body)
            .map_err(request_failure)?;
        if status != 200 {
            return Err(classify_status(status, "intent", &response));
        }
        let response: Value = serde_json::from_slice(&response)
            .map_err(|error| DeliveryError::Drop(format!("invalid intent response: {error}")))?;
        if response["Accepted"] != true {
            let reason = response["Reason"].as_str().unwrap_or("missing acceptance");
            return Err(DeliveryError::Drop(format!("intent rejected: {reason}")));
        }
        Ok(())
    }

    fn blob(&self, content_type: &str, bytes: &[u8]) -> std::result::Result<String, DeliveryError> {
        let (status, response) = self
            .request("POST", "/v1/blob", Some(content_type), bytes)
            .map_err(request_failure)?;
        if status != 200 {
            return Err(classify_status(status, "blob", &response));
        }
        let value: Value = serde_json::from_slice(&response)
            .map_err(|error| DeliveryError::Drop(format!("invalid blob response: {error}")))?;
        let id = value["blobId"]
            .as_str()
            .ok_or_else(|| DeliveryError::Drop("blob response missing blobId".to_owned()))?;
        if !id.starts_with("sha256:") {
            return Err(DeliveryError::Drop(format!("invalid blobId {id}")));
        }
        Ok(id.to_owned())
    }

    pub(crate) fn request(
        &self,
        method: &str,
        path: &str,
        content_type: Option<&str>,
        body: &[u8],
    ) -> std::result::Result<(u16, Vec<u8>), RequestError> {
        let mut stream =
            TcpStream::connect_timeout(&self.addr, TIMEOUT).map_err(RequestError::Unavailable)?;
        // Each read has a 3s timeout; only this isolated worker can accumulate read waits.
        stream
            .set_read_timeout(Some(TIMEOUT))
            .map_err(RequestError::Unavailable)?;
        stream
            .set_write_timeout(Some(TIMEOUT))
            .map_err(RequestError::Unavailable)?;
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: {}\r\n",
            self.host,
            body.len()
        )
        .map_err(RequestError::Unavailable)?;
        if let Some(content_type) = content_type {
            write!(stream, "Content-Type: {content_type}\r\n")
                .map_err(RequestError::Unavailable)?;
        }
        stream
            .write_all(b"\r\n")
            .map_err(RequestError::Unavailable)?;
        stream.write_all(body).map_err(RequestError::Unavailable)?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        read_line(&mut reader, &mut line)?;
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| RequestError::Invalid(anyhow!("missing HTTP status")))?
            .parse()
            .map_err(|error| RequestError::Invalid(anyhow!("invalid HTTP status: {error}")))?;
        let mut length = None;
        let mut chunked = false;
        let mut header_size = line.len();
        loop {
            line.clear();
            read_line(&mut reader, &mut line)?;
            header_size += line.len();
            if header_size > MAX_HEADERS {
                return Err(RequestError::Invalid(anyhow!("Rhizome headers too large")));
            }
            if line == "\r\n" || line == "\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = Some(value.trim().parse::<usize>().map_err(|error| {
                        RequestError::Invalid(anyhow!("invalid Content-Length: {error}"))
                    })?);
                } else if name.eq_ignore_ascii_case("transfer-encoding") {
                    chunked = value
                        .split(',')
                        .any(|part| part.trim().eq_ignore_ascii_case("chunked"));
                }
            }
        }
        let mut response = Vec::new();
        if chunked {
            loop {
                line.clear();
                read_line(&mut reader, &mut line)?;
                let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                    .map_err(|error| {
                    RequestError::Invalid(anyhow!("invalid chunk size: {error}"))
                })?;
                if size == 0 {
                    loop {
                        line.clear();
                        read_line(&mut reader, &mut line)?;
                        if line == "\r\n" || line == "\n" {
                            break;
                        }
                    }
                    break;
                }
                if size > MAX_RESPONSE - response.len() {
                    return Err(RequestError::Invalid(anyhow!("Rhizome response too large")));
                }
                let old = response.len();
                response.resize(old + size, 0);
                reader
                    .read_exact(&mut response[old..])
                    .map_err(RequestError::Unavailable)?;
                let mut delimiter = [0; 2];
                reader
                    .read_exact(&mut delimiter)
                    .map_err(RequestError::Unavailable)?;
                if delimiter != *b"\r\n" {
                    return Err(RequestError::Invalid(anyhow!("invalid chunk delimiter")));
                }
            }
        } else if let Some(length) = length {
            if length > MAX_RESPONSE {
                return Err(RequestError::Invalid(anyhow!("Rhizome response too large")));
            }
            response.resize(length, 0);
            reader
                .read_exact(&mut response)
                .map_err(RequestError::Unavailable)?;
        } else {
            reader
                .take((MAX_RESPONSE + 1) as u64)
                .read_to_end(&mut response)
                .map_err(RequestError::Unavailable)?;
            if response.len() > MAX_RESPONSE {
                return Err(RequestError::Invalid(anyhow!("Rhizome response too large")));
            }
        }
        Ok((status, response))
    }
}

fn read_line<R: BufRead>(
    reader: &mut R,
    line: &mut String,
) -> std::result::Result<(), RequestError> {
    let count = reader
        .take((MAX_HEADERS + 1) as u64)
        .read_line(line)
        .map_err(RequestError::Unavailable)?;
    if count == 0 || !line.ends_with('\n') || count > MAX_HEADERS {
        return Err(RequestError::Invalid(anyhow!(
            "incomplete or oversized HTTP line"
        )));
    }
    Ok(())
}
