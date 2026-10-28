#!/usr/bin/env python3
"""Prepare an isolated synthetic XCUITest host; never edit the shipping app entry.
Usage: python3 scripts/prepare_conversation_ux_ui.py /tmp/unique-copy
"""
from pathlib import Path
import sys, shutil, hashlib, json, subprocess
source = Path(__file__).resolve().parents[1]
destination = Path(sys.argv[1]).resolve()
if destination.exists(): raise SystemExit('Use a new empty destination; existing files are preserved')
shutil.copytree(source, destination, ignore=shutil.ignore_patterns('.build', '*.xcresult', 'DerivedData'))
main = destination / 'Claudex/ClaudexApp.swift'
original = main.read_text()
marker = 'struct RootView: View {'
root = original[original.index(marker):]
host = (source / 'ClaudexUITestSupport/ConversationUXHost.swift').read_text()
main.write_text(host + '\n' + root)
ui = destination / 'ClaudexUITests/ClaudexUITests.swift'
ui.write_text((source / 'ClaudexUITestSupport/ConversationUXUITests.swift').read_text())
generator = destination / 'scripts/generate_project.py'
s = generator.read_text().replace("'com.example.claudex'", "'com.example.claudex.uxharness'").replace("'com.example.claudex.tests'", "'com.example.claudex.uxharness.tests'").replace("'com.example.claudex.uitests'", "'com.example.claudex.uxharness.uitests'")
generator.write_text(s)
subprocess.run([sys.executable, str(generator)], check=True)
manifest = {'source': str(source), 'isolatedHost': str(destination), 'entryPointReplacementOnly': True, 'rootViewSHA256': hashlib.sha256(root.encode()).hexdigest(), 'sourceSHA': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(), 'copiedSwiftSHA256': {}}
manifest['workingTreeStatus'] = subprocess.check_output(['git', 'status', '--short'], cwd=source, text=True)
manifest['testOnlyEntrySHA256'] = hashlib.sha256(host.encode()).hexdigest()
manifest['testOnlyUITestsSHA256'] = hashlib.sha256(ui.read_bytes()).hexdigest()
for p in sorted((source / 'Claudex').rglob('*.swift')):
 rel = p.relative_to(source)
 if rel.as_posix() == 'Claudex/ClaudexApp.swift': continue
 if p.read_bytes() != (destination / rel).read_bytes(): raise SystemExit('Unexpected source difference: ' + str(rel))
 manifest['copiedSwiftSHA256'][str(rel)] = hashlib.sha256(p.read_bytes()).hexdigest()
(destination / 'synthetic-ui-source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sourceSHA': manifest['sourceSHA'], 'identicalSwiftFiles': len(manifest['copiedSwiftSHA256']), 'rootViewSHA256': manifest['rootViewSHA256'], 'isolatedHost': str(destination)}))
