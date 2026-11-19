"""Points test imports of moved names at their new modules.

usage: python3 scripts/route-test-imports.py <old module> '<json: name -> new module>' files...
Modules are repository paths without extension ("electron/browser/mcp-tools").
Handles `import { a, b } from "…/old"` and `const { a, b } = await import("…/old")`;
names not in the map keep the old module.
"""
import json
import re
import sys

old, mapping, files = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3:]


def target(name):
    key = name.replace("type ", "").split(" as ")[0].strip()
    return mapping.get(key, old)


def grouped(names):
    groups = {}
    for name in names:
        groups.setdefault(target(name), []).append(name)
    return groups


for path in files:
    text = open(path).read()
    before = text

    def dynamic(m):
        indent, names, prefix = m.group(1), m.group(2), m.group(3)
        names = [n.strip() for n in names.split(",") if n.strip()]
        return "\n".join(
            f'{indent}const {{ {", ".join(ns)} }} = await import("{prefix}{spec}");'
            for spec, ns in grouped(names).items()
        )

    text = re.sub(
        r'(^[ \t]*)const \{([^}]*)\}\s*=\s*await import\("((?:\.\./)+)' + re.escape(old) + r'"\);',
        dynamic,
        text,
        flags=re.M,
    )

    def static(m):
        kind, names, prefix = m.group(1), m.group(2), m.group(3)
        names = [n.strip() for n in names.split(",") if n.strip()]
        return "\n".join(
            f'import {kind}{{ {", ".join(ns)} }} from "{prefix}{spec}";'
            for spec, ns in grouped(names).items()
        )

    text = re.sub(
        r'import (type )?\{([^}]*)\} from "((?:\.\./)+)' + re.escape(old) + r'";',
        lambda m: static(type("M", (), {"group": lambda self, i: (m.group(1) or "") if i == 1 else m.group(i)})()),
        text,
    )
    if text != before:
        open(path, "w").write(text)
        print("routed", path)
