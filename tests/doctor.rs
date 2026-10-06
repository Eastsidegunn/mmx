use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::SystemTime;

fn fixture() -> (PathBuf, PathBuf, PathBuf) {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "doctor-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let home = root.join("home");
    let project = root.join("project");
    let bin = root.join("bin");
    for dir in [&home, &project, &bin] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let binary = env!("CARGO_BIN_EXE_mmx");
    let launcher = bin.join("mmx");
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nexec '{}' \"$@\"\n",
            binary.replace('\'', "'\\''")
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // A login profile that puts the launcher on PATH, as an installed mmx
    // would be; doctor checks PATH from a fresh login shell (SHELL=/bin/sh).
    std::fs::write(
        home.join(".profile"),
        format!("export PATH=\"{}:/usr/bin:/bin\"\n", bin.display()),
    )
    .unwrap();
    (home, project, bin)
}

fn run(home: &Path, project: &Path, bin: &Path, args: &[&str]) -> Output {
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(project)
        .env("HOME", home)
        .env("SHELL", "/bin/sh")
        .env("PATH", path)
        .args(args)
        .output()
        .unwrap()
}

fn output(o: &Output) -> String {
    String::from_utf8(o.stdout.clone()).unwrap()
}

fn setup() -> (PathBuf, PathBuf, PathBuf) {
    let (home, project, bin) = fixture();
    std::fs::write(project.join("diagram.mmd"), "flowchart TD\n A --> B\n").unwrap();
    let o = run(
        &home,
        &project,
        &bin,
        &["init", "--codex", "--hooks", "diagram.mmd"],
    );
    assert!(o.status.success(), "{}", output(&o));
    (home, project, bin)
}

#[test]
fn init_codex_skill_and_absolute_hooks() {
    let (home, project, bin) = setup();
    assert_eq!(
        std::fs::read_to_string(home.join(".codex/skills/mmx/SKILL.md")).unwrap(),
        include_str!("../skills/mmx/SKILL.md")
    );
    let hooks = std::fs::read_to_string(project.join(".codex/hooks.json")).unwrap();
    assert!(hooks.contains(&project.join(".mmx/mmx_hook.py").display().to_string()));
    assert!(hooks.contains("--diagram 'diagram.mmd'"));
    std::fs::write(project.join(".codex/hooks.json"), "original").unwrap();
    let o = run(
        &home,
        &project,
        &bin,
        &["init", "--codex", "--hooks", "diagram.mmd"],
    );
    assert!(o.status.success());
    assert_eq!(
        std::fs::read_to_string(project.join(".codex/hooks.json")).unwrap(),
        "original"
    );
    assert!(project.join(".codex/hooks.mmx.json").exists());
}

#[test]
fn init_codex_without_hooks_writes_skill() {
    let (home, project, bin) = fixture();
    let o = run(&home, &project, &bin, &["init", "--codex"]);
    assert!(o.status.success(), "{}", output(&o));
    assert_eq!(
        std::fs::read_to_string(home.join(".codex/skills/mmx/SKILL.md")).unwrap(),
        include_str!("../skills/mmx/SKILL.md")
    );
    assert!(!project.join(".codex/hooks.json").exists());
}

#[test]
fn doctor_healthy_and_read_only() {
    let (home, project, bin) = setup();
    let before = snapshot(&project);
    let o = run(&home, &project, &bin, &["doctor", "diagram.mmd"]);
    assert!(o.status.success(), "{}", output(&o));
    assert!(
        output(&o).lines().all(|line| line.starts_with("ok ")),
        "{}",
        output(&o)
    );
    assert!(output(&o).contains("ok diagram renders"));
    assert_eq!(before, snapshot(&project));
}

#[test]
fn doctor_missing_and_stale_skills() {
    let (home, project, bin) = setup();
    let path = home.join(".codex/skills/mmx/SKILL.md");
    std::fs::remove_file(&path).unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(output(&o).contains("FAIL Codex skill is missing\n  fix: mmx init --codex"));
    std::fs::write(&path, "old").unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert!(output(&o).contains("FAIL Codex skill is stale\n  fix: mmx init --codex"));
}

