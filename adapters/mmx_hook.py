#!/usr/bin/env python3
"""Bridge mmx's diff output to Claude Code and Codex lifecycle hooks."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def edited_paths(payload):
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return []
    paths = []
    for key in ("file_path", "path"):
        value = tool_input.get(key)
        if isinstance(value, str):
            paths.append(value)

    # Codex apply_patch reports its patch in tool_input.command.
    patch = tool_input.get("command", "")
    if isinstance(patch, str):
        paths.extend(
            re.findall(r"^\*\*\* (?:Add|Update|Move to) File: (.+)$", patch, re.MULTILINE)
        )
    return sorted({path for path in paths if Path(path).suffix == ".mmd"})


def emit(harness, event, output):
    if not output:
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse" if event == "post" else "UserPromptSubmit",
            "additionalContext": output,
        }
    }, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", choices=("claude", "codex"), required=True)
    parser.add_argument("--event", choices=("post", "prompt"), required=True)
    parser.add_argument("--diagram", default="diagram.mmd")
    args = parser.parse_args()

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parent.parent
    paths = edited_paths(payload) if args.event == "post" else [args.diagram]

    had_post_error = False
    had_other_error = False
    outputs = []
    for path in paths:
        full_path = Path(project_dir if args.event == "prompt" else cwd, path)
        if args.event == "post" and not full_path.is_file():
            continue
        who = "agent" if args.event == "post" else "human"
        try:
            result = subprocess.run(
                ["mmx", "render", str(full_path), "--by", who, "--print-if-changed"],
                cwd=cwd, text=True, capture_output=True, check=False,
            )
        except FileNotFoundError as exc:
            if exc.filename == "mmx":
                sys.stderr.write("mmx not found on PATH\n")
                return 1
            raise
        if result.returncode == 2 and args.event == "post":
            # PostToolUse exit 2 is feedback to the agent. Include the diff.
            sys.stderr.write(result.stdout or result.stderr)
            had_post_error = True
            continue
        if result.returncode not in (0, 2):
            sys.stderr.write(result.stderr)
            had_other_error = True
            continue
        # A UserPromptSubmit parse error is a message to repair, never a
        # prompt-blocking hook exit 2.
        if result.stdout:
            outputs.append(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
    if had_post_error or had_other_error:
        sys.stderr.write("".join(outputs))
        return 1 if had_other_error else 2
    emit(args.harness, args.event, "".join(outputs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
