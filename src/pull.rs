//! MMX-004: receive the latest published turn for one Rhizome binding.

use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;

use crate::publish::{workspace_kind, BindingKind, Client, RequestError};

struct PublishedTurn {
    seq: u64,
    by: String,
    diff: String,
    mmd: String,
}

pub fn run(input: &Path, url: &str, bind: &str) -> Result<String> {
    let client = Client::new(url, bind.to_owned())?;
    let workspace = get(&client, "/v1/workspace")?;
    let kind = workspace_kind(&workspace, bind)?
        .ok_or_else(|| anyhow!("Rhizome binding {bind} not found in workspace"))?;
    let value: Value = serde_json::from_slice(&workspace).context("invalid workspace JSON")?;
    let root = value.get("body").unwrap_or(&value);
    let mut candidates: Vec<PublishedTurn> = Vec::new();
    if let Some(deliverables) = root["deliverables"].as_array() {
        for deliverable in deliverables {
            if deliverable["kind"] != "mmx-turn" || !matches_binding(deliverable, kind, bind) {
                continue;
            }
            let summary = deliverable["summary"].as_str().unwrap_or("");
            let Some(turn) = parse_summary(summary) else {
                eprintln!(
                    "mmx pull: warning: skipping malformed mmx-turn summary: {}",
                    sanitize(summary)
                );
                continue;
            };
            candidates.push(turn);
        }
    }
    if candidates.is_empty() {
        bail!("no turns published for {bind}");
    }
    // Board order is registration order and `seq` restarts at 0 whenever a
    // serve process restarts, so the current state is the LAST retrievable
    // entry, never the max seq. A candidate whose blobs are gone or tampered
    // with must not block the ones registered before it.
    while let Some(turn) = candidates.pop() {
        let (mmd, diff) = match fetch_turn(&client, &turn) {
            Ok(blobs) => blobs,
            Err(error) => {
                eprintln!(
                    "mmx pull: warning: skipping turn {} by {}: {error:#}",
                    turn.seq,
                    sanitize(&turn.by)
                );
                continue;
            }
        };
        let diff_path = crate::sibling(input, "pulled.diff.json");
        if std::fs::read(input).ok().as_deref() == Some(mmd.as_slice())
            && std::fs::read(&diff_path).ok().as_deref() == Some(diff.as_slice())
        {
            return Ok(format!("already up to date (turn {})", turn.seq));
        }
        // Diff first: if we stop between the writes, the next pull still sees
        // a stale mmd and repairs both files instead of reporting up-to-date.
        crate::emit::write_atomic(&diff_path, &diff)?;
        crate::emit::write_atomic(input, &mmd)?;
        return Ok(format!(
            "pulled turn {} by {}",
            turn.seq,
            sanitize(&turn.by)
        ));
    }
    bail!("no retrievable turns for {bind} (all candidates failed, see warnings)");
}

fn fetch_turn(client: &Client, turn: &PublishedTurn) -> Result<(Vec<u8>, Vec<u8>)> {
    let mmd = get(client, &format!("/v1/blob/{}", turn.mmd))?;
    let diff = get(client, &format!("/v1/blob/{}", turn.diff))?;
    check_blob(&turn.mmd, &mmd)?;
    check_blob(&turn.diff, &diff)?;
    Ok((mmd, diff))
}

fn matches_binding(deliverable: &Value, kind: BindingKind, bind: &str) -> bool {
    let field = match kind {
        BindingKind::Goal => "goalId",
        BindingKind::Mission => "missionId",
    };
    deliverable[field].as_str() == Some(bind)
}

fn parse_summary(summary: &str) -> Option<PublishedTurn> {
    let (seq, remainder) = summary.strip_prefix("turn ")?.split_once(" by ")?;
    if seq.is_empty() || !seq.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let seq = seq.parse().ok()?;
    let (by, _) = remainder.split_once(": ")?;
    if by.is_empty() {
        return None;
    }
    let mut diff = None;
    let mut mmd = None;
    for part in remainder.split(';').map(str::trim) {
        if let Some(id) = part.strip_prefix("diff=") {
            diff = valid_blob_id(id).then(|| id.to_owned());
        }
        if let Some(id) = part.strip_prefix("mmd=") {
            mmd = valid_blob_id(id).then(|| id.to_owned());
        }
    }
    Some(PublishedTurn {
        seq,
        by: by.to_owned(),
        diff: diff?,
        mmd: mmd?,
    })
}

fn valid_blob_id(id: &str) -> bool {
    id.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn check_blob(id: &str, bytes: &[u8]) -> Result<()> {
    if format!("sha256:{}", crate::state::hex_sha256(bytes)) != id {
        bail!("Rhizome blob {id} has mismatched content");
    }
    Ok(())
}

/// Board summaries and actor names are written by other actors; strip
/// control characters and cap length before echoing them to a terminal.
fn sanitize(text: &str) -> String {
    let mut cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { '?' } else { c })
        .take(200)
        .collect();
    if text.chars().count() > 200 {
        cleaned.push('…');
    }
    cleaned
}

fn get(client: &Client, path: &str) -> Result<Vec<u8>> {
    let (status, body) = client
        .request("GET", path, None, &[])
        .map_err(|error| match error {
            RequestError::Unavailable(error) => anyhow!("Rhizome unavailable: {error}"),
            RequestError::Invalid(error) => anyhow!("invalid Rhizome response: {error:#}"),
        })?;
    if status != 200 {
        bail!("Rhizome {path} returned HTTP {status}");
    }
    Ok(body)
}
