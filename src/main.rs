use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};

use mmx::{default_job, run_render, sibling, PrevSource, RenderJob, TurnOutcome};

#[derive(Parser)]
#[command(
    name = "mmx",
    version,
    about = "Conversational diagram protocol over mermaid"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Install Claude Code skill and optionally Codex skill and project hooks
    Init {
        /// Also install Claude Code hooks in the current directory,
        /// wired to this diagram path
        #[arg(long, value_name = "DIAGRAM.mmd")]
        hooks: Option<PathBuf>,
        /// Also install the Codex skill and, with --hooks, Codex project hooks
        #[arg(long)]
        codex: bool,
    },
    /// Diagnose installation, project hooks, and an optional diagram
    Doctor {
        /// Diagram to validate without writing any project files
        diagram: Option<PathBuf>,
    },
    /// Render a diagram and emit diff.json / state.json for the turn
    Render {
        /// Input diagram file (.mmd)
        input: PathBuf,
        /// Who made the change; recorded verbatim in diff.json
        #[arg(long, default_value = "unknown")]
        by: String,
        /// Free-text note; recorded verbatim in diff.json
        #[arg(long)]
        note: Option<String>,
        /// Previous state to diff against; must exist if given
        /// (default: the --state-out path, baseline if absent)
        #[arg(long)]
        prev: Option<PathBuf>,
        /// SVG output path (default: <stem>.svg)
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// diff.json output path (default: <stem>.diff.json)
        #[arg(long)]
        diff_out: Option<PathBuf>,
        /// state.json output path (default: <stem>.state.json)
        #[arg(long)]
        state_out: Option<PathBuf>,
        /// Diagram text format (v0: only "mermaid")
        #[arg(long, default_value = "mermaid")]
        format: String,
        /// Print diff.json to stdout if this run wrote a non-baseline turn
        #[arg(long)]
        print_if_changed: bool,
        /// Try N reorderings of the node declaration lines and keep the one
        /// with the fewest edge crossings before rendering (max 500; 0 = off)
        #[arg(long, value_name = "N", default_value_t = 0)]
        layout_search: usize,
    },
    /// Make a turn that carries a message (any unrendered edits included)
    Note {
        /// Input diagram file (.mmd)
        input: PathBuf,
        /// The message
        text: String,
        /// Who is speaking
        #[arg(long, default_value = "agent")]
        by: String,
    },
    /// Block until the human has spoken last; print their turns' diffs as
    /// JSON lines (exit 0), or exit 3 on timeout
    Wait {
        /// Input diagram file (.mmd)
        input: PathBuf,
        /// Seconds to wait; 0 checks once and returns
        #[arg(long, default_value_t = 300)]
        timeout: u64,
    },
    /// Open a local browser cockpit for a diagram
    Serve {
        /// Input diagram file (.mmd)
        input: PathBuf,
        /// Listen address (default: 127.0.0.1:0)
        #[arg(long, default_value = "127.0.0.1:0")]
        addr: String,
        /// Permit listening on a non-loopback address
        #[arg(long)]
        allow_external: bool,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            input,
            addr,
            allow_external,
        } => match mmx::serve::run(input, &addr, allow_external) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("mmx serve: {e:#}");
                ExitCode::from(1)
            }
        },
        Command::Init { hooks, codex } => match mmx::init::run_init(hooks, codex) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("mmx init: {e:#}");
                ExitCode::from(1)
            }
        },
        Command::Doctor { diagram } => {
            if mmx::doctor::run(diagram.as_deref()) {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Command::Render {
            input,
            by,
            note,
            prev,
            out,
            diff_out,
            state_out,
            format,
            print_if_changed,
            layout_search,
        } => {
            if format != "mermaid" {
                eprintln!("mmx v0 supports only --format mermaid (got {format:?})");
                return ExitCode::from(1);
            }

            let out_state = state_out.unwrap_or_else(|| sibling(&input, "state.json"));
            let log = sibling(&input, "turns.jsonl");
            // A non-empty note is a message, so it always makes a turn: when a
            // hook or `mmx serve` already rendered these bytes, the note
            // arrives as a note-only turn instead of being dropped. Repeating
            // the very same note on unchanged bytes stays a no-op.
            let force_turn = note.as_deref().is_some_and(|n| !n.trim().is_empty())
                && !mmx::turnlog::repeats_last(&log, &input, &by, note.as_deref());
            let job = RenderJob {
                by,
                note,
                prev: match prev {
                    Some(p) => PrevSource::Explicit(p),
                    None => PrevSource::Default(out_state.clone()),
                },
                out_svg: out.unwrap_or_else(|| sibling(&input, "svg")),
                out_diff: diff_out.unwrap_or_else(|| sibling(&input, "diff.json")),
                out_state,
                print_if_changed,
                force_turn,
                log: Some(log),
                input,
            };
            if let Err(e) = mmx::validate_job(&job) {
                eprintln!("mmx: {e:#}");
                return ExitCode::from(1);
            }
            let original = match search_layout(&job.input, layout_search) {
                Ok(original) => original,
                Err(code) => return code,
            };
            let result = run_render(&job);
            if let (Err(e), Some(original)) = (&result, &original) {
                if e.downcast_ref::<mmx::RendererFailed>().is_some() {
                    if let Err(e) = mmx::emit::write_atomic(&job.input, original) {
                        eprintln!("mmx: {e:#}");
                    }
                }
            }
            finish_render(&job, result)
        }
        Command::Note { input, text, by } => {
            let log = sibling(&input, "turns.jsonl");
            if mmx::turnlog::repeats_last(&log, &input, &by, Some(&text)) {
                return ExitCode::SUCCESS;
            }
            let mut job = default_job(&input, &by, Some(text));
            job.force_turn = true;
            let result = run_render(&job);
            finish_render(&job, result)
        }
        Command::Wait { input, timeout } => {
            let diffs = mmx::turnlog::run_wait(&input, Duration::from_secs(timeout));
            if diffs.is_empty() {
                return ExitCode::from(3);
            }
            let mut stdout = std::io::stdout().lock();
            for diff in diffs {
                let line = diff.to_string() + "\n";
                if stdout.write_all(line.as_bytes()).is_err() {
                    return ExitCode::from(1);
                }
            }
            match stdout.flush() {
                Ok(()) => ExitCode::SUCCESS,
                Err(_) => ExitCode::from(1),
            }
        }
    }
}

