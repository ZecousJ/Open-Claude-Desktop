#!/usr/bin/env python3
"""Portable structure validation; intentionally does not claim an Apple SDK build."""
from pathlib import Path
import json, plistlib, xml.etree.ElementTree as ET
root=Path(__file__).resolve().parents[1]
project=plistlib.loads((root/'Claudex.xcodeproj/project.pbxproj').read_bytes())
objects=project['objects']
assert project['rootObject'] in objects
refs={key:value for key,value in objects.items() if value['isa']=='PBXFileReference'}
expected={p.relative_to(root).as_posix() for folder in ['Claudex','ClaudexTests','ClaudexUITests'] for p in (root/folder).rglob('*.swift')}
actual={x['path'] for x in refs.values() if x.get('lastKnownFileType')=='sourcecode.swift'}
assert expected==actual, f'Stale project refs: missing={expected-actual}, extra={actual-expected}'
compiled=set()
for value in objects.values():
 if value['isa']=='PBXSourcesBuildPhase':
  for build in value['files']: compiled.add(refs[objects[build]['fileRef']]['path'])
assert compiled==expected, 'A source file is not in a sources build phase'
for ref in refs.values():
 if ref.get('sourceTree')!='BUILT_PRODUCTS_DIR': assert (root/ref['path']).exists(), ref
for path in (root/'Claudex/Resources').rglob('*.plist'): plistlib.loads(path.read_bytes())
plistlib.loads((root/'Claudex/Resources/PrivacyInfo.xcprivacy').read_bytes())
for path in (root/'Claudex/Resources/Assets.xcassets').rglob('Contents.json'):
 content=json.loads(path.read_text())
 for image in content.get('images',[]):
  if image.get('filename'): assert (path.parent/image['filename']).exists(), f"Missing resource: {path.parent/image['filename']}"
ET.parse(root/'Claudex.xcodeproj/xcshareddata/xcschemes/Claudex.xcscheme')
print(f'PASS: {len(expected)} Swift source references/build entries, assets, plist and shared scheme')
print('Apple SDK typecheck, iOS build, signing and simulator tests are separate Mac-only checks.')

