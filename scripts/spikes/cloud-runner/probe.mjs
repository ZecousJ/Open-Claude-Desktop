// W-SPIKE / RUN-0: can the cloud runner host `codex app-server` (0.144.1)
// inside bwrap and gVisor (runsc)? Runs inside the spike container started by
// run.sh and writes results/<arch>.json. Every question is answered for each
// launcher: direct (baseline, no isolation), bwrap and runsc.
//
//   1. start + stdio JSON-RPC (initialize, thread/start, one turn)
//   2. the shell tool (exec_command) and Codex's own sandbox
//      (workspace-write must block writes outside the workspace and network)
//   3. memory: idle after a turn, and the peak during an `npm install`
//   4. thread/resume after the codex home and workspace were snapshotted,
//      deleted and restored under another host path (and across launchers)
//   5. git / npm / pip through the runner's allowlisting egress proxy, and
//      that a tool ignoring the proxy has no route out
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CodexHost,
  EgressProxy,
  MockResponses,
  Sandbox,
  cgroupMemoryMiB,
  delay,
  execPlan,
  message,
  outputText,
  sampler,
  tail,
  treeMemory,
  turnItems,
} from "./lib.mjs";

const OUT = process.env.SPIKE_OUT ?? "/out";
// Not under /tmp: Codex's workspace-write always allows /tmp, which would
// hide whether writes outside the workspace are blocked.
fs.mkdirSync("/var/spike", { recursive: true });
const ROOT = fs.mkdtempSync("/var/spike/run-");
fs.chmodSync(ROOT, 0o755);
const only = (process.env.SPIKE_LAUNCHERS ?? "direct,bwrap,runsc").split(",");
const skipNetwork = process.env.SPIKE_SKIP_NETWORK === "1";

const version = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
};

const findings = {
  generatedAt: new Date().toISOString(),
  arch: process.arch,
  kernel: os.release(),
  codex: version("/opt/codex/bin/codex", ["--version"]),
  bwrap: version("bwrap", ["--version"]),
  runsc: version("runsc", ["--version"]),
  runscPlatform: process.env.RUNSC_PLATFORM ?? "systrap",
  node: process.version,
  containerMemoryMiBAtStart: cgroupMemoryMiB(),
  launchers: {},
};

const mock = await new MockResponses().start();
const proxy = new EgressProxy([
  "github.com",
  "codeload.github.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
]);

// Codex's own sandbox: write inside and outside the workspace, open a socket
// to the model bridge (loopback, so only Codex's seccomp network rule can
// block it), and report how the command ran.
const SANDBOX_PROBE = [
  "echo in > /WS/in.txt && echo WS_WRITE_OK || echo WS_WRITE_BLOCKED",
  "(echo out > /SCRATCH/out.txt) 2>/dev/null && echo OUTSIDE_WRITE_OK || echo OUTSIDE_WRITE_BLOCKED",
  `node -e "require('net').connect(PORT,'127.0.0.1').on('connect',()=>{console.log('NET_OPEN');process.exit(0)}).on('error',e=>{console.log('NET_BLOCKED '+e.code);process.exit(0)})" 2>&1 | tail -1`,
  "echo UID=$(id -u)",
  "echo EXIT=0",
].join("; ");

function probeCommand(sb) {
  const port = sb.kind === "direct" ? mock.port : 18401;
  return SANDBOX_PROBE.replaceAll("/WS", sb.inner.ws)
    .replaceAll("/SCRATCH", sb.inner.scratch)
    .replaceAll("PORT", String(port));
}

function markers(text) {
  return (
    text.match(
      /WS_WRITE_\w+|OUTSIDE_WRITE_\w+|NET_OPEN|NET_BLOCKED \w*|UID=\d+|EXIT=\d+/g,
    ) ?? []
  );
}

