# Validation and rebuild instructions

No Codex installation or quota is needed. Use an ordinary shell with Node.js 22.16+ or 24 and npm. Work from a checkout containing this shared-source change.

```sh
npm ci --ignore-scripts
npm run test:mobile-conversation
npm run build:mobile-conversation
npm run build:web
```

`--ignore-scripts` is sufficient for the web/shared renderer: it avoids downloading Electron and unrelated native runtime binaries. For release provenance, set `CLAUDEX_SOURCE_REVISION` to the exact checked-out published source commit before the renderer build. The build emits `dist-mobile-conversation/index.html`, local `assets/`, and `reuse-manifest.json`. Source maps are used to verify reuse, then removed from shipped output.

## Browser fixtures, clearly separate from native evidence

```sh
node scripts/mobile-conversation/serve-fixtures.mjs
```

Open `http://127.0.0.1:5198/qa.html` in a normal local browser. It shows desktop-width and phone-width frames using the exact packaged components side by side. These are browser fixtures, not screenshots from iOS or Android. Direct URLs:

- `/fixture.html`: rich chat, code/table/math, attachments, artifacts and stopped output
- `/fixture.html?theme=dark`: dark theme
- `/fixture.html?mode=code`: code transcript
- `/fixture.html?mode=cowork`: cowork transcript

Check table/code horizontal containment, selected-text reply, repeated copy/edit/cancel/retry, file opening, long-answer scroll anchoring and touch target layout. Save screenshots showing the fixture labels. The fixture host mocks native action results and does not contact the backend.

A standalone Chromium test script is also included:

```sh
CHROME_PATH="/path/to/chrome" node scripts/mobile-conversation/browser-check.mjs
```

On macOS use `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; on Linux `/usr/bin/chromium` is the default. It starts its own loopback server and writes results/screenshots under the system temp folder (`claudex-mobile-conversation-check`). This script was authored and syntax-checked but could not run to completion in the constrained cloud executor. Do not treat it as a passed browser test until executed successfully.

## Native gates

Build each native app with the shared manifest-verified assets. Verify offline startup, relative entry/module/font/lazy chunk loading, copy and code Open in WK custom-scheme context, session/account/conversation switches with late replies, media budget eviction, rejected origin/subframe messages, image/attachment loading, interruption/resume, repeated edit/cancel/version changes, keyboard/safe-area layout and native navigation/back behavior. Export a two-file batch with the first chooser open longer than 30 seconds; the second picker must still open after save. Cancel the first picker (no second picker), then save one and cancel the next (exact partial saved count). Repeat with account switch/disposal while the chooser is open and delayed/duplicate callbacks; no old result may write a new file. Single exports must also survive slow human input. These chooser flows require real native runtime validation. iOS module/CORS behavior under its custom local scheme requires real WKWebView evidence; Android requires a device/emulator WebView run. A source compile or JVM test is not that evidence.

## This cloud run

Passed checks are recorded by the parent change report; test commands cover protocol/revision/async cancellation, injected services, rich SSR in chat/cowork/code, safe Markdown/source rendering, delayed image thumbnails and media eviction, absent secure-context UUID fallback, bounded native export batches beyond the 1.5-second gesture window/30-second RPC deadline with lifecycle cancellation and duplicate results, and the current production web build/budget.

Rendering restrictions were verified: local Chromium's required Unix sockets were denied (`EPERM`), even after the supported escalation path. The supported cloud browser refused the loopback fixture with `ERR_BLOCKED_BY_CLIENT`. No workaround bypassed those restrictions. No browser/native screenshots were produced or claimed.

The cloud used an available dependency cache. All 89 third-party packages actually present in the renderer bundle matched the unchanged main lockfile. The DOM-effect test helper used cached `linkedom` 0.18.13 whereas main locks 0.18.12; clean `npm ci` reproduction remains the portable verification command. No dependency lock was rewritten to match the cache.
