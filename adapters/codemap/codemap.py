#!/usr/bin/env python3
"""Select and reduce a code graph into an mmx-editable Mermaid flowchart."""

import argparse
import hashlib
import heapq
import json
import math
import os
import re
import sys
from collections import defaultdict, deque
from pathlib import Path


KINDS = {"package", "file", "symbol", "external", "function", "type", "module"}
EDGE_KINDS = {"import", "call", "test", "dynamic", "data", "event"}
STRATEGIES = {"neighborhood", "path", "impact", "changeset"}
SAFE_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED_IDS = {
    "end",
    "subgraph",
    "graph",
    "flowchart",
    "style",
    "class",
    "classDef",
    "click",
    "linkStyle",
    "direction",
    "default",
}


class CodemapError(ValueError):
    pass


def derive_id(path):
    """Return the stable Mermaid id prescribed by the codemap contract."""
    pieces = []
    in_non_ascii = False
    for character in str(path):
        if character.isascii() and character.isalnum():
            pieces.append(character)
            in_non_ascii = False
        elif not character.isascii():
            if not in_non_ascii:
                pieces.append("_x{:x}".format(ord(character)))
            in_non_ascii = True
        else:
            pieces.append("_")
            in_non_ascii = False
    value = "".join(pieces)
    if not value:
        value = "node"
    if value[0].isdigit():
        value = "n_" + value
    if value in RESERVED_IDS:
        value = "n_" + value
    return value


def _collision_id(base, path):
    digest = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:6]
    return "{}_{}".format(base, digest)


def _safe_explicit_id(value):
    return "n_" + value if value in RESERVED_IDS else value


def _legacy_derive_id(path):
    value = re.sub(r"[^A-Za-z0-9]", "_", str(path)) or "node"
    return "n_" + value if value[0].isdigit() else value


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def _write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(str(temporary), str(path))


def load_graph(path, lenient=False, skipped_edges=None, id_aliases=None):
    raw = _read_json(path)
    if not isinstance(raw, dict):
        raise CodemapError("graph must be a JSON object")

    raw_nodes = raw.get("nodes", [])
    derived_groups = defaultdict(set)
    for raw_node in raw_nodes:
        if isinstance(raw_node, dict) and raw_node.get("id") is None:
            raw_path = str(raw_node.get("path", "")).strip()
            derived_groups[derive_id(raw_path)].add(raw_path)

    nodes = {}
    raw_to_safe = {}
    for position, raw_node in enumerate(raw_nodes):
        if not isinstance(raw_node, dict):
            raise CodemapError("node {} is not an object".format(position))
        node = dict(raw_node)
        path_value = str(node.get("path", "")).strip()
        supplied_id = node.get("id")
        raw_id = str(supplied_id or derive_id(path_value))
        node_id = _safe_explicit_id(raw_id)
        if (
            supplied_id is None
            and len(derived_groups[node_id]) > 1
            and path_value != min(derived_groups[node_id])
        ):
            node_id = _collision_id(node_id, path_value)
        if not path_value:
            raise CodemapError("node {!r} has no path".format(node_id))
        if not SAFE_ID.match(node_id):
            raise CodemapError("node id {!r} is not Mermaid-safe".format(node_id))
        if node_id in nodes:
            raise CodemapError("duplicate node id {!r}".format(node_id))
        kind = node.get("kind", "file")
        if kind not in KINDS:
            raise CodemapError("node {!r} has invalid kind {!r}".format(node_id, kind))
        refs = node.get("refs", 0)
        if not isinstance(refs, int) or isinstance(refs, bool) or refs < 0:
            raise CodemapError("node {!r} refs must be a non-negative integer".format(node_id))
        nodes[node_id] = {"id": node_id, "path": path_value, "kind": kind, "refs": refs}
        raw_to_safe.setdefault(raw_id, node_id)
        raw_to_safe.setdefault(_legacy_derive_id(path_value), node_id)

    merged_edges = defaultdict(int)
    for position, raw_edge in enumerate(raw.get("edges", [])):
        if not isinstance(raw_edge, dict):
            raise CodemapError("edge {} is not an object".format(position))
        raw_source = str(raw_edge.get("from", ""))
        raw_target = str(raw_edge.get("to", ""))
        source = raw_to_safe.get(raw_source, _safe_explicit_id(raw_source))
        target = raw_to_safe.get(raw_target, _safe_explicit_id(raw_target))
        kind = raw_edge.get("kind", "import")
        count = raw_edge.get("count", 1)
        if source not in nodes or target not in nodes:
            if not lenient:
                raise CodemapError("edge {} references an unknown node".format(position))
            if skipped_edges is not None:
                skipped_edges.append(
                    {
                        "edge": position,
                        "from": raw_source,
                        "to": raw_target,
                        "reason": "unknown endpoint",
                    }
                )
            continue
        if kind not in EDGE_KINDS:
            raise CodemapError("edge {} has invalid kind {!r}".format(position, kind))
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise CodemapError("edge {} count must be a positive integer".format(position))
        merged_edges[(source, target, kind)] += count

    edges = [
        {"from": key[0], "to": key[1], "kind": key[2], "count": count}
        for key, count in sorted(merged_edges.items())
    ]
    if id_aliases is not None:
        id_aliases.update(raw_to_safe)
    return nodes, edges


