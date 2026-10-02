//! Conversation flow through the real binary: one test per protocol contract.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};

fn mmx(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(dir)
        .args(args)
        .output()
        .expect("mmx should run")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

fn tempdir() -> PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "mmx-test-{}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn two_turn_conversation() {
    let dir = tempdir();

    // Turn 1: baseline render by the agent.
    write(
        &dir,
        "d.mmd",
        "flowchart TD\n    A[요청] --> B{검토}\n    B --> C[완료]\n",
    );
    let out = mmx(&dir, &["render", "d.mmd", "--by", "agent"]);
    assert!(out.status.success(), "turn 1 failed: {out:?}");

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["baseline"], true);
    assert_eq!(diff["source_changed"], false);
    assert_eq!(diff["by"], "agent");
    assert_eq!(diff["stats"]["nodes"], 3);
    assert_eq!(diff["warnings"], json!([]));
    assert!(dir.join("d.svg").exists());
    assert!(dir.join("d.state.json").exists());

    // Turn 2: the human adds a node, relabels one, and leaves a note.
    write(
        &dir,
        "d.mmd",
        "flowchart TD\n    A[사용자 요청] --> B{검토}\n    B --> C[완료]\n    B --> G[반려]\n",
    );
    let out = mmx(
        &dir,
        &[
            "render",
            "d.mmd",
            "--by",
            "human",
            "--note",
            "반려 경로 추가",
        ],
    );
    assert!(out.status.success(), "turn 2 failed: {out:?}");

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["baseline"], false);
    assert_eq!(diff["source_changed"], true);
    assert_eq!(diff["kind_changed"], Value::Null);
    assert_eq!(diff["by"], "human");
    assert_eq!(diff["note"], "반려 경로 추가");
    assert_eq!(diff["nodes"]["added"], json!(["G"]));
    assert_eq!(diff["edges"]["added"], json!(["B->G#0"]));
    let changed = diff["nodes"]["changed"].as_array().unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["id"], "A");
    assert_eq!(changed[0]["field"], "label");
    assert_eq!(changed[0]["new"], "사용자 요청");
    assert!(diff["stats"]["global_shift"].is_object());
    assert_eq!(diff["error"], Value::Null);

    // No temp files left behind by atomic writes.
    for f in std::fs::read_dir(&dir).unwrap() {
        let name = f.unwrap().file_name().into_string().unwrap();
        assert!(!name.ends_with(".tmp"), "leftover temp file {name}");
    }
}

/// A1: same input as the committed state -> nothing is written at all.
#[test]
fn rerender_of_unchanged_input_is_a_noop() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    assert!(mmx(&dir, &["render", "d.mmd", "--by", "agent"])
        .status
        .success());

    // Tamper-evident sentinel: a second render must not overwrite diff.json.
    write(&dir, "d.diff.json", "SENTINEL");
    let svg = std::fs::read(dir.join("d.svg")).unwrap();
    let state = std::fs::read(dir.join("d.state.json")).unwrap();

    let out = mmx(
        &dir,
        &["render", "d.mmd", "--by", "human", "--print-if-changed"],
    );
    assert!(out.status.success(), "{out:?}");
    assert!(out.stdout.is_empty(), "no-op must print nothing");
    assert_eq!(
        std::fs::read_to_string(dir.join("d.diff.json")).unwrap(),
        "SENTINEL"
    );
    assert_eq!(svg, std::fs::read(dir.join("d.svg")).unwrap());
    assert_eq!(state, std::fs::read(dir.join("d.state.json")).unwrap());
}

/// Determinism: identical turn sequences in two directories produce
/// byte-identical outputs.
#[test]
fn outputs_are_deterministic() {
    let run = || {
        let dir = tempdir();
        write(&dir, "d.mmd", "flowchart TD\n    A --> B\n    B --> C\n");
        assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
        write(
            &dir,
            "d.mmd",
            "flowchart TD\n    A --> B\n    B --> C\n    A --> D[새 노드]\n",
        );
        assert!(mmx(&dir, &["render", "d.mmd", "--by", "human"])
            .status
            .success());
        ["d.svg", "d.diff.json", "d.state.json"].map(|f| std::fs::read(dir.join(f)).unwrap())
    };
    assert_eq!(run(), run());
}

/// A2: edge changes are anchored by `key`, node changes by `id`.
#[test]
fn edge_changes_use_key_field() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A -->|예| B\n");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    write(&dir, "d.mmd", "flowchart LR\n    A -->|아니오| B\n");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());

    let diff = read_json(&dir.join("d.diff.json"));
    let changed = &diff["edges"]["changed"];
    assert_eq!(
        *changed,
        json!([{ "key": "A->B#0", "field": "label", "old": "예", "new": "아니오" }])
    );
    assert!(changed[0].get("id").is_none());
}

