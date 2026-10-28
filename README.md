<p align="center">
  <img src="build/icon.png" width="128" height="128" alt="Claudex">
</p>

# Open Claude Desktop

Open Claude Desktop is an open-source workspace for working with AI models,
built as an app called **Claudex**: a desktop app for macOS, Windows and
Linux, a web app, and phone apps for iOS and Android, all signing in to a
server you run yourself. Conversations run on the open-source
[Codex](https://github.com/openai/codex) agent, so the model can read files,
run commands, edit code and use tools, with your approval where it matters.

[简体中文](README.zh-CN.md)

![A chat with an HTML artifact open beside it](docs/images/screenshot-chat-artifact.png)

## Try it

A hosted Claudex is running, so you can try it without deploying anything:

| | |
| --- | --- |
| **Web** | <https://claudex.zecous.cn> |
| **macOS** (Apple silicon) | [Claudex-0.0.38-arm64-mac.zip](https://github.com/ZecousJ/Open-Claude-Desktop/releases/download/v0.0.38/Claudex-0.0.38-arm64-mac.zip) |
| **Windows** | [Claudex-Setup-0.0.38.exe](https://github.com/ZecousJ/Open-Claude-Desktop/releases/download/v0.0.38/Claudex-Setup-0.0.38.exe) |
| **Android** | [Claudex-0.8.1.apk](https://github.com/ZecousJ/Open-Claude-Desktop/releases/download/v0.0.38/Claudex-0.8.1.apk) |
| **iOS** | [TestFlight](https://testflight.apple.com/join/2gUKqADt) |

Installers are on the [releases page](https://github.com/ZecousJ/Open-Claude-Desktop/releases/latest) and the service's
[downloads page](https://claudex.zecous.cn/downloads). These builds sign in to
the hosted service and update themselves; to run your own server, see
[Deployment](#deployment).

**Contents:** [Try it](#try-it) · [Features](#features) · [How it fits together](#how-it-fits-together) ·
[Deployment](#deployment) · [Development](#development) · [License](#license)

The desktop screenshots come from the offline interface preview
(`node --import tsx scripts/preview/ui-preview.mts`), which runs the real
interface on sample data; the phone screenshots come from the Android app's
`demo` flavor and the iOS app in the simulator.

## Features

### Chat

Ask, attach files and images, and get answers that render Markdown, code,
math, tables and diagrams. Longer pieces of work become **artifacts** (HTML
pages, React components, SVG, Mermaid, Markdown and other documents) shown
beside the conversation, with versions, sharing and a library of everything
you have made. **Projects** keep their own instructions, files and
conversations together. Chat can also search the web, run multi-step
research, remember things about you (memory you can review and edit) and take
dictation.

![Projects](docs/images/screenshot-projects.png)

### Code

A Code session works in a folder on your computer, on a computer you reach
over SSH, or in the cloud on a GitHub repository. Codex reads and edits the
files and runs commands there; you see every step, the files it changed and
the full diff, and you can review and undo changes. The session rail shows
the environment, the context in use, connectors and background tasks. A
built-in terminal and a browser pane for dev servers sit next to the
conversation.

![A Code session with its changes](docs/images/screenshot-code.png)

![The diff of a session's changes](docs/images/screenshot-code-diff.png)

**Permission modes** decide what needs your approval: **Manual** asks before
every change, **Accept edits** applies file edits and still asks for
commands, **Plan** writes a plan first and acts once you approve it, **Auto**
lets Claudex make the permission decisions, and **Bypass permissions** accepts
everything (for a sandbox you trust). A request waits in the composer until
you answer it.

![A command waiting for approval](docs/images/screenshot-approval.png)

### Workflows and background tasks

For larger jobs Codex can run a **workflow**: several agents working in
phases (for example review, then verify), each with its own context, reported
back as one result. Long commands keep running in the background while you
carry on, and the session rail lists running and finished tasks, scheduled
prompts and loops with their next run.

![A finished review workflow](docs/images/screenshot-workflow.png)

### Scheduled tasks

Run a prompt on a schedule (daily, on weekdays, weekly, or by hand) in
Chat or Code, locally or in the cloud. Each run is a conversation you can
open afterwards, and results can be sent by email.

![Scheduled tasks](docs/images/screenshot-scheduled.png)

### Cloud environments

Cloud Code sessions, and every conversation in the web app, run on a
**runner**: a Linux host where each user's Codex runs in its own gVisor (or
bubblewrap) sandbox, built from a read-only image, with no network interface
of its own and limits on memory, CPU, processes and disk. An **environment**
sets the network access (none, trusted hosts, or full), a setup script and
environment variables. Network traffic goes through the runner's egress proxy,
model requests through a proxy that keeps the real key outside the sandbox,
and Git clones and pushes through a broker that uses short-lived GitHub App
tokens.

![Editing a cloud environment](docs/images/screenshot-cloud-env.png)

![A runner and its sandboxes](docs/images/cloud-sandbox.svg)

### Remote control

With Remote Control on, the desktop app keeps a link to the server so you can
carry on from a phone or a browser: pick an online computer, open one of its
Code sessions, send messages, stop a turn and answer approvals, or start a new
session there. The files and commands stay on the computer. The computer can
require each phone or browser to be trusted before it may connect.

![How remote control connects](docs/images/remote-control.svg)

### Computer use and simulators

On the desktop, Codex can operate apps on your computer (with per-app
permission, a view-only level for browsers, and an administrator policy), and
drive the iOS Simulator and Android emulators to build, run and check mobile
apps. Each step shows what it did, with screenshots.

![A computer-use task](docs/images/screenshot-computer-use.png)

### Skills, connectors and plugins

**Skills** are reusable instructions Codex loads when a task calls for them.
**Connectors** add tools and data through MCP servers, either remote ones you
connect to or local ones on your computer. **Plugins** bundle skills,
connectors and hooks, and come from marketplaces you add or from Git
repositories.

![Skills](docs/images/screenshot-customize.png)

![Connectors](docs/images/screenshot-connectors.png)

### Phone apps

Native apps for iOS (SwiftUI) and Android (Jetpack Compose) on the same
account: chats and projects, cloud Code sessions with their diffs, artifacts,
scheduled tasks, dictation and approvals. The Code tab lists your computers,
so a phone can also drive a desktop's sessions through remote control. The
conversation view is the same React renderer the desktop and web use.

<p>
<img src="docs/images/phone-android-home.png" width="19%" alt="New chat on Android">
<img src="docs/images/phone-android-drawer.png" width="19%" alt="Navigation on Android">
<img src="docs/images/phone-android-chat.png" width="19%" alt="A conversation on Android">
<img src="docs/images/phone-android-review.png" width="19%" alt="Reviewing a diff on Android">
<img src="docs/images/phone-android-codehome.png" width="19%" alt="Code sessions and computers on Android">
</p>
<p>
<img src="docs/images/phone-android-code.png" width="19%" alt="A Code session on Android">
<img src="docs/images/phone-ios-sign-in.png" width="19%" alt="Signing in on iOS">
</p>

### Web app, themes and languages

The web app is the same interface served by your server, with its sessions
running on runners. Every surface has light and dark themes and can follow
the system, and the interface is available in English and 11 other
languages.

![The new-chat page in the dark theme](docs/images/screenshot-home-dark.png)

### Accounts, plans and administration

The server is an extended fork of [Sub2API](https://github.com/Wei-Shaw/sub2api):
users and groups, upstream model accounts and their scheduling, model
allowlists and prices, balance, subscription plans with daily, weekly and
monthly limits, payments, usage records and an admin console. Claudex adds the
model catalog clients show, client policy, release channels for desktop
updates, announcements, service status, the web app and runner management.

## How it fits together

![How Claudex fits together](docs/images/architecture.svg)

| Path | What it is |
| --- | --- |
| `electron/`, `src/`, `shared/` | The desktop app: Electron main process, React interface, code both share |
| `src-web/`, `web.html` | The web app: the same interface with a browser bridge |
| `runner/` | Runs web and cloud sessions on a Linux host, one sandboxed Codex per user |
| `server/` | The desktop app's local model-service process |
| `backend/` | The Claudex server, a fork of Sub2API (Go, with a Vue admin console) |
| `mobile/ios`, `mobile/android` | Native phone apps (SwiftUI, Jetpack Compose) |
| `deploy/` | Images and scripts for running the server and the runner |
| `scripts/` | Build, packaging, preview and release tooling |
| `tests/` | Test suites (`node:test`) |

More in [docs/architecture.md](docs/architecture.md).

## Deployment

A deployment is one server (with PostgreSQL and Redis), one or more runners if
you want the web app and cloud sessions, and the clients built to point at
your server.

![Deployment steps](docs/images/deployment.svg)

### 1. The server

You need a Linux host with Docker Engine and Compose v2, a domain and a TLS
certificate.

```sh
# Build the image (on any machine with Docker)
deploy/claudex-server/build-image.sh            # claudex-server:<version>

# On the server
cd deploy/claudex-server
cp .env.example .env && chmod 600 .env          # replace every change-me; secrets: openssl rand -hex 32
docker compose config --quiet                   # reports missing settings
docker compose up -d
ADMIN_EMAIL=… ADMIN_PASSWORD=… ./check.sh http://127.0.0.1:8080
```

- The server listens on `127.0.0.1:8080`; put `nginx.conf.example` (TLS,
  unbuffered streaming, query strings kept out of access logs) in front of it.
- The first start creates the database and the administrator from
  `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
- Back up with `deploy/claudex-server/backup.sh`; upgrade by building a new
  image, backing up and changing `CLAUDEX_SERVER_IMAGE`.

Details, secrets from files, restore and upgrades:
[deploy/claudex-server/README.md](deploy/claudex-server/README.md).

### 2. The admin console

Open `https://your.server/admin` and sign in as the administrator.

1. Accept Sub2API's deployment and operation commitment. Until you do, the
   admin console and admin API refuse every request; no script does it for
   you.
2. Add upstream accounts (API keys for OpenAI-compatible or other providers
   you are entitled to use).
3. Create groups with model allowlists, set prices, and create plans with
   their limits; choose who may register.
4. On the Claudex pages: the model catalog (names, descriptions, effort
   levels), client policy, release channels, announcements and service status.
5. Turn on the web app and create a runner (next step).

[`deploy/sub2api/seed-claudex.sh`](deploy/sub2api/README.md) sets up groups,
accounts and prices repeatably. Optional services (dictation, web search,
image generation, email, payments) are covered in
[docs/self-hosting.md](docs/self-hosting.md).

### 3. Runners

A runner is a Linux host (Ubuntu 24.04, or WSL2 with systemd) with Node.js 22
or later. It dials out to the server, so it needs no inbound port.

```sh
# On a build machine
node scripts/build-runner.mjs                     # dist-runner/
deploy/claudex-runner/image/build.sh amd64        # sandbox image for gVisor

# On the runner host, as root, from deploy/claudex-runner/
useradd --system --create-home --home-dir /var/lib/claudex-runner claudex-runner
install -d -o claudex-runner /opt/claudex-runner /etc/claudex-runner
cp dist-runner/* /opt/claudex-runner/
(cd /opt/claudex-runner && npm install @openai/codex@0.144.1)
install -m 0600 -o claudex-runner runner.env.example /etc/claudex-runner/runner.env
install -m 0440 claudex-runner.sudoers /etc/sudoers.d/claudex-runner
install -m 0644 claudex-runner.service /etc/systemd/system/
image/install-image.sh claudex-sandbox-<version>-amd64.rootfs.tar.zst
```

Create the runner on the console's **Runners** page, save its token (shown
once) to `/etc/claudex-runner/token` (mode 0600, owned by `claudex-runner`),
edit `runner.env`, then:

```sh
systemctl daemon-reload
systemctl enable --now claudex-runner
journalctl -u claudex-runner -f
```

gVisor (`runsc`) is the recommended sandbox; bubblewrap works for a small
private setup. For cloud Code on GitHub repositories, register a GitHub App
and enter it in the console. See
[deploy/claudex-runner/README.md](deploy/claudex-runner/README.md).

### 4. Clients

**Web.** The server serves the web app at its root and the admin console at
`/admin`. Turn the web app on in the console and open your server's address.

**Desktop.** Build with your server's address (without it the sign-in page
asks for one), then package:

```sh
npm ci
export CLAUDEX_SERVICE_URL=https://your.server
npm run package:mac      # macOS .zip
npm run package:win      # Windows NSIS installer
npm run package:linux    # .deb, .rpm, .tar.gz for x64 and arm64
```

Sign the installers with your own certificates (see
[docs/building.md](docs/building.md)), upload them with
`scripts/release/publish.ts` and announce them on the console's release page;
installed apps update themselves. Changes to the interface alone can ship as
signed interface packs without a new installer. See
[docs/releasing.md](docs/releasing.md).

**Android.**

```sh
cd mobile/android
./gradlew :app:assembleProductionRelease -PclaudexOrigin=https://your.server
```

Signing settings are in [mobile/android/README.md](mobile/android/README.md);
the `demo` flavor runs on sample data without a server.

**iOS.** Set `CLAUDEX_SERVICE_URL` in the target's build settings, choose your
team and bundle identifier, and build the `Claudex` scheme in Xcode; see
[mobile/ios/README.md](mobile/ios/README.md).

## Development

You need Node.js 24 and npm.

```sh
npm ci
npm run dev           # desktop app with reload
npm run dev:web       # web app on http://127.0.0.1:5174
node --import tsx scripts/preview/ui-preview.mts   # whole interface on sample data, no server
```

```sh
npm test              # all tests
npm run build         # type-check and build the desktop app
npm run build:web     # build the web app into dist-web/
```

[docs/building.md](docs/building.md) covers build settings, signing, the web
app, the runner, the server and the phone apps.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

Claudex is released under the [Apache License 2.0](LICENSE), except
`backend/`, which as a fork of Sub2API stays under the
[GNU Lesser General Public License v3.0](backend/LICENSE). Bundled third-party
software and assets keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Open Claude Desktop (Claudex) is an independent project. It is not affiliated
with or endorsed by Anthropic or OpenAI. Claude is a trademark of Anthropic;
Codex is a trademark of OpenAI.
