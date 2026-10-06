//! `mmx init`: finish the setup that `cargo install` cannot do.
//!
//! The skill, hook runner and hook settings are embedded in the binary at
//! compile time, so one command after any install path (cargo, installer
//! script, prebuilt archive) puts them where harnesses look for them.

use std::path::{Path, PathBuf};

use anyhow::Context;

const SKILL_MD: &str = include_str!("../skills/mmx/SKILL.md");
const DIFF_SCHEMA_MD: &str = include_str!("../skills/mmx/references/diff-schema.md");
const HOOK_PY: &str = include_str!("../adapters/mmx_hook.py");
/// Where `--hooks` puts the hook runner inside a project: one hidden
/// directory owned by mmx, rather than a top-level `adapters/` the user did
/// not ask for. (The script resolves the project as its parent's parent.)
pub const HOOK_REL: &str = ".mmx/mmx_hook.py";
const CLAUDE_SETTINGS: &str = include_str!("../adapters/claude/settings.json");
const CODEX_HOOKS: &str = include_str!("../adapters/codex/hooks.json");

fn home_dir() -> anyhow::Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("cannot locate the home directory (HOME/USERPROFILE unset)")
}

fn write(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("cannot create {}", parent.display()))?;
    }
    std::fs::write(path, content).with_context(|| format!("cannot write {}", path.display()))?;
    println!("  wrote {}", path.display());
    Ok(())
}

pub fn run_init(hooks_diagram: Option<PathBuf>, codex: bool) -> anyhow::Result<()> {
    // 1) Agent skill, machine-wide. Overwrites an older copy on purpose:
    //    the skill should match the installed binary's contracts.
    let skill_dir = home_dir()?.join(".claude").join("skills").join("mmx");
    println!("Installing the mmx agent skill (machine-wide):");
    write(&skill_dir.join("SKILL.md"), SKILL_MD)?;
    write(
        &skill_dir.join("references").join("diff-schema.md"),
        DIFF_SCHEMA_MD,
    )?;

    if codex {
        let skill_dir = home_dir()?.join(".codex").join("skills").join("mmx");
        println!("Installing the mmx Codex skill (machine-wide):");
        write(&skill_dir.join("SKILL.md"), SKILL_MD)?;
        write(
            &skill_dir.join("references").join("diff-schema.md"),
            DIFF_SCHEMA_MD,
        )?;
    }

    // 2) Optional per-project Claude Code hooks.
    match hooks_diagram {
        Some(diagram) => {
            let diagram = diagram.to_string_lossy().into_owned();
            println!("Installing Claude Code hooks in the current directory:");
            if cfg!(windows) {
                println!(
                    "  NOTE: hook commands use POSIX shell syntax; on Windows run the\n\
                     \x20       agent from WSL or Git Bash, or skip --hooks (the CLI works without them)."
                );
            }
            write(Path::new(HOOK_REL), HOOK_PY)?;
            // Built as JSON with a shell-quoted diagram path: a plain text
            // substitution broke on spaces (the hook then rejected its own
            // arguments and blocked every prompt) and on Windows backslashes.
            let settings = fill_hook_commands(
                CLAUDE_SETTINGS,
                &format!("\"$CLAUDE_PROJECT_DIR\"/{HOOK_REL}"),
                "\"$CLAUDE_PROJECT_DIR\"/adapters/mmx_hook.py",
                &diagram,
            )?;
            install_config(
                Path::new(".claude/settings.json"),
                Path::new(".claude/settings.mmx.json"),
                &settings,
            )?;
            if codex {
                let hook = std::env::current_dir()?.join(HOOK_REL);
                let hook = hook.canonicalize()?;
                let contents = fill_hook_commands(
                    CODEX_HOOKS,
                    &shell_quote(&hook.to_string_lossy()),
                    "adapters/mmx_hook.py",
                    &diagram,
                )?;
                println!("Installing Codex hooks in the current directory:");
                install_config(
                    Path::new(".codex/hooks.json"),
                    Path::new(".codex/hooks.mmx.json"),
                    &contents,
                )?;
                println!(
                    "  In Codex, run /hooks and trust this project's hooks, then start a\n\
                     \x20 new Codex session (hooks load at session start)."
                );
            }
            println!(
                "\nDone. Restart the Claude Code session in this project — hooks load at\n\
                 session start. From then on every .mmd edit renders automatically and\n\
                 human edits are injected as diffs at the start of each turn."
            );
        }
        None => {
            println!(
                "\nDone. New agent sessions on this machine now pick up the mmx skill.\n\
                 To also wire automatic rendering into a project, run this inside it:\n\
                 \x20   mmx init --hooks <path/to/diagram.mmd>"
            );
        }
    }
    Ok(())
}

