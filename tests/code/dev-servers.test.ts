/**
 * Dev servers (R8-B) with real processes: a small node server started from
 * a temporary folder's .claude/launch.json. Starting and waiting for the
 * port, logs, stopping the whole process group, port timeouts, crashes and
 * approvals asked again, Claude's starts (approval, scheduled runs),
 * the administrator's switch, the environment without secrets, folders
 * outside the project, saving launch.json, addresses printed in the
 * Terminal, and closing everything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AppEvent } from "../../shared/types";
import {
  DevServers,
  type DevServerApprovalRequest,
  type DevServersDeps,
} from "../../electron/browser/dev-servers";
import {
  LogBuffer,
  localPortOpen,
  mergePath,
  quoteWindowsArg,
  scrubEnv,
  windowsCommand,
} from "../../electron/browser/dev-server-support";

const serverScript = `
import http from "node:http";
import { spawn } from "node:child_process";
const mode = process.env.FAKE_MODE || "serve";
const port = Number(process.env.FAKE_PORT || 0);
if (mode === "env") {
  console.log("ENV " + JSON.stringify(Object.keys(process.env).sort()));
  console.log("CWD " + process.cwd());
}
if (mode === "never") {
  console.log("booting forever");
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  console.error("boom");
  process.exit(3);
} else if (mode === "child") {
  spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, FAKE_MODE: "serve" },
    stdio: "inherit",
  });
  setInterval(() => {}, 1000);
} else {
  const server = http
    .createServer((_q, s) => s.end("ok"))
    .listen(port, "127.0.0.1", () => {
      process.stdout.write("\\u001b[32mLocal:\\u001b[0m http://localhost:" + server.address().port + "/\\n");
      if (process.env.FAKE_CRASH_MS)
        setTimeout(() => process.exit(1), Number(process.env.FAKE_CRASH_MS));
    });
  process.on("SIGTERM", () => {
    console.log("bye");
    process.exit(0);
  });
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await wait(40);
  }
  return false;
}

interface Setup {
  folder: string;
  servers: DevServers;
  events: Set<(event: AppEvent) => void>;
  state: { unattended: boolean; allowed: boolean; deleted: boolean };
  writeConfig(configurations: unknown[]): void;
  changes: string[];
}

function setup(
  extra: Partial<DevServersDeps> = {},
  cwd?: (folder: string) => string,
): Setup {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-dev-"));
  fs.writeFileSync(path.join(folder, "server.mjs"), serverScript);
  const events = new Set<(event: AppEvent) => void>();
  const state = { unattended: false, allowed: true, deleted: false };
  const servers = new DevServers({
    conversation: (id) =>
      state.deleted
        ? undefined
        : id === "remote"
          ? { cwd: folder, remote: true }
          : id === "nofolder"
            ? {}
            : { cwd: cwd ? cwd(folder) : folder },
    unattended: () => state.unattended,
    allowed: () => state.allowed,
    onEvent: (cb) => {
      events.add(cb);
      return () => events.delete(cb);
    },
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KEEP_ME: "1",
      CLAUDEX_GATEWAY_TOKEN: "t",
      MY_SECRET: "s",
      OPENAI_API_KEY: "k",
      GITHUB_TOKEN: "g",
      ELECTRON_RUN_AS_NODE: "1",
    },
    shellPath: async () => undefined,
    timing: {
      portTimeoutMs: 3000,
      pollMs: 40,
      killGraceMs: 1500,
      detectedRecheckMs: 100,
    },
    ...extra,
  });
  const changes: string[] = [];
  servers.onChange((id) => changes.push(id));
  const writeConfig = (configurations: unknown[]) => {
    fs.mkdirSync(path.join(folder, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, ".claude", "launch.json"),
      JSON.stringify({ version: "0.0.1", configurations }),
    );
  };
  return { folder, servers, events, state, writeConfig, changes };
}

function nodeServer(
  folder: string,
  name: string,
  env: Record<string, string>,
  port?: number,
) {
  return {
    name,
    runtimeExecutable: process.execPath,
    runtimeArgs: [path.join(folder, "server.mjs")],
    ...(port ? { port } : {}),
    env,
  };
}

test("preview session data is prepared before each server restart, not when focusing an already running server", async () => {
  const prepared: string[] = [];
  const fixture = setup({
    beforeStart: async (id, name) => {
      prepared.push(`${id}:${name}`);
    },
    portOpen: async () => true,
  });
  try {
    fixture.writeConfig([{ name: "web", url: "http://localhost:5173" }]);
    await fixture.servers.start("c1", "web");
    assert.deepEqual(prepared, ["c1:web"]);
    await fixture.servers.start("c1", "web");
    assert.deepEqual(prepared, ["c1:web"]);
    await fixture.servers.stop("c1", "web");
    await fixture.servers.start("c1", "web");
    assert.deepEqual(prepared, ["c1:web", "c1:web"]);
  } finally {
    await fixture.servers.dispose();
    fs.rmSync(fixture.folder, { recursive: true, force: true });
  }
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("starts a server, waits for its port, keeps its logs and stops it", async () => {
  const port = await freePort();
  const s = setup();
  s.writeConfig([
    nodeServer(s.folder, "web", { FAKE_PORT: String(port) }, port),
  ]);
  assert.deepEqual(
    s.servers.list("c1").map((x) => [x.name, x.status, x.port, x.url]),
    [["web", "stopped", port, `http://localhost:${port}`]],
  );
  assert.equal(
    s.servers.launchConfig("c1").path,
    path.join(fs.realpathSync(s.folder), ".claude", "launch.json"),
  );
  const state = await s.servers.start("c1", "WEB");
  assert.equal(state.status, "running");
  assert.equal(state.source, "launch.json");
  assert.ok(state.pid && alive(state.pid));
  assert.equal(await localPortOpen(port), true);
  assert.equal(s.servers.list("c1")[0].status, "running");
  // A second start while it runs changes nothing.
  assert.equal((await s.servers.start("c1", "web")).pid, state.pid);
  await until(async () =>
    (await s.servers.logs("c1", "web")).some((l) => l.includes("Local:")),
  );
  const logs = await s.servers.logs("c1", "web");
  assert.match(logs[0], /^\$ /);
  assert.ok(logs.includes(`Local: http://localhost:${port}/`), logs.join("|"));
  assert.equal((await s.servers.logs("c1", "web", 1)).length, 1);
  await s.servers.stop("c1", "web");
  assert.equal(s.servers.list("c1")[0].status, "stopped");
  assert.equal(s.servers.list("c1")[0].pid, undefined);
  assert.equal(alive(state.pid!), false);
  assert.equal(await localPortOpen(port), false);
  assert.ok((await s.servers.logs("c1", "web")).includes("bye"));
  assert.ok(s.changes.includes("c1"));
  // The person started it: Claude may start the same command now without asking.
  assert.equal(s.servers.needsApproval("c1", "web"), false);
  assert.equal(s.servers.needsApproval("c2", "web"), true);
  await s.servers.dispose();
});

test("stopping ends the whole process group", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups");
  const port = await freePort();
  const s = setup();
  s.writeConfig([
    nodeServer(
      s.folder,
      "web",
      { FAKE_PORT: String(port), FAKE_MODE: "child" },
      port,
    ),
  ]);
  assert.equal((await s.servers.start("c1", "web")).status, "running");
  await s.servers.stop("c1", "web");
  // The grandchild that held the port is gone too.
  assert.equal(
    await until(async () => !(await localPortOpen(port)), 3000),
    true,
  );
  await s.servers.dispose();
});

test("a server that never opens its port fails and asks again", async () => {
  const port = await freePort();
  const s = setup({
    timing: { portTimeoutMs: 600, pollMs: 40, killGraceMs: 500 },
  });
  s.writeConfig([
    nodeServer(
      s.folder,
      "web",
      { FAKE_PORT: String(port), FAKE_MODE: "never" },
      port,
    ),
  ]);
  const state = await s.servers.start("c1", "web");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /didn't open within/);
  assert.equal(alive(state.pid!), false);
  assert.equal(s.servers.needsApproval("c1", "web"), true);
  await s.servers.dispose();
});

test("a server that exits while starting fails with its logs", async () => {
  const s = setup();
  const port = await freePort();
  s.writeConfig([nodeServer(s.folder, "web", { FAKE_MODE: "fail" }, port)]);
  const state = await s.servers.start("c1", "web");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /exited with code 3 before it was ready/);
  const logs = await s.servers.logs("c1", "web");
  assert.ok(logs.includes("boom"));
  assert.ok(logs.includes("Exited with code 3."));
  await s.servers.dispose();
});

test("a crash is reported and the next start is approved again", async () => {
  const port = await freePort();
  const s = setup();
  s.writeConfig([
    nodeServer(
      s.folder,
      "web",
      { FAKE_PORT: String(port), FAKE_CRASH_MS: "300" },
      port,
    ),
  ]);
  assert.equal((await s.servers.start("c1", "web")).status, "running");
  assert.equal(s.servers.needsApproval("c1", "web"), false);
  assert.equal(
    await until(() => s.servers.list("c1")[0].status === "crashed"),
    true,
  );
  assert.match(s.servers.list("c1")[0].error ?? "", /exit code 1/);
  assert.equal(s.servers.needsApproval("c1", "web"), true);
  await s.servers.dispose();
});

test("Claudex's starts: approval once per command, refused when unattended", async () => {
  const port = await freePort();
  const s = setup();
  s.writeConfig([
    nodeServer(s.folder, "web", { FAKE_PORT: String(port) }, port),
  ]);
  // No way to ask: refused, nothing runs.
  await assert.rejects(
    s.servers.start("c1", "web", { by: "claude" }),
    /needs your approval/,
  );
  assert.equal(s.servers.list("c1")[0].status, "stopped");
  // Declined.
  const asked: DevServerApprovalRequest[] = [];
  await assert.rejects(
    s.servers.start("c1", "web", {
      by: "claude",
      approve: async (request) => {
        asked.push(request);
        assert.equal(s.servers.list("c1")[0].status, "awaiting-approval");
        return false;
      },
    }),
    /wasn't approved/,
  );
  assert.equal(await localPortOpen(port), false);
  assert.equal(asked[0].name, "web");
  assert.equal(asked[0].folder, fs.realpathSync(s.folder));
  assert.equal(asked[0].port, port);
  assert.deepEqual(asked[0].envNames, ["FAKE_PORT"]);
  assert.match(asked[0].command, /server\.mjs/);
  // Allowed: runs; after a stop the same command doesn't ask again.
  let count = 0;
  const approve = async () => {
    count++;
    return true;
  };
  assert.equal(
    (await s.servers.start("c1", "web", { by: "claude", approve })).status,
    "running",
  );
  await s.servers.stop("c1", "web");
  assert.equal(
    (await s.servers.start("c1", "web", { by: "claude", approve })).status,
    "running",
  );
  assert.equal(count, 1);
  await s.servers.stop("c1", "web");
  // A changed command asks again.
  s.writeConfig([
    nodeServer(s.folder, "web", { FAKE_PORT: String(port), EXTRA: "1" }, port),
  ]);
  assert.equal(s.servers.needsApproval("c1", "web"), true);
  // Scheduled runs: Claude is refused without asking; the person may still start it.
  s.state.unattended = true;
  await assert.rejects(
    s.servers.start("c1", "web", { by: "claude", approve }),
    /scheduled tasks/,
  );
  assert.equal(count, 1);
  assert.equal((await s.servers.start("c1", "web")).status, "running");
  await s.servers.dispose();
});

test("the administrator can turn dev servers off", async () => {
  const s = setup();
  s.writeConfig([nodeServer(s.folder, "web", {}, 1234)]);
  s.state.allowed = false;
  await assert.rejects(s.servers.start("c1", "web"), /administrator/);
  await s.servers.dispose();
});

test("the server's environment has no secrets; launch.json variables are added", async () => {
  const s = setup();
  s.writeConfig([nodeServer(s.folder, "env", { FAKE_MODE: "env", MINE: "x" })]);
  // No port: ready when it prints a local address.
  const state = await s.servers.start("c1", "env");
  assert.equal(state.status, "running");
  assert.match(state.url ?? "", /^http:\/\/localhost:\d+$/);
  assert.ok(state.port);
  const line = (await s.servers.logs("c1", "env")).find((l) =>
    l.startsWith("ENV "),
  );
  const names: string[] = JSON.parse(line!.slice(4));
  for (const name of ["KEEP_ME", "MINE", "PATH", "BROWSER", "FAKE_MODE"])
    assert.ok(names.includes(name), name);
  for (const name of [
    "CLAUDEX_GATEWAY_TOKEN",
    "MY_SECRET",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.ok(!names.includes(name), name);
  assert.ok(
    (await s.servers.logs("c1", "env")).includes(
      `CWD ${fs.realpathSync(s.folder)}`,
    ),
  );
  await s.servers.dispose();
});

test("a folder outside the project is refused, also through a link", async (t) => {
  const s = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-out-"));
  try {
    fs.symlinkSync(outside, path.join(s.folder, "link"));
  } catch {
    return t.skip("no symbolic links here");
  }
  s.writeConfig([
    { ...nodeServer(s.folder, "linked", {}, 1234), cwd: "link" },
    { ...nodeServer(s.folder, "missing", {}, 1235), cwd: "nope" },
  ]);
  const linked = await s.servers.start("c1", "linked");
  assert.equal(linked.status, "failed");
  assert.match(linked.error ?? "", /inside this session's folder/);
  const missing = await s.servers.start("c1", "missing");
  assert.equal(missing.status, "failed");
  assert.match(missing.error ?? "", /doesn't exist/);
  await s.servers.dispose();
});

test("a port already in use is reported instead of starting", async () => {
  const blocker = http.createServer((_q, r) => r.end()).listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const port = (blocker.address() as net.AddressInfo).port;
  const s = setup();
  s.writeConfig([
    nodeServer(s.folder, "web", { FAKE_PORT: String(port) }, port),
  ]);
  const state = await s.servers.start("c1", "web");
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /already in use/);
  assert.equal(state.pid, undefined);
  // A configuration with only a url opens that running server.
  s.writeConfig([{ name: "running", url: `http://localhost:${port}` }]);
  const attached = await s.servers.start("c1", "running");
  assert.equal(attached.status, "running");
  assert.equal(attached.command, "");
  blocker.close();
  await s.servers.stop("c1", "running");
  assert.equal(s.servers.list("c1")[0].status, "stopped");
  const gone = await s.servers.start("c1", "running");
  assert.equal(gone.status, "failed");
  assert.match(gone.error ?? "", /Nothing is running/);
  await s.servers.dispose();
});

test("saves configurations to .claude/launch.json", async () => {
  const s = setup();
  // Reads .claudex/launch.json when .claude has none; writes .claude.
  fs.mkdirSync(path.join(s.folder, ".claudex"));
  fs.writeFileSync(
    path.join(s.folder, ".claudex", "launch.json"),
    JSON.stringify({
      version: "0.0.1",
      configurations: [
        { name: "legacy", runtimeExecutable: "yarn", port: 3000 },
      ],
    }),
  );
  assert.equal(
    s.servers.launchConfig("c1").path,
    path.join(fs.realpathSync(s.folder), ".claudex", "launch.json"),
  );
  assert.deepEqual(
    s.servers.list("c1").map((x) => x.name),
    ["legacy"],
  );
  await s.servers.save("c1", {
    name: "web",
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev"],
    port: 5173,
  });
  const written = JSON.parse(
    fs.readFileSync(path.join(s.folder, ".claude", "launch.json"), "utf8"),
  );
  assert.deepEqual(
    written.configurations.map((c: { name: string }) => c.name),
    ["legacy", "web"],
  );
  assert.deepEqual(
    s.servers.list("c1").map((x) => [x.name, x.command]),
    [
      ["legacy", "yarn"],
      ["web", "npm run dev"],
    ],
  );
  assert.ok(s.changes.includes("c1"));
  // Invalid configurations are refused.
  await assert.rejects(
    s.servers.save("c1", { name: "x", runtimeExecutable: "npm", cwd: "../.." }),
    /inside this project/,
  );
  // A file that can't be read is not overwritten.
  fs.writeFileSync(path.join(s.folder, ".claude", "launch.json"), "{ broken");
  assert.match(s.servers.launchConfig("c1").error ?? "", /isn't valid JSON/);
  await assert.rejects(
    s.servers.save("c1", { name: "y", runtimeExecutable: "npm" }),
    /Fix the file/,
  );
  assert.equal(
    fs.readFileSync(path.join(s.folder, ".claude", "launch.json"), "utf8"),
    "{ broken",
  );
  await s.servers.dispose();
});

test("a launch.json linked from outside the folder is not used", async (t) => {
  const s = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-out-"));
  fs.writeFileSync(
    path.join(outside, "launch.json"),
    JSON.stringify({
      configurations: [{ name: "evil", runtimeExecutable: "sh" }],
    }),
  );
  fs.mkdirSync(path.join(s.folder, ".claude"));
  try {
    fs.symlinkSync(
      path.join(outside, "launch.json"),
      path.join(s.folder, ".claude", "launch.json"),
    );
  } catch {
    return t.skip("no symbolic links here");
  }
  assert.deepEqual(s.servers.list("c1"), []);
  assert.match(
    s.servers.launchConfig("c1").error ?? "",
    /inside this session's folder/,
  );
  await assert.rejects(
    s.servers.save("c1", { name: "web", runtimeExecutable: "npm" }),
    /inside this session's folder/,
  );
  // A link to a file inside the folder is read, but saving never follows it.
  fs.writeFileSync(
    path.join(s.folder, "mine.json"),
    JSON.stringify({
      configurations: [{ name: "ok", url: "http://localhost:1" }],
    }),
  );
  fs.rmSync(path.join(s.folder, ".claude", "launch.json"));
  fs.symlinkSync(
    path.join(s.folder, "mine.json"),
    path.join(s.folder, ".claude", "launch.json"),
  );
  assert.deepEqual(
    s.servers.list("c1").map((x) => x.name),
    ["ok"],
  );
  await assert.rejects(
    s.servers.save("c1", { name: "web", runtimeExecutable: "npm" }),
    /plain file/,
  );
  await s.servers.dispose();
});

test("sessions without a local folder have no dev servers", async () => {
  const s = setup();
  assert.match(s.servers.launchConfig("remote").error ?? "", /remote host/);
  assert.deepEqual(s.servers.list("remote"), []);
  assert.match(
    s.servers.launchConfig("nofolder").error ?? "",
    /Choose a folder/,
  );
  await assert.rejects(s.servers.detect("remote"), /remote host/);
  await s.servers.dispose();
});

test("a launch.json Claudex creates later reaches the panel", async () => {
  const s = setup();
  assert.deepEqual(s.servers.list("c1"), []);
  s.changes.length = 0;
  // Let the folder watcher start: macOS drops events from its first moments.
  await wait(300);
  s.writeConfig([{ name: "late", url: "http://localhost:4999" }]);
  assert.ok(await until(() => s.changes.includes("c1")));
  assert.deepEqual(
    s.servers.list("c1").map((server) => server.name),
    ["late"],
  );
  await s.servers.dispose();
});

test("an oversized launch.json is not read", async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.folder, ".claude"));
  fs.writeFileSync(
    path.join(s.folder, ".claude", "launch.json"),
    " ".repeat(300 * 1024) + "{}",
  );
  assert.match(s.servers.launchConfig("c1").error ?? "", /too large/);
  await s.servers.dispose();
});

test("Detect proposes what launch.json doesn't have yet", async () => {
  const s = setup();
  fs.writeFileSync(
    path.join(s.folder, "package.json"),
    JSON.stringify({
      scripts: { dev: "vite" },
      devDependencies: { vite: "7" },
    }),
  );
  const drafts = await s.servers.detect("c1");
  assert.deepEqual(drafts, [
    {
      name: "dev",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "dev"],
      port: 5173,
    },
  ]);
  s.writeConfig([{ name: "dev", runtimeExecutable: "yarn", port: 1 }]);
  assert.equal((await s.servers.detect("c1"))[0].name, "dev 2");
  await s.servers.save("c1", drafts[0]);
  s.writeConfig([drafts[0]]);
  assert.deepEqual(await s.servers.detect("c1"), []);
  await s.servers.dispose();
});

test("lists local addresses printed in the session's Terminal while they answer", async () => {
  const s = setup();
  const server = http.createServer((_q, r) => r.end()).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  const send = (event: AppEvent) => {
    for (const cb of s.events) cb(event);
  };
  const output = (text: string) =>
    send({
      type: "terminal-output",
      id: "t1",
      conversationId: "c1",
      deltaBase64: Buffer.from(text).toString("base64"),
      sequence: 1,
    });
  // Split across two chunks.
  output("  Local:   http://local");
  output(`host:${port}/\r\n`);
  assert.equal(
    await until(() =>
      s.servers.list("c1").some((x) => x.source === "detected-output"),
    ),
    true,
  );
  const detected = s.servers
    .list("c1")
    .find((x) => x.source === "detected-output")!;
  assert.deepEqual(detected, {
    name: `localhost:${port}`,
    command: "",
    port,
    url: `http://localhost:${port}`,
    status: "running",
    source: "detected-output",
  });
  assert.equal(s.servers.list("c2").length, 0);
  assert.equal(
    (await s.servers.start("c1", `localhost:${port}`)).status,
    "running",
  );
  await assert.rejects(
    s.servers.stop("c1", `localhost:${port}`),
    /Stop it there/,
  );
  // Once it stops answering it leaves the list.
  server.close();
  assert.equal(
    await until(
      () => !s.servers.list("c1").some((x) => x.source === "detected-output"),
    ),
    true,
  );
  // The terminal closing forgets it.
  output(`http://localhost:${port}\n`);
  send({ type: "terminal-exit", id: "t1", conversationId: "c1", exitCode: 0 });
  assert.equal(s.servers.list("c1").length, 0);
  await s.servers.dispose();
});

test("deleted sessions and sign-out stop their servers", async () => {
  const port = await freePort();
  const port2 = await freePort();
  const s = setup({
    timing: { sweepMs: 100, portTimeoutMs: 3000, pollMs: 40 },
  });
  s.writeConfig([
    nodeServer(s.folder, "a", { FAKE_PORT: String(port) }, port),
    nodeServer(s.folder, "b", { FAKE_PORT: String(port2) }, port2),
  ]);
  const a = await s.servers.start("c1", "a");
  const b = await s.servers.start("c2", "b");
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  await s.servers.closeConversation("c1");
  assert.equal(alive(a.pid!), false);
  assert.equal(alive(b.pid!), true);
  assert.equal(s.servers.needsApproval("c1", "a"), true);
  // The periodic sweep stops a deleted conversation's servers.
  s.state.deleted = true;
  assert.equal(await until(() => !alive(b.pid!), 3000), true);
  s.state.deleted = false;
  const again = await s.servers.start("c2", "b");
  assert.equal(again.status, "running");
  await s.servers.dispose();
  assert.equal(alive(again.pid!), false);
  await assert.rejects(s.servers.start("c2", "b"), /closed/);
});

test("stopping while Claudex waits for approval cancels the start", async () => {
  const port = await freePort();
  const s = setup();
  s.writeConfig([
    nodeServer(s.folder, "web", { FAKE_PORT: String(port) }, port),
  ]);
  let release!: (value: boolean) => void;
  const pending = s.servers.start("c1", "web", {
    by: "claude",
    approve: () => new Promise((resolve) => (release = resolve)),
  });
  await until(() => s.servers.list("c1")[0].status === "awaiting-approval");
  await s.servers.stop("c1", "web");
  release(true);
  await assert.rejects(pending, /stopped/);
  assert.equal(await localPortOpen(port), false);
  await s.servers.dispose();
});

test("log lines: colours removed, carriage returns, bounded", () => {
  const logs = new LogBuffer(3);
  logs.write(
    "stdout",
    Buffer.from("\u001b[31mred\u001b[0m\nprogress 10%\rprogress 100%\n"),
  );
  logs.write("stderr", "err ");
  logs.write("stdout", "partial");
  assert.deepEqual(logs.tail(), ["progress 100%", "partial", "err "]);
  logs.write("stderr", "line\n");
  logs.note("Exited with code 0.");
  assert.deepEqual(logs.tail(), ["err line", "partial", "Exited with code 0."]);
  const long = new LogBuffer();
  long.write("stdout", "x".repeat(5000) + "\n");
  assert.equal(long.tail()[0].length, 2049);
  // A multi-byte character split across chunks.
  const split = new LogBuffer();
  const bytes = Buffer.from("é\n");
  split.write("stdout", bytes.subarray(0, 1));
  split.write("stdout", bytes.subarray(1));
  assert.deepEqual(split.tail(), ["é"]);
});

test("environment and PATH helpers", () => {
  assert.deepEqual(
    scrubEnv({
      PATH: "/bin",
      NPM_TOKEN: "x",
      AWS_SECRET_ACCESS_KEY: "x",
      DB_PASSWORD: "x",
      STRIPE_API_KEY: "x",
      CLAUDEX_FOO: "x",
      CODEX_HOME: "x",
      ANTHROPIC_BASE_URL: "x",
      LANG: "en_US.UTF-8",
      EMPTY: undefined,
    }),
    { PATH: "/bin", LANG: "en_US.UTF-8" },
  );
  assert.equal(
    mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:", ":"),
    "/opt/homebrew/bin:/usr/bin:/bin",
  );
});

test("Windows: .cmd shims run through cmd.exe with quoted arguments", () => {
  const files = new Set(["C:\\nodejs\\npm.cmd", "C:\\Python\\python.exe"]);
  const env = { Path: "C:\\nodejs;C:\\Python", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  // Windows file names ignore case.
  const exists = (file: string) =>
    [...files].some((f) => f.toLowerCase() === file.toLowerCase());
  assert.deepEqual(
    windowsCommand("python", ["-m", "http.server"], env, "C:\\p", exists),
    {
      command: "C:\\Python\\python.EXE",
      args: ["-m", "http.server"],
      verbatim: false,
    },
  );
  const npm = windowsCommand(
    "npm",
    ["run", "dev & calc"],
    env,
    "C:\\p",
    exists,
  );
  assert.equal(npm.command, "cmd.exe");
  assert.equal(npm.verbatim, true);
  assert.deepEqual(npm.args.slice(0, 3), ["/d", "/s", "/c"]);
  // The & can't end the command: it's quoted and escaped for cmd.exe.
  assert.ok(npm.args[3].includes("^&"), npm.args[3]);
  assert.ok(npm.args[3].startsWith('"^"C:\\nodejs\\npm.CMD^"'), npm.args[3]);
  assert.equal(quoteWindowsArg('a"b', false), '^"a\\^"b^"');
  // Not found: spawned as written (the error says it wasn't found).
  assert.equal(
    windowsCommand("nope", [], env, "C:\\p", exists).command,
    "nope",
  );
});
