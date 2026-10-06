//! Read-only checks for a usable mmx installation and project.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::{init, lint, render, serve, sibling, turnlog};

fn line(status: &str, message: &str, fix: Option<&str>) {
    // Agents often pipe this into `head`; a closed pipe is not an error.
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{status} {message}");
    if let Some(fix) = fix {
        let _ = writeln!(out, "  fix: {fix}");
    }
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn skill(path: &Path, name: &str, fix: &str) -> bool {
    // The skill is SKILL.md plus its diff-schema reference; both must match
    // the copies embedded in this binary.
    let schema_ok = path
        .parent()
        .map(|dir| dir.join("references").join("diff-schema.md"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|t| t == init::diff_schema());
    match std::fs::read_to_string(path) {
        Ok(text) if text == init::skill() && !schema_ok => {
            line(
                "FAIL",
                &format!("{name} skill reference diff-schema.md is missing or stale"),
                Some(fix),
            );
            false
        }
        Ok(text) if text == init::skill() => {
            line("ok", &format!("{name} skill matches installed mmx"), None);
            true
        }
        Ok(_) => {
            line("FAIL", &format!("{name} skill is stale"), Some(fix));
            false
        }
        Err(_) => {
            line("FAIL", &format!("{name} skill is missing"), Some(fix));
            false
        }
    }
}

fn commands(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(command) = map.get("command").and_then(Value::as_str) {
                if command.contains("mmx_hook.py") {
                    out.push(command.to_owned());
                }
            }
            for child in map.values() {
                commands(child, out);
            }
        }
        Value::Array(items) => {
            for child in items {
                commands(child, out);
            }
        }
        _ => {}
    }
}

// The generated commands use shell quotes; retain spaces inside them.
fn words(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut quote_char = None;
    let mut escaped = false;
    for ch in command.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
        } else if ch == '\\' && quote_char != Some('\'') {
            escaped = true;
        } else if Some(ch) == quote_char {
            quote_char = None;
        } else if quote_char.is_none() && (ch == '\'' || ch == '"') {
            quote_char = Some(ch);
        } else if quote_char.is_none() && ch.is_whitespace() {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        } else {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

fn hook_commands(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| {
            let mut found = Vec::new();
            commands(&v, &mut found);
            found
        })
        .unwrap_or_default()
}

fn python_fix() -> &'static str {
    // Package managers and privileges differ per machine; point at the
    // requirement rather than prescribing a privileged install command.
    "install Python 3 with your system's package manager so `python3` is on PATH (needed only for hooks)"
}