/// A6: within a (from,to) group, equal labels pair first.
#[test]
fn deleting_first_parallel_edge_is_a_removal_not_a_relabel() {
    let dir = tempdir();
    write(
        &dir,
        "d.mmd",
        "flowchart LR\n    A -->|x| B\n    A -->|y| B\n",
    );
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    write(&dir, "d.mmd", "flowchart LR\n    A -->|y| B\n");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["edges"]["removed"], json!(["A->B#0"]));
    assert_eq!(diff["edges"]["added"], json!([]));
    assert_eq!(diff["edges"]["changed"], json!([]));
}

/// A7: prepending a node shifts the whole LR chain; that is a global shift,
/// not per-node movement.
#[test]
fn global_shift_is_not_reported_as_movement() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n    B --> C\n");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    write(
        &dir,
        "d.mmd",
        "flowchart LR\n    Z --> A\n    A --> B\n    B --> C\n",
    );
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["nodes"]["added"], json!(["Z"]));
    assert_eq!(diff["moved"], json!([]), "{diff:#}");
    assert_eq!(diff["stats"]["max_move_px"], 0.0);
    assert!(diff["stats"]["global_shift"]["dx"].as_f64().unwrap() > 10.0);
    assert_eq!(diff["stats"]["global_shift"]["dy"], 0.0);
}

/// A7: a node that only grows (longer label) keeps its center, so the
/// horizontal "move" that top-left coordinates would show disappears.
/// (mmdr also widens rank gaps with label width, so rank-axis neighbours may
/// still register real vertical movement; that is measured, not hidden.)
#[test]
fn label_extension_is_not_counted_as_horizontal_movement() {
    let dir = tempdir();
    let before = "flowchart TD\n    A[start] --> B[abc]\n    B --> C[end]\n";
    let after = "flowchart TD\n    A[start] --> B[abc def ghi jkl]\n    B --> C[end]\n";
    write(&dir, "d.mmd", before);
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let old_state = read_json(&dir.join("d.state.json"));
    write(&dir, "d.mmd", after);
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let new_state = read_json(&dir.join("d.state.json"));

    // Top-left x of every node moved a lot (the graph got wider)...
    let raw_dx = new_state["nodes"]["C"]["x"].as_f64().unwrap()
        - old_state["nodes"]["C"]["x"].as_f64().unwrap();
    assert!(raw_dx.abs() > 5.0, "fixture no longer widens the graph");
    // ...but centers minus global shift did not move horizontally.
    let diff = read_json(&dir.join("d.diff.json"));
    for m in diff["moved"].as_array().unwrap() {
        assert!(m["dx"].as_f64().unwrap().abs() < 1.0, "{diff:#}");
    }
    // State carries size.
    assert!(
        new_state["nodes"]["B"]["w"].as_f64().unwrap()
            > old_state["nodes"]["B"]["w"].as_f64().unwrap()
    );
    assert!(new_state["nodes"]["B"]["h"].as_f64().unwrap() > 0.0);
}

/// A4: a corrupt state is backed up and the turn proceeds as baseline.
#[test]
fn corrupt_state_is_backed_up_and_treated_as_baseline() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    write(&dir, "d.state.json", "{ not json");
    let out = mmx(&dir, &["render", "d.mmd"]);
    assert!(out.status.success(), "{out:?}");

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["baseline"], true);
    assert_eq!(
        diff["warnings"],
        json!(["previous state corrupt; treated as baseline"])
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("d.state.json.corrupt")).unwrap(),
        "{ not json"
    );
    assert_eq!(read_json(&dir.join("d.state.json"))["mmx_state_version"], 1);

    // Version mismatch takes the same recovery path.
    let mut state = read_json(&dir.join("d.state.json"));
    state["mmx_state_version"] = json!(99);
    write(&dir, "d.state.json", &state.to_string());
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["baseline"], true);
    assert_eq!(
        diff["warnings"],
        json!(["previous state version unsupported; treated as baseline"])
    );
}

/// A3: an explicit --prev that does not exist is an error, not a baseline.
#[test]
fn missing_explicit_prev_exits_1() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    let out = mmx(&dir, &["render", "d.mmd", "--prev", "nope.state.json"]);
    assert_eq!(out.status.code(), Some(1), "{out:?}");
    assert!(!dir.join("d.diff.json").exists());
    assert!(!dir.join("d.svg").exists());
    assert!(!dir.join("d.state.json").exists());
}

