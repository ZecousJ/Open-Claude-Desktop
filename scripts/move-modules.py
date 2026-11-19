#!/usr/bin/env python3
"""Move source files and rewrite every relative reference to them.

Usage: python3 scripts/move-modules.py MOVES.json  (a list of [old, new] repo paths)
       python3 scripts/move-modules.py old new [old new ...]

Rewrites, across the TypeScript/JavaScript/CSS sources and tests:
- import / export ... from "…", import("…"), require("…"), vi.mock("…"),
  new URL("…", import.meta.url) and CSS @import "…" when the relative
  specifier resolves to a moved file (with or without its extension, or a
  folder index);
- the moved files' own relative specifiers, for their new folder;
- repo-root path strings such as readFileSync("src/x.css") in tests and
  scripts ("src/x.css" → "src/new/x.css").
Files are moved with `git mv`. Nothing else changes; run tsc and the tests after.
"""
import json
import os
import re
import subprocess
import sys

ROOT = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
os.chdir(ROOT)

SCAN_DIRS = ["src", "src-web", "electron", "shared", "runner", "server", "scripts", "tests", "tools"]
SCAN_FILES = ["vite.config.ts", "vite.web.config.ts", "vite.mobile-conversation.config.ts", "web.html", "index.html", "quick.html", "find.html"]
EXTS = (".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".css", ".html")
RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".json", ".svg", ".png"]

SPEC = re.compile(
    r"""(?P<pre>(?:\bfrom\s*|\bdeclare\s+module\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*|\bnew\s+URL\s*\(\s*|@import\s+(?:url\()?\s*))(?P<q>["'])(?P<spec>\.{1,2}/[^"'\n]*)(?P=q)"""
)


def tracked_sources():
    out = subprocess.check_output(["git", "ls-files", *SCAN_DIRS, *SCAN_FILES], text=True)
    return [p for p in out.splitlines() if p.endswith(EXTS) and os.path.isfile(p)]


def resolve(from_file, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec.split("?")[0]))
    for ext in RESOLVE_EXTS:
        if os.path.isfile(base + ext):
            return base + ext
    for index in ("index.ts", "index.tsx", "index.js"):
        cand = os.path.join(base, index)
        if os.path.isfile(cand):
            return cand
    return None


def specifier(from_file, target, original):
    """A relative specifier from from_file to target, keeping the original's
    extension style (with or without one, or a folder import)."""
    rel = os.path.relpath(target, os.path.dirname(from_file))
    if not rel.startswith("."):
        rel = "./" + rel
    orig_base = original.split("?")[0]
    query = original[len(orig_base):]
    _, orig_ext = os.path.splitext(orig_base)
    t_root, t_ext = os.path.splitext(rel)
    if os.path.basename(target).startswith("index.") and not orig_base.endswith(os.path.basename(target)) and not orig_ext:
        # imported as a folder
        rel = os.path.dirname(rel) or "."
        return rel + query
    if not orig_ext or orig_ext not in (".ts", ".tsx", ".mts", ".js", ".mjs", ".css", ".json", ".svg", ".png"):
        if t_ext in (".ts", ".tsx", ".mts", ".js", ".mjs") and not orig_ext:
            rel = t_root
    return rel + query


def main(argv):
    if len(argv) == 1 and argv[0].endswith(".json"):
        moves = json.load(open(argv[0]))
    else:
        moves = [argv[i : i + 2] for i in range(0, len(argv), 2)]
    moves = [(os.path.normpath(a), os.path.normpath(b)) for a, b in moves]
    for old, new in moves:
        if not os.path.isfile(old):
            sys.exit(f"missing: {old}")
        if os.path.exists(new):
            sys.exit(f"exists: {new}")
    mapping = dict(moves)
    global ROOT_MAP, ROOT_STRING, READ_CALL
    ROOT_MAP = {}
    for old, new in moves:
        ROOT_MAP[old] = new
        ROOT_MAP[os.path.splitext(old)[0]] = os.path.splitext(new)[0]
    alternation = "|".join(sorted((re.escape(k) for k in ROOT_MAP), key=len, reverse=True))
    ROOT_STRING = re.compile(r"""(["'`])(\.{0,2}/?)(""" + alternation + r""")(["'`])""")
    READ_CALL = re.compile(r"(readFileSync|readFile|source|read|stylesheet|new URL|path\.(?:join|resolve))\s*\(\s*$")
    files = tracked_sources()
    # Plan rewrites against the pre-move tree.
    plans = {}
    for f in files:
        text = open(f, encoding="utf-8").read()
        new_location = mapping.get(f, f)
        changed = False

        def repl(m):
            nonlocal changed
            spec = m.group("spec")
            target = resolve(f, spec)
            if target is None:
                return m.group(0)
            dest = mapping.get(target, target)
            if dest == target and new_location == f:
                return m.group(0)
            new_spec = specifier(new_location, dest, spec)
            if new_spec == spec:
                return m.group(0)
            changed = True
            return f"{m.group('pre')}{m.group('q')}{new_spec}{m.group('q')}"

        out = SPEC.sub(repl, text)
        # Repo-root strings ("src/x.css") in tests, scripts and configs, only
        # where they name a file to read: a read/URL/path call's argument or
        # a line that is just the string (a list of files). Test data that
        # merely looks like a path ("see @src/App.tsx") is left alone.
        if ROOT_STRING.search(out):
            lines = out.split("\n")
            for i, line in enumerate(lines):
                if not ROOT_STRING.search(line):
                    continue

                def root_repl(m, line=line):
                    before = line[: m.start()]
                    reading = READ_CALL.search(before)
                    alone = not before.strip() and line[m.end() :].strip() in ("", ",")
                    if not (reading or alone):
                        return m.group(0)
                    return f"{m.group(1)}{m.group(2)}{ROOT_MAP[m.group(3)]}{m.group(4)}"

                replaced = ROOT_STRING.sub(root_repl, line)
                if replaced != line:
                    lines[i] = replaced
                    changed = True
            out = "\n".join(lines)
        if changed:
            plans[f] = out
    for old, new in moves:
        os.makedirs(os.path.dirname(new) or ".", exist_ok=True)
        subprocess.check_call(["git", "mv", old, new])
    for f, text in plans.items():
        path = mapping.get(f, f)
        open(path, "w", encoding="utf-8").write(text)
    print(f"moved {len(moves)} file(s); rewrote {len(plans)} file(s)")


if __name__ == "__main__":
    main(sys.argv[1:])
