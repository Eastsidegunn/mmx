use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
fn dir() -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let p = std::env::temp_dir().join(format!(
        "mmx008-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}
fn turn(p: &Path, src: &str) -> (i32, Value) {
    std::fs::write(p.join("d.mmd"), src).unwrap();
    let o = Command::new(env!("CARGO_BIN_EXE_mmx"))
        .current_dir(p)
        .args(["render", "d.mmd"])
        .output()
        .unwrap();
    let v = serde_json::from_slice(&std::fs::read(p.join("d.diff.json")).unwrap()).unwrap();
    (o.status.code().unwrap(), v)
}
#[test]
fn mmx008_d_rich_entries_and_style() {
    let p = dir();
    turn(&p, "flowchart TD\n A[Alpha] --> B[Beta]\n");
    let (_, v) = turn(&p, "flowchart TD\n A[Alpha] -.-> C[Gamma]\n");
    assert_eq!(
        v["nodes"]["added"],
        json!([{"id":"C","label":"Gamma","shape":"Rectangle"}])
    );
    assert_eq!(
        v["nodes"]["removed"],
        json!([{"id":"B","label":"Beta","shape":"Rectangle"}])
    );
    assert_eq!(
        v["edges"]["added"],
        json!([{"key":"A->C#0","from":"A","to":"C","label":null,"style":"dotted"}])
    );
    assert_eq!(
        v["edges"]["removed"],
        json!([{"key":"A->B#0","from":"A","to":"B","label":null,"style":"solid"}])
    );
    let (_, v) = turn(&p, "flowchart TD\n A[Alpha] --> C[Gamma]\n");
    assert_eq!(
        v["edges"]["changed"],
        json!([{"key":"A->C#0","field":"style","old":"dotted","new":"solid"}])
    );
}
#[test]
fn mmx008_d_direction_subgraphs_and_hunks() {
    let p = dir();
    turn(&p, "flowchart TD\n A --> B\n");
    let (_, v) = turn(&p, "flowchart LR\n subgraph S [Old]\n A --> B\n end\n");
    assert_eq!(v["direction"], json!({"old":"TD","new":"LR"}));
    assert_eq!(v["subgraphs"]["added"][0]["id"], "S");
    assert_eq!(v["subgraphs"]["added"][0]["label"], "Old");
    let (_, v) = turn(&p, "flowchart LR\n subgraph S [New]\n A --> B\n end\n");
    assert_eq!(
        v["subgraphs"]["changed"],
        json!([{"id":"S","field":"label","old":"Old","new":"New"}])
    );
    let (_, v) = turn(&p, "flowchart LR\n A --> B\n");
    assert_eq!(v["subgraphs"]["removed"][0]["label"], "New");
}
#[test]
fn mmx008_d_style_source_hunks_and_cap() {
    let p = dir();
    turn(&p, "flowchart TD\n A --> B\n classDef w fill:#f00\n");
    let (_, v) = turn(&p, "flowchart TD\n A --> B\n classDef w fill:#0f0\n");
    assert_eq!(v["nodes"]["changed"], json!([]));
    assert_eq!(v["edges"]["changed"], json!([]));
    let lines = v["source_hunks"][0]["lines"].as_array().unwrap();
    assert!(lines.contains(&json!("- classDef w fill:#f00")));
    assert!(lines.contains(&json!("+ classDef w fill:#0f0")));
    let (_, v) = turn(
        &p,
        "flowchart TD\n A --> B\n classDef w fill:#0f0\n style A stroke:#f00\n",
    );
    assert_eq!(v["nodes"]["changed"], json!([]));
    assert_eq!(v["edges"]["changed"], json!([]));
    assert!(v["source_hunks"][0]["lines"]
        .as_array()
        .unwrap()
        .contains(&json!("+ style A stroke:#f00")));
    let before = format!(
        "flowchart TD\n A --> B\n{}",
        (0..450)
            .map(|i| format!(" %% old{i}\n"))
            .collect::<String>()
    );
    let after = before.replace("old", "new");
    turn(&p, &before);
    let (_, v) = turn(&p, &after);
    assert_eq!(v["source_hunks_truncated"], true);
    let n: usize = v["source_hunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["lines"].as_array().unwrap().len())
        .sum();
    assert_eq!(n, 400);
}
#[test]
fn mmx008_d_v1_upgrade_and_nonflow_warning() {
    let p = dir();
    turn(&p, "flowchart TD\n A --> B\n");
    let state_path = p.join("d.state.json");
    let mut state: Value = serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    state["mmx_state_version"] = json!(1);
    for k in ["source", "direction", "subgraphs"] {
        state.as_object_mut().unwrap().remove(k);
    }
    for edge in state["edges"].as_array_mut().unwrap() {
        edge.as_object_mut().unwrap().remove("style");
    }
    std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    let (_, v) = turn(&p, "flowchart LR\n A -.-> B\n");
    assert_eq!(v["baseline"], false);
    assert_eq!(v["warnings"], json!([]));
    assert_eq!(v["direction"], Value::Null);
    assert_eq!(v["edges"]["changed"], json!([]));
    assert_eq!(v["source_hunks"], Value::Null);
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(state_path).unwrap()).unwrap()
            ["mmx_state_version"],
        2
    );
    let p = dir();
    let (exit, v) = turn(&p, "pie\n \"A\" : 1\n");
    assert_eq!(exit, 0);
    assert_eq!(
        v["warnings"],
        json!(["Pie diagram: the nodes/edges diff is partial for this diagram type"])
    );
}
#[test]
fn mmx008_d_lint_positions() {
    let p = dir();
    let (exit, v) = turn(&p, "%% comment\n\n A --> B\n");
    assert_eq!(exit, 2);
    assert_eq!(v["error"]["line"], 3);
    assert_eq!(v["error"]["column"], 1);
    let (exit, v) = turn(&p, "flowchart TD\n  A[x] --> B[y\n");
    assert_eq!(exit, 2);
    assert_eq!(v["error"]["line"], 2);
    assert_eq!(v["error"]["column"], 13);
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("unclosed '['"));
    let p = dir();
    turn(&p, "flowchart TD\n A --> B\n");
    let (exit, v) = turn(&p, "flowchart TD\n A --> B[y\n");
    assert_eq!(exit, 2);
    assert!(v["source_hunks"][0]["lines"]
        .as_array()
        .unwrap()
        .contains(&json!("+ A --> B[y")));
}

