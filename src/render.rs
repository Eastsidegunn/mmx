//! The only module that talks to the renderer (mermaid-rs-renderer).
//! Swapping renderers or adding a format adapter means replacing this module's
//! internals; the rest of mmx sees only `RenderedTurn` / `TurnError`.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

use mermaid_rs_renderer::layout::Layout;
use mermaid_rs_renderer::{
    compute_layout, parse_mermaid_strict, render_svg, ParseError, RenderOptions,
};

/// What a successful render hands to the rest of mmx.
pub struct RenderedTurn {
    pub svg: String,
    pub kind: String,
    pub direction: String,
    pub subgraphs: Vec<RenderedSubgraph>,
    /// node id -> label, shape, top-left position and size
    pub nodes: BTreeMap<String, RenderedNode>,
    /// edges in source order
    pub edges: Vec<RenderedEdge>,
    /// Number of edge pairs whose routed polylines cross.
    pub crossings: usize,
}

pub struct RenderedSubgraph {
    pub id: Option<String>,
    pub label: String,
    pub nodes: Vec<String>,
    pub direction: Option<String>,
}

pub struct RenderedNode {
    pub label: String,
    pub shape: String,
    /// Top-left corner (mmdr's NodeLayout convention).
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub struct RenderedEdge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub style: String,
}

/// Structured turn failure the agent can fix by editing the diagram,
/// ready for diff.json's `error` field. `kind` is "parse" or "encoding";
/// [`RENDERER_FAILED`] marks a renderer panic, which is not a turn (exit 1).
#[derive(Debug, Clone)]
pub struct TurnError {
    pub kind: &'static str,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub candidates: Option<Vec<String>>,
}

pub const RENDERER_FAILED: &str = "renderer";

pub fn render_turn(source: &str) -> Result<RenderedTurn, TurnError> {
    let parsed = parse_mermaid_strict(source).map_err(structure_error)?;

    // Same pipeline as mermaid_rs_renderer 0.3.1's render_with_options.
    // (%%{init}%% merging lands in a newer mmdr; revisit when bumping the pin.)
    let options = RenderOptions::mermaid_default();
    let (layout, svg) = guarded(|| {
        let layout = compute_layout(&parsed.graph, &options.theme, &options.layout);
        let svg = render_svg(&layout, &options.theme, &options.layout);
        (layout, svg)
    })?;
    let crossings = count_crossings(&layout);

    let mut nodes = BTreeMap::new();
    for (id, nl) in &layout.nodes {
        let ir_node = parsed.graph.nodes.get(id);
        nodes.insert(
            id.clone(),
            RenderedNode {
                label: ir_node.map(|n| n.label.clone()).unwrap_or_default(),
                shape: ir_node
                    .map(|n| format!("{:?}", n.shape))
                    .unwrap_or_else(|| "Unknown".into()),
                x: nl.x,
                y: nl.y,
                w: nl.width,
                h: nl.height,
            },
        );
    }

    let edges = parsed
        .graph
        .edges
        .iter()
        .map(|e| RenderedEdge {
            from: e.from.clone(),
            to: e.to.clone(),
            label: e.label.clone(),
            style: format!("{:?}", e.style).to_ascii_lowercase(),
        })
        .collect();

    Ok(RenderedTurn {
        svg,
        kind: format!("{:?}", parsed.graph.kind),
        direction: match parsed.graph.direction {
            mermaid_rs_renderer::ir::Direction::TopDown => "TD",
            mermaid_rs_renderer::ir::Direction::LeftRight => "LR",
            mermaid_rs_renderer::ir::Direction::BottomTop => "BT",
            mermaid_rs_renderer::ir::Direction::RightLeft => "RL",
        }
        .into(),
        subgraphs: parsed
            .graph
            .subgraphs
            .iter()
            .map(|s| RenderedSubgraph {
                id: s.id.clone(),
                label: s.label.clone(),
                nodes: s.nodes.clone(),
                direction: s.direction.map(|d| {
                    match d {
                        mermaid_rs_renderer::ir::Direction::TopDown => "TD",
                        mermaid_rs_renderer::ir::Direction::LeftRight => "LR",
                        mermaid_rs_renderer::ir::Direction::BottomTop => "BT",
                        mermaid_rs_renderer::ir::Direction::RightLeft => "RL",
                    }
                    .to_string()
                }),
            })
            .collect(),
        nodes,
        edges,
        crossings,
    })
}