/// A13: without --prev, the previous state is read from --state-out.
#[test]
fn state_out_is_also_the_default_prev() {
    let dir = tempdir();
    let args = ["render", "d.mmd", "--state-out", "memo.json"];
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    assert!(mmx(&dir, &args).status.success());
    assert!(dir.join("memo.json").exists());
    assert!(!dir.join("d.state.json").exists());

    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n    B --> C\n");
    assert!(mmx(&dir, &args).status.success());
    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["baseline"], false);
    assert_eq!(diff["nodes"]["added"], json!(["C"]));
}

/// A12: outputs may not clobber the input (or each other).
#[test]
fn output_path_colliding_with_input_exits_1() {
    let dir = tempdir();
    let src = "flowchart LR\n    A --> B\n";
    write(&dir, "d.mmd", src);
    for args in [
        &["render", "d.mmd", "-o", "d.mmd"][..],
        &["render", "d.mmd", "--diff-out", "./d.mmd"][..],
        &["render", "d.mmd", "--state-out", "d.mmd"][..],
        &[
            "render",
            "d.mmd",
            "--diff-out",
            "x.json",
            "--state-out",
            "x.json",
        ][..],
    ] {
        let out = mmx(&dir, args);
        assert_eq!(out.status.code(), Some(1), "{args:?}: {out:?}");
        assert_eq!(std::fs::read_to_string(dir.join("d.mmd")).unwrap(), src);
    }
}

/// `--prev` may not point at the input or the svg/diff outputs: exit 1 and
/// every artifact stays byte-for-byte unchanged.
#[test]
fn prev_colliding_with_input_or_outputs_exits_1() {
    let dir = tempdir();
    let src = "flowchart LR\n    A --> B\n";
    write(&dir, "d.mmd", src);
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());

    let names = ["d.mmd", "d.svg", "d.diff.json", "d.state.json"];
    let snapshot = || -> Vec<Vec<u8>> {
        names
            .iter()
            .map(|n| std::fs::read(dir.join(n)).unwrap())
            .collect()
    };
    let before = snapshot();

    // Change the input so a wrongly accepted run would rewrite outputs.
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n    B --> C\n");
    let mut before_changed = before.clone();
    before_changed[0] = std::fs::read(dir.join("d.mmd")).unwrap();

    for prev in ["d.mmd", "d.svg", "d.diff.json"] {
        let out = mmx(&dir, &["render", "d.mmd", "--prev", prev]);
        assert_eq!(out.status.code(), Some(1), "--prev {prev}: {out:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("--prev points"), "--prev {prev}: {stderr}");
        assert_eq!(snapshot(), before_changed, "--prev {prev} touched outputs");
        assert!(!dir.join(format!("{prev}.corrupt")).exists());
    }
}

/// Exit 2 contract + A8 structured error + A10 null stats; reverting to the
/// last good text re-renders (not a no-op) so the stale error is cleared.
#[test]
fn parse_error_exits_2_preserves_state_and_recovers() {
    let dir = tempdir();
    let good = "flowchart LR\n    A --> B\n";
    write(&dir, "d.mmd", good);
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let state_before = std::fs::read(dir.join("d.state.json")).unwrap();
    let svg_before = std::fs::read(dir.join("d.svg")).unwrap();

    write(&dir, "d.mmd", "flowchart LR\n    --> B\n");
    let out = mmx(
        &dir,
        &["render", "d.mmd", "--by", "agent", "--print-if-changed"],
    );
    assert_eq!(out.status.code(), Some(2), "expected exit 2: {out:?}");

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["error"]["kind"], "parse");
    assert_eq!(diff["error"]["line"], 2);
    assert_eq!(diff["error"]["column"], 5);
    assert!(!diff["error"]["message"].as_str().unwrap().is_empty());
    assert_eq!(diff["stats"], Value::Null);
    assert_eq!(out.stdout, std::fs::read(dir.join("d.diff.json")).unwrap());

    // Last valid state and svg stay untouched.
    assert_eq!(
        state_before,
        std::fs::read(dir.join("d.state.json")).unwrap()
    );
    assert_eq!(svg_before, std::fs::read(dir.join("d.svg")).unwrap());

    // Revert: same hash as state, but the error must be replaced.
    write(&dir, "d.mmd", good);
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["error"], Value::Null);
    assert_eq!(diff["baseline"], false);
    // ...and after that, the normal no-op contract applies again.
    write(&dir, "d.diff.json", "SENTINEL");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    assert_eq!(
        std::fs::read_to_string(dir.join("d.diff.json")).unwrap(),
        "SENTINEL"
    );
}