async function execTurn(codex, threadId, label, cmd, extra) {
  mock.script = execPlan(cmd);
  try {
    const r = await codex.turn(threadId, label, extra);
    const outs = turnItems(r.requests.at(-1) ?? {})
      .filter((x) => x.type === "function_call_output")
      .map(outputText);
    const all = outs.join("\n");
    return {
      ran: outs.length > 0,
      markers: markers(all),
      output: all.slice(-1500),
      finalReply: r.requests.length,
      status: r.completed.turn?.status,
    };
  } catch (error) {
    return { ran: false, error: String(error) };
  }
}

async function snapshot(sb, file) {
  const r = spawnSync(
    "tar",
    ["-czf", file, "-C", sb.root, "codex-home", "workspace"],
    { encoding: "utf8" },
  );
  return {
    ok: r.status === 0,
    bytes: fs.statSync(file).size,
    ...(r.status ? { tarStderr: r.stderr.slice(-500) } : {}),
  };
}

async function restore(sb, file) {
  fs.rmSync(sb.host.home, { recursive: true, force: true });
  fs.rmSync(sb.host.ws, { recursive: true, force: true });
  const r = spawnSync("tar", ["-xzf", file, "-C", sb.root]);
  spawnSync("chown", ["-R", "1000:1000", sb.root]);
  return r.status === 0;
}

/** Restores a snapshot into a fresh sandbox, resumes the thread, runs a turn. */
async function resumeCheck(kind, label, file, threadId, marker) {
  const sb = new Sandbox(kind, ROOT, label);
  await sb.listen(mock, proxy);
  const res = { hostRoot: sb.root };
  let codex;
  try {
    res.restored = await restore(sb, file);
    codex = await new CodexHost(sb, mock).start();
    const resumed = await codex.resume(threadId);
    res.resumedTurns = resumed.thread?.turns?.length ?? null;
    res.resumedPath = resumed.thread?.path ?? null;
    mock.script = () => [message("RESUMED_OK")];
    const t = await codex.turn(threadId, "after restore");
    const history = JSON.stringify(t.requests[0]?.input ?? []);
    res.previousContextSent = history.includes(marker);
    res.turnStatus = t.completed.turn?.status;
    res.ok = res.previousContextSent && res.turnStatus === "completed";
  } catch (error) {
    res.ok = false;
    res.error = String(error);
    if (codex) res.stderr = tail(codex.stderr);
  } finally {
    await codex?.stop();
    sb.close();
  }
  return res;
}

async function egressChecks(sb) {
  const run = (cmd) => sb.exec(cmd);
  const summary = (r, okPattern) => ({
    ok: r.code === 0 && (!okPattern || okPattern.test(r.output)),
    code: r.code,
    ms: r.ms,
    output: r.output.slice(-600),
  });
  const retry = (cmd) =>
    `for i in 1 2 3; do ${cmd} && exit 0; sleep 2; done; exit 1`;
  const out = {};
  const before = proxy.log.length;
  out.git = summary(
    await run(
      retry(
        "rm -rf /workspace/hello && git clone --depth 1 -q https://github.com/octocat/Hello-World /workspace/hello && test -f /workspace/hello/README",
      ),
    ),
  );
  out.npm = summary(
    await run(
      retry(
        "mkdir -p /workspace/npmcheck && cd /workspace/npmcheck && npm install --no-audit --no-fund --silent is-number@7.0.0 && node -e \"require('is-number')\"",
      ),
    ),
  );
  out.pip = summary(
    await run(
      retry(
        "python3 -m pip download --no-deps --disable-pip-version-check -q -d /tmp/pip six==1.16.0 && ls /tmp/pip",
      ),
    ),
    /six-1\.16\.0/,
  );
  out.blockedHost = summary(
    await run(
      "curl -sS -o /dev/null -w '%{http_code}' https://example.com; echo",
    ),
  );
  out.blockedHost.ok = /403|CONNECT tunnel failed/.test(out.blockedHost.output);
  out.bypassProxy = summary(
    await run(
      "curl -sS --max-time 10 --noproxy '*' -o /dev/null https://registry.npmjs.org/ && echo REACHED || echo NO_ROUTE",
    ),
  );
  out.bypassProxy.ok = /NO_ROUTE/.test(out.bypassProxy.output);
  out.proxyLog = proxy.log
    .slice(before)
    .map(
      (e) =>
        `${e.kind} ${e.host}${e.port ? ":" + e.port : ""} ${e.allowed ? "allowed" : "BLOCKED"}${e.error ? " " + e.error : ""}`,
    );
  return out;
}

