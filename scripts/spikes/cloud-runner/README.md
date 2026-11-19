# Cloud runner feasibility spike (W-SPIKE / RUN-0)

Can the web version's cloud runner host `codex app-server` (the bundled
`@openai/codex` 0.144.1) inside a bubblewrap sandbox and inside gVisor (runsc)?
The probe starts the real Linux build of Codex against a loopback Responses
mock (fake key, no paid requests) and answers the questions from
`W-RUN-design.md` section 13 (RUN-0) for three launchers:

- `direct`: no isolation, the baseline;
- `bwrap`: bubblewrap as an unprivileged user (new user, pid, net, ipc, uts
  and cgroup namespaces; read-only system dirs; `/codex-home`, `/workspace`,
  `/scratch` and `/run/claudex` bound in), the planned `single` test mode;
- `runsc`: gVisor, an OCI bundle run with `--network=none --host-uds=open`
  (systrap platform), the planned production driver.

The sandbox has only loopback. `bridge.mjs` runs inside it and forwards
`127.0.0.1:18401` (model gateway) and `127.0.0.1:3128` (egress proxy) to Unix
sockets that the runner binds in; `lib.mjs` has the runner side, including an
allowlisting CONNECT proxy.

## Running

```sh
GOLOCK_WEIGHT=2 SCRATCH/golock.sh scripts/spikes/cloud-runner/run.sh
node scripts/spikes/cloud-runner/summary.mjs
```

`run.sh` downloads (with retries) and hash-checks the Codex Linux package and
the gVisor `20260921` release into `work/spikes/cloud-runner/cache`, builds a
small Alpine image (`Dockerfile`) and runs `probe.mjs` in a privileged
container limited to 3 GB and 3 CPUs. It needs network for the downloads and
for the git/npm/pip checks (`SPIKE_SKIP_NETWORK=1` skips the latter). Results:
`results/<arch>.json`. It takes about 5 minutes on the Docker Desktop VM.

## Results (arm64, Docker Desktop VM, kernel 6.12, 2026-09-26)

| Question | bwrap | runsc (gVisor) |
| --- | --- | --- |
| app-server starts, stdio JSON-RPC (initialize, thread/start, turn) | Yes, 1.9 s | Yes, 16.6 s for the first sandbox (cold: runsc builds its seccomp programs and reads the 259 MB Codex binary through the gofer) |
| Shell tool (`exec_command`, `write_stdin`) | Works | Works |
| Codex's own sandbox, `workspace-write` (network off) | Enforced: writes outside the workspace and network are blocked | **Breaks every command**: Codex's bundled bwrap cannot set up loopback in a new network namespace under gVisor (`bwrap: loopback: Failed RTM_NEWADDR`), and Codex logs that its Linux sandbox needs user namespaces |
| Codex's own sandbox, `workspace-write` with `networkAccess: true` | Enforced (filesystem) | **Enforced (filesystem)**: only the network part fails, so this mode works |
| `danger-full-access` | Works | Works |
| Idle memory after one turn (PSS of the process tree) | 144 MiB (Codex 94) | 907 MiB; 777 MiB of it is file-backed (host page cache of mapped files), anonymous 31 MiB; runsc reports 414 MiB in-sandbox usage |
| Peak during `npm install typescript` through Codex | 301 MiB | 1717 MiB (726 MiB is the sentry's memfd: guest memory including gVisor's own page cache) |
| Two more sandboxes at once, each with one finished turn (container memory delta) | +41 MiB per sandbox | +104 MiB per sandbox |
| `thread/resume` after the codex home and workspace were tarred, deleted and restored under another host path | Works (history sent, turn completes) | Works; a bwrap snapshot also resumes under runsc |
| git clone, npm install, pip download through the egress proxy (`HTTPS_PROXY`) | Work | Work |
| Host not on the allowlist | 403 from the proxy | 403 from the proxy |
| A tool that ignores the proxy (`curl --noproxy '*'`) | No route (no DNS, no network) | No route |

