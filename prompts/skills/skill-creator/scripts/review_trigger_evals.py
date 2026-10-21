#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Anthropic, PBC.
# Wevir addition to the skill-creator from anthropics/skills (commit
# dbd4588f1e1033efb41dad4bef2f7947c8993d44). Upstream fills assets/eval_review.html by hand and
# opens it as a file, then reads the export from ~/Downloads. Wevir's browser pane opens http(s)
# pages only, so this serves the filled page on 127.0.0.1 and saves the export to --output.
"""Serve the trigger eval set for the user to review and edit.

Usage:
    python3 -B scripts/review_trigger_evals.py <eval_set.json> --skill-path <skill> --output <reviewed.json>
        [--port 0]

Prints the URL; open it in Wevir. "Export Eval Set" writes the edited list to --output.
"""

from __future__ import annotations

import argparse
import html
import json
import sys
from functools import partial
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.dont_write_bytecode = True
# Runs as a file path or with -m from the skill-creator folder.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.utils import parse_skill_md  # noqa: E402

TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "eval_review.html"
MAX_BODY = 1024 * 1024


def render(eval_set: list[dict], name: str, description: str) -> str:
    # `</` inside a <script> would end it early; JSON allows the escaped form.
    data = json.dumps(eval_set).replace("</", "<\\/")
    return (
        TEMPLATE.read_text()
        .replace("__EVAL_DATA_PLACEHOLDER__", data)
        .replace("__SKILL_NAME_PLACEHOLDER__", html.escape(name))
        .replace("__SKILL_DESCRIPTION_PLACEHOLDER__", html.escape(description))
    )


class Handler(BaseHTTPRequestHandler):
    def __init__(self, page: str, output: Path, *args, **kwargs):
        self.page = page
        self.output = output
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        if self.path not in ("/", "/index.html"):
            self.send_error(404)
            return
        body = self.page.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/api/eval-set":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > MAX_BODY:
            self.send_error(400)
            return
        try:
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, list) or not all(
                isinstance(i, dict) and isinstance(i.get("query"), str) and isinstance(i.get("should_trigger"), bool)
                for i in data
            ):
                raise ValueError("expected a list of {query, should_trigger}")
        except (json.JSONDecodeError, ValueError) as error:
            self.send_error(400, str(error))
            return
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text(json.dumps(data, indent=2) + "\n")
        print(f"Saved {len(data)} queries to {self.output}", flush=True)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the trigger eval set for review")
    parser.add_argument("eval_set", type=Path)
    parser.add_argument("--skill-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
    args = parser.parse_args()

    name, description, _ = parse_skill_md(args.skill_path)
    page = render(json.loads(args.eval_set.read_text()), name, description)
    server = HTTPServer(("127.0.0.1", args.port), partial(Handler, page, args.output.resolve()))
    print(f"URL: http://127.0.0.1:{server.server_address[1]}", flush=True)
    print(f"Saves to: {args.output.resolve()}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
