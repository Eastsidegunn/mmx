//! Turn log: `<stem>.turns.jsonl`, the conversation's durable history.
//!
//! Policy:
//! - One line per committed turn (an `Ok` render after state.json is written,
//!   or a `ParseError` after diff.json is written). No-ops are never logged.
//! - Line format: `{"v":1,"at":<unix ms>,"by":..,"note":..,
//!   "source_sha256":..,"diff":<the full diff.json object>}`.
//!   `source_sha256` is the hash of the rendered bytes, so a reader can tell
//!   whether the current file content was already turned into a turn (an
//!   error turn does not update state.json).
//! - Writers (the CLI and `mmx serve`, possibly concurrent) serialize on
//!   `<log>.lock` and append each line with a single `write_all`; a torn
//!   last line from a crashed writer is closed off before the next append.
//! - Rotation: before appending, if the file exceeds [`MAX_BYTES`], it is
//!   rewritten atomically (tmp + rename) keeping the newest [`KEEP_ENTRIES`]
//!   entries. Readers must therefore tolerate the file shrinking or being
//!   replaced.
//! - Readers skip lines that do not parse as a JSON object.
//! - A log write failure never fails the turn; the caller only warns.

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Rotate once the log grows past this many bytes.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Entries kept by a rotation (the newest ones).
pub const KEEP_ENTRIES: usize = 200;
pub const LOG_VERSION: u64 = 1;

/// Unix time in milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build one log line (no trailing newline) for a turn.
pub fn entry_line(
    by: &str,
    note: Option<&str>,
    source_sha256: &str,
    diff_json: &str,
) -> anyhow::Result<String> {
    let diff: Value = serde_json::from_str(diff_json)?;
    let entry = json!({
        "v": LOG_VERSION,
        "at": now_ms(),
        "by": by,
        "note": note,
        "source_sha256": source_sha256,
        "diff": diff,
    });
    Ok(serde_json::to_string(&entry)?)
}

/// Cross-process mutex for the log: `<log>.lock`, created exclusively.
/// Rotation is read-rewrite-rename, so an append racing it could land in the
/// replaced file and vanish; every writer holds this lock for the whole
/// rotate-and-append. A lock older than [`LOCK_STALE`] is presumed left by
/// a crashed writer and broken.
struct LogLock(std::path::PathBuf);

const LOCK_STALE: Duration = Duration::from_secs(10);
const LOCK_WAIT: Duration = Duration::from_secs(5);

