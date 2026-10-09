#!/usr/bin/env python3
"""Build a small file-level graph from Rust module and path references."""

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


MOD_RE = re.compile(
    r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;"
)
USE_RE = re.compile(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);")
RESERVED_IDS = {
    "end", "subgraph", "graph", "flowchart", "style", "class", "classDef",
    "click", "linkStyle", "direction", "default",
}


def derive_id(path):
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
    value = "".join(pieces) or "node"
    if value[0].isdigit() or value in RESERVED_IDS:
        value = "n_" + value
    return value


def unique_ids(paths):
    result = {}
    used = {}
    for path in sorted(paths, key=str):
        base = derive_id(path)
        node_id = base
        if node_id in used and used[node_id] != str(path):
            suffix = hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:6]
            node_id = "{}_{}".format(base, suffix)
        if node_id in used and used[node_id] != str(path):
            raise ValueError("could not derive a unique id for {!r}".format(str(path)))
        used[node_id] = str(path)
        result[path] = node_id
    return result


def _blank(text):
    return "".join("\n" if character == "\n" else " " for character in text)


def strip_comments(source):
    """Blank comments and literals while preserving offsets and newlines."""
    output = []
    index = 0
    length = len(source)
    while index < length:
        if source.startswith("//", index):
            end = source.find("\n", index)
            end = length if end < 0 else end
            output.append(_blank(source[index:end]))
            index = end
            continue
        if source.startswith("/*", index):
            start = index
            index += 2
            depth = 1
            while index < length and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            output.append(_blank(source[start:index]))
            continue
        raw = re.match(r"(?:br|r)(?P<hashes>#{0,16})\"", source[index:])
        if raw:
            start = index
            terminator = '"' + raw.group("hashes")
            index += raw.end()
            end = source.find(terminator, index)
            index = length if end < 0 else end + len(terminator)
            output.append(_blank(source[start:index]))
            continue
        quote_start = None
        if source[index] == '"':
            quote_start = index
        elif source.startswith('b"', index):
            quote_start = index + 1
        if quote_start is not None:
            start = index
            index = quote_start + 1
            escaped = False
            while index < length:
                character = source[index]
                index += 1
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    break
            output.append(_blank(source[start:index]))
            continue
        output.append(source[index])
        index += 1
    return "".join(output)


def module_key(relative):
    parts = list(relative.with_suffix("").parts)
    if parts[-1] in ("lib", "main"):
        return ()
    if parts[-1] == "mod":
        parts.pop()
    return tuple(parts)


def _split_top_level(value):
    result = []
    start = 0
    depth = 0
    for index, character in enumerate(value):
        if character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
        elif character == "," and depth == 0:
            result.append(value[start:index])
            start = index + 1
    result.append(value[start:])
    return result


