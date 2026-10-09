//! diff.json: the one file agents read. Deterministic: no timestamps, sorted
//! keys (BTreeMap upstream), floats rounded to one decimal.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Serialize;

use crate::diff::{Diff, FieldChange};
use crate::model::{GraphModel, SubgraphInfo};
use crate::render::TurnError;

pub const DIFF_VERSION: u32 = 2;

#[derive(Serialize)]
pub struct DiffReport {
    pub mmx_diff_version: u32,
    pub format: String,
    pub by: String,
    pub note: Option<String>,
    pub baseline: bool,
    /// True whenever a non-baseline turn was written: the source text differs
    /// from the previous state even if the semantic diff below is empty
    /// (e.g. only arrow/style/classDef/subgraph edits).
    pub source_changed: bool,
    pub kind_changed: Option<KindChange>,
    pub direction: Option<KindChange>,
    pub subgraphs: SubgraphDiffSection,
    pub source_hunks: Option<Vec<crate::source_diff::SourceHunk>>,
    pub source_hunks_truncated: bool,
    pub nodes: NodeDiffSection,
    pub edges: EdgeDiffSection,
    pub moved: Vec<MovedEntry>,
    /// null on error turns.
    pub stats: Option<Stats>,
    pub warnings: Vec<String>,
    pub error: Option<ErrorEntry>,
}

#[derive(Serialize)]
pub struct KindChange {
    pub old: String,
    pub new: String,
}

#[derive(Serialize, Default)]
pub struct NodeDiffSection {
    pub added: Vec<NodeEntry>,
    pub removed: Vec<NodeEntry>,
    pub changed: Vec<NodeChange>,
}

#[derive(Serialize, Default)]
pub struct EdgeDiffSection {
    pub added: Vec<EdgeEntry>,
    pub removed: Vec<EdgeEntry>,
    pub changed: Vec<EdgeChange>,
}

#[derive(Serialize)]
pub struct NodeEntry {
    pub id: String,
    pub label: String,
    pub shape: String,
}

#[derive(Serialize)]
pub struct EdgeEntry {
    pub key: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub style: Option<String>,
}

#[derive(Serialize, Default)]
pub struct SubgraphDiffSection {
    pub added: Vec<SubgraphInfo>,
    pub removed: Vec<SubgraphInfo>,
    pub changed: Vec<SubgraphChange>,
}

#[derive(Serialize)]
pub struct SubgraphChange {
    pub id: String,
    pub field: String,
    pub old: serde_json::Value,
    pub new: serde_json::Value,
}

#[derive(Serialize)]
pub struct NodeChange {
    pub id: String,
    pub field: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Serialize)]
pub struct EdgeChange {
    pub key: String,
    pub field: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Serialize)]
pub struct MovedEntry {
    pub id: String,
    pub dx: f32,
    pub dy: f32,
}

#[derive(Serialize, Default)]
pub struct Shift {
    pub dx: f32,
    pub dy: f32,
}

#[derive(Serialize, Default)]
pub struct Stats {
    pub mean_move_px: f32,
    pub max_move_px: f32,
    pub global_shift: Shift,
    pub nodes: usize,
    pub edges: usize,
    pub crossings: usize,
}

#[derive(Serialize)]
pub struct ErrorEntry {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
}

impl DiffReport {
    fn empty(by: &str, note: Option<&str>, warnings: Vec<String>) -> Self {
        DiffReport {
            mmx_diff_version: DIFF_VERSION,
            format: "mermaid".into(),
            by: by.into(),
            note: note.map(Into::into),
            baseline: false,
            source_changed: false,
            kind_changed: None,
            direction: None,
            subgraphs: SubgraphDiffSection::default(),
            source_hunks: None,
            source_hunks_truncated: false,
            nodes: NodeDiffSection::default(),
            edges: EdgeDiffSection::default(),
            moved: Vec::new(),
            stats: None,
            warnings,
            error: None,
        }
    }

    pub fn from_diff(
        by: &str,
        note: Option<&str>,
        d: Diff,
        previous: &GraphModel,
        current: &GraphModel,
        warnings: Vec<String>,
    ) -> Self {
        DiffReport {
            source_changed: true,
            kind_changed: d.kind_changed.map(|(old, new)| KindChange { old, new }),
            direction: d.direction.map(|(old, new)| KindChange { old, new }),
            subgraphs: SubgraphDiffSection {
                added: d.subgraphs_added,
                removed: d.subgraphs_removed,
                changed: d
                    .subgraphs_changed
                    .into_iter()
                    .map(|c| SubgraphChange {
                        id: c.id,
                        field: c.field.into(),
                        old: c.old,
                        new: c.new,
                    })
                    .collect(),
            },
            nodes: NodeDiffSection {
                added: d
                    .nodes_added
                    .into_iter()
                    .map(|id| node_entry(&id, current))
                    .collect(),
                removed: d
                    .nodes_removed
                    .into_iter()
                    .map(|id| node_entry(&id, previous))
                    .collect(),
                changed: d.nodes_changed.into_iter().map(node_change).collect(),
            },
            edges: EdgeDiffSection {
                added: d
                    .edges_added
                    .into_iter()
                    .map(|key| edge_entry(&key, current))
                    .collect(),
                removed: d
                    .edges_removed
                    .into_iter()
                    .map(|key| edge_entry(&key, previous))
                    .collect(),
                changed: d.edges_changed.into_iter().map(edge_change).collect(),
            },
            moved: d
                .moved
                .into_iter()
                .map(|m| MovedEntry {
                    id: m.id,
                    dx: m.dx,
                    dy: m.dy,
                })
                .collect(),
            stats: Some(Stats {
                mean_move_px: d.mean_move_px,
                max_move_px: d.max_move_px,
                global_shift: Shift {
                    dx: d.global_shift.0,
                    dy: d.global_shift.1,
                },
                nodes: current.nodes.len(),
                edges: current.edges.len(),
                crossings: current.crossings,
            }),
            ..Self::empty(by, note, warnings)
        }
    }