def load_memory(path):
    memory = _read_json(path, {"aliases": {}, "omitted": [], "last": {}})
    if not isinstance(memory, dict):
        raise CodemapError("memory must be a JSON object")
    aliases = memory.get("aliases", {})
    omitted = memory.get("omitted", [])
    if not isinstance(aliases, dict) or not isinstance(omitted, list):
        raise CodemapError("memory aliases must be an object and omitted must be a list")
    memory["aliases"] = {str(key): str(value) for key, value in aliases.items()}
    memory["omitted"] = sorted({str(value) for value in omitted})
    if not isinstance(memory.get("last", {}), dict):
        memory["last"] = {}
    return memory


def _summary_members(memory):
    mapping = {}
    last = memory.get("last", {})
    groups = list(last.get("summaries", []))
    for reduction in last.get("reductions", []):
        if reduction.get("kind") == "fold_packages":
            groups.extend(reduction.get("groups", []))
    for group in groups:
        node_id = group.get("node")
        members = group.get("members")
        if node_id and isinstance(members, list):
            mapping[str(node_id)] = [str(member) for member in members]
    return mapping


def _expand_omitted(memory):
    summaries = _summary_members(memory)
    expanded = set()
    pending = list(memory.get("omitted", []))
    while pending:
        node_id = pending.pop()
        members = summaries.get(node_id)
        if members:
            pending.extend(members)
        else:
            expanded.add(_safe_explicit_id(node_id))
    memory["omitted"] = sorted(expanded)
    return expanded


def _adjacency(nodes, edges):
    outgoing = {node_id: [] for node_id in nodes}
    incoming = {node_id: [] for node_id in nodes}
    for edge in edges:
        outgoing[edge["from"]].append(edge["to"])
        incoming[edge["to"]].append(edge["from"])
    for values in outgoing.values():
        values.sort()
    for values in incoming.values():
        values.sort()
    return outgoing, incoming


def _walk_distances(start, adjacency, depth):
    distances = {node_id: 0 for node_id in start}
    queue = deque((node_id, 0) for node_id in sorted(start))
    while queue:
        node_id, distance = queue.popleft()
        if distance >= depth:
            continue
        for neighbor in adjacency.get(node_id, []):
            if neighbor not in distances:
                distances[neighbor] = distance + 1
                queue.append((neighbor, distance + 1))
    return distances


def _k_shortest_paths(start, target, outgoing, count):
    queue = [(0, (start,))]
    results = []
    expanded = 0
    expansion_limit = max(1000, len(outgoing) * max(10, count * 4))
    while queue and len(results) < count and expanded < expansion_limit:
        _, path = heapq.heappop(queue)
        expanded += 1
        last = path[-1]
        if last == target:
            results.append(path)
            continue
        for neighbor in outgoing.get(last, []):
            if neighbor not in path:
                next_path = path + (neighbor,)
                heapq.heappush(queue, (len(next_path), next_path))
    return results


def _edge_identity(edge):
    return (edge["from"], edge["to"], edge["kind"])


def _induced_edges(edges, selected):
    return [
        dict(edge)
        for edge in edges
        if edge["from"] in selected and edge["to"] in selected
    ]


def _selection_over_hard(selected, edges, hard_nodes, hard_edges):
    if hard_nodes is None or hard_edges is None:
        return False
    return (
        len(selected) > hard_nodes
        or len(_induced_edges(edges, selected)) > hard_edges
    )


def _aggregate_id(nodes, used, package, ring):
    base = "folded_{}_ring{}".format(derive_id(package), ring)
    candidate = base
    suffix = 2
    while candidate in nodes or candidate in used:
        candidate = "{}_{}".format(base, suffix)
        suffix += 1
    return candidate


def _package_map(nodes):
    """Return package labels relative to the selected graph's common root."""
    path_parts = {}
    directories = []
    for node_id, node in nodes.items():
        if node["kind"] == "external":
            continue
        parts = tuple(
            part
            for part in node["path"].replace("\\", "/").strip("/").split("/")
            if part
        )
        path_parts[node_id] = parts
        directories.append(parts[:-1])

    common = list(directories[0]) if directories else []
    for directory in directories[1:]:
        length = 0
        for left, right in zip(common, directory):
            if left != right:
                break
            length += 1
        common = common[:length]

    relative = {
        node_id: parts[len(common) :]
        for node_id, parts in path_parts.items()
    }

    def at_depth(parts, depth):
        if len(parts) <= 1:
            return "(root)"
        directories_below_root = parts[:-1]
        return "/".join(directories_below_root[:depth])

    packages = {
        node_id: ("external" if node["kind"] == "external" else at_depth(relative[node_id], 1))
        for node_id, node in nodes.items()
    }
    counts = defaultdict(int)
    for package in packages.values():
        counts[package] += 1
    if counts and max(counts.values()) > len(nodes) * 0.5:
        packages = {
            node_id: (
                "external"
                if node["kind"] == "external"
                else at_depth(relative[node_id], 2)
            )
            for node_id, node in nodes.items()
        }
    return packages


