# Architecture

Claudex has five parts: the desktop app, the web app with its runner, the
phone apps, and the server they all talk to. The desktop app and the runner
share most of their code; the web app and the desktop app share the whole
interface.

## Desktop app

```text
renderer (React, no Node) ──IPC──> main process ──> provider service (127.0.0.1, random token)
                                      │                   │  holds the device key
                                      │                   └──HTTPS──> Claudex server /v1/*
                                      ├── Codex app-server (stdio JSON-RPC), one per account
                                      └──HTTPS──> Claudex server /api/v1/*
```

- **Renderer** (`src/`): the whole interface. It has no Node access and reaches
  the main process only through the preload bridge (`electron/preload.ts`),
  whose methods are listed in `shared/*-api.ts`. It never sees tokens or keys.
- **Main process** (`electron/`): windows, IPC handlers (`electron/ipc/`), the
  conversation engine (`electron/engine/`) that drives Codex, the store
  (`electron/store/`), and everything that touches the machine: folders,
  terminals (`electron/terminal/`), SSH (`electron/ssh/`), the browser pane
  (`electron/browser/`), computer use, simulators, Git, updates.
- **Codex**: the bundled Codex binary runs as `codex app-server`, one per
  signed-in account, with its own `CODEX_HOME`. The engine speaks its JSON-RPC
  protocol over stdio. Codex sends model requests to the provider service with
  a random loopback token; it never gets the device key.
- **Provider service** (`server/provider-service.ts`): a separate process on
  `127.0.0.1` that forwards model traffic to the server's `/v1/responses` or
  `/v1/chat/completions` with the device key, translates protocols, applies
  request limits and relays dictation audio.

### Accounts and the device key

The desktop app always signs in to a Claudex server. A build names a default
server with `CLAUDEX_SERVICE_URL`; without one the sign-in page asks for the
address and keeps it (`backend/sub2api.json` in the app's data folder).

- `electron/sub2api/` keeps the access token in memory and the rotating
  refresh token encrypted with Electron `safeStorage`.
- After sign-in the main process reads `GET /api/v1/claudex/bootstrap` (plan,
  device, policy, model catalog, release, voice and usage sections). The policy
  is cached so the app keeps working when the bootstrap is briefly unavailable.
- The installation registers as a device (`POST /api/v1/claudex/devices`). The
  server issues one key per account and device, enforces the per-user device
  limit, and returns the key once; it goes straight into the provider service's
  encrypted vault.
- Gateway refusals carry a structured reason (limit, reset time, action) that
  the app turns into notices, a sign-out when the device was revoked, or a new
  device key.

Every account has its own profile folder: conversations, projects, settings,
Codex home, artifacts and usage.

### Conversations

A conversation is a list of turns; each turn holds the items Codex reports
(messages, reasoning, commands, file changes, tool calls). The engine turns
Codex notifications into store updates and pushes them to the renderer as
events. Chat runs with a read-only sandbox; Code sessions run with the sandbox
and approval policy of the chosen permission mode (`shared/sandbox-policy.ts`).

Cloud conversations (`electron/cloud/`) are stored on the server and run on a
runner; the desktop app shows them and can send to them.

## Web app and runner

```text
browser ──HTTPS /api/v1/claudex/web/rpc/*──> server ──runner link (WebSocket)──> runner
        <──WSS  /api/v1/claudex/web/events──           │
                                                        └── per user: engine + Codex in a sandbox
```

- **Web app** (`src-web/`, `web.html`): the same React interface. The bridge
  installs `window.desktop` and routes each method by its kind in
  `shared/web-bridge-methods.ts`: to the runner, to the server's auth API, in
  the page, or not available. Build-time `surface` and run-time host
  capabilities (`shared/host.ts`) hide what a browser can't do (local folders,
  terminals, computer use).
- **Runner** (`runner/`): a Node service on a Linux host. It dials out to the
  server, gets assigned users, and runs a desktop-style app context per user
  (`runner/src/web-app-context.ts`) that reuses the desktop's IPC handlers and
  engine. Codex runs inside a sandbox: gVisor (`runsc`) on dedicated hosts or
  bubblewrap. Network access goes through an egress proxy with per-session
  policy; Git operations go through a broker outside the sandbox.
- **Storage**: web conversations live in the server's database (`webstore`);
  the runner assigned to a user is their only writer.

## Phone apps

`mobile/ios` (SwiftUI) and `mobile/android` (Jetpack Compose) are native apps
for sign-in, the composer, navigation, approvals and settings. The
conversation itself renders with the shared React components, built by
`npm run build:mobile-conversation` and checked into each app with a lock
file (see [mobile-shared-conversation.md](mobile-shared-conversation.md)).
Phones run cloud conversations and can drive a desktop's Code sessions
through remote control.

## Server

`backend/` is a fork of [Sub2API](https://github.com/Wei-Shaw/sub2api), kept
in the upstream layout and licensed under the LGPL-3.0. It keeps every Sub2API
feature (users, groups, model allowlists, upstream accounts, pricing, balance,
subscriptions, payments, usage records, the admin console) and adds the
Claudex module in `backend/backend/internal/claudex/`:

| Package | Purpose |
| --- | --- |
| `bootstrap`, `policy`, `catalog`, `release` | What a client reads after sign-in: plan, policy, models, release channels |
| `devices`, `signin`, `profile`, `onboarding` | Device keys, sign-in extensions, profile and onboarding |
| `usage`, `accountguard`, `gatewayhook`, `refusal` | Usage rules and structured refusals on the gateway; pausing failing upstream accounts |
| `web`, `webstore`, `webhost`, `webproto`, `webconsole` | The web app: sessions, storage, relay to runners, protocol, serving the SPA and console |
| `cloud`, `ghconn` | Cloud conversations and Code sessions; GitHub connections |
| `voice` | Realtime dictation relay |
| `sharing`, `memory`, `feedback`, `announce`, `payment`, `status` | Shared links, memory, feedback, announcements, desktop checkout, service status |

Every change to upstream files is listed in
[`backend/CLAUDEX_CHANGES.md`](../backend/CLAUDEX_CHANGES.md); the server's
extension points are described in
[`backend/README.claudex.md`](../backend/README.claudex.md).

## Shared code

`shared/` holds types, protocol definitions and pure logic used by more than
one part: the IPC contract, the web protocol (`shared/web-protocol.ts`, with a
Go twin in `webproto` and shared golden files), sandbox policy, i18n catalogs,
cron parsing, model catalog rules. Code there has no Electron or DOM
dependencies.
