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
const CLAUDE_SETTINGS: &str = include_str!("../adapters/claude/settings.json");

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

pub fn run_init(hooks_diagram: Option<PathBuf>) -> anyhow::Result<()> {
    // 1) Agent skill, machine-wide. Overwrites an older copy on purpose:
    //    the skill should match the installed binary's contracts.
    let skill_dir = home_dir()?.join(".claude").join("skills").join("mmx");
    println!("Installing the mmx agent skill (machine-wide):");
    write(&skill_dir.join("SKILL.md"), SKILL_MD)?;
    write(
        &skill_dir.join("references").join("diff-schema.md"),
        DIFF_SCHEMA_MD,
    )?;

    // 2) Optional per-project Claude Code hooks.
    match hooks_diagram {
        Some(diagram) => {
            let diagram = diagram.to_string_lossy().into_owned();
            println!("Installing Claude Code hooks in the current directory:");
            write(Path::new("adapters/mmx_hook.py"), HOOK_PY)?;
            let settings = CLAUDE_SETTINGS.replace("diagram.mmd", &diagram);
            let target = Path::new(".claude/settings.json");
            if target.exists() {
                let side = Path::new(".claude/settings.mmx.json");
                write(side, &settings)?;
                println!(
                    "  NOTE: .claude/settings.json already exists — not touching it.\n\
                     \x20       Merge the \"hooks\" section from {} into it by hand.",
                    side.display()
                );
            } else {
                write(target, &settings)?;
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