Direct (no sandbox) for reference: start 2.8 s, idle 99 MiB, npm peak 226 MiB,
Codex's own sandbox enforced.

## Conclusions for W-RUNNER, W-BWRAP, W-GVISOR, W-EGRESS

1. **Both drivers can host Codex.** stdio JSON-RPC, the shell tool, resume and
   egress through the proxy work in bwrap and in gVisor.
2. **Codex's own sandbox under gVisor**: do not use Codex's `workspace-write`
   with network off inside runsc (every command fails). Use `workspace-write`
   with `networkAccess: true` (its filesystem sandbox still works, and the
   outer sandbox has no network other than the proxy anyway), or
   `danger-full-access` with the outer sandbox as the boundary. The first keeps
   Codex's approval flow meaningful for Auto/Ask. Under bwrap Codex's own
   sandbox works fully, nested inside the outer user namespace.
3. **Network**: a loopback-only namespace plus Unix-socket bridges is enough;
   git, npm and pip honour `HTTPS_PROXY`, tools that ignore it simply have no
   route. A transparent proxy (iptables redirect) is not needed. Only
   CONNECT to port 443 was allowed in the spike; the real proxy also needs
   per-session byte counters (the spike logs bytes per tunnel).
4. **Snapshots**: keep the in-sandbox paths fixed (`/codex-home`,
   `/workspace`). Codex records absolute paths (rollout path, sqlite state):
   with the direct launcher, a thread restored under another host path still
   resumed, but `thread.path` pointed at the old location. With fixed
   in-sandbox paths the host directory can change freely.
5. **Memory and capacity**: gVisor costs far more memory than bwrap. Idle,
   an extra sandbox adds about 100 MiB (bwrap about 40 MiB) once the Codex
   binary is in the page cache; a build step can push one sandbox to 1.7 GB
   because the sentry keeps the guest page cache in its own memory. Run each
   sandbox in its own cgroup with a memory limit (the spike used
   `--ignore-cgroups`) so the sentry is made to reclaim, and plan the design's
   "8 GB for about 3 code + 6 chat" estimate as optimistic for gVisor until it
   is measured on the real x86_64 host. The global limit of one active engine
   on DC6 stands; `single` mode on DC6 should use bwrap.
6. **runsc setup details** the driver must get right:
   - the OCI root must be its own directory (an image rootfs), not the host
     `/`: with `/` as root, runsc silently drops every bind mount and the
     sandbox sees empty mount-point directories;
   - release 2026-09 and later start the sentry from the `gvisor-bin/` sidecar
     next to `runsc`; install the whole release archive, not only `runsc`;
   - use a shared `--root` (or `--shared-root`) across sandboxes for faster
     starts, and expect the first start on a host to be slow;
   - Node's stdio pipes (Unix socketpairs) work as the sandbox's stdio.
7. **Hardening the spike did not need but production does** (review notes):
   - bwrap: add `--new-session` (no shared controlling terminal, so no
     `TIOCSTI` injection) and `--cap-drop ALL`; the spike child has no TTY, so
     the measurements are unaffected. The runner host (WSL2 Ubuntu 24.04) ships
     bubblewrap 0.9.0; the spike image had 0.12.0, so recheck the flags there.
   - The egress proxy checks the host name only. The real one must resolve the
     name itself and refuse private, loopback and link-local addresses (DNS
     rebinding), restrict plain-HTTP requests to port 80, and strip
     `Proxy-*` and hop-by-hop headers before forwarding.
   - Codex started `git-remote-http` on its own at idle (direct and bwrap: about
     11 MiB PSS), apparently a background git fetch at start-up. W-RUNNER should find
     the setting that turns this off, or the proxy allowlist must expect it;
     the idle numbers above include it.
8. **Not measured here**: x86_64 (the production VPS; `run.sh` supports it and
   takes the hashes from the registry and the release), the ptrace platform
   (`RUNSC_PLATFORM=ptrace`), containerd/`containerd-shim-runsc-v1`, cgroup
   limits and disk quotas, and a real model.