/// `--layout-search`: rewrite the input with the least-crossing declaration
/// order before the turn renders it, returning the original bytes when it
/// did. A parse error is left to the render (exit 2 with the usual
/// diff.json); a renderer failure is exit 1 here. N = 0 does nothing.
fn search_layout(input: &Path, variants: usize) -> Result<Option<Vec<u8>>, ExitCode> {
    use mmx::layout_search::Search;
    if variants == 0 {
        return Ok(None);
    }
    let bytes = std::fs::read(input).map_err(|e| {
        eprintln!("mmx: cannot read {}: {e}", input.display());
        ExitCode::from(1)
    })?;
    let Ok(source) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    match mmx::layout_search::search(source, variants) {
        Ok(Search::Skipped(reason)) => eprintln!("layout: search skipped ({reason})"),
        Ok(Search::Done {
            before,
            after,
            searched,
            edges,
            source,
        }) => {
            let scope = if edges {
                "node and edge order"
            } else {
                "node order only: linkStyle/~~~ present"
            };
            eprintln!("layout: crossings {before} -> {after} (searched {searched}, {scope})");
            if let Some(source) = source {
                mmx::emit::write_atomic(input, source.as_bytes()).map_err(|e| {
                    eprintln!("mmx: {e:#}");
                    ExitCode::from(1)
                })?;
                return Ok(Some(bytes));
            }
        }
        Err(err) if err.kind == mmx::render::RENDERER_FAILED => {
            eprintln!(
                "mmx: renderer failed on this input; the file was not changed ({})",
                err.message
            );
            return Err(ExitCode::from(1));
        }
        Err(_) => {}
    }
    Ok(None)
}

/// Run a turn and map its outcome to the render exit codes.
fn finish_render(job: &RenderJob, result: anyhow::Result<mmx::TurnResult>) -> ExitCode {
    match result {
        Ok(result) => {
            if let Some(text) = &result.print {
                let mut stdout = std::io::stdout().lock();
                if stdout
                    .write_all(text.as_bytes())
                    .and_then(|_| stdout.flush())
                    .is_err()
                {
                    return ExitCode::from(1);
                }
            }
            match result.outcome {
                TurnOutcome::Ok | TurnOutcome::NoOp => ExitCode::SUCCESS,
                TurnOutcome::ParseError => {
                    eprintln!(
                        "parse error: see {} (exit 2 = fixable by editing the diagram)",
                        job.out_diff.display()
                    );
                    ExitCode::from(2)
                }
            }
        }
        Err(e) if e.downcast_ref::<mmx::RendererFailed>().is_some() => {
            eprintln!("mmx: renderer failed on this input; the file was not changed ({e:#})");
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("mmx: {e:#}");
            ExitCode::from(1)
        }
    }
}