const snapshots = {};

/** Writes results after every launcher, so a crash keeps what was learned. */
function save() {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${process.arch}.json`);
  fs.writeFileSync(file, JSON.stringify(findings, null, 2) + "\n");
  return file;
}

/** Warning and error lines from runsc's own logs (runsc sandboxes only). */
function runscErrors(sb) {
  if (sb.kind !== "runsc") return undefined;
  const dir = path.join(sb.root, "runsc-logs");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((f) =>
      fs
        .readFileSync(path.join(dir, f), "utf8")
        .split("\n")
        .filter((l) => /^[WE]\d{4}|error|fail/i.test(l))
        .map((l) => `${f}: ${l.slice(0, 300)}`),
    )
    .slice(-25);
}

for (const kind of only) {
  const res = (findings.launchers[kind] = {});
  const sb = new Sandbox(kind, ROOT, `${kind}-a`);
  await sb.listen(mock, proxy);
  let codex;
  console.error(`[spike] ${kind}: starting app-server`);
  try {
    codex = await new CodexHost(sb, mock).start();
    res.start = {
      ok: true,
      ms: codex.startupMs,
      userAgent: codex.initialize?.userAgent ?? null,
      codexHome: codex.initialize?.codexHome ?? null,
    };
  } catch (error) {
    res.start = {
      ok: false,
      error: String(error),
      stderr: tail(codex?.stderr ?? ""),
      runscLog: runscErrors(sb),
    };
    await codex?.stop();
    sb.close();
    save();
    continue;
  }
  try {
    const marker = `MARKER_${kind.toUpperCase()}_${Date.now()}`;
    const threadId = await codex.thread();
    mock.script = () => [message(`HELLO_${kind}`)];
    const first = await codex.turn(threadId, `remember ${marker}`);
    res.jsonRpc = {
      ok: first.completed.turn?.status === "completed",
      threadId,
      agentReply:
        first.items.find((i) => i.type === "agentMessage")?.text ?? null,
      advertisedTools:
        first.requests[0]?.tools?.map((t) => t.name ?? t.type) ?? [],
    };

    await delay(3000);
    res.memoryIdle = {
      ...treeMemory(codex.child.pid),
      containerMiB: cgroupMemoryMiB(),
      runscStats: sb.runscStats(),
    };

    console.error(`[spike] ${kind}: codex sandbox checks`);
    res.codexSandbox = {
      workspaceWrite: await execTurn(
        codex,
        threadId,
        "sandbox probe (workspace-write)",
        probeCommand(sb),
      ),
      // Network allowed: Codex's bwrap then keeps the network namespace, so
      // only the filesystem part of its sandbox is in play.
      workspaceWriteWithNetwork: await execTurn(
        codex,
        threadId,
        "sandbox probe (workspace-write, network on)",
        probeCommand(sb),
        {
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      ),
      dangerFullAccess: await execTurn(
        codex,
        threadId,
        "sandbox probe (danger-full-access)",
        probeCommand(sb),
        { sandboxPolicy: { type: "dangerFullAccess" } },
      ),
    };
    res.codexSandbox.stderr = tail(codex.stderr, 20);
    const ws = res.codexSandbox.workspaceWrite.markers ?? [];
    res.codexSandbox.verdict = !res.codexSandbox.workspaceWrite.ran
      ? "exec failed under workspace-write"
      : ws.includes("OUTSIDE_WRITE_BLOCKED") &&
          ws.some((m) => m.startsWith("NET_BLOCKED"))
        ? "codex sandbox enforced (writes outside workspace and network blocked)"
        : ws.includes("WS_WRITE_OK")
          ? `codex sandbox NOT enforced: ${ws.join(" ")}`
          : `codex sandbox broke the command: ${ws.join(" ") || "no markers"}`;

    if (!skipNetwork) {
      console.error(`[spike] ${kind}: npm install through codex`);
      const peak = sampler(codex.child.pid);
      const install = await execTurn(
        codex,
        threadId,
        "npm install",
        "cd " +
          sb.inner.ws +
          " && mkdir -p npmrss && cd npmrss && npm init -y >/dev/null && " +
          "for i in 1 2 3; do npm install --no-audit --no-fund --silent typescript@5.6.3 && break; sleep 2; done; " +
          "node -e \"require('typescript');console.log('TS_OK')\"; echo EXIT=$?",
        { sandboxPolicy: { type: "dangerFullAccess" } },
      );
      res.memoryNpmInstall = {
        peak: peak.stop(),
        installed: /TS_OK/.test(install.output ?? ""),
        output: (install.output ?? install.error ?? "").slice(-400),
      };
    }

    await codex.stop();
    const file = path.join(ROOT, `${kind}-snapshot.tgz`);
    res.snapshot = await snapshot(sb, file);
    snapshots[kind] = { file, threadId, marker };
    console.error(`[spike] ${kind}: resume after restore`);
    res.resumeAfterRestore = await resumeCheck(
      kind,
      `${kind}-b`,
      file,
      threadId,
      marker,
    );
    if (kind === "runsc" && snapshots.bwrap) {
      const s = snapshots.bwrap;
      res.resumeBwrapSnapshotUnderRunsc = await resumeCheck(
        "runsc",
        "runsc-from-bwrap",
        s.file,
        s.threadId,
        s.marker,
      );
    }
    if (kind !== "direct" && !skipNetwork) {
      console.error(`[spike] ${kind}: egress through the proxy`);
      res.egress = await egressChecks(sb);
    }
  } catch (error) {
    res.error = String(error);
    res.stderr = tail(codex?.stderr ?? "", 30);
    res.runscLog = runscErrors(sb);
  } finally {
    await codex?.stop();
    sb.close();
    save();
  }
}

// Density: several sandboxes at once (one app-server and one finished turn
// each). Shared file pages (the Codex binary) are split between processes in
// PSS, so this shows the per-sandbox cost when a runner hosts many.
const DENSITY = Number(process.env.SPIKE_DENSITY ?? 2);
findings.density = {};
for (const kind of only.filter((k) => k !== "direct")) {
  if (!DENSITY) break;
  const before = cgroupMemoryMiB();
  const hosts = [];
  const res = (findings.density[kind] = { sandboxes: DENSITY });
  console.error(`[spike] ${kind}: density x${DENSITY}`);
  try {
    for (let i = 0; i < DENSITY; i++) {
      const sb = new Sandbox(kind, ROOT, `${kind}-density-${i}`);
      await sb.listen(mock, proxy);
      const codex = await new CodexHost(sb, mock).start();
      hosts.push({ sb, codex });
      const id = await codex.thread();
      mock.script = () => [message("ok")];
      await codex.turn(id, "hello");
    }
    await delay(3000);
    const each = hosts.map(({ codex }) => treeMemory(codex.child.pid));
    res.pssMiBEach = each.map((m) => m.pssMiB);
    res.pssMiBTotal = Math.round(each.reduce((a, m) => a + m.pssMiB, 0));
    res.containerDeltaMiB = Math.round(cgroupMemoryMiB() - before);
    res.containerDeltaMiBPerSandbox = Math.round(
      res.containerDeltaMiB / DENSITY,
    );
  } catch (error) {
    res.error = String(error);
    res.started = hosts.length;
  } finally {
    for (const { sb, codex } of hosts) {
      await codex.stop();
      sb.close();
    }
    save();
  }
}

findings.containerMemoryMiBAtEnd = cgroupMemoryMiB();
proxy.close();
await mock.close();
const outFile = save();
if (process.env.SPIKE_KEEP !== "1")
  fs.rmSync(ROOT, { recursive: true, force: true });
console.error(`[spike] wrote ${outFile}`);
process.exit(0);
