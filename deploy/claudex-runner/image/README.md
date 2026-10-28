# claudex-sandbox image and gVisor runtime settings

The root file system of every gVisor sandbox on a runner host. The runner's
`RunscDriver` (`runner/src/sandbox/runsc.ts`) runs codex from this image,
read-only, with the sandbox's workspace and codex home bound in.

| File | Purpose |
| --- | --- |
| `Dockerfile` | Debian 12 slim + git, build-essential, Python 3, Node 24, and Codex 0.144.1 checked against the npm registry integrity (sha512) for amd64 and arm64. Writes `/opt/claudex/image.json`. |
| `build.sh` | Builds the image on a development machine or in CI and packs `claudex-sandbox-<version>-<arch>.rootfs.tar.zst` plus `.sha256` and a copy of the manifest into `work/runner-image/`. |
| `install-image.sh` | On the runner host, as root: verifies the archive, unpacks it to `/var/lib/claudex-runner/images/<version>-<arch>/rootfs`, re-checks codex against the manifest, makes it root-owned and read-only, and moves the `current` link. |
| `runsc.toml` | Only for the optional containerd engine: options for `containerd-shim-runsc-v1` (`network = "none"`, `host-uds = "open"`, `platform = "systrap"`). `RunscDriver.check()` refuses a file that turns the network on or the host sockets off. |

## Build and install

```sh
# build machine (Docker)
deploy/claudex-runner/image/build.sh amd64
# runner host, as root
install-image.sh claudex-sandbox-<version>-amd64.rootfs.tar.zst
install -m 0644 runsc.toml /etc/claudex-runner/runsc.toml
```

To move to a new Codex version, change
`CODEX_VERSION` and both `CODEX_SRI_*` values in the Dockerfile (take them
from `npm view @openai/codex@<version>-linux-x64 dist.integrity` and the
`-linux-arm64` variant) together with the desktop app's pin.

## Runner host requirements

- gVisor release `20260921` or later, installed whole (`runsc`, the
  `gvisor-bin/` directory next to it, and `containerd-shim-runsc-v1` on
  containerd's PATH).
- The default engine is `runsc` (`runsc run --bundle`, flags
  `--network=none --host-uds=open`). It needs root for the per-sandbox
  cgroups, so the runner runs as root or calls the launcher through a
  dedicated sudo rule; the sandbox itself runs as uid 1000 without
  capabilities. This path is verified end to end (real codex, memory limit,
  loop quota, snapshots).
- Optional engine `containerd`: the runner uses
  its own namespace `claudex` and only `ctr run --config`, so no CRI or CNI
  setup is needed; install `runsc.toml` for the shim. The runner user needs
  the containerd socket (for example `[grpc] gid = <claudex-runner gid>`),
  which is equivalent to root. The runsc shim has been seen to hang after
  `runsc create` (containerd 2.3.6, gVisor 20260921), so only switch to it
  after `RunscDriver.check({ smoke: true })` passes on the host.
- cgroup v2 with the memory, pids and cpu controllers (WSL2 with systemd has
  them). Sandboxes go below `/sys/fs/cgroup/claudex/`.
- Disk quotas: the loop quota (`quota.ts`, `LoopQuota`) needs `mkfs.ext4`,
  `mount`, `umount`, `losetup` and `resize2fs` as root (or through
  `sudo -n`). On XFS with `prjquota`, `XfsProjectQuota` is lighter.
- Snapshots: local disk by default; with S3-compatible storage (such as
  Cloudflare R2) configured on the server, the runner gets the endpoint,
  bucket and keys at run time. They stay in the runner process, never in a
  sandbox or a log.

## Licenses

The image bundles Debian packages (their own licenses, listed in
`/usr/share/doc/*/copyright` inside the image), Node.js (MIT) and Codex
(Apache-2.0). The runner hosts it privately; it is not published.
