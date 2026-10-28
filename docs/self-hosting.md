# Running your own Claudex server

A Claudex deployment is the server (with PostgreSQL and Redis), optionally
one or more runners for the web app, and the clients pointed at it.

```text
desktop / phones / browsers ──HTTPS──> TLS proxy ──> Claudex server ──> model providers
                                                       │   ▲
                                          PostgreSQL ──┘   └── runners (outbound WebSocket)
                                          Redis
```

## 1. The server

Follow [`deploy/claudex-server/README.md`](../deploy/claudex-server/README.md):
build the image, fill in `.env`, start it with Docker Compose behind a TLS
proxy (`nginx.conf.example`), and set up backups. The first start creates the
administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

Before the admin console or the admin API does anything, the administrator
must accept Sub2API's deployment and operation commitment in the console.
No script does this for you. Read the upstream README's notice about
commercial operation (`backend/README.md`) before offering the service to
others, and only connect upstream accounts you are entitled to use through
their APIs.

## 2. Models, plans and settings

In the admin console, or with
[`deploy/sub2api/seed-claudex.sh`](../deploy/sub2api/README.md) for a
repeatable setup:

- add upstream accounts (API keys for OpenAI-compatible or other providers);
- create groups with model allowlists, a balance group and subscription plans
  with daily, weekly and monthly limits;
- set token prices;
- choose who may register (open, invitation, email verification);
- set the group new desktop devices are provisioned in.

The Claudex pages of the console add the client policy, model catalog
(names, descriptions, efforts), release channels, announcements, service
status, usage rules, the web app and runners.

## 3. The web app

The server serves the web app at its root and the admin console at `/admin`.
The image embeds both. To serve a different web build, set
`CLAUDEX_WEB_APP_DIR` to a folder holding `npm run build:web`'s `dist-web/`.

Turn the web app on, and choose who may use it, under the console's web app
settings. Chat in the web app needs at least one runner; so do cloud Code
sessions for the desktop and the phones.

## 4. Runners

See [`deploy/claudex-runner/README.md`](../deploy/claudex-runner/README.md).
A runner is a Linux host that connects out to the server with a token from
the console's **Runners** page, so it needs no inbound port. Each user's
Codex runs in a gVisor (or bubblewrap) sandbox, and network access goes
through the runner's egress policy.

For cloud Code on GitHub repositories, register a GitHub App and enter it in
the console; the runner clones and pushes through a broker outside the
sandbox, with short-lived installation tokens.

## 5. Clients

- **Desktop**: build with `CLAUDEX_SERVICE_URL=https://your.server`, or let
  users type the address on the sign-in page. Publish installers through the
  console's release page; see [releasing.md](releasing.md).
- **Web**: open the server's address.
- **Phones**: build with your server's address (`CLAUDEX_SERVICE_URL` for iOS,
  `-PclaudexOrigin` for Android).

## Optional services

- **Dictation**: the server relays microphone audio to a realtime
  transcription service you configure in the console; its key stays on the
  server.
- **Web search** and **image generation** use upstream models or tools you
  enable per group.
- **Email** (verification codes, password reset, scheduled-task mail): SMTP
  settings in the console.
- **Payments**: Sub2API's payment providers (Stripe and others); the desktop
  opens the server's checkout page in the browser.

## Legal pages

`backend/docs/legal/terms.en.md` and `terms.zh.md` are the terms the server
shows at `/legal/terms`, written as templates. Replace `[Operator]` and
`[contact email]` (`【运营方】` and `【联系邮箱】` in Chinese) with your own
details and have them reviewed for your jurisdiction. Links to your privacy
policy and usage policy are set in the console's Claudex settings.
