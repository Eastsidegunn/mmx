//! The only module that talks to the renderer (mermaid-rs-renderer).
//! Swapping renderers or adding a format adapter means replacing this module's
//! internals; the rest of mmx sees only `RenderedTurn` / `TurnError`.

use std::collections::BTreeMap;

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
/// ready for diff.json's `error` field. `kind` is "parse" or "encoding".
#[derive(Debug, Clone)]
pub struct TurnError {
    pub kind: &'static str,
    pub message: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub candidates: Option<Vec<String>>,
}

pub fn render_turn(source: &str) -> Result<RenderedTurn, TurnError> {
    let parsed = parse_mermaid_strict(source).map_err(structure_error)?;

    // Same pipeline as mermaid_rs_renderer 0.3.1's render_with_options.
    // (%%{init}%% merging lands in a newer mmdr; revisit when bumping the pin.)
    let options = RenderOptions::mermaid_default();
    let layout = compute_layout(&parsed.graph, &options.theme, &options.layout);
    let svg = render_svg(&layout, &options.theme, &options.layout);

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