def _summarize_ring(nodes, edges, selected, distances, ring, focus):
    packages = _package_map(nodes)
    members = sorted(
        (node_id for node_id, distance in distances.items() if distance == ring),
        key=lambda node_id: (packages[node_id], node_id),
    )
    groups = defaultdict(list)
    for node_id in members:
        groups[packages[node_id]].append(node_id)

    selected_nodes = {node_id: dict(nodes[node_id]) for node_id in selected}
    remap = {}
    folded = set()
    reports = []
    non_focus_count = len((set(selected) | set(members)) - set(focus))
    group_limit = max(2, non_focus_count // 2)
    for package in sorted(groups):
        pending = sorted(groups[package])
        while len(pending) >= 2:
            size = min(len(pending), group_limit)
            if len(pending) - size == 1 and size > 2:
                size -= 1
            group = pending[:size]
            pending = pending[size:]
            aggregate = _aggregate_id(nodes, folded, package, ring)
            folded.add(aggregate)
            for member in group:
                remap[member] = aggregate
            selected_nodes[aggregate] = {
                "id": aggregate,
                "path": "{}/* ({} files)".format(package, len(group)),
                "kind": "file",
                "refs": sum(nodes[member]["refs"] for member in group),
                "folded_members": group,
                "distance": ring,
            }
            reports.append(
                {
                    "package": package,
                    "node": aggregate,
                    "files": len(group),
                    "members": group,
                    "ring": ring,
                }
            )
        for member in pending:
            selected_nodes[member] = dict(nodes[member])

    merged = defaultdict(int)
    allowed = set(selected) | set(members)
    for edge in edges:
        if edge["from"] not in allowed or edge["to"] not in allowed:
            continue
        source = remap.get(edge["from"], edge["from"])
        target = remap.get(edge["to"], edge["to"])
        if source != target and source in selected_nodes and target in selected_nodes:
            merged[(source, target, edge["kind"])] += edge["count"]
    selected_edges = [
        {"from": key[0], "to": key[1], "kind": key[2], "count": count}
        for key, count in sorted(merged.items())
    ]
    selected_distances = {node_id: distances[node_id] for node_id in selected}
    selected_distances.update({node_id: ring for node_id in members if node_id not in remap})
    selected_distances.update({node_id: ring for node_id in folded})
    return selected_nodes, selected_edges, selected_distances, folded, reports


def _select_graph_details(
    nodes, edges, focus, strategy, hops, hard_nodes=None, hard_edges=None
):
    if strategy not in STRATEGIES:
        raise CodemapError("unknown strategy {!r}".format(strategy))
    if hops < 1:
        raise CodemapError("--hops must be at least 1")
    missing = [node_id for node_id in focus if node_id not in nodes]
    if missing:
        raise CodemapError("focus node(s) not found: {}".format(", ".join(missing)))
    if not focus:
        raise CodemapError("--focus must name at least one node")

    outgoing, incoming = _adjacency(nodes, edges)
    details = {
        "distances": {},
        "protected_edges": set(),
        "protected_nodes": set(),
        "folded": set(),
        "summary_groups": [],
        "hops_used": None,
        "hop2_summarized": False,
    }
    paths = []
    if strategy in ("neighborhood", "changeset"):
        depth = 1 if strategy == "changeset" else hops
        both = {
            node_id: sorted(set(outgoing[node_id]) | set(incoming[node_id]))
            for node_id in nodes
        }
        distances = _walk_distances(focus, both, depth)
        selected = {node_id for node_id, distance in distances.items() if distance <= 1}
        used = min(depth, 1)
        if depth > 1 and not _selection_over_hard(
            selected, edges, hard_nodes, hard_edges
        ):
            for ring in range(2, depth + 1):
                candidate = {
                    node_id for node_id, distance in distances.items() if distance <= ring
                }
                if _selection_over_hard(candidate, edges, hard_nodes, hard_edges):
                    selected_nodes, selected_edges, selected_distances, folded, groups = (
                            _summarize_ring(nodes, edges, selected, distances, ring, focus)
                    )
                    details.update(
                        {
                            "distances": selected_distances,
                            "folded": folded,
                            "summary_groups": groups,
                            "hops_used": used,
                            "hop2_summarized": ring == 2,
                            "summarized_ring": ring,
                        }
                    )
                    focus_set = set(focus)
                    details["protected_edges"] = {
                        _edge_identity(edge)
                        for edge in selected_edges
                        if edge["from"] in focus_set or edge["to"] in focus_set
                    }
                    return selected_nodes, selected_edges, details
                selected = candidate
                used = ring
        details["distances"] = {
            node_id: distances[node_id] for node_id in selected
        }
        details["hops_used"] = used
    elif strategy == "impact":
        distances = _walk_distances(focus, incoming, hops)
        selected = set(distances)
        details["distances"] = distances
    else:
        if len(focus) != 2:
            raise CodemapError("path strategy requires exactly two focus nodes")
        paths = _k_shortest_paths(focus[0], focus[1], outgoing, hops)
        selected = set(focus)
        for path in paths:
            selected.update(path)
        details["protected_nodes"] = set(selected)
        details["paths_found"] = len(paths)
        details["distances"] = {
            node_id: min(
                index
                for path in paths
                for index, member in enumerate(path)
                if member == node_id
            )
            if any(node_id in path for path in paths)
            else 0
            for node_id in selected
        }

    selected_nodes = {node_id: dict(nodes[node_id]) for node_id in selected}
    selected_edges = _induced_edges(edges, selected)
    focus_set = set(focus)
    protected = {
        _edge_identity(edge)
        for edge in selected_edges
        if edge["from"] in focus_set or edge["to"] in focus_set
    }
    if strategy == "path":
        path_pairs = {
            (path[index], path[index + 1])
            for path in paths
            for index in range(len(path) - 1)
        }
        protected.update(
            _edge_identity(edge)
            for edge in selected_edges
            if (edge["from"], edge["to"]) in path_pairs
        )
    elif strategy == "impact":
        by_source = defaultdict(list)
        for edge in selected_edges:
            by_source[edge["from"]].append(edge)
        for node_id, distance in sorted(details["distances"].items()):
            if distance == 0:
                continue
            candidates = [
                edge
                for edge in by_source[node_id]
                if details["distances"].get(edge["to"]) == distance - 1
            ]
            if candidates:
                chosen = sorted(
                    candidates, key=lambda edge: (-edge["count"], _edge_key(edge))
                )[0]
                protected.add(_edge_identity(chosen))
    details["protected_edges"] = protected
    return selected_nodes, selected_edges, details


def select_graph(nodes, edges, focus, strategy, hops):
    """Select a graph while preserving the original two-value public API."""
    selected_nodes, selected_edges, _ = _select_graph_details(
        nodes, edges, focus, strategy, hops
    )
    return selected_nodes, selected_edges


def _over_cap(nodes, edges, max_nodes, max_edges):
    return len(nodes) > max_nodes or len(edges) > max_edges


def _median(values):
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _fold_hubs(nodes, edges, focus, protected_edges, protected_nodes):
    degree = {node_id: 0 for node_id in nodes}
    refs = {node_id: 0 for node_id in nodes}
    for edge in edges:
        degree[edge["from"]] += 1
        degree[edge["to"]] += 1
        refs[edge["from"]] += edge["count"]
        refs[edge["to"]] += edge["count"]
    values = sorted(degree.values())
    if not values or not any(values):
        return edges, set(), None
    rank = max(0, math.ceil(0.90 * len(values)) - 1)
    p90 = values[rank]
    median = _median(values)
    threshold = max(p90, 2 * median)
    candidates = [
        node_id
        for node_id, value in degree.items()
        if value >= threshold
        and value > 0
        and node_id not in focus
        and node_id not in protected_nodes
    ]
    limit = int(math.ceil(0.10 * len(nodes)))
    hubs = set(
        sorted(candidates, key=lambda node_id: (-degree[node_id], node_id))[:limit]
    )
    if not hubs:
        return edges, set(), None
    retained = [
        edge
        for edge in edges
        if (edge["from"] not in hubs and edge["to"] not in hubs)
        or edge["from"] in focus
        or edge["to"] in focus
        or _edge_identity(edge) in protected_edges
    ]
    removed = len(edges) - len(retained)
    for node_id in hubs:
        nodes[node_id]["hub_refs"] = nodes[node_id]["refs"] or refs[node_id]
    reduction = {
        "kind": "fold_hubs",
        "nodes": sorted(hubs),
        "folded_ids": sorted(hubs),
        "threshold": int(threshold) if int(threshold) == threshold else threshold,
        "edges_removed": removed,
    }
    return retained, hubs, reduction


def _drop_edges(edges, max_edges, protected_edges):
    if len(edges) <= max_edges:
        return edges, None
    removable = sorted(
        (edge for edge in edges if _edge_identity(edge) not in protected_edges),
        key=lambda edge: (
            edge["count"],
            edge["from"],
            edge["to"],
            edge["kind"],
        ),
    )
    remove_count = min(len(edges) - max_edges, len(removable))
    if remove_count == 0:
        return edges, None
    removed = removable[:remove_count]
    removed_ids = {_edge_identity(edge) for edge in removed}
    retained = [edge for edge in edges if _edge_identity(edge) not in removed_ids]
    refs = sum(edge["count"] for edge in removed)
    reduction = {
        "kind": "drop_edges",
        "edges": remove_count,
        "refs": refs,
        "_removed_edges": removed,
    }
    return sorted(retained, key=_edge_key), reduction


def _edge_key(edge):
    return (edge["from"], edge["to"], edge["kind"], edge["count"])


def _fold_package_group(
    nodes, edges, hubs, folded, protected_edges, package, ring, members
):
    remap = {}
    new_nodes = {node_id: dict(node) for node_id, node in nodes.items()}
    aggregate_id = _aggregate_id(nodes, folded, package, ring)
    for member in members:
        remap[member] = aggregate_id
        new_nodes.pop(member, None)
    new_folded = set(folded) | {aggregate_id}
    new_nodes[aggregate_id] = {
        "id": aggregate_id,
        "path": "{}/* ({} files)".format(package, len(members)),
        "kind": "file",
        "refs": sum(nodes[member]["refs"] for member in members),
        "folded_members": list(members),
        "distance": ring,
    }

    merged = defaultdict(int)
    for edge in edges:
        source = remap.get(edge["from"], edge["from"])
        target = remap.get(edge["to"], edge["to"])
        if source != target:
            merged[(source, target, edge["kind"])] += edge["count"]
    new_edges = [
        {"from": key[0], "to": key[1], "kind": key[2], "count": count}
        for key, count in sorted(merged.items())
    ]
    new_hubs = {remap.get(node_id, node_id) for node_id in hubs} - {aggregate_id}
    new_protected = set()
    for source, target, kind in protected_edges:
        new_source = remap.get(source, source)
        new_target = remap.get(target, target)
        if new_source != new_target:
            new_protected.add((new_source, new_target, kind))
    report = {
        "package": package,
        "node": aggregate_id,
        "files": len(members),
        "members": list(members),
        "ring": ring,
    }
    return new_nodes, new_edges, new_hubs, new_folded, new_protected, report


def _limit_focus_edges(nodes, edges, focus, max_nodes, max_edges):
    focus_set = set(focus)
    incident = [
        edge
        for edge in edges
        if edge["from"] in focus_set or edge["to"] in focus_set
    ]
    if len(nodes) <= max_nodes and len(edges) <= max_edges:
        return nodes, edges, None

    kept = []
    used_nodes = set(focus_set)
    focus_edge_target = min(max(0, max_nodes - len(focus_set)), max_edges)
    for edge in sorted(incident, key=lambda edge: (-edge["count"], _edge_key(edge))):
        edge_nodes = {edge["from"], edge["to"]}
        if len(kept) >= focus_edge_target or len(used_nodes | edge_nodes) > max_nodes:
            continue
        kept.append(edge)
        used_nodes.update(edge_nodes)
    kept_ids = {_edge_identity(edge) for edge in kept}
    removed = [edge for edge in incident if _edge_identity(edge) not in kept_ids]
    nonincident_candidates = [
        edge
        for edge in edges
        if edge["from"] not in focus_set and edge["to"] not in focus_set
        and edge["from"] in used_nodes and edge["to"] in used_nodes
    ]
    nonincident_candidates.sort(key=lambda edge: (-edge["count"], _edge_key(edge)))
    nonincident = nonincident_candidates[: max(0, max_edges - len(kept))]
    retained = nonincident + kept
    connected = set(focus_set)
    for edge in retained:
        connected.add(edge["from"])
        connected.add(edge["to"])
    pruned = sorted(set(nodes) - connected)
    new_nodes = {node_id: node for node_id, node in nodes.items() if node_id in connected}
    if not removed and not pruned:
        return nodes, edges, None
    reduction = {
        "kind": "limit_focus_edges",
        "kept": len(kept),
        "dropped": len(removed),
        "focus_edges_kept": len(kept),
        "focus_edges_dropped": len(removed),
        "refs": sum(edge["count"] for edge in removed),
        "pruned_orphans": pruned,
    }
    return new_nodes, sorted(retained, key=_edge_key), reduction


def _prune_orphans(nodes, edges, focus, hubs, folded):
    connected = set()
    for edge in edges:
        connected.add(edge["from"])
        connected.add(edge["to"])
    pruned = sorted(set(nodes) - connected - set(focus))
    if not pruned:
        return nodes, hubs, folded, []
    pruned_set = set(pruned)
    nodes = {node_id: node for node_id, node in nodes.items() if node_id not in pruned_set}
    return nodes, hubs - pruned_set, folded - pruned_set, pruned


def _record_pruned(reduction, pruned):
    if pruned:
        existing = set(reduction.get("pruned_orphans", []))
        reduction["pruned_orphans"] = sorted(existing | set(pruned))


def _restore_nonfocus_edges(edges, dropped, nodes, focus, max_edges):
    if len(edges) >= max_edges or not dropped:
        return edges, []
    focus_set = set(focus)
    existing = {_edge_identity(edge) for edge in edges}
    candidates = [
        edge
        for edge in dropped
        if edge["from"] in nodes
        and edge["to"] in nodes
        and edge["from"] not in focus_set
        and edge["to"] not in focus_set
        and _edge_identity(edge) not in existing
    ]
    candidates.sort(key=lambda edge: (-edge["count"], _edge_key(edge)))
    restored = candidates[: max_edges - len(edges)]
    return sorted(edges + restored, key=_edge_key), restored


def _hidden_comment(nodes, reductions, summary_groups):
    parts = []
    hubs = next((item for item in reductions if item["kind"] == "fold_hubs"), None)
    if hubs:
        visible_hubs = [node_id for node_id in hubs["nodes"] if node_id in nodes]
        descriptions = []
        for node_id in visible_hubs[:3]:
            node = nodes.get(node_id, {})
            descriptions.append(
                "{} {} refs".format(
                    node.get("path", node_id),
                    node.get("hub_refs", node.get("refs", 0)),
                )
            )
        if len(visible_hubs) > 3:
            descriptions.append("…")
        if visible_hubs:
            parts.append(
                "{} hubs ({})".format(len(visible_hubs), ", ".join(descriptions))
            )
    dropped = sum(
        item["edges"] for item in reductions if item["kind"] == "drop_edges"
    )
    dropped -= sum(
        item["edges"] for item in reductions if item["kind"] == "restore_edges"
    )
    if dropped:
        parts.append("{} low-weight edges".format(dropped))
    limited = next(
        (item for item in reductions if item["kind"] == "limit_focus_edges"), None
    )
    if limited and limited["dropped"]:
        parts.append("{} excess focus edges".format(limited["dropped"]))
    groups = list(summary_groups)
    for reduction in reductions:
        if reduction["kind"] == "fold_packages":
            groups.extend(reduction["groups"])
    if groups:
        rings = sorted({group["ring"] for group in groups})
        if len(rings) == 1:
            ring_label = "ring {}".format(rings[0])
        else:
            ring_label = "rings {}".format(", ".join(map(str, rings)))
        parts.append("{} packages folded ({})".format(len(groups), ring_label))
    return "%% hidden: {}".format(", ".join(parts)) if parts else None


def reduce_graph(
    nodes,
    edges,
    focus,
    max_nodes,
    max_edges,
    strategy="neighborhood",
    distances=None,
    protected_edges=None,
    protected_nodes=None,
):
    nodes = {node_id: dict(node) for node_id, node in nodes.items()}
    edges = [dict(edge) for edge in edges]
    reductions = []
    hubs = set()
    folded = set()
    distances = dict(distances or {node_id: 0 for node_id in nodes})
    protected_edges = set(protected_edges or ())
    protected_nodes = set(protected_nodes or ())
    dropped_edges = []

    def prune_after(reduction):
        nonlocal nodes, hubs, folded
        nodes, hubs, folded, pruned = _prune_orphans(
            nodes, edges, focus, hubs, folded
        )
        _record_pruned(reduction, pruned)

    if _over_cap(nodes, edges, max_nodes, max_edges):
        edges, hubs, reduction = _fold_hubs(
            nodes, edges, set(focus), protected_edges, protected_nodes
        )
        if reduction:
            prune_after(reduction)
            reductions.append(reduction)
    if not _over_cap(nodes, edges, max_nodes, max_edges):
        return nodes, edges, hubs, folded, reductions

    minimum_ring = 2 if strategy in ("neighborhood", "changeset") else 1
    package_groups = []
    package_pruned = set()
    packages = _package_map(nodes)
    non_focus_count = len(set(nodes) - set(focus))
    group_limit = max(2, non_focus_count // 2)
    rings = sorted(set(distances.values()), reverse=True)
    if len(nodes) <= max_nodes:
        rings = []
    for ring in rings:
        if ring < minimum_ring or strategy == "path":
            continue
        groups = defaultdict(list)
        for node_id in sorted(nodes):
            if distances.get(node_id) == ring and node_id not in focus:
                groups[packages.get(node_id, "(root)")].append(node_id)
        for package in sorted(groups):
            pending = [node_id for node_id in groups[package] if node_id in nodes]
            while len(pending) >= 2:
                size = min(len(pending), group_limit)
                if len(pending) - size == 1 and size > 2:
                    size -= 1
                members = pending[:size]
                pending = pending[size:]
                nodes, edges, hubs, folded, protected_edges, report = _fold_package_group(
                    nodes,
                    edges,
                    hubs,
                    folded,
                    protected_edges,
                    package,
                    ring,
                    members,
                )
                package_groups.append(report)
                current_reduction = {"kind": "fold_packages", "groups": package_groups}
                prune_after(current_reduction)
                package_pruned.update(current_reduction.get("pruned_orphans", []))
                if not _over_cap(nodes, edges, max_nodes, max_edges):
                    _record_pruned(current_reduction, package_pruned)
                    reductions.append(current_reduction)
                    return nodes, edges, hubs, folded, reductions
                if len(nodes) <= max_nodes:
                    break
            if len(nodes) <= max_nodes:
                break
        if len(nodes) <= max_nodes:
            break
    if package_groups:
        package_reduction = {"kind": "fold_packages", "groups": package_groups}
        _record_pruned(package_reduction, package_pruned)
        reductions.append(package_reduction)

    if _over_cap(nodes, edges, max_nodes, max_edges):
        edges, reduction = _drop_edges(edges, max_edges, protected_edges)
        if reduction:
            dropped_edges.extend(reduction.pop("_removed_edges", []))
            prune_after(reduction)
            reductions.append(reduction)
    if not _over_cap(nodes, edges, max_nodes, max_edges):
        return nodes, edges, hubs, folded, reductions

    if strategy in ("neighborhood", "changeset"):
        nodes, edges, reduction = _limit_focus_edges(
            nodes, edges, focus, max_nodes, max_edges
        )
        if reduction:
            _record_pruned(reduction, reduction.get("pruned_orphans", []))
            nodes, hubs, folded, extra_pruned = _prune_orphans(
                nodes, edges, focus, hubs, folded
            )
            _record_pruned(reduction, extra_pruned)
            reductions.append(reduction)
    edges, restored = _restore_nonfocus_edges(
        edges, dropped_edges, nodes, focus, max_edges
    )
    if restored:
        reductions.append(
            {
                "kind": "restore_edges",
                "edges": len(restored),
                "refs": sum(edge["count"] for edge in restored),
            }
        )
    return nodes, edges, hubs, folded, reductions


def _short_label(path):
    path = str(path).replace("\\", "/")
    if len(path) <= 52:
        return path
    parts = path.split("/")
    if len(parts) == 1:
        return parts[0][:25] + "…" + parts[0][-25:]
    prefix = parts[0] + "/…/"
    suffix = []
    for part in reversed(parts[1:]):
        candidate = prefix + "/".join([part] + suffix)
        if suffix and len(candidate) > 52:
            break
        suffix.insert(0, part)
    return prefix + "/".join(suffix)


def _clean_label(label):
    return re.sub(r"[\r\n]+", " ", str(label)).replace('"', "'")


def _strip_generated_suffix(label):
    label = re.sub(r"/\* \(\d+ files\)$", "", str(label))
    return re.sub(r" \(\d+ refs\)$", "", label)


def _node_label(node_id, node, aliases, hubs):
    label = aliases.get(node_id, _short_label(node["path"]))
    label = _strip_generated_suffix(label)
    if "folded_members" in node:
        label = "{}/* ({} files)".format(label.rstrip("/"), len(node["folded_members"]))
    if node_id in hubs:
        label = "{} ({} refs)".format(label, node.get("hub_refs", node["refs"]))
    return _clean_label(label)


def _node_declaration(node_id, node, aliases, hubs):
    label = _node_label(node_id, node, aliases, hubs)
    if node["kind"] == "external":
        return '    {}(("{}"))'.format(node_id, label)
    return '    {}["{}"]'.format(node_id, label)


def _edge_declaration(edge):
    dotted = edge["kind"] in ("test", "dynamic")
    arrow = "-.->" if dotted else "-->"
    label = None
    if edge["kind"] == "test":
        label = "test ×{}".format(edge["count"]) if edge["count"] > 1 else "test"
    elif edge["count"] > 1:
        label = str(edge["count"])
    if label is not None:
        arrow += "|{}|".format(label)
    return "    {} {} {}".format(edge["from"], arrow, edge["to"])


def render_mermaid(nodes, edges, focus, aliases, hubs, folded, strategy, comments=None):
    comments = comments or []
    lines = ["flowchart LR"]
    lines.append(
        "    %% codemap: strategy={} focus={}".format(strategy, ",".join(focus))
    )
    for comment in comments:
        lines.append("    " + comment)

    focus_order = [node_id for node_id in focus if node_id in nodes]
    remainder = sorted(node_id for node_id in nodes if node_id not in focus_order)
    for node_id in focus_order + remainder:
        lines.append(_node_declaration(node_id, nodes[node_id], aliases, hubs))
    for edge in sorted(edges, key=_edge_key):
        lines.append(_edge_declaration(edge))

    lines.extend(
        [
            "    classDef focus fill:#fff3bf,stroke:#e67700,stroke-width:3px",
            "    classDef hub fill:#f3f0ff,stroke:#7048e8,stroke-dasharray:5 3",
            "    classDef folded fill:#e7f5ff,stroke:#1971c2,stroke-dasharray:4 2",
            "    classDef external fill:#f8f9fa,stroke:#868e96,color:#495057",
        ]
    )
    external = sorted(
        node_id for node_id, node in nodes.items() if node["kind"] == "external"
    )
    class_sets = [
        (external, "external"),
        (sorted(hubs & set(nodes)), "hub"),
        (sorted(folded & set(nodes)), "folded"),
        (focus_order, "focus"),
    ]
    for members, class_name in class_sets:
        if members:
            lines.append("    class {} {}".format(",".join(members), class_name))
    return "\n".join(lines) + "\n"


def _write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _split_graph(nodes, edges, focus, max_nodes, max_edges, out_path):
    if edges and max_nodes < 2:
        raise CodemapError("cannot split edges into pictures with fewer than two nodes")
    if edges and max_edges < 1:
        raise CodemapError("cannot split edges into pictures with an edge cap of zero")

    focus = [node_id for node_id in focus if node_id in nodes]
    if not focus:
        raise CodemapError("cannot split a picture without a focus node")
    chunks = []
    chunk_nodes = []
    chunk_node_set = set()
    chunk_edges = []
    for edge in sorted(edges, key=_edge_key):
        edge_nodes = {edge["from"], edge["to"]}
        edge_focus = [node_id for node_id in focus if node_id in edge_nodes]
        anchor = edge_focus[0] if edge_focus else focus[0]
        required = edge_nodes | {anchor}
        if len(required) > max_nodes:
            raise CodemapError(
                "cannot split a non-focus edge while keeping a focus node in every picture"
            )
        if chunk_edges and (
            len(chunk_edges) >= max_edges
            or len(chunk_node_set | required) > max_nodes
        ):
            chunks.append((chunk_nodes, chunk_edges))
            chunk_nodes = []
            chunk_node_set = set()
            chunk_edges = []
        if not chunk_nodes:
            chunk_nodes.append(anchor)
            chunk_node_set.add(anchor)
        for node_id in sorted(edge_nodes):
            if node_id not in chunk_node_set:
                chunk_nodes.append(node_id)
                chunk_node_set.add(node_id)
        chunk_edges.append(edge)
    if chunk_edges:
        chunks.append((chunk_nodes, chunk_edges))

    covered = {node_id for chunk, _ in chunks for node_id in chunk}
    remaining = [
        node_id for node_id in focus if node_id in nodes and node_id not in covered
    ]
    remaining.extend(
        sorted(
            node_id
            for node_id in nodes
            if node_id not in covered and node_id not in remaining
        )
    )
    while remaining:
        if max_nodes == 1 and any(node_id not in focus for node_id in remaining):
            raise CodemapError(
                "cannot split non-focus nodes while keeping a focus node in every picture"
            )
        first_focus = next((node_id for node_id in remaining if node_id in focus), focus[0])
        chunk = [first_focus]
        remaining = [node_id for node_id in remaining if node_id != first_focus]
        take = max_nodes - 1
        chunk.extend(remaining[:take])
        remaining = remaining[take:]
        chunks.append((chunk, []))

    stem = Path(out_path).stem
    parent = Path(out_path).parent
    written = []
    pictures = []
    for index, (chunk, chunk_edges) in enumerate(chunks, 1):
        chunk_set = set(chunk)
        chunk_focus = [node_id for node_id in focus if node_id in chunk_set]
        path = Path(out_path) if index == 1 else parent / "{}-part{}.mmd".format(stem, index)
        written.append(str(path))
        pictures.append((path, chunk, chunk_edges, chunk_focus))
    return written, pictures


def build(args):
    if args.max_nodes < 1 or args.max_edges < 0:
        raise CodemapError("max node/edge caps must be positive (edges may be zero)")
    if args.hard_nodes < 1 or args.hard_edges < 0:
        raise CodemapError("hard node/edge caps must be positive (edges may be zero)")
    if args.max_nodes > args.hard_nodes or args.max_edges > args.hard_edges:
        raise CodemapError("target caps cannot exceed hard caps")

    skipped_edges = []
    id_aliases = {}
    all_nodes, all_edges = load_graph(
        args.graph, getattr(args, "lenient", False), skipped_edges, id_aliases
    )
    memory = load_memory(args.memory)
    remembered_summaries = set(_summary_members(memory))
    memory["aliases"] = {
        id_aliases.get(node_id, node_id): _strip_generated_suffix(value)
        for node_id, value in memory["aliases"].items()
        if node_id not in remembered_summaries
    }
    omitted = {
        id_aliases.get(node_id, node_id) for node_id in _expand_omitted(memory)
    }
    memory["omitted"] = sorted(omitted)
    focus = []
    for value in args.focus.split(","):
        raw_focus = value.strip()
        node_id = id_aliases.get(raw_focus, _safe_explicit_id(raw_focus))
        if node_id and node_id not in focus:
            focus.append(node_id)
    omitted_focus = [node_id for node_id in focus if node_id in omitted]
    if omitted_focus:
        message = (
            "focus node(s) are omitted by memory: {}; "
            "remove them from 'omitted' to focus them"
        )
        raise CodemapError(
            message.format(", ".join(omitted_focus))
        )
    nodes = {
        node_id: node
        for node_id, node in all_nodes.items()
        if node_id not in omitted
    }
    edges = [
        edge
        for edge in all_edges
        if edge["from"] in nodes and edge["to"] in nodes
    ]
    nodes, edges, selection = _select_graph_details(
        nodes,
        edges,
        focus,
        args.strategy,
        args.hops,
        args.hard_nodes,
        args.hard_edges,
    )
    nodes, edges, hubs, reduced_folded, reductions = reduce_graph(
        nodes,
        edges,
        focus,
        args.max_nodes,
        args.max_edges,
        args.strategy,
        selection["distances"],
        selection["protected_edges"],
        selection["protected_nodes"],
    )
    folded = set(selection["folded"]) | set(reduced_folded)
    if not any(node_id in nodes for node_id in focus):
        raise CodemapError("reductions removed every focus node")
    hidden = _hidden_comment(nodes, reductions, selection["summary_groups"])
    comments = [hidden] if hidden else []

    split_files = []
    picture_counts = []
    if _over_cap(nodes, edges, args.max_nodes, args.max_edges):
        split_files, pictures = _split_graph(
            nodes, edges, focus, args.max_nodes, args.max_edges, args.out
        )
        reductions.append(
            {
                "kind": "split",
                "reason": "reductions could not reach the target cap",
                "pictures": len(pictures),
            }
        )
        for path, chunk, chunk_edges, chunk_focus in pictures:
            chunk_nodes = {node_id: nodes[node_id] for node_id in chunk}
            text = render_mermaid(
                chunk_nodes,
                chunk_edges,
                chunk_focus,
                memory["aliases"],
                hubs,
                folded,
                args.strategy,
                comments
                + ["%% split picture; remaining edges continue in companion pictures"],
            )
            _write_text(path, text)
            picture_counts.append((len(chunk_nodes), len(chunk_edges)))
    else:
        text = render_mermaid(
            nodes,
            edges,
            focus,
            memory["aliases"],
            hubs,
            folded,
            args.strategy,
            comments,
        )
        _write_text(args.out, text)
        picture_counts.append((len(nodes), len(edges)))

    memory["last"] = {
        "focus": focus,
        "strategy": args.strategy,
        "reductions": reductions,
        "summaries": selection["summary_groups"],
    }
    _write_json(args.memory, memory)
    report = {
        "nodes": max(count[0] for count in picture_counts) if picture_counts else 0,
        "edges": max(count[1] for count in picture_counts) if picture_counts else 0,
        "strategy": args.strategy,
        "reductions": reductions,
        "split": split_files,
        "pruned_orphans": sorted(
            {
                node_id
                for reduction in reductions
                for node_id in reduction.get("pruned_orphans", [])
            }
        ),
    }
    if skipped_edges:
        report["skipped_edges"] = skipped_edges
    if args.strategy == "neighborhood":
        report["hops_used"] = selection["hops_used"]
        report["hop2_summarized"] = selection["hop2_summarized"]
    if args.strategy == "path":
        report["paths_found"] = selection.get("paths_found", 0)
    return report


def parser():
    command = argparse.ArgumentParser(
        description="Draw a bounded codebase map from a host-supplied graph index."
    )
    command.add_argument("graph", help="graph JSON file")
    command.add_argument("--focus", required=True, help="comma-separated node ids")
    command.add_argument("--strategy", required=True, choices=sorted(STRATEGIES))
    command.add_argument(
        "--hops", type=int, default=1, help="walk depth; for path, number of paths"
    )
    command.add_argument("--memory", default=".mmx/codemap.json")
    command.add_argument("--out", default="map.mmd")
    command.add_argument("--max-nodes", type=int, default=25)
    command.add_argument("--max-edges", type=int, default=40)
    command.add_argument("--hard-nodes", type=int, default=40)
    command.add_argument("--hard-edges", type=int, default=60)
    command.add_argument(
        "--lenient",
        action="store_true",
        help="skip edges with unknown endpoints and report them",
    )
    return command


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        report = build(args)
    except (CodemapError, OSError, json.JSONDecodeError) as error:
        print("codemap: {}".format(error), file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