pub fn run(diagram: Option<&Path>) -> bool {
    let mut good = true;
    if cfg!(windows) {
        line(
            "warn",
            "fresh login shell PATH check unavailable on Windows",
            Some("where mmx"),
        );
    } else {
        // A fresh login shell: no inherited environment except HOME/USER, so a
        // session-only `export PATH=...` does not count (hooks and new agent
        // sessions start from the profile, not from this shell).
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_owned());
        let fresh = |script: &str| {
            let mut cmd = Command::new(&shell);
            cmd.env_clear().args(["-lc", script]);
            for key in ["HOME", "USER", "LOGNAME", "SHELL"] {
                if let Some(v) = std::env::var_os(key) {
                    cmd.env(key, v);
                }
            }
            cmd.output()
        };
        let here = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.display().to_string()))
            .unwrap_or_else(|| "<dir of mmx>".to_owned());
        let path_fix = format!(
            "add {here} to PATH in your shell profile (e.g. echo 'export PATH=\"{here}:$PATH\"' >> ~/.profile), then open a new shell"
        );
        let found = fresh("command -v mmx");
        let on_current_path = Command::new("sh")
            .args(["-c", "command -v mmx"])
            .output()
            .is_ok_and(|o| o.status.success());
        if !found.as_ref().is_ok_and(|o| o.status.success()) {
            if on_current_path {
                // Found here but not from the login profile: fine for this
                // session, fragile for hooks and new sessions.
                line(
                    "warn",
                    "mmx is on this shell's PATH but not on a fresh login shell's",
                    Some(&path_fix),
                );
            } else {
                line("FAIL", "mmx is missing from PATH", Some(&path_fix));
                good = false;
            }
        } else {
            let version = fresh("mmx --version");
            let expected = format!("mmx {}", env!("CARGO_PKG_VERSION"));
            if version.as_ref().is_ok_and(|o| {
                o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == expected
            }) {
                line(
                    "ok",
                    "mmx on fresh shell PATH has the running version",
                    None,
                );
            } else {
                let other = found
                    .as_ref()
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
                    .unwrap_or_default();
                line(
                    "FAIL",
                    &format!("mmx on fresh shell PATH ({other}) is a different version"),
                    Some(&format!(
                        "remove or upgrade {other}, or put {here} first on PATH"
                    )),
                );
                good = false;
            }
        }
    }

    let claude = hook_commands(Path::new(".claude/settings.json"));
    let codex = hook_commands(Path::new(".codex/hooks.json"));
    if let Some(home) = home() {
        good &= skill(
            &home.join(".claude/skills/mmx/SKILL.md"),
            "Claude Code",
            "mmx init",
        );
        let codex_skill = home.join(".codex/skills/mmx/SKILL.md");
        let codex_hooks_reference_runner = !codex.is_empty();
        if codex_hooks_reference_runner || home.join(".codex").exists() {
            // Project hooks make the Codex skill mandatory even when the
            // user's ~/.codex directory has been removed.
            if codex_hooks_reference_runner || codex_skill.exists() {
                good &= skill(&codex_skill, "Codex", "mmx init --codex");
            } else {
                line(
                    "warn",
                    "Codex skill not installed — run `mmx init --codex` if you use Codex",
                    None,
                );
            }
        }
    } else {
        line(
            "FAIL",
            "home directory is unknown",
            Some("export HOME=\"$(cd ~ && pwd)\""),
        );
        good = false;
    }

    let configured = !claude.is_empty() || !codex.is_empty();
    let configured_diagram = claude
        .iter()
        .chain(codex.iter())
        .find_map(|command| {
            let args = words(command);
            args.iter()
                .position(|arg| arg == "--diagram")
                .and_then(|index| args.get(index + 1).cloned())
        })
        .unwrap_or_else(|| "diagram.mmd".to_owned());
    let init_command = format!(
        "mmx init {}--hooks {}",
        if codex.is_empty() { "" } else { "--codex " },
        quote(&configured_diagram)
    );
    if configured {
        let project = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        // One verdict per harness and runner path (each harness has a post
        // and a prompt command pointing at the same runner).
        let mut seen = std::collections::BTreeSet::new();
        for (name, command) in claude
            .iter()
            .map(|c| ("Claude Code", c))
            .chain(codex.iter().map(|c| ("Codex", c)))
        {
            let args = words(command);
            let Some(raw) = args.iter().find(|arg| arg.ends_with("mmx_hook.py")) else {
                line(
                    "FAIL",
                    &format!("{name} hook command has no mmx_hook.py script path"),
                    Some(&init_command),
                );
                good = false;
                continue;
            };
            let dir = project.to_string_lossy();
            let raw = raw
                .replace("${CLAUDE_PROJECT_DIR}", &dir)
                .replace("$CLAUDE_PROJECT_DIR", &dir);
            if !seen.insert((name, raw.clone())) {
                continue;
            }
            let script = PathBuf::from(raw);
            let inside = script
                .canonicalize()
                .ok()
                .is_some_and(|p| p.starts_with(&project));
            match std::fs::read_to_string(&script) {
                Ok(text) if text == init::hook() && (name == "Claude Code" || inside) => line(
                    "ok",
                    &format!("{name} hook script matches installed mmx"),
                    None,
                ),
                Ok(_) => {
                    line(
                        "FAIL",
                        &format!("{name} hook script is stale or outside the current project"),
                        Some(&init_command),
                    );
                    good = false;
                }
                Err(_) => {
                    line(
                        "FAIL",
                        &format!("{name} hook script is missing or outside the current project"),
                        Some(&init_command),
                    );
                    good = false;
                }
            }
        }
    }
    let python = Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if python {
        line("ok", "python3 is on PATH", None);
    } else if configured {
        line("FAIL", "python3 is missing from PATH", Some(python_fix()));
        good = false;
    } else {
        line(
            "warn",
            "python3 is missing from PATH (needed for hooks)",
            Some(python_fix()),
        );
    }
    for (name, list) in [("Claude Code", claude), ("Codex", codex)] {
        for command in list {
            let args = words(&command);
            if let Some(index) = args.iter().position(|a| a == "--diagram") {
                if let Some(path) = args.get(index + 1) {
                    let path = Path::new(path);
                    if path.exists() {
                        line(
                            "ok",
                            &format!("{name} hook diagram {} exists", path.display()),
                            None,
                        );
                    } else {
                        let parent = path
                            .parent()
                            .filter(|p| !p.as_os_str().is_empty())
                            .unwrap_or(Path::new("."));
                        let fix = format!(
                            "mkdir -p {} && printf 'flowchart TD\\n    A --> B\\n' > {}",
                            quote(&parent.to_string_lossy()),
                            quote(&path.to_string_lossy())
                        );
                        line(
                            "FAIL",
                            &format!("{name} hook diagram {} is missing", path.display()),
                            Some(&fix),
                        );
                        good = false;
                    }
                }
            }
        }
    }

    if let Some(path) = diagram {
        if !path.is_file() {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let fix = format!(
                "mkdir -p {} && printf 'flowchart TD\\n    A --> B\\n' > {}",
                quote(&parent.to_string_lossy()),
                quote(&path.to_string_lossy())
            );
            line(
                "FAIL",
                &format!("diagram {} is missing", path.display()),
                Some(&fix),
            );
            return false;
        }
        line("ok", &format!("diagram {} exists", path.display()), None);
        match std::fs::read_to_string(path) {
            Ok(source) => {
                match lint::check(&source).and_then(|_| render::render_turn(&source).map(|_| ())) {
                    Ok(()) => line("ok", "diagram renders", None),
                    Err(err) => {
                        line(
                            "FAIL",
                            &format!("diagram parse error: {}", err.message),
                            Some(&format!(
                                "${{EDITOR:-vi}} {}",
                                quote(&path.to_string_lossy())
                            )),
                        );
                        good = false;
                    }
                }
            }
            Err(_) => {
                line(
                    "FAIL",
                    "diagram cannot be read as UTF-8",
                    Some(&format!(
                        "${{EDITOR:-vi}} {}",
                        quote(&path.to_string_lossy())
                    )),
                );
                good = false;
            }
        }
        if serve::is_live(path) {
            line("ok", "mmx serve is attached", None);
        } else {
            line("ok", "mmx serve is not attached", None);
        }
        let log = sibling(path, "turns.jsonl");
        if log.exists() {
            line("ok", "turn log exists", None);
            if turnlog::pending_human(&turnlog::read_entries(&log)).is_empty() {
                line("ok", "no unanswered human turns", None);
            } else {
                line(
                    "warn",
                    "human is waiting",
                    Some(&format!("mmx wait {}", quote(&path.to_string_lossy()))),
                );
            }
        } else {
            line("ok", "no turn log yet", None);
        }
    }
    good
}