/// What a layout-search candidate is judged by: the parsed graph (so a
/// reorder that changed anything but line order is rejected) and its
/// crossing count. No SVG is rendered.
pub struct Probe {
    pub signature: String,
    pub crossings: usize,
}

pub fn probe(source: &str) -> Result<Probe, TurnError> {
    let parsed = parse_mermaid_strict(source).map_err(structure_error)?;
    let options = RenderOptions::mermaid_default();
    let layout = guarded(|| compute_layout(&parsed.graph, &options.theme, &options.layout))?;
    Ok(Probe {
        signature: signature(&parsed.graph),
        crossings: count_crossings(&layout),
    })
}

/// Everything the diff and the picture depend on except declaration order.
/// Edges keep their relative order within a (from, to) pair, which is what
/// the `{from}->{to}#{k}` keys are built from.
fn signature(graph: &mermaid_rs_renderer::ir::Graph) -> String {
    let mut out = format!("{:?} {:?}\n", graph.kind, graph.direction);
    for (id, node) in &graph.nodes {
        out += &format!(
            "node {id} {node:?} classes={:?} style={:?} link={:?}\n",
            graph.node_classes.get(id),
            graph.node_styles.get(id),
            graph.node_links.get(id)
        );
    }
    let mut edges: Vec<(&str, &str, String)> = graph
        .edges
        .iter()
        .enumerate()
        .map(|(i, e)| {
            (
                e.from.as_str(),
                e.to.as_str(),
                format!("{e:?} override={:?}", graph.edge_styles.get(&i)),
            )
        })
        .collect();
    edges.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    for (from, to, rest) in edges {
        out += &format!("edge {from}->{to} {rest}\n");
    }
    let mut class_defs: Vec<_> = graph.class_defs.iter().collect();
    class_defs.sort_by(|a, b| a.0.cmp(b.0));
    out += &format!(
        "subgraphs={:?} class_defs={class_defs:?} edge_default={:?}\n",
        graph.subgraphs, graph.edge_style_default
    );
    out
}

/// Edge pairs whose routes meet somewhere. Two edges leaving or entering
/// the same port touch there without crossing, so contact at a port both
/// edges share is not counted; any other contact (a proper crossing, a
/// touch at a bend, running along each other) is.
fn count_crossings(layout: &Layout) -> usize {
    let routes: Vec<&[(f32, f32)]> = layout.edges.iter().map(|e| e.points.as_slice()).collect();
    let mut count = 0;
    for (i, a) in routes.iter().enumerate() {
        for b in &routes[i + 1..] {
            let ports = |r: &[(f32, f32)]| [r.first().copied(), r.last().copied()];
            let shared: Vec<(f32, f32)> = ports(a)
                .into_iter()
                .flatten()
                .filter(|p| ports(b).into_iter().flatten().any(|q| near(*p, q)))
                .collect();
            let crosses = a.windows(2).any(|s| {
                b.windows(2).any(|t| {
                    contact(s[0], s[1], t[0], t[1])
                        .is_some_and(|point| !shared.iter().any(|p| near(*p, point)))
                })
            });
            count += usize::from(crosses);
        }
    }
    count
}

fn near(p: (f32, f32), q: (f32, f32)) -> bool {
    (p.0 - q.0).abs() < 0.5 && (p.1 - q.1).abs() < 0.5
}