/// Write a hook config without clobbering anyone else's: identical content is
/// left alone, a file mmx wrote earlier (only mmx hook commands in it) is
/// replaced, and anything else gets a sidecar plus a merge instruction.
fn install_config(target: &Path, side: &Path, contents: &str) -> anyhow::Result<()> {
    match std::fs::read_to_string(target) {
        Ok(existing) if existing == contents => {
            println!("  unchanged {}", target.display());
            Ok(())
        }
        Ok(existing) if only_mmx_hooks(&existing) => write(target, contents),
        Ok(_) => {
            write(side, contents)?;
            println!(
                "  NOTE: {} has other settings — not touching it.\n\
                 \x20       Merge the \"hooks\" section from {} into it by hand.",
                target.display(),
                side.display()
            );
            Ok(())
        }
        Err(_) => write(target, contents),
    }
}

/// True for a config whose only content is hooks that run mmx_hook.py.
fn only_mmx_hooks(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(map) = value.as_object() else {
        return false;
    };
    if map.keys().any(|k| k != "hooks") {
        return false;
    }
    fn commands(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => m.iter().for_each(|(k, c)| {
                if k == "command" {
                    if let Some(t) = c.as_str() {
                        out.push(t.to_owned());
                    }
                } else {
                    commands(c, out);
                }
            }),
            serde_json::Value::Array(a) => a.iter().for_each(|c| commands(c, out)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    commands(&value["hooks"], &mut found);
    // Only commands mmx itself generates: the runner invoked with --harness.
    !found.is_empty()
        && found
            .iter()
            .all(|c| c.contains("mmx_hook.py --harness") && c.starts_with("python3 "))
}

/// The hook template with every command's script path and `diagram.mmd`
/// placeholder filled in, re-serialized as JSON.
fn fill_hook_commands(
    template: &str,
    script: &str,
    template_script: &str,
    diagram: &str,
) -> anyhow::Result<String> {
    let mut config: serde_json::Value =
        serde_json::from_str(template).context("invalid embedded hook template")?;
    // The template's description is a note for people copying it by hand.
    if let Some(map) = config.as_object_mut() {
        map.remove("description");
    }
    fn walk(v: &mut serde_json::Value, f: &dyn Fn(&str) -> String) {
        match v {
            serde_json::Value::Object(map) => {
                for (key, child) in map.iter_mut() {
                    if key == "command" {
                        if let Some(text) = child.as_str() {
                            *child = f(text).into();
                            continue;
                        }
                    }
                    walk(child, f);
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|c| walk(c, f)),
            _ => {}
        }
    }
    let quoted = shell_quote(diagram);
    walk(&mut config, &|command| {
        command
            .replace(template_script, script)
            .replace("--diagram diagram.mmd", &format!("--diagram {quoted}"))
    });
    Ok(serde_json::to_string_pretty(&config)? + "\n")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn diff_schema() -> &'static str {
    DIFF_SCHEMA_MD
}

pub(crate) fn skill() -> &'static str {
    SKILL_MD
}

pub(crate) fn hook() -> &'static str {
    HOOK_PY
}
