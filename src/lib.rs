//! mmx core: parse, diff, state, emit. No harness names in here.

pub mod diff;
pub mod doctor;
pub mod emit;
pub mod init;
pub mod layout_search;
pub mod lint;
pub mod model;
pub mod render;
pub mod serve;
pub mod source_diff;
pub mod state;
pub mod turnlog;

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
    /// Emit a full turn even when the source is unchanged (a zero-change
    /// diff). Serve uses this for note-only turns; the CLI leaves it false,
    /// keeping the no-op contract.
    pub force_turn: bool,
    /// Turn log (`<stem>.turns.jsonl`) to append each committed turn to
    /// (see [`turnlog`]). `None` disables logging.
    pub log: Option<PathBuf>,
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
    /// The line appended to the turn log for this turn (without newline),
    /// if one was written. Lets `mmx serve` recognise its own entries.
    pub logged: Option<String>,
}

enum Prev {
    None,
    Loaded(state::State),
    Corrupt {
        path: PathBuf,
        warning: &'static str,
    },
}

/// A panic inside the renderer. Not a turn: nothing is written, and the
/// caller reports it as exit 1 / an HTTP 500 rather than as diff.json.
#[derive(Debug)]
pub struct RendererFailed(pub String);

impl std::fmt::Display for RendererFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "renderer failed on this input ({})", self.0)
    }
}

impl std::error::Error for RendererFailed {}

/// The argument checks `run_render` makes before touching any file, for a
/// caller that wants to edit the input first (`--layout-search`).
pub fn validate_job(job: &RenderJob) -> anyhow::Result<()> {
    check_path_collisions(job)?;
    if let PrevSource::Explicit(p) = &job.prev {
        anyhow::ensure!(p.exists(), "--prev {} does not exist", p.display());
    }
    Ok(())
}

pub fn run_render(job: &RenderJob) -> anyhow::Result<TurnResult> {
    let bytes = std::fs::read(&job.input)
        .with_context(|| format!("cannot read {}", job.input.display()))?;
    run_render_bytes(job, &bytes)
}

pub fn run_render_bytes(job: &RenderJob, bytes: &[u8]) -> anyhow::Result<TurnResult> {
    check_path_collisions(job)?;
    let source_hash = state::hex_sha256(bytes);

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
        if !job.force_turn && s.source_sha256 == source_hash && !last_turn_was_error(&job.out_diff)
        {
            return Ok(TurnResult {
                outcome: TurnOutcome::NoOp,
                print: None,
                logged: None,
            });
        }
    }

    let warnings: Vec<String> = match &prev {
        Prev::Corrupt { warning, .. } => vec![(*warning).to_string()],
        _ => Vec::new(),
    };
    let by = job.by.as_str();
    let note = job.note.as_deref();

    let source = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            let err = render::encoding_error(bytes, e);
            return emit_turn_error(
                job,
                &source_hash,
                emit::DiffReport::turn_error(
                    by,
                    note,
                    &err,
                    warnings,
                    !matches!(&prev, Prev::Loaded(_)),
                ),
            );
        }
    };

    if let Err(err) = lint::check(source) {
        let mut report = emit::DiffReport::turn_error(
            by,
            note,
            &err,
            warnings,
            !matches!(&prev, Prev::Loaded(_)),
        );
        report.set_source_hunks(previous_source(&prev), source);
        return emit_turn_error(job, &source_hash, report);
    }
    let rendered = match render::render_turn(source) {
        Ok(r) => r,
        Err(err) if err.kind == render::RENDERER_FAILED => {
            return Err(RendererFailed(err.message).into());
        }
        Err(err) => {
            let mut report = emit::DiffReport::turn_error(
                by,
                note,
                &err,
                warnings,
                !matches!(&prev, Prev::Loaded(_)),
            );
            report.set_source_hunks(previous_source(&prev), source);
            return emit_turn_error(job, &source_hash, report);
        }
    };

    let current = model::GraphModel::from_rendered(&rendered);
    let new_state = state::State::from_model(&source_hash, source, &current);

    let mut warnings = warnings;
    lint::warnings(&current, !matches!(prev, Prev::Loaded(_)), &mut warnings);
    let report = match &prev {
        Prev::Loaded(p) => {
            let old_model = p.to_model();
            let d = diff::diff_with_subgraphs(&old_model, &current, p.subgraphs.is_some());
            let mut report =
                emit::DiffReport::from_diff(by, note, d, &old_model, &current, warnings);
            report.set_source_hunks(p.source.as_deref(), source);
            // A forced turn over identical bytes (note-only) must not claim a
            // text change the agent would then hunt for in the blind spots.
            report.source_changed = p.source_sha256 != source_hash;
            report
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
    let logged = log_turn(job, &source_hash, &diff_json);

    Ok(TurnResult {
        outcome: TurnOutcome::Ok,
        print: (job.print_if_changed && report.is_printable()).then_some(diff_json),
        logged,
    })
}

fn previous_source(prev: &Prev) -> Option<&str> {
    match prev {
        Prev::Loaded(s) => s.source.as_deref(),
        _ => None,
    }
}

fn emit_turn_error(
    job: &RenderJob,
    source_hash: &str,
    report: emit::DiffReport,
) -> anyhow::Result<TurnResult> {
    let diff_json = report.to_json()?;
    emit::write_atomic(&job.out_diff, diff_json.as_bytes())?;
    let logged = log_turn(job, source_hash, &diff_json);
    Ok(TurnResult {
        outcome: TurnOutcome::ParseError,
        print: (job.print_if_changed && report.is_printable()).then_some(diff_json),
        logged,
    })
}

/// Append the committed turn to the turn log. Best effort: the turn is
/// already committed, so a log failure only warns on stderr.
fn log_turn(job: &RenderJob, source_hash: &str, diff_json: &str) -> Option<String> {
    let log = job.log.as_ref()?;
    let result = turnlog::entry_line(&job.by, job.note.as_deref(), source_hash, diff_json)
        .and_then(|line| turnlog::append(log, &line).map(|()| line));
    match result {
        Ok(line) => Some(line),
        Err(e) => {
            eprintln!(
                "mmx: warning: cannot append turn log {}: {e:#}",
                log.display()
            );
            None
        }
    }
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

/// A turn job with every output at its default sibling path (`<stem>.svg`,
/// `.diff.json`, `.state.json`) and the turn log at `<stem>.turns.jsonl`.
pub fn default_job(input: &Path, by: &str, note: Option<String>) -> RenderJob {
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
        force_turn: false,
        log: Some(sibling(input, "turns.jsonl")),
    }
}

/// `<stem>.<ext>` next to the input file.
pub fn sibling(input: &Path, ext: &str) -> PathBuf {
    input.with_extension(ext)
}