def _matching_brace(value, opening):
    depth = 0
    for index in range(opening, len(value)):
        if value[index] == "{":
            depth += 1
        elif value[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def use_candidates(expression):
    expression = re.sub(
        r"\s+as\s+(?:r#)?[A-Za-z_][A-Za-z0-9_]*", "", expression
    )
    expression = re.sub(r"\s+", "", expression)
    opening = expression.find("{")
    if opening < 0:
        if expression.endswith("::*"):
            return
        candidate = expression.rstrip(":")
        if candidate and candidate not in ("self", "*"):
            yield candidate
        return
    closing = _matching_brace(expression, opening)
    if closing < 0:
        return
    prefix = expression[:opening]
    suffix = expression[closing + 1 :]
    for item in _split_top_level(expression[opening + 1 : closing]):
        item = item.strip()
        if not item or item == "*":
            continue
        if item == "self":
            candidate = prefix.rstrip(":") + suffix
            if candidate:
                yield candidate
            continue
        for candidate in use_candidates(prefix + item + suffix):
            yield candidate


def _is_binary(relative):
    return relative.as_posix() == "main.rs" or relative.parts[:1] == ("bin",)


def resolve_use(
    expression,
    current_module,
    modules,
    library_root=None,
    crate_name=None,
    binary=False,
    exact_only=False,
):
    parts = [part for part in expression.split("::") if part]
    if not parts:
        return None
    head = parts.pop(0)
    if head == crate_name:
        base = []
        may_fall_back = True
    elif head == "crate":
        if binary:
            return None
        base = []
        may_fall_back = True
    elif head == "self":
        base = list(current_module or ())
        may_fall_back = False
    elif head == "super":
        base = list(current_module or ())
        if base:
            base.pop()
        while parts and parts[0] == "super":
            if base:
                base.pop()
            parts.pop(0)
        may_fall_back = not base
    else:
        return None
    identifiers = [
        part[2:] if part.startswith("r#") else part
        for part in parts
        if re.match(r"^(?:r#)?[A-Za-z_][A-Za-z0-9_]*$", part)
    ]
    full = base + identifiers
    sizes = [len(full)] if exact_only else range(len(full), 0, -1)
    for size in sizes:
        key = tuple(full[:size])
        if key in modules:
            return modules[key]
    return library_root if may_fall_back and not exact_only else None


def _crate_name(root):
    for cargo in (root / "Cargo.toml", root.parent / "Cargo.toml"):
        if not cargo.is_file():
            continue
        section = None
        for line in cargo.read_text(encoding="utf-8").splitlines():
            match = re.match(r"\s*\[([^]]+)\]\s*$", line)
            if match:
                section = match.group(1)
                continue
            if section == "package":
                match = re.match(r'\s*name\s*=\s*"([^"]+)"', line)
                if match:
                    return match.group(1).replace("-", "_")
    return None


def _matching_source_brace(source, opening):
    depth = 0
    for index in range(opening, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return len(source) - 1


def _test_spans(source):
    starts = []
    starts.extend(
        match.end()
        for match in re.finditer(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]", source)
    )
    starts.extend(match.end() for match in re.finditer(r"\bmod\s+tests\s*", source))
    spans = []
    for start in starts:
        opening = source.find("{", start)
        semicolon = source.find(";", start, opening if opening >= 0 else len(source))
        if opening >= 0 and semicolon < 0:
            spans.append((opening, _matching_source_brace(source, opening) + 1))
    return spans


def _kind_at(position, spans, relative):
    if relative.parts[:1] == ("tests",):
        return "test"
    return "test" if any(start <= position < end for start, end in spans) else "import"


def index(crate_dir):
    root = Path(crate_dir).resolve()
    if not root.is_dir():
        raise ValueError("{} is not a directory".format(crate_dir))
    prefix = root.name
    crate_name = _crate_name(root)
    files = sorted(path for path in root.rglob("*.rs") if path.is_file())
    relative = {path: path.relative_to(root) for path in files}
    display = {path: (Path(prefix) / relative[path]).as_posix() for path in files}
    ids_by_display = unique_ids(display.values())
    node_ids = {path: ids_by_display[display[path]] for path in files}

    library_root = next(
        (path for path in files if relative[path].as_posix() == "lib.rs"), None
    )
    modules = {}
    for path in files:
        if _is_binary(relative[path]) or path == library_root:
            continue
        modules.setdefault(module_key(relative[path]), path)

    roots = ["crate", "self", "super"]
    if crate_name:
        roots.append(crate_name)
    path_pattern = re.compile(
        r"\b({})(?:::(?:r#)?[A-Za-z_][A-Za-z0-9_]*)+".format(
            "|".join(re.escape(value) for value in roots)
        )
    )
    edges = defaultdict(int)
    for path in files:
        source = strip_comments(path.read_text(encoding="utf-8"))
        current = module_key(relative[path])
        binary = _is_binary(relative[path])
        spans = _test_spans(source)
        for match in MOD_RE.finditer(source):
            target = modules.get(current + (match.group(1),))
            if target is not None and target != path:
                edges[(path, target, _kind_at(match.start(), spans, relative[path]))] += 1

        use_targets = defaultdict(set)
        use_matches = list(USE_RE.finditer(source))
        for match in path_pattern.finditer(source):
            target = resolve_use(
                match.group(0), current, modules, library_root, crate_name, binary
            )
            if target is not None and target != path:
                kind = _kind_at(match.start(), spans, relative[path])
                edges[(path, target, kind)] += 1
                for use_match in use_matches:
                    if use_match.start() <= match.start() < use_match.end():
                        use_targets[use_match.start()].add((target, kind))
                        break

        for match in use_matches:
            kind = _kind_at(match.start(), spans, relative[path])
            for candidate in use_candidates(match.group(1)):
                target = resolve_use(
                    candidate,
                    current,
                    modules,
                    library_root,
                    crate_name,
                    binary,
                    exact_only="{" in match.group(1),
                )
                if (
                    target is not None
                    and target != path
                    and (target, kind) not in use_targets[match.start()]
                ):
                    edges[(path, target, kind)] += 1
                    use_targets[match.start()].add((target, kind))

    refs = defaultdict(int)
    for (source, target, _kind), count in edges.items():
        refs[source] += count
        refs[target] += count
    nodes = [
        {"id": node_ids[path], "path": display[path], "kind": "file", "refs": refs[path]}
        for path in files
    ]
    output_edges = [
        {"from": node_ids[source], "to": node_ids[target], "kind": kind, "count": count}
        for (source, target, kind), count in sorted(
            edges.items(),
            key=lambda item: (display[item[0][0]], display[item[0][1]], item[0][2]),
        )
    ]
    return {"nodes": nodes, "edges": output_edges}


def main(argv=None):
    command = argparse.ArgumentParser(description=__doc__)
    command.add_argument("crate_dir")
    args = command.parse_args(argv)
    try:
        graph = index(args.crate_dir)
    except (OSError, UnicodeError, ValueError) as error:
        print("index_rust: {}".format(error), file=sys.stderr)
        return 1
    json.dump(graph, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
