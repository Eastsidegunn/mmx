#!/usr/bin/env python3

import argparse
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import codemap


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GRAPH = HERE / "example" / "graph.json"
MMX = REPO / "target" / "release" / "mmx"


class CodemapTests(unittest.TestCase):
    def args(self, directory, strategy, focus, hops=1, **overrides):
        values = {
            "graph": str(GRAPH),
            "focus": focus,
            "strategy": strategy,
            "hops": hops,
            "memory": str(Path(directory) / "memory.json"),
            "out": str(Path(directory) / "map.mmd"),
            "max_nodes": 25,
            "max_edges": 40,
            "hard_nodes": 40,
            "hard_edges": 60,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def write_graph(self, directory, nodes, edges):
        graph = Path(directory, "graph.json")
        graph.write_text(
            json.dumps({"nodes": nodes, "edges": edges}), encoding="utf-8"
        )
        return graph

    def node(self, node_id, path=None, refs=0):
        return {
            "id": node_id,
            "path": path or "pkg/{}.rs".format(node_id),
            "kind": "file",
            "refs": refs,
        }

    def edge(self, source, target, count=1, kind="call"):
        return {"from": source, "to": target, "kind": kind, "count": count}

    def test_each_strategy_stays_within_caps(self):
        cases = [
            ("neighborhood", "api_file_08_rs", 2),
            ("neighborhood", "core_file_00_rs", 2),
            ("path", "api_file_08_rs,core_file_00_rs", 3),
            ("impact", "core_file_00_rs", 2),
            ("changeset", "api_file_08_rs,db_file_06_rs", 3),
        ]
        for strategy, focus, hops in cases:
            with self.subTest(strategy=strategy), tempfile.TemporaryDirectory() as directory:
                report = codemap.build(self.args(directory, strategy, focus, hops))
                self.assertLessEqual(report["nodes"], 25)
                self.assertLessEqual(report["edges"], 40)
                self.assertEqual(report["strategy"], strategy)

    def test_reproduction_keeps_top_focus_edges_and_stops_when_it_fits(self):
        with tempfile.TemporaryDirectory() as directory:
            report = codemap.build(
                self.args(directory, "neighborhood", "core_file_00_rs", 2)
            )
            kinds = [reduction["kind"] for reduction in report["reductions"]]
            self.assertEqual(
                kinds, ["fold_hubs", "drop_edges", "limit_focus_edges"]
            )
            self.assertLessEqual(report["nodes"], 25)
            self.assertLessEqual(report["edges"], 40)
            self.assertFalse(report["split"])
            limited = report["reductions"][-1]
            self.assertEqual(limited["kept"], 24)
            self.assertEqual(limited["dropped"], 167)
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            incident = [
                line
                for line in source.splitlines()
                if "-->" in line and "core_file_00_rs" in line
            ]
            self.assertEqual(len(incident), 24)
            self.assertTrue(all("|3|" in line for line in incident))
            self.assertNotIn("hubs (", source)
            self.assertIn("195 low-weight edges", source)
            self.assertIn("167 excess focus edges", source)

    def test_reduction_rechecks_and_stops_after_hub_folding(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("focus"), self.node("hub")]
            nodes.extend(self.node("leaf{:02d}".format(index)) for index in range(10))
            edges = [self.edge("focus", "hub", 5)]
            edges.extend(
                self.edge("hub", "leaf{:02d}".format(index)) for index in range(10)
            )
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "focus",
                    2,
                    graph=str(graph),
                    max_nodes=20,
                    max_edges=3,
                    hard_nodes=30,
                    hard_edges=30,
                )
            )
            self.assertEqual(
                [item["kind"] for item in report["reductions"]], ["fold_hubs"]
            )
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn("focus -->|5| hub", source)
            self.assertNotIn("hub --> leaf", source)

    def test_hop_two_is_summarized_when_expansion_would_cross_hard_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("focus"), self.node("near")]
            nodes.extend(
                self.node("far{:02d}".format(index), "far/file_{:02d}.rs".format(index))
                for index in range(12)
            )
            edges = [self.edge("focus", "near", 4)]
            edges.extend(
                self.edge("near", "far{:02d}".format(index)) for index in range(12)
            )
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "focus",
                    2,
                    graph=str(graph),
                    max_nodes=4,
                    max_edges=4,
                    hard_nodes=8,
                    hard_edges=8,
                )
            )
            self.assertEqual(report["hops_used"], 1)
            self.assertTrue(report["hop2_summarized"])
            self.assertEqual(report["reductions"], [])
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn('folded_far_ring2["far/* (6 files)"]', source)
            self.assertIn('folded_far_ring2_2["far/* (6 files)"]', source)
            self.assertIn("near -->|6| folded_far_ring2", source)
            self.assertIn("2 packages folded (ring 2)", source)

    def test_focus_adjacent_hub_keeps_the_focus_edge(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("focus"), self.node("hub")]
            nodes.extend(self.node("leaf{:02d}".format(index)) for index in range(10))
            edges = [self.edge("focus", "hub", 7)]
            edges.extend(
                self.edge("hub", "leaf{:02d}".format(index)) for index in range(10)
            )
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "focus",
                    2,
                    graph=str(graph),
                    max_nodes=20,
                    max_edges=2,
                    hard_nodes=30,
                    hard_edges=30,
                )
            )
            hubs = report["reductions"][0]
            self.assertEqual(hubs["nodes"], ["hub"])
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn("focus -->|7| hub", source)

    def test_drop_edges_keeps_all_focus_incident_edges_when_they_fit(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [
                self.node(node_id)
                for node_id in ("focus", "a", "b", "c", "x", "y")
            ]
            edges = [
                self.edge("focus", "a"),
                self.edge("b", "focus", 2),
                self.edge("focus", "c", 3),
                self.edge("a", "x"),
                self.edge("a", "y"),
                self.edge("b", "x"),
                self.edge("b", "y"),
                self.edge("c", "x"),
                self.edge("c", "y"),
            ]
            graph = self.write_graph(directory, nodes, edges)
            codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "focus",
                    2,
                    graph=str(graph),
                    max_nodes=20,
                    max_edges=4,
                    hard_nodes=30,
                    hard_edges=30,
                )
            )
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn("focus --> a", source)
            self.assertIn("b -->|2| focus", source)
            self.assertIn("focus -->|3| c", source)

    def test_distant_ring_folds_before_low_weight_edges_drop(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("focus"), self.node("near1"), self.node("near2")]
            nodes.extend(
                self.node("far{:02d}".format(index), "far/file_{:02d}.rs".format(index))
                for index in range(6)
            )
            edges = [
                self.edge("focus", "near1", 5),
                self.edge("focus", "near2", 5),
                self.edge("near1", "near2"),
            ]
            edges.extend(
                self.edge("near{}".format(1 + index % 2), "far{:02d}".format(index))
                for index in range(6)
            )
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "focus",
                    2,
                    graph=str(graph),
                    max_nodes=5,
                    max_edges=2,
                    hard_nodes=20,
                    hard_edges=20,
                )
            )
            kinds = [item["kind"] for item in report["reductions"]]
            self.assertLess(kinds.index("fold_packages"), kinds.index("drop_edges"))
            groups = next(
                item["groups"]
                for item in report["reductions"]
                if item["kind"] == "fold_packages"
            )
            self.assertEqual({group["ring"] for group in groups}, {2})

    def test_path_edges_are_never_folded_or_dropped(self):
        nodes = {node["id"]: node for node in [
            self.node("start"), self.node("a"), self.node("b"), self.node("end")
        ]}
        edges = [
            self.edge("start", "a", 5),
            self.edge("a", "b", 5),
            self.edge("b", "end", 5),
            self.edge("b", "a"),
            self.edge("end", "a"),
            self.edge("a", "start"),
        ]
        selected_nodes, selected_edges, details = codemap._select_graph_details(
            nodes, edges, ["start", "end"], "path", 1
        )
        reduced = codemap.reduce_graph(
            selected_nodes,
            selected_edges,
            ["start", "end"],
            10,
            4,
            "path",
            details["distances"],
            details["protected_edges"],
            details["protected_nodes"],
        )
        retained = {codemap._edge_identity(edge) for edge in reduced[1]}
        self.assertTrue(details["protected_edges"].issubset(retained))
        self.assertEqual(reduced[2], set())
        self.assertEqual(reduced[3], set())

    def test_impact_shortest_reverse_paths_are_protected(self):
        nodes = {node["id"]: node for node in [
            self.node("focus"), self.node("a"), self.node("b"), self.node("c")
        ]}
        edges = [
            self.edge("a", "focus", 5),
            self.edge("b", "a", 5),
            self.edge("c", "a", 4),
            self.edge("b", "c"),
            self.edge("c", "b"),
            self.edge("a", "b"),
        ]
        selected_nodes, selected_edges, details = codemap._select_graph_details(
            nodes, edges, ["focus"], "impact", 3
        )
        reduced = codemap.reduce_graph(
            selected_nodes,
            selected_edges,
            ["focus"],
            10,
            len(details["protected_edges"]),
            "impact",
            details["distances"],
            details["protected_edges"],
            details["protected_nodes"],
        )
        retained = {codemap._edge_identity(edge) for edge in reduced[1]}
        self.assertTrue(details["protected_edges"].issubset(retained))

    def test_hub_folding_is_bounded_to_ten_percent(self):
        nodes = {
            "hub{:02d}".format(index): self.node("hub{:02d}".format(index))
            for index in range(15)
        }
        nodes.update(
            {
                "leaf{:02d}".format(index): self.node("leaf{:02d}".format(index))
                for index in range(85)
            }
        )
        edges = []
        for hub in range(15):
            for offset in range(20):
                leaf = (hub * 20 + offset) % 85
                edges.append(
                    self.edge(
                        "hub{:02d}".format(hub), "leaf{:02d}".format(leaf)
                    )
                )
        _, hubs, reduction = codemap._fold_hubs(nodes, edges, set(), set(), set())
        self.assertEqual(len(hubs), 10)
        self.assertLessEqual(len(hubs), 10)
        self.assertEqual(reduction["threshold"], 20)

    def test_focus_nodes_are_never_folded(self):
        with tempfile.TemporaryDirectory() as directory:
            report = codemap.build(
                self.args(directory, "impact", "core_file_00_rs", 2)
            )
            hub_nodes = set()
            for reduction in report["reductions"]:
                if reduction["kind"] == "fold_hubs":
                    hub_nodes.update(reduction["nodes"])
                elif reduction["kind"] == "fold_packages":
                    for group in reduction["groups"]:
                        self.assertNotEqual(group["node"], "core_file_00_rs")
            self.assertNotIn("core_file_00_rs", hub_nodes)
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn('core_file_00_rs["core/file_00.rs"]', source)
            self.assertIn("class core_file_00_rs focus", source)
            self.assertNotIn("core_file_00_rs (", source)

    def test_edge_styles_counts_and_external_shape_follow_drawing_contract(self):
        nodes = {
            "app": {"id": "app", "path": "src/app.py", "kind": "file", "refs": 3},
            "dep": {"id": "dep", "path": "vendor/sdk", "kind": "external", "refs": 3},
        }
        single_test = [{"from": "app", "to": "dep", "kind": "test", "count": 1}]
        source = codemap.render_mermaid(
            nodes, single_test, ["app"], {}, set(), set(), "neighborhood"
        )
        self.assertIn('dep(("vendor/sdk"))', source)
        self.assertIn("app -.->|test| dep", source)
        counted = [{"from": "app", "to": "dep", "kind": "test", "count": 3}]
        source = codemap.render_mermaid(
            nodes, counted, ["app"], {}, set(), set(), "neighborhood"
        )
        self.assertIn("app -.->|test ×3| dep", source)

    def test_ids_are_deterministic_from_paths(self):
        self.assertEqual(codemap.derive_id("src/serve.rs"), "src_serve_rs")
        self.assertEqual(codemap.derive_id("pkg/a-b+c.rs"), "pkg_a_b_c_rs")
        self.assertEqual(codemap.derive_id("end"), "n_end")
        self.assertTrue(codemap.derive_id("src/한글.rs").startswith("src__xd55c"))
        with tempfile.TemporaryDirectory() as directory:
            graph = Path(directory, "graph.json")
            graph.write_text(
                json.dumps(
                    {
                        "nodes": [
                            {"path": "src/serve.rs", "kind": "file", "refs": 0}
                        ],
                        "edges": [],
                    }
                ),
                encoding="utf-8",
            )
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    "src_serve_rs",
                    graph=str(graph),
                )
            )
            self.assertEqual(report["nodes"], 1)
            self.assertIn(
                'src_serve_rs["src/serve.rs"]',
                Path(directory, "map.mmd").read_text(encoding="utf-8"),
            )

    def test_colliding_derived_ids_get_stable_hash_suffixes(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = self.write_graph(
                directory,
                [
                    {"path": "src/a-b.rs", "kind": "file"},
                    {"path": "src/a_b.rs", "kind": "file"},
                    {"path": "src/한글.rs", "kind": "file"},
                    {"path": "src/日本.rs", "kind": "file"},
                ],
                [],
            )
            nodes, _ = codemap.load_graph(graph)
            self.assertEqual(len(nodes), 4)
            self.assertIn("src_a_b_rs", nodes)
            self.assertTrue(any(re.match(r"src_a_b_rs_[0-9a-f]{6}$", value) for value in nodes))
            self.assertEqual(len(set(nodes)), 4)
            reversed_graph = self.write_graph(
                directory,
                list(reversed([
                    {"path": "src/a-b.rs", "kind": "file"},
                    {"path": "src/a_b.rs", "kind": "file"},
                    {"path": "src/한글.rs", "kind": "file"},
                    {"path": "src/日本.rs", "kind": "file"},
                ])),
                [],
            )
            reversed_nodes, _ = codemap.load_graph(reversed_graph)
            self.assertEqual(set(nodes), set(reversed_nodes))

    def test_labels_replace_quotes_and_newlines_but_not_html_characters(self):
        nodes = {"a": self.node("a")}
        source = codemap.render_mermaid(
            nodes,
            [],
            ["a"],
            {"a": 'a & b < c > d "quoted"\nnext'},
            set(),
            set(),
            "neighborhood",
        )
        self.assertIn('a["a & b < c > d \'quoted\' next"]', source)
        self.assertNotIn("&amp;", source)

    @unittest.skipUnless(MMX.is_file(), "target/release/mmx is missing")
    def test_ampersand_alias_round_trips_through_real_mmx_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "map.mmd")
            path.write_text(
                codemap.render_mermaid(
                    {"a": self.node("a")}, [], ["a"], {"a": "a & b"},
                    set(), set(), "neighborhood"
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [str(MMX), "render", str(path), "--by", "agent"],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            state = json.loads(path.with_suffix(".state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["nodes"]["a"]["label"], "a & b")

    def test_reserved_path_id_and_newline_alias_render_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = self.write_graph(
                directory,
                [{"path": "end", "kind": "file"}],
                [],
            )
            memory = Path(directory, "memory.json")
            memory.write_text(
                json.dumps({"aliases": {"n_end": "one\ntwo"}, "omitted": []}),
                encoding="utf-8",
            )
            report = codemap.build(
                self.args(directory, "neighborhood", "n_end", graph=str(graph))
            )
            self.assertEqual(report["nodes"], 1)
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn('n_end["one two"]', source)

    def test_thirty_neighbors_keep_one_picture_and_top_24_edges(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("focus")]
            nodes.extend(self.node("n{:02d}".format(index)) for index in range(30))
            edges = [
                self.edge("focus", "n{:02d}".format(index), index + 1)
                for index in range(30)
            ]
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(directory, "neighborhood", "focus", 1, graph=str(graph))
            )
            self.assertFalse(report["split"])
            self.assertEqual(report["nodes"], 25)
            self.assertEqual(report["edges"], 24)
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertNotIn("focus --> n05", source)
            self.assertIn("focus -->|7| n06", source)
            self.assertIn("focus -->|30| n29", source)

    def test_pruned_hop_summary_does_not_create_empty_split_part(self):
        with tempfile.TemporaryDirectory() as directory:
            nodes = [self.node("f", "a/f.rs")]
            nodes.extend(
                self.node("r{:02d}".format(i), "a/r{:02d}.rs".format(i))
                for i in range(30)
            )
            nodes.append(self.node("b1", "b/b1.rs"))
            nodes.extend(self.node("c{}".format(i), "c/c{}.rs".format(i)) for i in range(15))
            edges = [self.edge("f", "r{:02d}".format(i)) for i in range(30)]
            edges.append(self.edge("r00", "b1"))
            edges.extend(self.edge("r{:02d}".format(i), "c{}".format(i)) for i in range(15))
            graph = self.write_graph(directory, nodes, edges)
            report = codemap.build(
                self.args(directory, "neighborhood", "f", 2, graph=str(graph))
            )
            self.assertFalse(report["split"])
            self.assertIn("folded_c_ring2", report["pruned_orphans"])
            self.assertEqual(report["nodes"], 25)

    def test_package_detection_strips_common_root_and_uses_second_level(self):
        nodes = {
            "focus": self.node("focus", "src/layout/mod.rs"),
            "root": self.node("root", "src/lib.rs"),
            "render": self.node("render", "src/render.rs"),
        }
        for index in range(6):
            nodes["flow{}".format(index)] = self.node(
                "flow{}".format(index), "src/layout/flowchart/f{}.rs".format(index)
            )
        nodes["seq"] = self.node("seq", "src/layout/sequence.rs")
        packages = codemap._package_map(nodes)
        self.assertEqual(packages["root"], "(root)")
        self.assertEqual(packages["flow0"], "layout/flowchart")
        self.assertEqual(packages["seq"], "layout")

    def test_short_label_keeps_package_prefix(self):
        label = codemap._short_label(
            "package/very/long/path/with/many/more/nested/directories/than/fit/file.rs"
        )
        self.assertTrue(label.startswith("package/…/"))
        self.assertTrue(label.endswith("file.rs"))

    def test_path_report_includes_paths_found(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = self.write_graph(
                directory,
                [self.node("a"), self.node("b")],
                [self.edge("a", "b")],
            )
            report = codemap.build(
                self.args(directory, "path", "a,b", 3, graph=str(graph))
            )
            self.assertEqual(report["paths_found"], 1)

    def test_lenient_skips_unknown_endpoints_and_reports_them(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = self.write_graph(
                directory,
                [self.node("a")],
                [self.edge("a", "missing")],
            )
            args = self.args(directory, "neighborhood", "a", graph=str(graph))
            args.lenient = True
            report = codemap.build(args)
            self.assertEqual(report["skipped_edges"][0]["to"], "missing")
            self.assertEqual(report["edges"], 0)

    def test_summary_omission_expands_to_member_files(self):
        memory = {
            "aliases": {},
            "omitted": ["folded_pkg_ring2"],
            "last": {
                "summaries": [
                    {"node": "folded_pkg_ring2", "members": ["a", "b"]}
                ]
            },
        }
        self.assertEqual(codemap._expand_omitted(memory), {"a", "b"})

    def test_generated_suffixes_are_not_persisted_as_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            graph = self.write_graph(directory, [self.node("focus")], [])
            memory_path = Path(directory, "memory.json")
            memory_path.write_text(
                json.dumps(
                    {
                        "aliases": {
                            "focus": "friendly (12 refs)",
                            "folded_pkg_ring2": "pkg/* (3 files)",
                        },
                        "omitted": [],
                        "last": {
                            "summaries": [
                                {
                                    "node": "folded_pkg_ring2",
                                    "members": ["a", "b", "c"],
                                }
                            ]
                        },
                    }
                ),
                encoding="utf-8",
            )
            codemap.build(
                self.args(directory, "neighborhood", "focus", graph=str(graph))
            )
            memory = json.loads(memory_path.read_text(encoding="utf-8"))
            self.assertEqual(memory["aliases"], {"focus": "friendly"})

    def test_aliases_and_omitted_nodes_are_honored(self):
        with tempfile.TemporaryDirectory() as directory:
            memory_path = Path(directory, "memory.json")
            memory_path.write_text(
                json.dumps(
                    {
                        "aliases": {"api_file_08_rs": "request router"},
                        "omitted": ["api_file_07_rs"],
                        "last": {},
                    }
                ),
                encoding="utf-8",
            )
            report = codemap.build(
                self.args(directory, "neighborhood", "api_file_08_rs")
            )
            self.assertFalse(report["split"])
            source = Path(directory, "map.mmd").read_text(encoding="utf-8")
            self.assertIn('api_file_08_rs["request router"]', source)
            self.assertNotIn("api_file_07_rs", source)
            memory = json.loads(memory_path.read_text(encoding="utf-8"))
            self.assertEqual(memory["aliases"]["api_file_08_rs"], "request router")
            self.assertEqual(memory["omitted"], ["api_file_07_rs"])
            self.assertEqual(memory["last"]["strategy"], "neighborhood")

    def test_split_is_last_resort_and_only_when_needed(self):
        with tempfile.TemporaryDirectory() as directory:
            reducible = codemap.build(
                self.args(directory, "impact", "core_file_00_rs", 2)
            )
            self.assertEqual(reducible["split"], [])
            self.assertNotIn(
                "split", [item["kind"] for item in reducible["reductions"]]
            )

        with tempfile.TemporaryDirectory() as directory:
            nodes = [
                {
                    "id": "focus_{:02d}".format(index),
                    "path": "pkg/focus_{:02d}.rs".format(index),
                    "kind": "file",
                    "refs": 0,
                }
                for index in range(27)
            ]
            graph = Path(directory, "graph.json")
            graph.write_text(json.dumps({"nodes": nodes, "edges": []}), encoding="utf-8")
            focus = ",".join(node["id"] for node in nodes)
            report = codemap.build(
                self.args(
                    directory,
                    "neighborhood",
                    focus,
                    graph=str(graph),
                    max_nodes=10,
                    max_edges=5,
                    hard_nodes=40,
                    hard_edges=60,
                )
            )
            self.assertEqual(
                [item["kind"] for item in report["reductions"]], ["split"]
            )
            self.assertEqual(len(report["split"]), 3)
            self.assertLessEqual(report["nodes"], 10)
            self.assertEqual(Path(report["split"][0]), Path(directory, "map.mmd"))
            self.assertEqual(Path(report["split"][1]).name, "map-part2.mmd")
            for filename in report["split"]:
                self.assertTrue(Path(filename).is_file())
            self.assertTrue(Path(directory, "map.mmd").exists())

    def test_rust_indexer_finds_file_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory, "src")
            root.mkdir()
            Path(root, "lib.rs").write_text(
                "mod api;\nuse crate::model::Thing;\n", encoding="utf-8"
            )
            Path(root, "api.rs").write_text(
                "use super::model::Thing;\n", encoding="utf-8"
            )
            Path(root, "model.rs").write_text("pub struct Thing;\n", encoding="utf-8")
            result = subprocess.run(
                ["python3", str(HERE / "example" / "index_rust.py"), str(root)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            graph = json.loads(result.stdout)
            self.assertEqual(len(graph["nodes"]), 3)
            pairs = {(edge["from"], edge["to"]) for edge in graph["edges"]}
            self.assertIn(("src_lib_rs", "src_api_rs"), pairs)
            self.assertIn(("src_api_rs", "src_model_rs"), pairs)

    def test_rust_indexer_handles_inline_nested_binary_and_test_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            crate = Path(directory)
            Path(crate, "Cargo.toml").write_text(
                '[package]\nname = "demo-crate"\n', encoding="utf-8"
            )
            root = Path(crate, "src")
            Path(root, "a").mkdir(parents=True)
            Path(root, "bin").mkdir()
            Path(root, "lib.rs").write_text("mod a;\nmod q;\n", encoding="utf-8")
            Path(root, "a", "mod.rs").write_text(
                "pub mod b;\npub mod c;\nuse crate::{a::{b,c}};\n",
                encoding="utf-8",
            )
            Path(root, "a", "b.rs").write_text("pub struct Thing;\n", encoding="utf-8")
            Path(root, "a", "c.rs").write_text(
                'pub fn go() { let marker = "/* not a comment"; crate::q::go(); }\n',
                encoding="utf-8",
            )
            Path(root, "q.rs").write_text(
                "pub fn go() {}\n#[cfg(test)]\nmod tests {\n"
                "  use crate::a::b::Thing;\n}\n",
                encoding="utf-8",
            )
            Path(root, "main.rs").write_text(
                "fn main() { demo_crate::q::go(); }\n", encoding="utf-8"
            )
            Path(root, "bin", "tool.rs").write_text(
                "use demo_crate::a::b::Thing;\nfn main() {}\n", encoding="utf-8"
            )
            result = subprocess.run(
                ["python3", str(HERE / "example" / "index_rust.py"), str(root)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            graph = json.loads(result.stdout)
            edges = {
                (edge["from"], edge["to"], edge["kind"]): edge["count"]
                for edge in graph["edges"]
            }
            self.assertIn(("src_a_mod_rs", "src_a_b_rs", "import"), edges)
            self.assertIn(("src_a_mod_rs", "src_a_c_rs", "import"), edges)
            self.assertIn(("src_a_c_rs", "src_q_rs", "import"), edges)
            self.assertIn(("src_q_rs", "src_a_b_rs", "test"), edges)
            self.assertIn(("src_main_rs", "src_q_rs", "import"), edges)
            self.assertIn(("src_bin_tool_rs", "src_a_b_rs", "import"), edges)
            self.assertFalse(
                any(
                    edge["from"] == "src_bin_tool_rs"
                    and edge["to"] == "src_lib_rs"
                    for edge in graph["edges"]
                )
            )

    @unittest.skipUnless(MMX.is_file(), "target/release/mmx is missing; skipping real render test")
    def test_every_produced_mermaid_renders_with_real_mmx(self):
        cases = [
            ("neighborhood", "api_file_08_rs", 2),
            ("path", "api_file_08_rs,core_file_00_rs", 3),
            ("impact", "core_file_00_rs", 2),
            ("changeset", "api_file_08_rs,db_file_06_rs", 1),
        ]
        with tempfile.TemporaryDirectory() as directory:
            diagrams = []
            for index, (strategy, focus, hops) in enumerate(cases):
                case_dir = Path(directory, str(index))
                case_dir.mkdir()
                args = self.args(case_dir, strategy, focus, hops)
                report = codemap.build(args)
                diagrams.extend(Path(path) for path in report["split"])
                if not report["split"]:
                    diagrams.append(Path(args.out))

            split_dir = Path(directory, "split")
            split_dir.mkdir()
            split_nodes = [
                {
                    "id": "focus_{:02d}".format(index),
                    "path": "pkg/focus_{:02d}.rs".format(index),
                    "kind": "file",
                    "refs": 0,
                }
                for index in range(27)
            ]
            split_graph = split_dir / "graph.json"
            split_graph.write_text(
                json.dumps({"nodes": split_nodes, "edges": []}), encoding="utf-8"
            )
            split_args = self.args(
                split_dir,
                "neighborhood",
                ",".join(node["id"] for node in split_nodes),
                graph=str(split_graph),
                max_nodes=10,
                max_edges=5,
            )
            split_report = codemap.build(split_args)
            diagrams.extend(Path(path) for path in split_report["split"])

            summary_dir = Path(directory, "hop2-summary")
            summary_dir.mkdir()
            summary_nodes = [self.node("focus"), self.node("near")]
            summary_nodes.extend(
                self.node("far{:02d}".format(index), "far/file_{:02d}.rs".format(index))
                for index in range(12)
            )
            summary_edges = [self.edge("focus", "near")]
            summary_edges.extend(
                self.edge("near", "far{:02d}".format(index)) for index in range(12)
            )
            summary_graph = self.write_graph(summary_dir, summary_nodes, summary_edges)
            summary_args = self.args(
                summary_dir,
                "neighborhood",
                "focus",
                2,
                graph=str(summary_graph),
                max_nodes=4,
                max_edges=4,
                hard_nodes=8,
                hard_edges=8,
            )
            summary_report = codemap.build(summary_args)
            self.assertFalse(summary_report["split"])
            diagrams.append(Path(summary_args.out))

            self_map_dir = Path(directory, "self-maps")
            self_map_dir.mkdir()
            for source in sorted((HERE / "example" / "mmx-self").glob("*.mmd")):
                target = self_map_dir / source.name
                shutil.copyfile(str(source), str(target))
                diagrams.append(target)
            for diagram in diagrams:
                with self.subTest(diagram=diagram.name):
                    result = subprocess.run(
                        [str(MMX), "render", str(diagram), "--by", "agent"],
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    diff = json.loads(diagram.with_suffix(".diff.json").read_text(encoding="utf-8"))
                    self.assertIsNone(diff["error"])
                    self.assertFalse(diff["warnings"])


if __name__ == "__main__":
    unittest.main()
