# Open Claude Desktop

Open Claude Desktop is an open-source workspace for working with AI models,
built as an app called **Claudex**: a desktop app for macOS, Windows and
Linux, a web app, and phone apps for iOS and Android. Conversations
run on the open-source [Codex](https://github.com/openai/codex) agent, so the
model can read files, run commands, edit code and use tools, with your approval
where it matters.

[简体中文](README.zh-CN.md)

## What's in it

- **Chat** with artifacts (HTML, SVG, React, Mermaid, documents), file
  attachments, projects with their own instructions and files, memory, web
  search and research.
- **Code**: sessions in a local folder, over SSH, or in the cloud on a
  GitHub repository. Permission modes, plans, diffs and review, a terminal,
  a browser pane for dev servers, background tasks, scheduled prompts and
  multi-agent workflows.
- **Computer use** and **iOS/Android simulator** control from the desktop.
- **Remote control**: pick up a desktop session from the web or a phone.
- **Accounts, plans and usage** from the Claudex server, an extended fork of
  [Sub2API](https://github.com/Wei-Shaw/sub2api) that also serves the web app
  and an admin console.
- Interface in 11 languages.

## How it fits together

```
 desktop app (Electron)      web app (browser)        phone apps
   │  Codex runs locally        │                        │
   │                            ▼                        │
   │                      runner ── Codex in a gVisor    │
   │                        │      or bubblewrap sandbox │
   ▼                        ▼                            ▼
 Claudex server (backend/): accounts, models, billing, sync, web relay
   │
   ▼
 model providers (OpenAI-compatible APIs and others)
```

| Path | What it is |
| --- | --- |
| `electron/`, `src/`, `shared/` | The desktop app: Electron main process, React interface, code both share |
| `src-web/`, `web.html` | The web app: the same interface with a browser bridge |
| `runner/` | Runs the web app's sessions on a Linux host, one sandboxed Codex per user |
| `server/` | The desktop app's local model-service process |
| `backend/` | The Claudex server, a fork of Sub2API (Go, with a Vue admin console) |
| `mobile/ios`, `mobile/android` | Native phone apps (SwiftUI, Jetpack Compose) |
| `deploy/` | Images and scripts for running the server and the runner |
| `scripts/` | Build, packaging and release tooling |
| `tests/` | Test suites (`node:test`) |
| `preview/` | Static pages showing interface states, for development |

More in [docs/architecture.md](docs/architecture.md).

## Getting started

You need Node.js 24 and npm.

```sh
npm ci
npm run dev
```

The app signs in to a Claudex server. Name one at build time with
`CLAUDEX_SERVICE_URL=https://claudex.example.com`, or enter its address on
the sign-in page. To run a server yourself, see
[docs/self-hosting.md](docs/self-hosting.md).

Other commands:

```sh
npm test              # all tests
npm run build         # type-check and build the desktop app
npm run build:web     # build the web app into dist-web/
npm run package:mac   # installers (also package:win, package:linux)
```

[docs/building.md](docs/building.md) covers build settings, signing, the web
app, the runner and the phone apps. [docs/releasing.md](docs/releasing.md)
covers update channels and interface packs.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

Claudex is released under the [Apache License 2.0](LICENSE), except
`backend/`, which as a fork of Sub2API stays under the
[GNU Lesser General Public License v3.0](backend/LICENSE). Bundled third-party
software and assets keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Open Claude Desktop (Claudex) is an independent project. It is not affiliated with or endorsed by
Anthropic or OpenAI. Claude is a trademark of Anthropic; Codex is a trademark
of OpenAI.
