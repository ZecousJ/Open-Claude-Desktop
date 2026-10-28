# Claudex runner deployment

The runner runs the web app's conversations: it dials out to the Claudex
server, gets assigned users, and runs one Codex per user inside a sandbox.
It needs a Linux host (Ubuntu 24.04 and WSL2 with systemd both work) with
Node.js 22 or later.

| File | Purpose |
| --- | --- |
| `claudex-runner.service` | systemd unit |
| `runner.env.example` | Settings; every one is described at the top of `runner/src/main.ts` |
| `claudex-runner.sudoers` | What the gVisor driver may run as root |
| `image/` | The sandbox root file system for the gVisor driver |

## Sandboxes

- **gVisor** (`CLAUDEX_RUNNER_DRIVER=runsc`, recommended): each user's Codex
  runs in its own gVisor sandbox with no network of its own, from the
  read-only image in `image/`. Needs `runsc`, cgroup v2 with the memory, pids
  and cpu controllers, and (for `CLAUDEX_RUNNER_DISK_QUOTA=loop`) the ext4
  volume tools. See [image/README.md](image/README.md).
- **bubblewrap** (`CLAUDEX_RUNNER_DRIVER=bwrap`): namespaces only, weaker
  than gVisor; the runner caps the network at `trusted`. Suitable for a
  small private deployment on the server itself.

Either way the model key never enters the sandbox: Codex reaches the gateway
through a loopback token the runner's provider service exchanges.

## Install

On a build machine:

```sh
node scripts/build-runner.mjs          # dist-runner/
deploy/claudex-runner/image/build.sh amd64   # gVisor driver only
```

On the runner host, as root:

```sh
useradd --system --create-home --home-dir /var/lib/claudex-runner claudex-runner
install -d -o claudex-runner /opt/claudex-runner /etc/claudex-runner
cp dist-runner/* /opt/claudex-runner/
cd /opt/claudex-runner && npm install @openai/codex@0.144.1   # the Codex version the app pins

install -m 0600 -o claudex-runner runner.env.example /etc/claudex-runner/runner.env
install -m 0440 claudex-runner.sudoers /etc/sudoers.d/claudex-runner
install -m 0644 claudex-runner.service /etc/systemd/system/
image/install-image.sh claudex-sandbox-<version>-amd64.rootfs.tar.zst
```

In the server's admin console, open **Runners**, create a runner and save
its token (shown once) to `/etc/claudex-runner/token` (mode 0600, owned by
`claudex-runner`). Edit `runner.env`, then:

```sh
systemctl daemon-reload
systemctl enable --now claudex-runner
journalctl -u claudex-runner -f
```

The runner shows as connected on the Runners page. To update it, copy a new
`dist-runner/` and `systemctl restart claudex-runner`; running turns finish
first (up to the unit's `TimeoutStopSec`).
