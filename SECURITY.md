# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository. Include what is
affected (desktop, web app, runner, server, phone app), the version or
commit, and steps to reproduce.

We aim to reply within a week and to fix confirmed problems in the next
release, crediting you unless you'd rather not be named.

## Supported versions

Fixes go into the latest release and `main`. Older versions are not patched.

## Scope

In scope: code in this repository, including the server in `backend/` and
the deployment files in `deploy/`. Vulnerabilities in upstream projects
(Codex, Electron, Sub2API, other dependencies) should also be reported to
them; tell us too if Claudex's use of them is affected.

Areas where a report is especially valuable:

- the renderer reaching the main process beyond the preload bridge;
- interface packs or hosted interfaces loading unsigned code;
- sandbox escapes on the runner (gVisor, bubblewrap) or in Codex's
  sandbox on the desktop;
- one user reaching another user's data on the server or a runner;
- keys or tokens leaking into logs, sandboxes or the renderer.
