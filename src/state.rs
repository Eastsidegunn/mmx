//! state.json: mmx's memory between turns. Agents never read this file;
//! it exists so the next `mmx render` can compute a diff.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::model::{edge_key_index, EdgeInfo, GraphModel, NodeInfo, SubgraphInfo};

pub const STATE_VERSION: u32 = 2;

pub const WARN_CORRUPT: &str = "previous state corrupt; treated as baseline";
pub const WARN_VERSION: &str = "previous state version unsupported; treated as baseline";

#[derive(Serialize, Deserialize)]
pub struct State {
    pub mmx_state_version: u32,
    pub format: String,
    pub source_sha256: String,
    pub kind: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub subgraphs: Option<Vec<SubgraphInfo>>,
    pub nodes: BTreeMap<String, StateNode>,
    pub edges: Vec<StateEdge>,
}

#[derive(Serialize, Deserialize)]
pub struct StateNode {
    pub label: String,
    pub shape: String,
    /// Top-left corner and size; movement is measured at the center.
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Serialize, Deserialize)]
pub struct StateEdge {
    pub key: String,
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    #[serde(default)]
    pub style: Option<String>,
}

/// Result of reading a previous state file that exists.
pub enum Loaded {
    Ok(State),
    /// Unparseable, wrong version or wrong format. Carries the warning to
    /// put in diff.json; the caller backs the file up and runs as baseline.
    Corrupt(&'static str),
}

impl State {
    pub fn from_model(source_sha256: &str, source: &str, model: &GraphModel) -> Self {
        let nodes = model
            .nodes
            .iter()
            .map(|(id, n)| {
                (
                    id.clone(),
                    StateNode {
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
        let edges = model
            .edges
            .iter()
            .map(|(key, e)| StateEdge {
                key: key.clone(),
                from: e.from.clone(),
                to: e.to.clone(),
                label: e.label.clone(),
                style: e.style.clone(),
            })
            .collect();
        State {
            mmx_state_version: STATE_VERSION,
            format: "mermaid".into(),
            source_sha256: source_sha256.into(),
            kind: model.kind.clone(),
            source: Some(source.into()),
            direction: model.direction.clone(),
            subgraphs: Some(model.subgraphs.clone()),
            nodes,
            edges,
        }
    }

    pub fn to_model(&self) -> GraphModel {
        let nodes = self
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
        let edges = self
            .edges
            .iter()
            .map(|e| {
                (
                    e.key.clone(),
                    EdgeInfo {
                        from: e.from.clone(),
                        to: e.to.clone(),
                        label: e.label.clone(),
                        style: e.style.clone(),
                        k: edge_key_index(&e.key).unwrap_or(0),
                    },
                )
            })
            .collect();
        GraphModel {
            kind: self.kind.clone(),
            direction: self.direction.clone(),
            subgraphs: self.subgraphs.clone().unwrap_or_default(),
            nodes,
            edges,
        }
    }

    /// I/O failure is an error (exit 1); bad content is `Loaded::Corrupt`.
    pub fn load(path: &Path) -> anyhow::Result<Loaded> {
        let raw =
            std::fs::read(path).with_context(|| format!("cannot read state {}", path.display()))?;
        let value: serde_json::Value = match serde_json::from_slice(&raw) {
            Ok(v) => v,
            Err(_) => return Ok(Loaded::Corrupt(WARN_CORRUPT)),
        };
        match value.get("mmx_state_version").and_then(|v| v.as_u64()) {
            Some(v) if v == STATE_VERSION as u64 || v == 1 => {}
            Some(_) => return Ok(Loaded::Corrupt(WARN_VERSION)),
            None => return Ok(Loaded::Corrupt(WARN_CORRUPT)),
        }
        match serde_json::from_value::<State>(value) {
            Ok(s)
                if s.format == "mermaid"
                    && s.edges.iter().all(|e| edge_key_index(&e.key).is_some()) =>
            {
                Ok(Loaded::Ok(s))
            }
            _ => Ok(Loaded::Corrupt(WARN_CORRUPT)),
        }
    }

    pub fn to_json(&self) -> anyhow::Result<String> {
        crate::emit::to_json(self)
    }
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}
