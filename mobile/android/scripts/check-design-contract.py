#!/usr/bin/env python3
"""Source/asset contract checks, not a screenshot or device test."""
import hashlib, json, re
from pathlib import Path
root = Path(__file__).resolve().parents[1]
source = root / 'app/src/main/java/com/claudex/mobile'
texts = {p.name: p.read_text() for p in source.glob('*.kt')}
mapping = json.loads((root / 'screen-mapping.json').read_text())
assert [r['id'] for r in mapping] == [f'{i:02}' for i in range(1, 21)]
assert len({r['reference'] for r in mapping}) == 20
for row in mapping:
    assert re.search(r'fun\s+' + row['composable'] + r'\(', (root / row['source']).read_text()), row
    assert row['preserved_actions']
assert 'NavigationBar(' not in texts['MainActivity.kt']
assert 'NavigationBarItem(' not in texts['MainActivity.kt']
assert 'ModalNavigationDrawer(' in texts['MainActivity.kt']
for target in ['home', 'work', 'code', 'library', 'cowork']:
    # The drawer's rows are DrawerItem(label, icon, route, ...); New chat opens "home".
    assert re.search(r'DrawerItem\([^\n]*"' + target + '"', texts['SidebarScreen.kt']) or f'nav.navigate("{target}")' in texts['SidebarScreen.kt'], target
assert 'api.login(' not in texts['ChatScreens.kt']  # VM still owns guarded auth.
# The chat page is ChatSurface.kt (ChatScreens.kt keeps the list and auth pages).
assert 'ConversationContentStatus(vm, it)' in texts['ChatSurface.kt']
assert 'ConversationContentStatus(vm, id)' in texts['WorkScreens.kt']
for capability in ['settings.javaScriptEnabled = false', 'settings.blockNetworkLoads = true', 'settings.allowFileAccess = false', 'settings.allowContentAccess = false']:
    assert capability in texts['LibraryScreens.kt']
for action in ['"conversationTurns"', 'beginViewingConversation', 'retryConversationContent']:
    assert action in texts['RemoteRepository.kt']
assert 'valueOf(' not in texts['DiffPresentation.kt']
# One shared renderer, including native task transcripts and document/code previews.
assert 'SharedConversationView(vm, nav, conversation' in texts['ChatSurface.kt']
assert 'SharedConversationView(vm, nav, c' in texts['WorkScreens.kt']
assert 'MarkdownContent(' not in '\n'.join(texts.values())
assert 'fun ReplyActions(' not in '\n'.join(texts.values())
assert 'addWebMessageListener' in texts['SharedConversationView.kt']
assert '.addJavascriptInterface(' not in '\n'.join(texts.values())
assert 'ConversationBridgePolicy.acceptsFrame' in texts['SharedConversationView.kt']
assert 'ConversationDocument(' in texts['GeneratedFileScreen.kt']
assert 'ConversationDocument(' in texts['LibraryScreens.kt']
assert "verifySharedConversation" in (root / 'app/build.gradle.kts').read_text()
brand = json.loads((root / 'docs/brand-provenance.json').read_text())
assert hashlib.sha256((root / brand['asset']).read_bytes()).hexdigest() == brand['sha256']
assert 'R.drawable.ic_claudex' not in '\n'.join(texts.values())
manifest = (root / 'app/src/main/AndroidManifest.xml').read_text()
assert 'android.permission.INTERNET' in manifest
# The microphone (dictation, voice) is declared but asked for at the moment it is used.
if 'android.permission.RECORD_AUDIO' in manifest:
    assert 'launch(Manifest.permission.RECORD_AUDIO)' in '\n'.join(texts.values())
assert 'android:allowBackup="false"' in manifest
print(json.dumps({'result': 'passed', 'mapped_screens': 20, 'primary_sidebar_destinations': 5,
                  'official_logo_sha256': brand['sha256'], 'scope': 'source and asset checks only'}, indent=2))