impl LogLock {
    fn acquire(log: &Path) -> anyhow::Result<Self> {
        let mut path = log.as_os_str().to_owned();
        path.push(".lock");
        let path = std::path::PathBuf::from(path);
        let deadline = Instant::now() + LOCK_WAIT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(LogLock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > LOCK_STALE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    if Instant::now() >= deadline {
                        anyhow::bail!("turn log is locked: {}", path.display());
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

impl Drop for LogLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Append `line` (built by [`entry_line`]) to the log, rotating first if the
/// log is over [`MAX_BYTES`].
pub fn append(log: &Path, line: &str) -> anyhow::Result<()> {
    let _lock = LogLock::acquire(log)?;
    if std::fs::metadata(log).is_ok_and(|m| m.len() > MAX_BYTES) {
        rotate(log, KEEP_ENTRIES)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(log)?;
    let mut bytes = Vec::with_capacity(line.len() + 2);
    // A writer that crashed mid-line leaves no trailing newline; start a
    // fresh line so this entry is not glued onto the torn one (readers skip
    // the torn line itself).
    if ends_without_newline(&mut file)? {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    Ok(())
}

fn ends_without_newline(file: &mut std::fs::File) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(len - 1))?;
    let mut last = [0u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// Rewrite the log atomically, keeping only the newest `keep` valid entries.
pub fn rotate(log: &Path, keep: usize) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let entries: Vec<(&str, Value)> = text
        .lines()
        .filter_map(|l| parse_line(l).map(|v| (l, v)))
        .collect();
    let start = entries.len().saturating_sub(keep);
    let mut out = String::new();
    // Keep the conversation boundary: if the newest non-human turn would be
    // rotated out, `mmx wait` would treat every kept human turn as unanswered.
    // Keep that one entry ahead of the window.
    if let Some(boundary) = entries
        .iter()
        .rposition(|(_, v)| v["by"].as_str() != Some("human"))
        .filter(|&i| i < start)
    {
        out.push_str(entries[boundary].0);
        out.push('\n');
    }
    for (line, _) in &entries[start..] {
        out.push_str(line);
        out.push('\n');
    }
    crate::emit::write_atomic(log, out.as_bytes())
}

/// Parse one log line; `None` for blank or unparseable lines.
pub fn parse_line(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    value.is_object().then_some(value)
}

/// All valid entries with their raw lines, oldest first. A missing log is
/// an empty history.
pub fn read_raw(log: &Path) -> Vec<(String, Value)> {
    let text = match std::fs::read(log) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return Vec::new(),
    };
    text.lines()
        .filter_map(|l| parse_line(l).map(|v| (l.trim().to_owned(), v)))
        .collect()
}

/// All valid entries, oldest first.
pub fn read_entries(log: &Path) -> Vec<Value> {
    read_raw(log).into_iter().map(|(_, v)| v).collect()
}

/// Would a turn with this `by`/`note` over the current file content just
/// repeat the newest logged turn? (Same author, same note, same bytes.)
pub fn repeats_last(log: &Path, input: &Path, by: &str, note: Option<&str>) -> bool {
    let Ok(bytes) = std::fs::read(input) else {
        return false;
    };
    let hash = crate::state::hex_sha256(&bytes);
    // An error turn is never repeated away: a retry must report the error
    // again (exit 2), not a silent success.
    read_entries(log).last().is_some_and(|e| {
        e["by"].as_str() == Some(by)
            && e["note"].as_str() == note
            && e["source_sha256"].as_str() == Some(hash.as_str())
            && e["diff"]["error"].is_null()
    })
}

/// The human turns nobody has answered yet: entries with `by == "human"`
/// after the last entry whose `by` is anything else.
pub fn pending_human(entries: &[Value]) -> &[Value] {
    let start = entries
        .iter()
        .rposition(|e| e["by"].as_str() != Some("human"))
        .map_or(0, |i| i + 1);
    let pending = &entries[start..];
    // A human-attributed first render with no note (e.g. a hook rendering a
    // freshly created diagram) is the starting picture, not a message.
    let silent_baseline = |e: &Value| {
        e["diff"]["baseline"].as_bool() == Some(true)
            && e["diff"]["error"].is_null()
            && e["note"].as_str().is_none_or(|n| n.trim().is_empty())
    };
    let skip = pending.iter().take_while(|e| silent_baseline(e)).count();
    &pending[skip..]
}

/// Generic one-line summary of a diff object: counts of the arrays (or maps)
/// under `nodes`/`edges` `added`/`removed`/`changed`, plus the error message.
/// It does not depend on the shape of the individual entries.
pub fn summary(diff: &Value) -> Value {
    let count = |section: &str, kind: &str| -> usize {
        match &diff[section][kind] {
            Value::Array(a) => a.len(),
            Value::Object(o) => o.len(),
            _ => 0,
        }
    };
    let error = match &diff["error"] {
        Value::Null => Value::Null,
        e => e["message"]
            .as_str()
            .map_or_else(|| Value::String(e.to_string()), |m| json!(m)),
    };
    json!({
        "nodes_added": count("nodes", "added"),
        "nodes_removed": count("nodes", "removed"),
        "nodes_changed": count("nodes", "changed"),
        "edges_added": count("edges", "added"),
        "edges_removed": count("edges", "removed"),
        "edges_changed": count("edges", "changed"),
        "error": error,
        "baseline": diff["baseline"].as_bool().unwrap_or(false),
    })
}

/// How often `mmx wait` re-reads the log (and the diagram).
pub const WAIT_POLL_MS: u64 = 250;

/// `mmx wait`: block until the human has spoken last, then return the
/// diffs of the pending human turns, oldest first. `None` on timeout.
/// A zero timeout checks once (plus one stability re-read for an
/// unrendered edit).
///
/// Without a live `mmx serve`, nobody else renders the human's direct file
/// edits, so wait does: content that differs from the last rendered bytes
/// and stays identical for two consecutive polls is rendered as
/// `by: "human"`. With a live serve, its poller owns external edits (and
/// attributes them to the agent), so wait only reads the log.
pub fn run_wait(input: &Path, timeout: Duration) -> Vec<Value> {
    let log = crate::sibling(input, "turns.jsonl");
    let deadline = Instant::now() + timeout;
    let mut candidate: Option<String> = None;
    let mut grace = false;
    loop {
        // Re-read the whole log every poll: this also copes with rotation
        // (the file shrinking or being replaced).
        let entries = read_entries(&log);
        let pending = pending_human(&entries);
        if !pending.is_empty() {
            return pending.iter().map(|e| e["diff"].clone()).collect();
        }
        let mut fresh_candidate = false;
        match unrendered_hash(input, entries.last()) {
            Some(hash) if candidate.as_ref() == Some(&hash) => {
                candidate = None;
                if !crate::serve::is_live(input) {
                    let job = crate::default_job(input, "human", None);
                    match crate::run_render(&job) {
                        Ok(_) => continue,
                        Err(e) => eprintln!("mmx wait: warning: render failed: {e:#}"),
                    }
                }
            }
            Some(hash) => {
                candidate = Some(hash);
                fresh_candidate = true;
            }
            None => candidate = None,
        }
        if Instant::now() >= deadline {
            if !fresh_candidate || grace {
                return Vec::new();
            }
            grace = true;
        }
        std::thread::sleep(Duration::from_millis(WAIT_POLL_MS));
    }
}

/// Hash of the diagram's current bytes if they have not been rendered into
/// a turn yet: they match neither state.json's `source_sha256` nor the last
/// logged turn's (an error turn leaves state.json behind).
fn unrendered_hash(input: &Path, last: Option<&Value>) -> Option<String> {
    let bytes = std::fs::read(input).ok()?;
    let hash = crate::state::hex_sha256(&bytes);
    if last.is_some_and(|e| e["source_sha256"].as_str() == Some(hash.as_str())) {
        return None;
    }
    let state: Option<Value> = std::fs::read(crate::sibling(input, "state.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok());
    if state.is_some_and(|s| s["source_sha256"].as_str() == Some(hash.as_str())) {
        return None;
    }
    Some(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mmx-turnlog-{}-{}-{name}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("d.turns.jsonl")
    }

    #[test]
    fn append_after_torn_line_stays_readable() {
        let log = tmp("torn");
        append(&log, &entry_line("agent", None, "h", "{}").unwrap()).unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(br#"{"v":1,"at":"#)
            .unwrap();
        append(&log, &entry_line("human", Some("q"), "h", "{}").unwrap()).unwrap();
        let entries = read_entries(&log);
        assert_eq!(
            entries.len(),
            2,
            "torn line must not swallow the next entry"
        );
        assert_eq!(entries[1]["note"], "q");
    }

    #[test]
    fn concurrent_appends_survive_rotation() {
        let log = tmp("race");
        let pad = "x".repeat(4 * 1024);
        while std::fs::metadata(&log).map_or(0, |m| m.len()) <= MAX_BYTES {
            let diff = json!({"pad": pad}).to_string();
            append(&log, &entry_line("agent", None, "h", &diff).unwrap()).unwrap();
        }
        // Both writers arrive while the log is over the limit: one rotates,
        // the other must still land in the rotated file.
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|note| {
                let log = log.clone();
                std::thread::spawn(move || {
                    append(&log, &entry_line("human", Some(note), "h", "{}").unwrap()).unwrap()
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let notes: Vec<String> = read_entries(&log)
            .iter()
            .filter_map(|e| e["note"].as_str().map(str::to_owned))
            .collect();
        assert!(notes.contains(&"first".to_owned()), "{notes:?}");
        assert!(notes.contains(&"second".to_owned()), "{notes:?}");
    }

    #[test]
    fn rotation_keeps_the_last_answer_boundary() {
        let log = tmp("boundary");
        append(
            &log,
            &entry_line("agent", Some("answer"), "h", "{}").unwrap(),
        )
        .unwrap();
        for i in 0..5 {
            append(
                &log,
                &entry_line("human", Some(&format!("q{i}")), "h", "{}").unwrap(),
            )
            .unwrap();
        }
        rotate(&log, 3).unwrap();
        let entries = read_entries(&log);
        assert_eq!(
            entries[0]["by"], "agent",
            "boundary kept ahead of the window"
        );
        assert_eq!(entries.len(), 4);
        let pending = pending_human(&entries);
        assert_eq!(pending.len(), 3);
        assert_eq!(pending[2]["note"], "q4");
    }

    #[test]
    fn rotation_keeps_newest_200() {
        let log = tmp("rotate");
        // ~4 KiB per entry: ~500 entries before the log passes MAX_BYTES.
        let pad = "x".repeat(4 * 1024);
        let mut n: i64 = 0;
        while std::fs::metadata(&log).map_or(0, |m| m.len()) <= MAX_BYTES {
            let diff = json!({"i": n, "pad": pad}).to_string();
            append(&log, &entry_line("agent", None, "h", &diff).unwrap()).unwrap();
            n += 1;
        }
        // Also a garbage line, which readers and rotation drop.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&log)
            .unwrap()
            .write_all(b"{not json\n")
            .unwrap();
        let diff = json!({"i": n}).to_string();
        append(
            &log,
            &entry_line("human", Some("last"), "h", &diff).unwrap(),
        )
        .unwrap();
        let entries = read_entries(&log);
        assert_eq!(entries.len(), KEEP_ENTRIES + 1);
        assert_eq!(entries[0]["diff"]["i"], n - KEEP_ENTRIES as i64);
        assert_eq!(entries[KEEP_ENTRIES]["note"], "last");
        assert!(std::fs::metadata(&log).unwrap().len() < MAX_BYTES * 2);
        let _ = std::fs::remove_dir_all(log.parent().unwrap());
    }

    #[test]
    fn pending_and_summary() {
        let e = |by: &str| json!({"by": by});
        let entries = vec![e("human"), e("agent"), e("human"), e("human")];
        assert_eq!(pending_human(&entries).len(), 2);
        assert_eq!(pending_human(&entries[..2]).len(), 0);
        assert_eq!(pending_human(&entries[..1]).len(), 1);
        let s = summary(&json!({
            "nodes": {"added": ["A", {"id": "B"}], "removed": [], "changed": {"C": {}}},
            "edges": {"added": ["A->B"]},
            "error": {"message": "bad"}
        }));
        assert_eq!(s["nodes_added"], 2);
        assert_eq!(s["nodes_changed"], 1);
        assert_eq!(s["edges_added"], 1);
        assert_eq!(s["edges_removed"], 0);
        assert_eq!(s["error"], "bad");
    }
}