    /// First turn (no usable previous state): diff sections stay empty by
    /// design — dumping the whole graph as "added" would defeat
    /// diff-as-message.
    pub fn baseline(
        by: &str,
        note: Option<&str>,
        current: &GraphModel,
        warnings: Vec<String>,
    ) -> Self {
        DiffReport {
            baseline: true,
            stats: Some(Stats {
                nodes: current.nodes.len(),
                edges: current.edges.len(),
                crossings: current.crossings,
                ..Stats::default()
            }),
            ..Self::empty(by, note, warnings)
        }
    }

    /// Parse/encoding error turn (exit 2).
    pub fn turn_error(
        by: &str,
        note: Option<&str>,
        err: &TurnError,
        warnings: Vec<String>,
        baseline: bool,
    ) -> Self {
        DiffReport {
            baseline,
            source_changed: true,
            error: Some(ErrorEntry {
                kind: err.kind.into(),
                message: err.message.clone(),
                line: err.line,
                column: err.column,
                candidates: err.candidates.clone(),
            }),
            ..Self::empty(by, note, warnings)
        }
    }

    /// Whether `--print-if-changed` should emit this report: a non-baseline
    /// turn whose semantic diff is non-empty or whose source changed.
    pub fn is_printable(&self) -> bool {
        // An error turn is always news, even on a first render: hooks deliver
        // it to the agent from stdout.
        self.error.is_some()
            || (!self.baseline && (self.source_changed || !self.is_semantically_empty()))
    }

    pub fn is_semantically_empty(&self) -> bool {
        self.error.is_none()
            && self.kind_changed.is_none()
            && self.direction.is_none()
            && self.subgraphs.added.is_empty()
            && self.subgraphs.removed.is_empty()
            && self.subgraphs.changed.is_empty()
            && self.source_hunks.as_ref().is_none_or(Vec::is_empty)
            && self.nodes.added.is_empty()
            && self.nodes.removed.is_empty()
            && self.nodes.changed.is_empty()
            && self.edges.added.is_empty()
            && self.edges.removed.is_empty()
            && self.edges.changed.is_empty()
            && self.moved.is_empty()
    }

    pub fn set_source_hunks(&mut self, previous: Option<&str>, current: &str) {
        if let Some(old) = previous.filter(|old| *old != current) {
            let (hunks, truncated) = crate::source_diff::hunks(old, current);
            self.source_hunks = Some(hunks);
            self.source_hunks_truncated = truncated;
            if self.source_hunks.as_ref().is_some_and(Vec::is_empty)
                && old.replace("\r\n", "\n") == current.replace("\r\n", "\n")
            {
                self.warnings.push("line endings changed (CRLF/LF)".into());
            }
        }
    }

    pub fn to_json(&self) -> anyhow::Result<String> {
        to_json(self)
    }
}

fn node_entry(id: &str, model: &GraphModel) -> NodeEntry {
    let n = &model.nodes[id];
    NodeEntry {
        id: id.into(),
        label: n.label.clone(),
        shape: n.shape.clone(),
    }
}
fn edge_entry(key: &str, model: &GraphModel) -> EdgeEntry {
    let e = &model.edges[key];
    EdgeEntry {
        key: key.into(),
        from: e.from.clone(),
        to: e.to.clone(),
        label: e.label.clone(),
        style: e.style.clone(),
    }
}

fn node_change(c: FieldChange) -> NodeChange {
    NodeChange {
        id: c.anchor,
        field: c.field.into(),
        old: c.old,
        new: c.new,
    }
}

fn edge_change(c: FieldChange) -> EdgeChange {
    EdgeChange {
        key: c.anchor,
        field: c.field.into(),
        old: c.old,
        new: c.new,
    }
}

/// Pretty JSON + trailing newline: the on-disk form of diff.json/state.json.
pub fn to_json<T: Serialize>(value: &T) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(value)? + "\n")
}

/// Atomic replace: write `<path>.<pid>.<n>.tmp`, then rename over `<path>`. A reader
/// never observes a half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    // Unique per writer: two processes (an agent's `mmx note` and `mmx serve`,
    // say) writing the same output must not rename each other's temp file.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut tmp_name = path.as_os_str().to_owned();
    tmp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, bytes).with_context(|| format!("cannot write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot rename {} to {}", tmp.display(), path.display())
    })
}