/// A point where two segments meet, if any: the intersection, or the middle
/// of the overlap when they are collinear.
fn contact(p1: (f32, f32), p2: (f32, f32), q1: (f32, f32), q2: (f32, f32)) -> Option<(f32, f32)> {
    let f = |p: (f32, f32)| (p.0 as f64, p.1 as f64);
    let (p1, p2, q1, q2) = (f(p1), f(p2), f(q1), f(q2));
    let r = (p2.0 - p1.0, p2.1 - p1.1);
    let s = (q2.0 - q1.0, q2.1 - q1.1);
    let qp = (q1.0 - p1.0, q1.1 - p1.1);
    let cross = |a: (f64, f64), b: (f64, f64)| a.0 * b.1 - a.1 * b.0;
    let dot = |a: (f64, f64), b: (f64, f64)| a.0 * b.0 + a.1 * b.1;
    let eps = 1e-6;
    let denom = cross(r, s);
    if denom.abs() > eps {
        let t = cross(qp, s) / denom;
        let u = cross(qp, r) / denom;
        let inside = |v: f64| (-eps..=1.0 + eps).contains(&v);
        return (inside(t) && inside(u))
            .then_some(((p1.0 + t * r.0) as f32, (p1.1 + t * r.1) as f32));
    }
    let rr = dot(r, r);
    if cross(qp, r).abs() > eps || rr < eps {
        return None;
    }
    let t0 = dot(qp, r) / rr;
    let t1 = t0 + dot(s, r) / rr;
    let (lo, hi) = (t0.min(t1).max(0.0), t0.max(t1).min(1.0));
    (lo <= hi + eps).then(|| {
        let m = (lo + hi) / 2.0;
        ((p1.0 + m * r.0) as f32, (p1.1 + m * r.1) as f32)
    })
}

thread_local! {
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    pub(crate) static FORCE_PANIC: Cell<bool> = const { Cell::new(false) };
}

/// Run a renderer call with panics turned into a [`RENDERER_FAILED`] error.
/// The process-wide panic hook stays quiet for this thread while the call
/// runs, so a renderer bug reports one line instead of a backtrace note.
fn guarded<T>(call: impl FnOnce() -> T) -> Result<T, TurnError> {
    static HOOK: Once = Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(Cell::get) {
                previous(info);
            }
        }));
    });
    QUIET.with(|q| q.set(true));
    let result = catch_unwind(AssertUnwindSafe(|| {
        #[cfg(test)]
        if FORCE_PANIC.with(Cell::get) {
            panic!("injected renderer panic");
        }
        call()
    }));
    QUIET.with(|q| q.set(false));
    result.map_err(|payload| {
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        TurnError {
            kind: RENDERER_FAILED,
            message,
            line: None,
            column: None,
            candidates: None,
        }
    })
}

/// Map mmdr's typed ParseError onto diff.json's error schema without
/// scraping the Display string. ParseError is #[non_exhaustive], so the
/// wildcard arm keeps future variants working (message only).
fn structure_error(err: ParseError) -> TurnError {
    let message = err.to_string();
    let (line, column, candidates) = match err {
        ParseError::UnknownParticipant {
            line, candidates, ..
        } => (Some(line), None, Some(candidates)),
        ParseError::UnclosedSubgraph { opened_at } => (Some(opened_at), None, None),
        ParseError::UnexpectedToken { line, col, .. } => (Some(line), Some(col), None),
        ParseError::InvalidDirective { line, col, .. } => (Some(line), Some(col), None),
        _ => (None, None, None),
    };
    TurnError {
        kind: "parse",
        message,
        line,
        column,
        candidates,
    }
}

