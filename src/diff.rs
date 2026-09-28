//! Semantic + positional diff between two GraphModels. Pure; no I/O.

use std::collections::BTreeMap;

use crate::model::{EdgeInfo, GraphModel};

/// One attribute change. `anchor` is the node id (nodes) or the edge key
/// (edges); emit.rs names it `id` / `key` respectively.
pub struct FieldChange {
    pub anchor: String,
    pub field: &'static str,
    pub old: Option<String>,
    pub new: Option<String>,
}

pub struct Moved {
    pub id: String,
    pub dx: f32,
    pub dy: f32,
}

#[derive(Default)]
pub struct Diff {
    pub kind_changed: Option<(String, String)>,
    pub nodes_added: Vec<String>,
    pub nodes_removed: Vec<String>,
    pub nodes_changed: Vec<FieldChange>,
    pub edges_added: Vec<String>,
    pub edges_removed: Vec<String>,
    pub edges_changed: Vec<FieldChange>,
    pub moved: Vec<Moved>,
    pub mean_move_px: f32,
    pub max_move_px: f32,
    /// Median center displacement over common nodes, subtracted before
    /// measuring per-node movement.
    pub global_shift: (f32, f32),
}

impl Diff {
    /// No semantic or positional change (kind change counts as semantic).
    pub fn is_empty(&self) -> bool {
        self.kind_changed.is_none()
            && self.nodes_added.is_empty()
            && self.nodes_removed.is_empty()
            && self.nodes_changed.is_empty()
            && self.edges_added.is_empty()
            && self.edges_removed.is_empty()
            && self.edges_changed.is_empty()
            && self.moved.is_empty()
    }
}

/// Movement below this is float noise, not information.
const MOVE_THRESHOLD_PX: f32 = 0.5;

pub fn diff(prev: &GraphModel, cur: &GraphModel) -> Diff {
    let mut d = Diff::default();

    if prev.kind != cur.kind {
        d.kind_changed = Some((prev.kind.clone(), cur.kind.clone()));
    }

    diff_nodes(prev, cur, &mut d);
    diff_edges(prev, cur, &mut d);
    diff_positions(prev, cur, &mut d);
    d
}

fn diff_nodes(prev: &GraphModel, cur: &GraphModel, d: &mut Diff) {
    for (id, node) in &cur.nodes {
        match prev.nodes.get(id) {
            None => d.nodes_added.push(id.clone()),
            Some(old) => {
                if old.label != node.label {
                    d.nodes_changed.push(FieldChange {
                        anchor: id.clone(),
                        field: "label",
                        old: Some(old.label.clone()),
                        new: Some(node.label.clone()),
                    });
                }
                if old.shape != node.shape {
                    d.nodes_changed.push(FieldChange {
                        anchor: id.clone(),
                        field: "shape",
                        old: Some(old.shape.clone()),
                        new: Some(node.shape.clone()),
                    });
                }
            }
        }
    }
    for id in prev.nodes.keys() {
        if !cur.nodes.contains_key(id) {
            d.nodes_removed.push(id.clone());
        }
    }
}

type EdgeGroup<'a> = Vec<(&'a String, &'a EdgeInfo)>;

/// Group edges by (from, to), each group ordered by occurrence index k.
fn group_edges(m: &GraphModel) -> BTreeMap<(&str, &str), EdgeGroup<'_>> {
    let mut groups: BTreeMap<(&str, &str), EdgeGroup<'_>> = BTreeMap::new();
    for (key, e) in &m.edges {
        groups
            .entry((e.from.as_str(), e.to.as_str()))
            .or_default()
            .push((key, e));
    }
    for g in groups.values_mut() {
        g.sort_by_key(|(_, e)| e.k);
    }
    groups
}

