//! mmx core: parse, diff, state, emit. No harness names in here.

pub mod diff;
pub mod emit;
pub mod init;
pub mod model;
pub mod render;
pub mod serve;
pub mod state;

use std::path::{Path, PathBuf};

use anyhow::Context;

/// Where the previous state comes from.
pub enum PrevSource {
    /// `--prev` given: must exist (else exit 1).
    Explicit(PathBuf),
    /// No `--prev`: the state output path; absent file means baseline.
    Default(PathBuf),
}

impl PrevSource {
    pub fn path(&self) -> &Path {
        match self {
            PrevSource::Explicit(p) | PrevSource::Default(p) => p,
        }
    }
}

/// Everything `mmx render` needs, resolved from CLI args.
pub struct RenderJob {
    pub input: PathBuf,
    pub by: String,
    pub note: Option<String>,
    pub prev: PrevSource,
    pub out_svg: PathBuf,
    pub out_diff: PathBuf,
    pub out_state: PathBuf,
    pub print_if_changed: bool,
}

/// Outcome of a render turn, mapped to exit codes by main.
#[derive(Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    /// Input identical to the previous state: nothing written. Exit 0.
    NoOp,
    /// Diff emitted, all three outputs written. Exit 0.
    Ok,
    /// Parse/encoding error: diff.json written with `error`, svg/state
    /// untouched. Exit 2.
    ParseError,
}

pub struct TurnResult {
    pub outcome: TurnOutcome,
    /// diff.json content to print on stdout (`--print-if-changed`).
    pub print: Option<String>,
}

enum Prev {
    None,
    Loaded(state::State),
    Corrupt {
        path: PathBuf,
        warning: &'static str,
    },
}

pub fn run_render(job: &RenderJob) -> anyhow::Result<TurnResult> {
    check_path_collisions(job)?;

    let bytes = std::fs::read(&job.input)
        .with_context(|| format!("cannot read {}", job.input.display()))?;
    let source_hash = state::hex_sha256(&bytes);

    let prev = match &job.prev {
        PrevSource::Explicit(p) if !p.exists() => {
            anyhow::bail!("--prev {} does not exist", p.display())
        }
        src if !src.path().exists() => Prev::None,
        src => match state::State::load(src.path())? {
            state::Loaded::Ok(s) => Prev::Loaded(s),
            state::Loaded::Corrupt(warning) => Prev::Corrupt {
                path: src.path().to_path_buf(),
                warning,
            },
        },
    };

    // No-op re-render contract: same input as the committed state -> write
    // nothing. Exception: if the last emitted turn was an error, this run
    // is the recovery and must replace the stale error message.
    if let Prev::Loaded(s) = &prev {
        if s.source_sha256 == source_hash && !last_turn_was_error(&job.out_diff) {
            return Ok(TurnResult {
                outcome: TurnOutcome::NoOp,
                print: None,
            });
        }
    }

    let warnings: Vec<String> = match &prev {
        Prev::Corrupt { warning, .. } => vec![(*warning).to_string()],
        _ => Vec::new(),
    };
    let by = job.by.as_str();
    let note = job.note.as_deref();

    let source = match std::str::from_utf8(&bytes) {
        Ok(s) => s,
        Err(e) => {
            let err = render::encoding_error(&bytes, e);
            return emit_turn_error(job, emit::DiffReport::turn_error(by, note, &err, warnings));
        }
    };

    let rendered = match render::render_turn(source) {
        Ok(r) => r,
        Err(err) => {
            return emit_turn_error(job, emit::DiffReport::turn_error(by, note, &err, warnings));
        }
    };

    let current = model::GraphModel::from_rendered(&rendered);
    let new_state = state::State::from_model(&source_hash, &current);

    let report = match &prev {
        Prev::Loaded(p) => {
            let d = diff::diff(&p.to_model(), &current);
            emit::DiffReport::from_diff(by, note, d, &current, warnings)
        }
        _ => emit::DiffReport::baseline(by, note, &current, warnings),
    };

    // Commit order: svg -> diff -> state. state.json is the commit point: if
    // we die earlier, the next run still diffs against the old state.
    let diff_json = report.to_json()?;
    let state_json = new_state.to_json()?;
    emit::write_atomic(&job.out_svg, rendered.svg.as_bytes())?;
    emit::write_atomic(&job.out_diff, diff_json.as_bytes())?;

    // Back up a corrupt state only once svg/diff are written (exit 2 never
    // touches state; a failed svg/diff write leaves the original in place).
    // Must precede the state write, which may target the same path.
    if let Prev::Corrupt { path, .. } = &prev {
        let mut backup = path.as_os_str().to_owned();
        backup.push(".corrupt");
        std::fs::rename(path, PathBuf::from(&backup))
            .with_context(|| format!("cannot back up corrupt state {}", path.display()))?;
    }

    emit::write_atomic(&job.out_state, state_json.as_bytes())?;

    Ok(TurnResult {
        outcome: TurnOutcome::Ok,
        print: (job.print_if_changed && report.is_printable()).then_some(diff_json),
    })
}

fn emit_turn_error(job: &RenderJob, report: emit::DiffReport) -> anyhow::Result<TurnResult> {
    let diff_json = report.to_json()?;
    emit::write_atomic(&job.out_diff, diff_json.as_bytes())?;
    Ok(TurnResult {
        outcome: TurnOutcome::ParseError,
        print: (job.print_if_changed && report.is_printable()).then_some(diff_json),
    })
}

/// Best effort: does the diff.json on disk carry a non-null `error`?
fn last_turn_was_error(diff_path: &Path) -> bool {
    std::fs::read(diff_path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("error").map(|e| !e.is_null()))
        .unwrap_or(false)
}

/// Outputs must not overwrite the input or each other, and `--prev` must not
/// point at the input or a non-state output (a corrupt-looking "state" would
/// otherwise be renamed away).
fn check_path_collisions(job: &RenderJob) -> anyhow::Result<()> {
    let input = normalize(&job.input);
    let outs = [
        ("--out", normalize(&job.out_svg)),
        ("--diff-out", normalize(&job.out_diff)),
        ("--state-out", normalize(&job.out_state)),
    ];
    for (i, (name, p)) in outs.iter().enumerate() {
        anyhow::ensure!(
            *p != input,
            "{name} {} would overwrite the input file",
            p.display()
        );
        for (other, q) in &outs[i + 1..] {
            anyhow::ensure!(
                p != q,
                "{name} and {other} point to the same file {}",
                p.display()
            );
        }
    }
    let prev = normalize(job.prev.path());
    anyhow::ensure!(prev != input, "--prev points to the input file");
    anyhow::ensure!(
        prev != outs[0].1 && prev != outs[1].1,
        "--prev points to an svg/diff output"
    );
    Ok(())
}

/// Absolute path with symlinks resolved as far as the filesystem allows
/// (the file itself may not exist yet).
fn normalize(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    if let Ok(c) = abs.canonicalize() {
        return c;
    }
    match (abs.parent(), abs.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map(|c| c.join(name))
            .unwrap_or_else(|_| abs.clone()),
        _ => abs,
    }
}

/// `<stem>.<ext>` next to the input file.
pub fn sibling(input: &Path, ext: &str) -> PathBuf {
    input.with_extension(ext)
}
