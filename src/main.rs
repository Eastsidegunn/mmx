use std::io::Write;
use std::path::PathBuf;
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
            finish_render(&job)
        }
        Command::Note { input, text, by } => {
            let log = sibling(&input, "turns.jsonl");
            if mmx::turnlog::repeats_last(&log, &input, &by, Some(&text)) {
                return ExitCode::SUCCESS;
            }
            let mut job = default_job(&input, &by, Some(text));
            job.force_turn = true;
            finish_render(&job)
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

/// Run a turn and map its outcome to the render exit codes.
fn finish_render(job: &RenderJob) -> ExitCode {
    match run_render(job) {
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
        Err(e) => {
            eprintln!("mmx: {e:#}");
            ExitCode::from(1)
        }
    }
}