/// A8: UnknownParticipant carries line and candidates.
#[test]
fn unknown_participant_error_carries_candidates() {
    let dir = tempdir();
    write(
        &dir,
        "d.mmd",
        "sequenceDiagram\n    participant Alice\n    Alice->>Bob: hi\n",
    );
    let out = mmx(&dir, &["render", "d.mmd"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let err = &read_json(&dir.join("d.diff.json"))["error"];
    assert_eq!(err["kind"], "parse");
    assert_eq!(err["line"], 3);
    assert!(err["candidates"].is_array());
    assert!(err.get("column").is_none());
}

/// A11: non-UTF-8 input is a fixable turn error.
#[test]
fn non_utf8_input_exits_2_with_encoding_error() {
    let dir = tempdir();
    std::fs::write(dir.join("d.mmd"), b"flowchart TD\n    A[caf\xe9] --> B\n").unwrap();
    let out = mmx(&dir, &["render", "d.mmd"]);
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(diff["error"]["kind"], "encoding");
    assert_eq!(diff["error"]["line"], 2);
    assert!(!dir.join("d.state.json").exists());
    assert!(!dir.join("d.svg").exists());
}

/// A9: --print-if-changed prints exactly the written diff.json, only for
/// non-baseline turns.
#[test]
fn print_if_changed_only_prints_real_turns() {
    let dir = tempdir();
    let args = ["render", "d.mmd", "--by", "human", "--print-if-changed"];
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    let out = mmx(&dir, &args);
    assert!(out.status.success());
    assert!(out.stdout.is_empty(), "baseline must not print");

    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n    B --> C\n");
    let out = mmx(&dir, &args);
    assert!(out.status.success());
    assert_eq!(out.stdout, std::fs::read(dir.join("d.diff.json")).unwrap());

    // Text-only change (comment) with an empty semantic diff still prints:
    // source_changed is the signal.
    write(
        &dir,
        "d.mmd",
        "flowchart LR\n    %% comment\n    A --> B\n    B --> C\n",
    );
    let out = mmx(&dir, &args);
    assert!(out.status.success());
    let printed: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(printed["source_changed"], true);
    assert_eq!(printed["nodes"]["added"], json!([]));

    let out = mmx(&dir, &args);
    assert!(out.status.success());
    assert!(out.stdout.is_empty(), "no-op must not print");

    // Without the flag nothing is ever printed.
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    let out = mmx(&dir, &["render", "d.mmd"]);
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}

/// A14: diagram kind change is reported.
#[test]
fn kind_change_is_reported() {
    let dir = tempdir();
    write(&dir, "d.mmd", "flowchart LR\n    A --> B\n");
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let kind_before = read_json(&dir.join("d.state.json"))["kind"].clone();
    write(
        &dir,
        "d.mmd",
        "sequenceDiagram\n    participant A\n    participant B\n    A->>B: hi\n",
    );
    assert!(mmx(&dir, &["render", "d.mmd"]).status.success());
    let kind_after = read_json(&dir.join("d.state.json"))["kind"].clone();
    assert_ne!(kind_before, kind_after);

    let diff = read_json(&dir.join("d.diff.json"));
    assert_eq!(
        diff["kind_changed"],
        json!({ "old": kind_before, "new": kind_after })
    );
}

#[test]
fn init_installs_skill_and_hooks() {
    let fake_home = tempdir();
    let project = tempdir();

    // Skill only.
    let out = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(&project)
        .env("HOME", &fake_home)
        .args(["init"])
        .output()
        .unwrap();
    assert!(out.status.success(), "init failed: {out:?}");
    let skill = fake_home.join(".claude/skills/mmx/SKILL.md");
    assert!(skill.exists());
    assert!(fake_home
        .join(".claude/skills/mmx/references/diff-schema.md")
        .exists());
    assert!(std::fs::read_to_string(&skill)
        .unwrap()
        .contains("mmx render"));

    // Hooks into a clean project.
    let out = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(&project)
        .env("HOME", &fake_home)
        .args(["init", "--hooks", "docs/arch.mmd"])
        .output()
        .unwrap();
    assert!(out.status.success(), "init --hooks failed: {out:?}");
    assert!(project.join("adapters/mmx_hook.py").exists());
    let settings = std::fs::read_to_string(project.join(".claude/settings.json")).unwrap();
    assert!(settings.contains("docs/arch.mmd"));
    assert!(!settings.contains("--diagram diagram.mmd"));

    // Existing settings.json must not be clobbered.
    std::fs::write(project.join(".claude/settings.json"), "{\"custom\":true}").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(&project)
        .env("HOME", &fake_home)
        .args(["init", "--hooks", "docs/arch.mmd"])
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        std::fs::read_to_string(project.join(".claude/settings.json")).unwrap(),
        "{\"custom\":true}"
    );
    assert!(project.join(".claude/settings.mmx.json").exists());
}