/// Within each (from, to) group: pair edges with equal labels first, then
/// pair the leftovers in source order. Unpaired prev edges are removed
/// (reported under their prev key), unpaired current edges are added and
/// paired edges with differing labels are changed (both under current keys).
fn diff_edges(prev: &GraphModel, cur: &GraphModel, d: &mut Diff) {
    let prev_groups = group_edges(prev);
    let cur_groups = group_edges(cur);
    let empty: EdgeGroup<'_> = Vec::new();

    let pairs: std::collections::BTreeSet<(&str, &str)> = prev_groups
        .keys()
        .chain(cur_groups.keys())
        .copied()
        .collect();

    for pair in pairs {
        let p = prev_groups.get(&pair).unwrap_or(&empty);
        let c = cur_groups.get(&pair).unwrap_or(&empty);
        let mut p_used = vec![false; p.len()];
        let mut c_match: Vec<Option<usize>> = vec![None; c.len()];

        // Phase 1: identical labels.
        for (ci, (_, ce)) in c.iter().enumerate() {
            if let Some(pi) = (0..p.len()).find(|&pi| !p_used[pi] && p[pi].1.label == ce.label) {
                p_used[pi] = true;
                c_match[ci] = Some(pi);
            }
        }
        // Phase 2: leftovers in source order.
        let mut free_p = (0..p.len())
            .filter(|&pi| !p_used[pi])
            .collect::<Vec<_>>()
            .into_iter();
        for slot in c_match.iter_mut().filter(|m| m.is_none()) {
            if let Some(pi) = free_p.next() {
                p_used[pi] = true;
                *slot = Some(pi);
            }
        }

        for (ci, (ckey, ce)) in c.iter().enumerate() {
            match c_match[ci] {
                None => d.edges_added.push((*ckey).clone()),
                Some(pi) => {
                    let pe = p[pi].1;
                    if pe.label != ce.label {
                        d.edges_changed.push(FieldChange {
                            anchor: (*ckey).clone(),
                            field: "label",
                            old: pe.label.clone(),
                            new: ce.label.clone(),
                        });
                    }
                }
            }
        }
        for (pi, (pkey, _)) in p.iter().enumerate() {
            if !p_used[pi] {
                d.edges_removed.push((*pkey).clone());
            }
        }
    }

    d.edges_added.sort();
    d.edges_removed.sort();
    d.edges_changed.sort_by(|a, b| a.anchor.cmp(&b.anchor));
}

/// Movement over nodes present on both sides, measured at node centers
/// after subtracting the global shift (component-wise median displacement).
/// Stats include sub-threshold moves; the `moved` list filters noise out.
fn diff_positions(prev: &GraphModel, cur: &GraphModel, d: &mut Diff) {
    let displacements: Vec<(&String, f32, f32)> = cur
        .nodes
        .iter()
        .filter_map(|(id, node)| {
            prev.nodes.get(id).map(|old| {
                let (cx, cy) = node.center();
                let (ox, oy) = old.center();
                (id, cx - ox, cy - oy)
            })
        })
        .collect();

    if displacements.is_empty() {
        return;
    }

    let gx = median(displacements.iter().map(|t| t.1).collect());
    let gy = median(displacements.iter().map(|t| t.2).collect());
    d.global_shift = (round1(gx), round1(gy));

    let mut total = 0.0f32;
    let mut max = 0.0f32;
    for (id, dx, dy) in &displacements {
        let rx = dx - gx;
        let ry = dy - gy;
        let dist = (rx * rx + ry * ry).sqrt();
        total += dist;
        max = max.max(dist);
        if dist > MOVE_THRESHOLD_PX {
            d.moved.push(Moved {
                id: (*id).clone(),
                dx: round1(rx),
                dy: round1(ry),
            });
        }
    }
    d.mean_move_px = round1(total / displacements.len() as f32);
    d.max_move_px = round1(max);
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// One decimal place: absorbs float drift so outputs stay byte-identical
/// (determinism contract). Normalizes -0.0 to 0.0 so "-0.0" never appears
/// in JSON. NaN is treated as an upstream bug and not guarded.
pub fn round1(v: f32) -> f32 {
    let r = (v * 10.0).round() / 10.0;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round1_normalizes_negative_zero() {
        assert!(round1(-0.01).is_sign_positive());
        assert_eq!(serde_json::to_string(&round1(-0.04)).unwrap(), "0.0");
        assert_eq!(round1(1.26), 1.3);
    }

    #[test]
    fn median_even_and_odd() {
        assert_eq!(median(vec![3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(vec![4.0, 1.0, 2.0, 3.0]), 2.5);
    }

    fn edge(from: &str, to: &str, k: usize, label: Option<&str>) -> (String, EdgeInfo) {
        (
            crate::model::edge_key(from, to, k),
            EdgeInfo {
                from: from.into(),
                to: to.into(),
                label: label.map(Into::into),
                k,
            },
        )
    }

    #[test]
    fn edge_matching_prefers_equal_labels() {
        let prev = GraphModel {
            edges: [edge("A", "B", 0, Some("x")), edge("A", "B", 1, Some("y"))]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        // First edge deleted: the remaining "y" edge is now #0.
        let cur = GraphModel {
            edges: [edge("A", "B", 0, Some("y"))].into_iter().collect(),
            ..Default::default()
        };
        let d = diff(&prev, &cur);
        assert_eq!(d.edges_removed, vec!["A->B#0".to_string()]);
        assert!(d.edges_added.is_empty());
        assert!(d.edges_changed.is_empty());
    }

    #[test]
    fn edge_matching_falls_back_to_source_order() {
        let prev = GraphModel {
            edges: [edge("A", "B", 0, Some("x"))].into_iter().collect(),
            ..Default::default()
        };
        let cur = GraphModel {
            edges: [edge("A", "B", 0, Some("z")), edge("A", "B", 1, None)]
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let d = diff(&prev, &cur);
        assert_eq!(d.edges_added, vec!["A->B#1".to_string()]);
        assert_eq!(d.edges_changed.len(), 1);
        assert_eq!(d.edges_changed[0].anchor, "A->B#0");
    }
}
