#!/usr/bin/env python3
"""Source/resource contracts only; NOT Swift compilation or WKWebView execution."""
from pathlib import Path
import hashlib,json,plistlib,re
root=Path(__file__).resolve().parents[1]
from verify_shared_conversation_bundle import verify
verify(root)
ui=(root/'Claudex/UI/SharedConversationView.swift').read_text()
store=(root/'Claudex/UI/AppStore.swift').read_text()
core=(root/'Claudex/Core/SharedConversationBridge.swift').read_text()
chat=(root/'Claudex/UI/ConversationViews.swift').read_text()
assert 'SharedConversationView(conversation: shown, quietLoading: conversation == nil)' in chat
assert 'struct TurnView' not in chat and 'MarkdownContentView' not in chat
assert not (root/'Claudex/UI/MarkdownContentView.swift').exists()
assert not (root/'Claudex/UI/ReplyActionsView.swift').exists()
for token in ['.nonPersistent()', 'message.frameInfo.isMainFrame', 'message.frameInfo.request.url == SharedConversationAssets.entry', 'message.frameInfo.securityOrigin.protocol', 'message.frameInfo.securityOrigin.host', 'removeScriptMessageHandler', 'webViewWebContentProcessDidTerminate', 'lease.rotate()', 'Task.sleep(for: .milliseconds(80))', 'callAsyncJavaScript', 'renderDocument(state)', "connect-src 'none'", "frame-src 'none'", 'Access-Control-Allow-Origin', 'exporter.isExporting', 'scenePhase != .active', 'if !watchdogPaused { armTimeout() }']:
    assert token in ui, token
assert 'case .downloadArtifact:' in store and 'let savedName = try await export(file)' in store
assert 'case .openArtifact, .downloadArtifact:' not in store
assert 'case .downloadArtifacts:' in store and 'for (index, identity) in identities.enumerated()' in store and 'let current = conversations.first' in store
exporter=(root/'Claudex/UI/SharedConversationExport.swift').read_text()
for token in ['withCheckedThrowingContinuation', 'withTaskCancellationHandler', 'UIDocumentPickerViewController(forExporting:', 'documentPickerWasCancelled', 'urls.first?.lastPathComponent', 'presentationControllerDidDismiss', 'picker.dismiss(animated:', 'pending == nil, loadingID == nil']:
    assert token in exporter, token
for token in ['activeConversationID == conversationID','conversationBridgeGeneration == expected','SharedConversationResolver.file','SharedConversationResolver.attachment','SharedConversationResolver.containsLink','SharedConversationResolver.quoteForComposer']:
    assert token in store, token
for token in ['maximumMessageBytes = 1_100_000','actions.count < 16','rateCount < 32','seen.count < 4_096','now - lastSent >= 0.08']:
    assert token in core, token
for prohibited in ['accessToken', 'refreshToken', 'window.desktop', 'window.rpc', 'evaluateJavaScript("fetch']:
    assert prohibited not in ui, prohibited
# The only user script is the official transcript layer, in an isolated content world: never
# the page world, where it could reach the bridge.
scripts=re.findall(r'addUserScript\((.*)\)', ui)
assert all('in: .defaultClient' in call for call in scripts) and len(scripts) <= 1, scripts
assert 'contentWorld: .defaultClient, name: TranscriptOfficialStyle.messageHandler' in ui
manifest=json.loads((root/'docs/shared-conversation-bundle.json').read_text())
bundle=root/'Claudex/Resources/SharedConversation'
actual={p.relative_to(bundle).as_posix() for p in bundle.rglob('*') if p.is_file()}
assert actual == {x['path'] for x in manifest['files']}
for record in manifest['files']:
    data=(bundle/record['path']).read_bytes()
    assert len(data)==record['bytes'] and hashlib.sha256(data).hexdigest()==record['sha256'], record['path']
html=(bundle/'index.html').read_text()
for asset in re.findall(r'(?:src|href)="(\./assets/[^\"]+)"',html): assert (bundle/asset).is_file(), asset
project=plistlib.loads((root/'Claudex.xcodeproj/project.pbxproj').read_bytes())['objects']
ref=next(k for k,v in project.items() if v.get('path')=='Claudex/Resources/SharedConversation')
assert project[ref]['lastKnownFileType']=='folder'
assert any(p['isa']=='PBXShellScriptBuildPhase' and 'verify_shared_conversation_bundle.py' in p.get('shellScript','') for p in project.values()), 'Missing Xcode prebuild bundle verification'
assert any(project[x]['fileRef']==ref for p in project.values() if p['isa']=='PBXResourcesBuildPhase' for x in p['files'])
print(f"PASS: shared-only transcript/document rendering, bridge isolation, bounded protocol and {len(actual)} exact bundle/resource hashes")
print('Static source/resource contracts only. Swift core tests, Apple SDK typecheck and WKWebView runtime checks are separate gates.')
