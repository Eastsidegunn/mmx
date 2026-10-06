//! Format-agnostic graph view: what diff.rs compares. Node identity is the
//! source-text ID; edge identity is `{from}->{to}#{k}` (k = occurrence index
//! among edges sharing the same from/to pair, in source order).

use std::collections::BTreeMap;

use crate::render::RenderedTurn;

#[derive(Clone, Debug, PartialEq)]
pub struct NodeInfo {
    pub label: String,
    pub shape: String,
    /// Top-left corner.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl NodeInfo {
    /// Center point: the movement metric is measured here so a node that
    /// only grew (longer label) does not count as moved.
    pub fn center(&self) -> (f32, f32) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EdgeInfo {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub style: Option<String>,
    /// Occurrence index within the (from, to) group, in source order.
    pub k: usize,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SubgraphInfo {
    pub id: Option<String>,
    pub label: String,
    pub nodes: Vec<String>,
    #[serde(default)]
    pub direction: Option<String>,
}

impl SubgraphInfo {
    pub fn key(&self) -> &str {
        self.id.as_deref().unwrap_or(&self.label)
    }
}

#[derive(Clone, Debug, Default)]
pub struct GraphModel {
    pub kind: String,
    pub direction: Option<String>,
    pub subgraphs: Vec<SubgraphInfo>,
    pub nodes: BTreeMap<String, NodeInfo>,
    /// edge key -> info, key = "{from}->{to}#{k}"
    pub edges: BTreeMap<String, EdgeInfo>,
}

impl GraphModel {
    pub fn from_rendered(r: &RenderedTurn) -> Self {
        let nodes = r
            .nodes
            .iter()
            .map(|(id, n)| {
                (
                    id.clone(),
                    NodeInfo {
                        label: n.label.clone(),
                        shape: n.shape.clone(),
                        x: n.x,
                        y: n.y,
                        w: n.w,
                        h: n.h,
                    },
                )
            })
            .collect();

        let mut occurrence: BTreeMap<(String, String), usize> = BTreeMap::new();
        let mut edges = BTreeMap::new();
        for e in &r.edges {
            let pair = (e.from.clone(), e.to.clone());
            let k = *occurrence.entry(pair).and_modify(|k| *k += 1).or_insert(0);
            edges.insert(
                edge_key(&e.from, &e.to, k),
                EdgeInfo {
                    from: e.from.clone(),
                    to: e.to.clone(),
                    label: e.label.clone(),
                    style: Some(e.style.clone()),
                    k,
                },
            );
        }

        GraphModel {
            kind: r.kind.clone(),
            direction: Some(r.direction.clone()),
            subgraphs: r
                .subgraphs
                .iter()
                .map(|s| SubgraphInfo {
                    id: s.id.clone(),
                    label: s.label.clone(),
                    nodes: s.nodes.clone(),
                    direction: s.direction.clone(),
                })
                .collect(),
            nodes,
            edges,
        }
    }
}

pub fn edge_key(from: &str, to: &str, k: usize) -> String {
    format!("{from}->{to}#{k}")
}

/// The `k` suffix of an edge key (`None` if malformed).
pub fn edge_key_index(key: &str) -> Option<usize> {
    key.rsplit_once('#').and_then(|(_, k)| k.parse().ok())
}
