#!/usr/bin/env python3
"""Independently read the saved workbook; never author or mark acceptance here."""
import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl

parser = argparse.ArgumentParser()
parser.add_argument("inventory")
parser.add_argument("workbook")
parser.add_argument("render_directory")
parser.add_argument("--require-complete", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
data = json.loads(Path(args.inventory).read_text())
render_dir = Path(args.render_directory)
specs = json.loads((render_dir / "expected.json").read_text())
render_data = json.loads((render_dir / "render-data.json").read_text())
book = openpyxl.load_workbook(args.workbook, read_only=True, data_only=False)
assert book.sheetnames == [spec["name"] for spec in specs], "Sheet membership/order mismatch"
errors = []
checked = 0
for spec in specs:
    if not spec.get("key"):
        continue
    rows = render_data[spec["key"]]
    assert len(rows) == spec["records"]
    sheet = book[spec["name"]]
    # Artifact Tool omits the optional worksheet dimension element. Read to
    # EOF and compare row membership, rather than treating max_row=None as loss.
    actual_rows = sheet.iter_rows(min_row=spec["header"] + 1, max_col=len(spec["columns"]))
    for index, (source, actual) in enumerate(zip(rows, actual_rows, strict=True)):
        for column, cell in zip(spec["columns"], actual, strict=True):
            wanted = source.get(column)
            if isinstance(wanted, (dict, list)):
                # JS JSON.stringify is compact and keeps non-ASCII characters.
                wanted = json.dumps(wanted, ensure_ascii=False, separators=(",", ":"))
            if wanted is None:
                wanted = ""
            observed = cell.value if cell.value is not None else ""
            if isinstance(wanted, str) and len(wanted) > 1000 and sheet.title != "长单元格原文":
                match = re.fullmatch(r'完整原文见“长单元格原文” (LONG-\d+)（(\d+) 字符）', str(observed))
                assert match, f"Missing overflow reference {sheet.title}!{cell.coordinate}"
                fragments = [r for r in render_data["overflow"] if r["id"] == match[1]]
                assert fragments and "".join(r["original"] for r in fragments) == wanted
                assert all(r["source"] == f"{sheet.title}!{cell.coordinate}" for r in fragments)
            else:
                assert observed == wanted, f"Cell mismatch {sheet.title}!{cell.coordinate}: {str(observed)[:100]!r} vs {str(wanted)[:100]!r}"
            assert cell.data_type != "e", f"Excel error {sheet.title}!{cell.coordinate}"
            assert cell.data_type != "f", f"Source text exported as a formula {sheet.title}!{cell.coordinate}"
            checked += 1

# Independently enumerate the source checkbox lines with string operations,
# rather than reusing the generator's regular expression or marker allowlist.
original_checks = []
for line in (root / "docs/parity-progress.md").read_text().splitlines():
    stripped = line.lstrip()
    if len(stripped) < 3 or stripped[0] not in "-*+" or not stripped[1].isspace():
        continue
    rest = stripped[1:].lstrip()
    if rest.startswith("[") and "]" in rest:
        original_checks.append(line)
assert original_checks == [row["original"] for row in data["parityChecks"]]
assert Counter(row["marker"] for row in data["parityChecks"])["[s]"] == sum(line.lstrip()[1:].lstrip().startswith("[s]") for line in original_checks)

schema = json.loads((root / "work/official-native/schema.json").read_text())
contract = json.loads((root / "build/official-ui/data/native-ipc-contract.json").read_text())
native_ops = {f"{domain}.{method}" for domain, group in schema["domains"].items() for method in group.get("methods", {})}
channels = []
for call in [*contract["invokes"], *contract["sync"]]:
    channel = call["channel"]
    pieces = channel.split("_$_")
    native_ops.add(f"{pieces[2]}.{ '_$_'.join(pieces[3:])}" if len(pieces) >= 4 else channel)
    channels.append(channel)
assert native_ops == {row["operation"] for row in data["native"]}
assert Counter(channels) == Counter(channel for row in data["native"] for channel in row["channels"].splitlines())
# Re-enumerate language membership from the delivered page, independently of
# the scanner and of which catalogs happened to be captured.
html = (root / "build/official-ui/ui/index.html").read_text()
declared = re.search(r'data-i18n-catalogs="([^"]+)"', html).group(1)
locales = {"en-US", *(entry.split(":", 1)[0] for entry in declared.split(","))}
assert {(row["locale"], row["part"]) for row in data["localeCatalogs"]} == {(locale, part) for locale in locales for part in ("base", "dynamic")}
for row in data["localeCatalogs"]:
    file = root / "build/official-ui/ui/i18n" / ("dynamic" if row["part"] == "dynamic" else "") / f"{row['locale']}.json"
    assert row["messages"] == (len(json.loads(file.read_text())) if file.exists() else 0)
    assert (row["file"] != "未恢复") == file.exists()
# Catch the original fixed-module-list omission even if the operation's row
# survives in the contract union as an incorrectly labelled legacy fallback.
entry = (root / "electron/official-ui/native/index.ts").read_text()
for imported, module in re.findall(r'import\s*\{\s*(register\w+)\s*\}\s*from\s*"\./([^"/]+)"', entry):
    if re.search(rf'\b{re.escape(imported)}\(', entry):
        assert any(row["source"].startswith(f"electron/official-ui/native/{module}.ts") for row in data["native"]), f"Native registration module omitted: {module}"
assert len(data["features"]) == len(json.loads((root / "docs/official-ui-inventory-baseline.json").read_text())["features"])
assert all(row["expected"] == row["actual"] for row in data["checks"])

# Check every retained audit line against source text, including split order.
fragments = defaultdict(list)
for row in data["auditLines"]:
    fragments[row["source"]].append(row)
for location, rows in fragments.items():
    file, number = location.rsplit(":", 1)
    expected = (root / file).read_text().splitlines()[int(number) - 1]
    assert "".join(row["original"] for row in rows) == expected, f"Audit text lost: {location}"

ledger = json.loads((root / "docs/official-ui-verification-runs.json").read_text())
assert data["runs"] == ledger["runs"], "Stale verification ledger"
assert len({run["id"] for run in data["runs"]}) == len(data["runs"])
if ledger.get("timestampRequiredFrom"):
    assert all(run.get("completedAt") for run in data["runs"] if run["id"] >= ledger["timestampRequiredFrom"]), "New verification record missing completion time"
from datetime import datetime, timezone, timedelta
def rendered_time(value):
    if not value or value in {"未完成", "历史未记录/未核验"}:
        return value
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S +08:00")
for key in ("runs", "features", "native"):
    for original, rendered in zip(data[key], render_data[key], strict=True):
        for field in ("verifiedAt", "completedAt"):
            assert rendered.get(field) == rendered_time(original.get(field)), f"Timestamp mismatch {key}/{original['id']}/{field}"
for source in data["inputs"]:
    digest = hashlib.sha256((root / source["file"]).read_bytes()).hexdigest()
    assert digest == source["sha256"], f"Inventory input changed after generation: {source['file']}"

summary = {"sheets": len(book.sheetnames), "checked_detail_cells": checked,
           "historical_checkboxes": len(original_checks), "native_operations": len(native_ops),
           "runs": len(data["runs"]), "declared_locales": len(locales), "workbook_reconciliation": "passed", "product_acceptance": data["acceptance"]}
print(json.dumps(summary, ensure_ascii=False))
if args.require_complete and (data["acceptance"] != "complete" or any(row["status"] not in {"完成", "有证据不适用"} for row in data["acceptanceGaps"])):
    print("验收未完成：仍有已知失败、未知映射或平台/交付缺口。未将其修改为通过。")
    raise SystemExit(2)
