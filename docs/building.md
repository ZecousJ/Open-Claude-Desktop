# Building Claudex

## Requirements

- Node.js 24 and npm (desktop app, web app, runner, tests)
- For the server: Go 1.27 and pnpm 9, or just Docker
- For the phone apps: Xcode 26+ (iOS), JDK 17/21 and the Android SDK (Android)

```sh
npm ci
```

## Desktop app

```sh
npm run dev           # Vite + Electron with reload
npm run build         # type-check, build the renderer (dist/) and main process (dist-electron/)
npm start             # run the last build
```

Installers:

```sh
npm run package:mac     # macOS .zip for this Mac's architecture
npm run package:win     # NSIS installer, x64
npm run package:linux   # .deb, .rpm and .tar.gz, x64 and arm64
```

Packaging first runs `scripts/prepare-runtime.mjs`, which downloads the pinned
Codex build for the target platform and checks its hash, and
`scripts/computer-use/fetch-driver.mjs` for the computer-use driver. Output goes
to `release/`.

### Build settings

These are read from the environment when building:

| Variable | Effect |
| --- | --- |
| `CLAUDEX_SERVICE_URL` | The Claudex server the app signs in to. Without it the sign-in page asks for an address. |
| `CLAUDEX_UI_PACK_PUBLIC_KEY` | Base64 SPKI of the ed25519 key interface packs are signed with. Without it the app never loads an interface pack. See [releasing.md](releasing.md). |

### Signing

Release builds are signed; electron-builder reads the usual variables.

- **macOS**: a Developer ID identity in the keychain or `CSC_LINK` /
  `CSC_KEY_PASSWORD`, and notarization credentials (`APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). The app's updater checks the new
  version's Developer ID and Team ID before installing it.
- **Windows**: `CSC_LINK` / `WIN_CSC_LINK` and `CSC_KEY_PASSWORD`.

Unsigned builds run fine locally, but the built-in updater only installs
updates signed by the same publisher as the running app.

### Run-time settings

| Variable | Effect |
| --- | --- |
| `CLAUDEX_DATA_DIR` | Use another data folder (handy for a second instance while developing) |
| `CLAUDEX_DISABLE_UPDATES=1` | No update checks |
| `CLAUDEX_DISABLE_UI_PACKS=1` | Always use the interface the app shipped with |

Administrators can also preset settings for every user of a machine; see
[managed-settings.md](managed-settings.md).

## Web app

```sh
npm run build:web     # dist-web/, with an import check and a first-load size budget
npm run dev:web       # http://127.0.0.1:5174, proxying /api to CLAUDEX_WEB_API
```

`CLAUDEX_WEB_API` defaults to `http://127.0.0.1:18080`. The server serves
`dist-web/` itself; see [self-hosting.md](self-hosting.md).

The web build must not import Electron, Node built-ins or anything under
`electron/`, `server/`, `runner/` or `scripts/`; `scripts/check-web-imports.mjs`
enforces it. The first load is held to 500 kB of JavaScript and 100 kB of CSS
(gzip) by `scripts/check-web-bundle.mjs`, so heavy libraries (Mermaid, pdf.js,
xterm) stay lazy.

## Runner

```sh
node scripts/build-runner.mjs    # dist-runner/runner.mjs, provider-service.cjs, sandbox-codex.mjs
```

The runner needs Node 22+ and Linux. Its settings are environment variables,
listed at the top of `runner/src/main.ts`; deploying it is covered in
[self-hosting.md](self-hosting.md).

## Server

```sh
deploy/claudex-server/build-image.sh                    # Docker image
docker compose -f deploy/claudex-server/docker-compose.dev.yml up -d --build
```

To build without Docker, see `backend/README.claudex.md` (Go in
`backend/backend`, the admin console in `backend/frontend`).

## Phone apps

See [`mobile/ios/README.md`](../mobile/ios/README.md) and
[`mobile/android/README.md`](../mobile/android/README.md). Both embed the
conversation view built by:

```sh
npm run build:mobile-conversation
```

## Tests

```sh
npm test                 # every suite under tests/
npm run test:engine      # the bundled Codex against a loopback mock model
npm run format:check
```

Tests use `node:test` with `tsx`. DOM tests run on linkedom (jsdom for a few);
CSS imports are stubbed by `tests/support/css-stub.mjs`. Tests that need Linux
sandboxes (bubblewrap, gVisor) skip themselves elsewhere.

The server has its own Go and frontend tests:

```sh
cd backend/backend && go test ./...
cd backend/frontend && pnpm install && pnpm test
```

## Interface previews

The whole interface can run on synthetic fixture data, without a server or an
account:

```sh
node --import tsx scripts/preview/ui-preview.mts [port]
```

Query keys pick the fixture profile (for example `?states=1` for transcript
states); the other `preview/*.html` pages show single components and are served
by the same command.