#[test]
fn mmx008_d_front_matter_closes_before_header() {
    for front in [
        "---\ntitle: x\n---\n",
        "\n---\nconfig:\n  theme: forest\n---\n",
    ] {
        let p = dir();
        let (exit, v) = turn(&p, &format!("{front}flowchart TD\nA --> B\n"));
        assert_eq!(exit, 0, "{v}");
        assert!(v["error"].is_null());
    }
    let p = dir();
    let (exit, v) = turn(
        &p,
        "%% before front matter\n---\ntitle: x\n---\nflowchart TD\nA --> B\n",
    );
    assert_eq!(exit, 2);
    assert_eq!(v["error"]["line"], 2);
}

#[test]
fn mmx008_d_angle_text_in_shapes() {
    for line in [
        "A[line1<br>line2] --> B",
        "A[List<T>] --> B",
        "A[Vec<u8>] --> B[HashMap<K, V>]",
        "A[<b>bold</b> x] --> B",
        "A[x>y] --> B",
        "A[i>0] --> B",
        "A{x>0?} --> B",
        "A(x>y) --> B",
    ] {
        let p = dir();
        let (exit, v) = turn(&p, &format!("flowchart TD\n{line}\n"));
        assert_eq!(exit, 0, "{line}: {v}");
    }
}

