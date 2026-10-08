#!/usr/bin/env python3
"""Regenerate graph.json, the deterministic stress fixture for codemap.py."""

import json
from pathlib import Path


PACKAGES = [
    "api",
    "auth",
    "cli",
    "core",
    "db",
    "events",
    "jobs",
    "model",
    "search",
    "tests",
    "ui",
    "util",
]
FILES_PER_PACKAGE = 17


def node_id(package, number):
    return "{}_file_{:02d}_rs".format(package, number)


def build():
    nodes = []
    edges = []
    for package in PACKAGES:
        for number in range(FILES_PER_PACKAGE):
            nodes.append(
                {
                    "id": node_id(package, number),
                    "path": "{}/file_{:02d}.rs".format(package, number),
                    "kind": "file",
                    "refs": 0,
                }
            )
            if number:
                edges.append(
                    {
                        "from": node_id(package, number),
                        "to": node_id(package, number - 1),
                        "kind": "import",
                        "count": 1 + (number % 4),
                    }
                )
            if package != "core":
                edges.append(
                    {
                        "from": node_id(package, number),
                        "to": node_id("core", 0),
                        "kind": "call",
                        "count": 1 + (number % 3),
                    }
                )
            if package not in ("core", "util") and number % 2 == 0:
                edges.append(
                    {
                        "from": node_id(package, number),
                        "to": node_id("util", 0),
                        "kind": "import",
                        "count": 1,
                    }
                )
            if package not in ("events", "tests") and number % 5 == 0:
                edges.append(
                    {
                        "from": node_id(package, number),
                        "to": node_id("events", 0),
                        "kind": "dynamic",
                        "count": 1,
                    }
                )
    for index, package in enumerate(PACKAGES):
        target = PACKAGES[(index + 1) % len(PACKAGES)]
        edges.append(
            {
                "from": node_id(package, 0),
                "to": node_id(target, 0),
                "kind": "import",
                "count": 2,
            }
        )
    for number in range(FILES_PER_PACKAGE):
        edges.append(
            {
                "from": node_id("tests", number),
                "to": node_id(PACKAGES[number % 9], number),
                "kind": "test",
                "count": 1 + (number % 2),
            }
        )

    refs = {node["id"]: 0 for node in nodes}
    for edge in edges:
        refs[edge["from"]] += edge["count"]
        refs[edge["to"]] += edge["count"]
    for node in nodes:
        node["refs"] = refs[node["id"]]
    return {"nodes": nodes, "edges": edges}


def main():
    target = Path(__file__).with_name("graph.json")
    target.write_text(json.dumps(build(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
