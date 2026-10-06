//! One mmx turn, callable from the browser.
//!
//! Input (JSON, utf-8 at ptr/len): {source, by, note?, prev_state?}
//! Output (JSON): {exit, svg?, diff, state?, noop?}
//!   exit 0 = rendered (or noop: true when the source hash matches prev),
//!   exit 2 = repairable parse/encoding error (diff carries `error`).
//! Same contracts as the CLI; this is the CLI's core with files swapped
//! for JSON in/out.

use std::alloc::{alloc, Layout};
use std::cell::RefCell;

use mmx::{diff, emit, lint, model, render, state};

thread_local! {
    static LAST: RefCell<String> = const { RefCell::new(String::new()) };
}

#[no_mangle]
pub extern "C" fn wasm_alloc(len: usize) -> *mut u8 {
    unsafe { alloc(Layout::from_size_align(len.max(1), 1).unwrap()) }
}

/// Free a buffer from `wasm_alloc` (same `len`) once `wasm_turn` returned.
#[no_mangle]
pub extern "C" fn wasm_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { std::alloc::dealloc(ptr, Layout::from_size_align(len.max(1), 1).unwrap()) }
    }
}

#[no_mangle]
pub extern "C" fn wasm_result_len() -> usize {
    LAST.with(|l| l.borrow().len())
}

#[no_mangle]
pub extern "C" fn wasm_turn(ptr: *const u8, len: usize) -> *const u8 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len) };
    let out = run(input).unwrap_or_else(|e| format!("{{\"exit\":1,\"error\":{}}}", json_str(&e)));
    LAST.with(|l| {
        *l.borrow_mut() = out;
        l.borrow().as_ptr()
    })
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"?\"".into())
}

fn run(input: &[u8]) -> Result<String, String> {
    let req: serde_json::Value =
        serde_json::from_slice(input).map_err(|e| format!("bad request json: {e}"))?;
    let source = req["source"].as_str().ok_or("missing source")?;
    let by = req["by"].as_str().unwrap_or("unknown");
    let note = req["note"].as_str().filter(|s| !s.is_empty());

    let source_hash = state::hex_sha256(source.as_bytes());
    let prev: Option<state::State> = req
        .get("prev_state")
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|e| format!("bad prev_state: {e}"))?;

    // No-op contract: identical source, nothing to say (browser host decides
    // whether the previous diff message is stale).
    if let Some(p) = &prev {
        if p.source_sha256 == source_hash {
            return Ok("{\"exit\":0,\"noop\":true}".into());
        }
    }

    let rendered = match lint::check(source).and_then(|_| render::render_turn(source)) {
        Ok(r) => r,
        Err(err) => {
            let mut report =
                emit::DiffReport::turn_error(by, note, &err, Vec::new(), prev.is_none());
            report.set_source_hunks(prev.as_ref().and_then(|p| p.source.as_deref()), source);
            let diff_json = report.to_json().map_err(|e| e.to_string())?;
            return Ok(format!("{{\"exit\":2,\"diff\":{diff_json}}}"));
        }
    };

    let current = model::GraphModel::from_rendered(&rendered);
    let new_state = state::State::from_model(&source_hash, source, &current);
    let mut warnings = Vec::new();
    lint::warnings(&current, prev.is_none(), &mut warnings);
    let report = match &prev {
        Some(p) => {
            let old_model = p.to_model();
            let d = diff::diff_with_subgraphs(&old_model, &current, p.subgraphs.is_some());
            let mut report =
                emit::DiffReport::from_diff(by, note, d, &old_model, &current, warnings);
            report.set_source_hunks(p.source.as_deref(), source);
            report
        }
        None => emit::DiffReport::baseline(by, note, &current, warnings),
    };

    let diff_json = report.to_json().map_err(|e| e.to_string())?;
    let state_json = new_state.to_json().map_err(|e| e.to_string())?;
    let svg_json = json_str(&rendered.svg);
    Ok(format!(
        "{{\"exit\":0,\"svg\":{svg_json},\"diff\":{diff_json},\"state\":{state_json}}}"
    ))
}