#[test]
fn mmx008_d_trailing_comment_is_not_shape_text() {
    let p = dir();
    let (exit, v) = turn(&p, "flowchart TD\nA[x] --> B %% todo (fix\n");
    assert_eq!(exit, 0, "{v}");
}

#[test]
fn mmx008_d_parallel_edges_match_style_before_position() {
    let p = dir();
    turn(&p, "flowchart TD\nA --> B\nA -.-> B\nA ==> B\n");
    let (_, v) = turn(&p, "flowchart TD\nA --> B\nA ==> B\n");
    assert_eq!(
        v["edges"]["removed"],
        json!([{"key":"A->B#1","from":"A","to":"B","label":null,"style":"dotted"}])
    );
    assert_eq!(v["edges"]["changed"], json!([]));
    let p = dir();
    turn(&p, "flowchart TD\nA --> B\nA -.-> B\nA ==> B\n");
    let (_, v) = turn(&p, "flowchart TD\nA -.-> B\nA --> B\nA -.-> B\nA ==> B\n");
    assert_eq!(
        v["edges"]["added"],
        json!([{"key":"A->B#2","from":"A","to":"B","label":null,"style":"dotted"}])
    );
    assert_eq!(v["edges"]["changed"], json!([]));
}

#[test]
fn mmx008_d_subgraph_direction_change() {
    let p = dir();
    turn(
        &p,
        "flowchart TD\nsubgraph S [Group]\ndirection LR\nA --> B\nend\n",
    );
    let (_, v) = turn(
        &p,
        "flowchart TD\nsubgraph S [Group]\ndirection TB\nA --> B\nend\n",
    );
    assert_eq!(
        v["subgraphs"]["changed"],
        json!([{"id":"S","field":"direction","old":"LR","new":"TD"}])
    );
}

#[test]
fn mmx008_d_same_label_subgraphs_remain_distinct() {
    let p = dir();
    let before = "flowchart TD\nsubgraph Same X\nA\nend\nsubgraph Same X\nB\nend\n";
    let after = "flowchart TD\nsubgraph Same X\nA\nend\nsubgraph Same X\nC\nend\n";
    let (exit, v) = turn(&p, before);
    assert_eq!(exit, 0, "{v}");
    let (exit, v) = turn(&p, after);
    assert_eq!(exit, 0, "{v}");
    assert_eq!(
        v["subgraphs"]["changed"],
        json!([{"id":"Same X#2","field":"nodes","old":["B"],"new":["C"]}])
    );
}

#[test]
fn mmx008_d_crlf_conversion_warns_without_line_changes() {
    let p = dir();
    turn(&p, "flowchart TD\r\nA --> B\r\n");
    let (_, v) = turn(&p, "flowchart TD\nA --> B\n");
    assert_eq!(v["source_changed"], true);
    assert_eq!(v["source_hunks"], json!([]));
    assert!(v["warnings"]
        .as_array()
        .unwrap()
        .contains(&json!("line endings changed (CRLF/LF)")));
}

#[test]
fn mmx008_d_nonflow_warning_mentions_partial_diff() {
    let p = dir();
    let (_, baseline) = turn(&p, "classDiagram\nA <|-- B\n");
    assert_eq!(
        baseline["warnings"],
        json!(["Class diagram: the nodes/edges diff is partial for this diagram type"])
    );
    let (_, changed) = turn(&p, "classDiagram\nA <|-- C\n");
    assert_eq!(changed["warnings"], json!(["Class diagram: the nodes/edges diff is partial for this diagram type; source_hunks shows every text change"]));
}

#[test]
fn mmx008_d_mermaid_js_lint_policy() {
    for source in [
        "flowchart TD\nA[foo (bar]\n",
        "flowchart TD\nA[a|b]\n",
        "A --> B\n",
    ] {
        let p = dir();
        let (exit, v) = turn(&p, source);
        assert_eq!(exit, 2, "{source}: {v}");
    }
}