/// Non-UTF-8 input is fixable by the agent (re-save the file as UTF-8), so it
/// is a turn error (exit 2), not an I/O failure. Position is 1-based
/// line/character column of the first invalid byte.
pub fn encoding_error(bytes: &[u8], err: std::str::Utf8Error) -> TurnError {
    let valid = &bytes[..err.valid_up_to()];
    // `valid` is valid UTF-8 by definition.
    let text = std::str::from_utf8(valid).unwrap_or_default();
    let line = text.matches('\n').count() as u32 + 1;
    let last_line = text.rsplit('\n').next().unwrap_or("");
    let column = last_line.chars().count() as u32 + 1;
    TurnError {
        kind: "encoding",
        message: format!(
            "input is not valid UTF-8 (invalid byte at offset {}, line {line}, column {column}); re-save the file as UTF-8",
            err.valid_up_to()
        ),
        line: Some(line),
        column: Some(column),
        candidates: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_chain_has_no_crossings() {
        let turn = render_turn("flowchart LR\n    A --> B\n    B --> C\n").unwrap();
        assert_eq!(turn.crossings, 0);
        assert_eq!(
            probe("flowchart LR\n    A --> B\n    B --> C\n")
                .unwrap()
                .crossings,
            0
        );
    }

    #[test]
    fn crossing_count_is_stable_across_renders() {
        let source = "flowchart TD\n    A --> D\n    A --> C\n    B --> C\n    B --> D\n    C --> E\n    D --> E\n    A --> E\n";
        let first = render_turn(source).unwrap().crossings;
        assert_eq!(render_turn(source).unwrap().crossings, first);
        assert_eq!(probe(source).unwrap().crossings, first);
    }

    #[test]
    fn signature_ignores_line_order_but_not_the_graph() {
        let a = probe("flowchart TD\n    A[a]\n    B[b]\n    A --> B\n").unwrap();
        let b = probe("flowchart TD\n    B[b]\n    A[a]\n    A --> B\n").unwrap();
        let c = probe("flowchart TD\n    A[a]\n    B[c]\n    A --> B\n").unwrap();
        let d = probe("flowchart TD\n    A[a]\n    B[b]\n    A -.-> B\n").unwrap();
        assert_eq!(a.signature, b.signature);
        assert_ne!(a.signature, c.signature);
        assert_ne!(a.signature, d.signature);
    }

    #[test]
    fn contacts_between_segments() {
        let x = contact((0.0, 0.0), (2.0, 2.0), (0.0, 2.0), (2.0, 0.0)).unwrap();
        assert!(near(x, (1.0, 1.0)));
        assert!(contact((0.0, 0.0), (2.0, 0.0), (0.0, 1.0), (2.0, 1.0)).is_none());
        let touch = contact((0.0, 0.0), (2.0, 2.0), (0.0, 0.0), (2.0, 0.0)).unwrap();
        assert!(near(touch, (0.0, 0.0)));
        let vertex = contact((0.0, 0.0), (2.0, 0.0), (1.0, -1.0), (1.0, 0.0)).unwrap();
        assert!(near(vertex, (1.0, 0.0)));
        assert!(contact((0.0, 0.0), (2.0, 0.0), (1.0, 0.0), (3.0, 0.0)).is_some());
    }

    #[test]
    fn shared_port_is_not_a_crossing_but_a_vertex_hit_is() {
        let parsed = parse_mermaid_strict("flowchart LR\n    A --> B\n    B --> C\n").unwrap();
        let options = RenderOptions::mermaid_default();
        let mut layout = compute_layout(&parsed.graph, &options.theme, &options.layout);
        assert_eq!(layout.edges.len(), 2);
        layout.edges[0].points = vec![(0.0, 0.0), (2.0, 2.0)];
        layout.edges[1].points = vec![(0.0, 0.0), (2.0, 0.0)];
        assert_eq!(count_crossings(&layout), 0);
        layout.edges[0].points = vec![(0.0, 0.0), (2.0, 0.0), (4.0, 0.0)];
        layout.edges[1].points = vec![(2.0, -1.0), (2.0, 0.0), (2.0, 1.0)];
        assert_eq!(count_crossings(&layout), 1);
        layout.edges[1].points = vec![(1.0, 1.0), (3.0, 1.0)];
        assert_eq!(count_crossings(&layout), 0);
    }

    #[test]
    fn renderer_panic_is_a_renderer_error() {
        FORCE_PANIC.with(|f| f.set(true));
        let err = match render_turn("flowchart LR\n    A --> B\n") {
            Ok(_) => panic!("injected panic was not caught"),
            Err(err) => err,
        };
        let count = probe("flowchart LR\n    A --> B\n");
        FORCE_PANIC.with(|f| f.set(false));
        assert_eq!(err.kind, RENDERER_FAILED);
        assert_eq!(err.message, "injected renderer panic");
        assert_eq!(err.line, None);
        assert_eq!(count.err().map(|e| e.kind), Some(RENDERER_FAILED));
        assert!(render_turn("flowchart LR\n    A --> B\n").is_ok());
    }

    #[test]
    fn renderer_panic_is_not_a_turn() {
        let dir = std::env::temp_dir().join(format!("mmx-panic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("d.mmd");
        let job = crate::default_job(&input, "agent", None);
        FORCE_PANIC.with(|f| f.set(true));
        let result = crate::run_render_bytes(&job, b"flowchart LR\n    A --> B\n");
        FORCE_PANIC.with(|f| f.set(false));
        let message = format!("{:#}", result.err().expect("renderer failure is an error"));
        assert!(
            message.starts_with("renderer failed on this input ("),
            "{message}"
        );
        assert!(message.contains("injected renderer panic"));
        assert!(!job.out_diff.exists());
        assert!(!job.out_state.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