#[test]
fn doctor_requires_codex_skill_when_project_hooks_use_mmx() {
    let (home, project, bin) = setup();
    std::fs::remove_dir_all(home.join(".codex")).unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(output(&o).contains("FAIL Codex skill is missing\n  fix: mmx init --codex"));
}

#[test]
fn doctor_warns_about_unused_missing_codex_skill() {
    let (home, project, bin) = fixture();
    let init = run(&home, &project, &bin, &["init"]);
    assert!(init.status.success());
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert!(o.status.success(), "{}", output(&o));
    assert!(output(&o).contains("warn Codex skill not installed"));
}

#[test]
fn doctor_rejects_codex_hook_runner_outside_project() {
    let (_home, project, bin) = setup();
    let hooks_path = project.join(".codex/hooks.json");
    let hooks = std::fs::read_to_string(&hooks_path).unwrap();
    let hooks = hooks.replace(
        &project.join(".mmx/mmx_hook.py").display().to_string(),
        "/tmp/mmx_hook.py",
    );
    std::fs::write(&hooks_path, hooks).unwrap();
    let o = run(&_home, &project, &bin, &["doctor"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(output(&o).contains("FAIL Codex hook script is missing or outside the current project"));
    assert!(output(&o).contains("fix: mmx init --codex --hooks 'diagram.mmd'"));
}

#[test]
fn doctor_missing_hook_and_diagram() {
    let (home, project, bin) = setup();
    std::fs::remove_file(project.join(".mmx/mmx_hook.py")).unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(output(&o).contains(
        "FAIL Claude Code hook script is missing or outside the current project\n  fix: mmx init --codex --hooks 'diagram.mmd'"
    ));
    std::fs::write(
        project.join(".mmx/mmx_hook.py"),
        include_str!("../adapters/mmx_hook.py"),
    )
    .unwrap();
    std::fs::remove_file(project.join("diagram.mmd")).unwrap();
    let o = run(&home, &project, &bin, &["doctor"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(output(&o).contains("FAIL Codex hook diagram diagram.mmd is missing"));
    assert!(output(&o).contains("fix: mkdir -p '.' && printf"));
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, (u64, SystemTime)> {
    fn walk(root: &Path, path: &Path, out: &mut BTreeMap<PathBuf, (u64, SystemTime)>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let p = entry.path();
            let metadata = entry.metadata().unwrap();
            out.insert(
                p.strip_prefix(root).unwrap().to_path_buf(),
                (metadata.len(), metadata.modified().unwrap()),
            );
            if metadata.is_dir() {
                walk(root, &p, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn hooks_with_spaced_diagram_path_and_rerun_is_idempotent() {
    let (home, project, bin) = fixture();
    std::fs::create_dir_all(project.join("my docs")).unwrap();
    std::fs::write(
        project.join("my docs/arch diagram.mmd"),
        "flowchart TD\n A --> B\n",
    )
    .unwrap();
    let args = ["init", "--codex", "--hooks", "my docs/arch diagram.mmd"];
    let o = run(&home, &project, &bin, &args);
    assert!(o.status.success(), "{}", output(&o));
    // Valid JSON, and the prompt hook command passes the path as one word.
    let settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(project.join(".claude/settings.json")).unwrap(),
    )
    .unwrap();
    let command = settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        command.contains("--diagram 'my docs/arch diagram.mmd'"),
        "{command}"
    );
    let echoed = Command::new("sh")
        .args([
            "-c",
            &format!(
                "set -- {}; while [ \"$1\" != --diagram ]; do shift; done; printf %s \"$2\"",
                command.replace("\"$CLAUDE_PROJECT_DIR\"", "/p")
            ),
        ])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&echoed.stdout),
        "my docs/arch diagram.mmd"
    );
    // doctor reads the quoted path back.
    let d = run(&home, &project, &bin, &["doctor"]);
    assert!(
        output(&d).contains("hook diagram my docs/arch diagram.mmd exists"),
        "{}",
        output(&d)
    );
    // Re-running is not a conflict with its own files: no sidecars.
    let again = run(&home, &project, &bin, &args);
    assert!(again.status.success(), "{}", output(&again));
    assert!(!project.join(".claude/settings.mmx.json").exists());
    assert!(!project.join(".codex/hooks.mmx.json").exists());
    assert!(!output(&again).contains("by hand"), "{}", output(&again));
}
