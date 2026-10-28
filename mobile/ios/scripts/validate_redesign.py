#!/usr/bin/env python3
"""Source-level design/safety contracts; NOT a SwiftUI typecheck or visual test."""
from pathlib import Path
import hashlib, json, plistlib, struct
root=Path(__file__).resolve().parents[1]
contract=json.loads((root/'docs/final-design-contract.json').read_text())
assert [x['number'] for x in contract['screens']]==[f'{x:02}' for x in range(1,21)]
for screen in contract['screens']:
    assert 'struct '+screen['view']+':' in (root/screen['source']).read_text(), screen
ui='\n'.join(p.read_text() for p in sorted((root/'Claudex/UI').rglob('*.swift')))
app=(root/'Claudex/ClaudexApp.swift').read_text()
assert 'TabView(' not in app and '.tabItem' not in app
assert 'SidebarView()' in app and 'case .cowork:' in app
assert 'sidebarPresented' in ui and 'sidebar-new-chat' in ui
assert 'struct DictationController' not in ui or ('requiresOnDeviceRecognition = true' in ui and 'supportsOnDeviceRecognition' in ui)
assert 'setActive(true, options:' not in (root/'Claudex/UI/DictationController.swift').read_text(), 'Deactivation flags must not be applied on activation'
assert '.duckOthers' not in (root/'Claudex/UI/DictationController.swift').read_text(), 'Recording-only category must not request duckOthers'
assert 'loader.onHydrated' in ui and 'retryTranscript' in ui
assert 'duplicateArtifact' in ui and 'sharingStatus' in ui and 'workingTreeChanges' in ui
assert 'allowsContentJavaScript = false' in ui and "default-src 'none'" in ui
assert 'if #available(iOS 26.0, *)' in ui and '.regularMaterial' in ui
for seed in ['demo/design-system','example.com/s/demo','示例账户','示例套餐']:
    assert seed not in ui, f'Design sample leaked into app: {seed}'
logo=(root/'Claudex/Resources/Assets.xcassets/BrandMark.imageset/brand.png').read_bytes()
assert hashlib.sha256(logo).hexdigest()==contract['logo_sha256']
assert logo[:8]==b'\x89PNG\r\n\x1a\n' and logo[25]==6, 'Expected official RGBA logo'
assert struct.unpack('>II',logo[16:24])==(1254,1254)
start=ui.index('struct BrandMark:')
brand=ui[start:ui.index('\nstruct ',start+1)]
assert '.clipShape' not in brand
info=plistlib.loads((root/'Claudex/Resources/Info.plist').read_bytes())
assert info['NSMicrophoneUsageDescription'] and info['NSSpeechRecognitionUsageDescription']
print('PASS: 20 design routes, sidebar/no tabs, official transparent logo, live-data guards, hydration/security anchors, dictation permissions')
print('Static contracts only. Native pixel review, permissions and UI flows still require Xcode/device tests.')
