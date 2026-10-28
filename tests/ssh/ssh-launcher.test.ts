/**
 * R9-S3: an SSH host's engine, end to end without a network. "The host" is
 * this computer behind tests/ssh/fake-ssh.mjs (HOME is a temporary folder),
 * the engine is the real bundled Codex app-server started through the
 * launcher's wrapper, and its model requests go through the remote forward
 * to the real gateway (provider-service) and on to a fixture Responses
 * server. Both ways of forwarding are covered: over a master connection
 * (`ssh -O forward`, macOS/Linux) and on the engine's own ssh process
 * (`-R … ` with the "Allocated port" line, Windows).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { AppEvent, Conversation } from "../../shared/types";
import type { SshHost, SshStatus } from "../../shared/ssh-api";
import { openPolicy } from "../../shared/client-policy";
import { Engine } from "../../electron/engine/engine";
import { remoteMcpServers } from "../../electron/engine/mcp-servers";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import { Store } from "../../electron/store/store";
import { resolveRuntime } from "../../electron/engine/runtime";
import {
  SshConnection,
  privateRuntimeDir,
} from "../../electron/ssh/connection";
import { SshHostStore } from "../../electron/ssh/host-store";
import { SshLauncher } from "../../electron/ssh/ssh-launcher";
import {
  WRAPPER_EXIT,
  gatewayAddress,
  parseAllocatedPort,
  parseForwardOutput,
  wrapperScript,
} from "../../electron/ssh/ssh-launcher-support";
import { remoteCommand } from "../../electron/ssh/remote-scripts";
import {
  SshWorkspaceTrustStore,
  sshWorkspaceTrustFile,
} from "../../electron/workspace/workspace-trust";
import type { SshServiceApi } from "../../electron/ipc/ssh";
import { FAKE_KEY, MODEL, MockResponses } from "../spikes/harness";

const posix = process.platform !== "win32";
const temp = (prefix = "cx-s3-") =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}

// ---------------------------------------------------------------- units

test("the wrapper reads port, token and config from stdin and starts Codex with them", () => {
  if (!posix) return;
  const root = temp();
  try {
    const home = path.join(root, "codex-home");
    const run = path.join(root, "run");
    fs.mkdirSync(run);
    // A stand-in for codex: prints what it got and exits.
    const codex = path.join(root, "codex");
    fs.writeFileSync(
      codex,
      '#!/bin/sh\nprintf "pid=%s\\n" "$$"\nprintf "home=%s\\n" "$CODEX_HOME"\nprintf "token=%s\\n" "$CLAUDEX_GATEWAY_TOKEN"\nprintf "openai=%s\\n" "${OPENAI_API_KEY-unset}"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\nIFS= read -r rest; printf "stdin=%s\\n" "$rest"\n',
      { mode: 0o755 },
    );
    const evil = `it's "$(touch ${root}/pwned)" \`x\``;
    const script = wrapperScript({
      layout: { codex, home, run },
      engineId: "e0123",
      args: ["-c", `model="${evil}"`, "-c", "x=$HOME"],
      basePath: "/v1",
    });
    const config = Buffer.from('[mcp_servers.a]\ncommand = "x"\n').toString(
      "base64",
    );
    const out = execFileSync("/bin/sh", ["-c", remoteCommand(script)], {
      input: `4567\nsecret-token\n${config}\n{"jsonrpc":1}\n`,
      env: { ...process.env, OPENAI_API_KEY: "leak", HOME: root },
    }).toString();
    const lines = out.trim().split("\n");
    assert.ok(lines.includes(`home=${home}`));
    assert.ok(lines.includes("token=secret-token"));
    assert.ok(lines.includes("openai=unset"));
    assert.ok(lines.includes("arg=app-server"));
    assert.ok(lines.includes(`arg=model="${evil}"`), out);
    assert.ok(lines.includes("arg=x=$HOME"));
    assert.equal(
      lines.filter((l) => l.startsWith("arg=")).at(-1),
      'arg=model_providers.claudex.base_url="http://127.0.0.1:4567/v1"',
    );
    // JSON-RPC continues on the same stdin after the three lines.
    assert.ok(lines.includes('stdin={"jsonrpc":1}'));
    assert.equal(fs.existsSync(path.join(root, "pwned")), false);
    assert.equal(
      fs.readFileSync(path.join(home, "config.toml"), "utf8"),
      '[mcp_servers.a]\ncommand = "x"\n',
    );
    assert.equal(
      (fs.statSync(path.join(home, "config.toml")).mode & 0o777).toString(8),
      "600",
    );
    const pid = lines.find((l) => l.startsWith("pid="))!.slice(4);
    assert.equal(
      fs.readFileSync(path.join(run, "e0123.pid"), "utf8").trim(),
      pid,
    );
    // The token is on no command line.
    assert.ok(!script.includes("secret-token"));
    // A port that isn't a number never reaches Codex.
    const bad = spawnSync("/bin/sh", ["-c", remoteCommand(script)], {
      input: `12;rm -rf /\nt\n\n`,
      env: { ...process.env, HOME: root },
    });
    assert.equal(bad.status, WRAPPER_EXIT.port);
    const short = spawnSync("/bin/sh", ["-c", remoteCommand(script)], {
      input: `12\n`,
      env: { ...process.env, HOME: root },
    });
    assert.equal(short.status, WRAPPER_EXIT.preamble);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the wrapper refuses damaged values", () => {
  const layout = { codex: "/r/codex", home: "/r/h", run: "/r/run" };
  const make = (patch: Record<string, unknown>) =>
    wrapperScript({
      layout,
      engineId: "e1",
      args: [],
      basePath: "/v1",
      ...patch,
    } as never);
  assert.throws(() => make({ engineId: "../x" }), /engine id/);
  assert.throws(() => make({ basePath: '/v1"; rm' }), /gateway/);
  assert.throws(() => make({ args: ["a\nb"] }), /line break/);
  assert.throws(
    () => make({ layout: { ...layout, codex: "relative/codex" } }),
    /absolute path/,
  );
});

test("forwarded ports and gateway addresses are read strictly", () => {
  assert.equal(
    parseAllocatedPort(
      "Warning: Permanently added 'box'.\r\nAllocated port 40123 for remote forward to 127.0.0.1:5555\n",
    ),
    40123,
  );
  assert.equal(
    parseAllocatedPort("Allocated port 99999 for remote forward"),
    undefined,
  );
  assert.equal(parseAllocatedPort("nothing"), undefined);
  assert.equal(parseForwardOutput("40123\n"), 40123);
  assert.equal(parseForwardOutput("x40123\n"), undefined);
  assert.deepEqual(gatewayAddress("http://127.0.0.1:5555/v1"), {
    port: 5555,
    path: "/v1",
  });
  assert.throws(() => gatewayAddress("http://10.0.0.2:5555/v1"), /loopback/);
});

test("MCP servers with secrets stay on this computer", () => {
  assert.deepEqual(
    Object.keys(
      remoteMcpServers({
        plain: { command: "npx", args: ["x"] },
        emptyEnv: { command: "a", env: {} },
        secretEnv: { command: "a", env: { API_KEY: "k" } },
        header: { url: "https://x", http_headers: { Authorization: "b" } },
        bearer: { url: "https://x", bearer_token_env_var: "T" },
      }),
    ),
    ["plain", "emptyEnv"],
  );
});

// ------------------------------------------------------ end to end

let root = "";
let fakeSsh = "";
let fakeHome = "";
let serviceScript = "";
let mock: MockResponses;
let log = "";
let cancelled = "";

before(async () => {
  if (!posix) return;
  root = temp();
  fakeHome = path.join(root, "home");
  fs.mkdirSync(path.join(fakeHome, "code", "app"), { recursive: true });
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fakeSsh = path.join(bin, "ssh");
  fs.writeFileSync(
    fakeSsh,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(
      path.join(import.meta.dirname, "fake-ssh.mjs"),
    )} "$@"\n`,
    { mode: 0o755 },
  );
  log = path.join(root, "ssh.log");
  cancelled = path.join(root, "cancelled.log");
  process.env.FAKE_SSH_HOME = fakeHome;
  process.env.FAKE_SSH_LOG = log;
  process.env.FAKE_SSH_CANCELLED = cancelled;
  serviceScript = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: [
      path.resolve(import.meta.dirname, "../../server/provider-service.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: serviceScript,
    logLevel: "silent",
  });
  mock = await new MockResponses().start();
});

after(async () => {
  await mock?.close();
  delete process.env.FAKE_SSH_LOG;
  delete process.env.FAKE_SSH_CANCELLED;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The parts of the SSH service the launcher uses, over real connections. */
class TestSshService implements SshServiceApi {
  readonly hosts: SshHostStore;
  private connections = new Map<string, SshConnection>();
  readonly statuses: SshStatus[] = [];
  listeners = new Set<(event: AppEvent) => void>();
  constructor(
    readonly dataRoot: string,
    readonly platform: NodeJS.Platform,
  ) {
    this.hosts = new SshHostStore(dataRoot);
  }
  allowed() {
    return true;
  }
  existing(hostId: string) {
    return this.connections.get(hostId);
  }
  connection(hostId: string) {
    let connection = this.connections.get(hostId);
    if (connection) return connection;
    const host = this.hosts.get(hostId)!;
    connection = new SshConnection({
      host,
      sshPath: fakeSsh,
      platform: this.platform,
      runtimeDir: privateRuntimeDir(this.dataRoot, this.platform),
      askpass: { session: () => ({ env: {}, close() {} }) },
      backoff: () => 400,
      onStatus: (status) => {
        this.statuses.push(status);
        for (const cb of this.listeners)
          cb({ type: "ssh-status", hostId, status } as AppEvent);
      },
    });
    this.connections.set(hostId, connection);
    return connection;
  }
  connect(hostId: string, interactive = true) {
    return this.connection(hostId).connect({ interactive });
  }
  async closeAll() {
    for (const connection of this.connections.values())
      await connection.disconnect();
  }
}

function setup(platform: NodeJS.Platform) {
  const dataRoot = temp();
  const profile = path.join(dataRoot, "profile");
  const store = new Store(profile);
  store.settings.providers = [
    {
      id: "p",
      name: "Fixture",
      protocol: "responses",
      baseUrl: mock.url,
      model: MODEL,
      models: [MODEL],
    },
  ];
  store.settings.activeProviderId = "p";
  const events: AppEvent[] = [];
  const local = new Engine(
    store,
    resolveRuntime(),
    () => FAKE_KEY,
    (event) => events.push(event),
    serviceScript,
  );
  local.policy = () => openPolicy;
  const service = new TestSshService(dataRoot, platform);
  const host: SshHost = service.hosts.save({
    label: "box",
    destination: "ok@box",
    sshPath: fakeSsh,
  });
  const clientRoot = fs.mkdtempSync(path.join(fakeHome, ".claudex-remote-"));
  const layout = {
    root: clientRoot,
    version: "0.144.1",
    triple: "test",
    dir: path.dirname(resolveRuntime()),
    codex: resolveRuntime(),
    home: path.join(clientRoot, "codex-home"),
    attachments: path.join(clientRoot, "attachments"),
    run: path.join(clientRoot, "run"),
  };
  fs.mkdirSync(layout.run, { recursive: true });
  const cleaned: string[][] = [];
  const registry = new EngineRegistry(() => local);
  registry.bind({
    ssh: () => service,
    dataRoot,
    allowedFolder: () => {},
    onEvent: (cb) => {
      const listener = (event: AppEvent) => cb(event);
      service.listeners.add(listener);
      return () => service.listeners.delete(listener);
    },
    launcher: (hostId) =>
      new SshLauncher({
        hostId,
        ssh: () => service,
        dataRoot,
        platform,
        exitGraceMs: 50,
        runtime: () => ({
          ensure: async () => layout,
          cleanup: async (ids) => {
            cleaned.push(ids);
          },
        }),
      }),
  });
  // The folder these tests work in is trusted on the host (workspace
  // trust: tests/workspace-trust-everywhere.test.ts asks about it).
  const trustedRoot = fs.realpathSync(path.join(fakeHome, "code", "app"));
  new SshWorkspaceTrustStore(sshWorkspaceTrustFile(profile)).trust(
    host.id,
    trustedRoot,
  );
  const environment = { kind: "ssh" as const, hostId: host.id };
  const conversationOf = (id: string) =>
    store.conversations.find((c) => c.id === id)!;
  return {
    dataRoot,
    store,
    local,
    service,
    host,
    layout,
    cleaned,
    registry,
    events,
    environment,
    conversationOf,
    async close() {
      await registry.stopRemote();
      await local.stop();
      await service.closeAll();
      await delay(100);
      store.flush();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function sshRuns(): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function completed(env: ReturnType<typeof setup>, id: string) {
  await until(
    () => env.conversationOf(id).turns.at(-1)?.status !== "inProgress",
    "turn finished",
  );
  return env.conversationOf(id).turns.at(-1)!;
}

for (const platform of ["darwin", "win32"] as const)
  test(`a Code conversation runs on the SSH host through the remote forward (${platform === "win32" ? "no master, Allocated port" : "master, ssh -O forward"})`, async () => {
    if (!posix) return;
    const env = setup(platform);
    fs.rmSync(log, { force: true });
    fs.rmSync(cancelled, { force: true });
    try {
      const before = mock.requests.length;
      const cwd = path.join(fakeHome, "code", "app");
      const conversation = await env.local.send({
        text: "hello from afar",
        mode: "code",
        cwd,
        attachments: [],
        providerId: "p",
        model: MODEL,
        environment: env.environment,
      });
      assert.deepEqual(conversation.environment, env.environment);
      const remote = env.registry.forConversation(conversation.id);
      assert.notEqual(remote, env.local);
      const turn = await completed(env, conversation.id);
      assert.equal(turn.status, "completed", turn.error);
      assert.ok(
        turn.items.some((i) => i.type === "agentMessage" && i.text === "ok"),
      );
      // The host's config.toml carries the trust kept on this computer.
      assert.match(
        fs.readFileSync(path.join(env.layout.home, "config.toml"), "utf8"),
        /trust_level = "trusted"/,
      );
      // The request went through this computer's gateway to the service.
      // Session classification and prompt suggestions follow the reply
      // (CodeSessionAssistance); they are not the send.
      const sends = mock.requests
        .slice(before)
        .filter((r) => !JSON.stringify(r).includes("untrusted session data"));
      assert.equal(sends.length, 1);
      assert.match(JSON.stringify(sends[0]), /hello from afar/);
      // The host ran Codex with its own CODEX_HOME and pid file.
      assert.ok(fs.existsSync(path.join(env.layout.home, "config.toml")));
      const pids = fs.readdirSync(env.layout.run);
      assert.equal(pids.length, 1);
      assert.deepEqual(env.cleaned, [[pids[0].replace(/\.pid$/, "")]]);
      // The window's engine status is the local engine's only.
      assert.ok(
        !env.events.some(
          (e) => e.type === "engine" && e.engine.state === "ready",
        ),
      );
      // The token is on no ssh command line; the forward binds loopback.
      const runs = sshRuns();
      const token = (remote as any).gateway.token as string;
      assert.ok(token.length > 10);
      assert.ok(!JSON.stringify(runs).includes(token));
      // The forward: `-O forward` (master) or the engine's own ssh (Windows).
      const engineRun = runs.find(
        (args) => args.includes("-R") && !args.includes("cancel"),
      )!;
      assert.ok(engineRun, JSON.stringify(runs));
      const spec = engineRun[engineRun.indexOf("-R") + 1];
      assert.match(spec, /^127\.0\.0\.1:0:127\.0\.0\.1:\d+$/);
      if (platform === "win32") {
        assert.ok(engineRun.includes("LogLevel=INFO"));
        assert.ok(engineRun.includes("ExitOnForwardFailure=yes"));
      }
      assert.equal(env.service.existing(env.host.id)?.status.state, "ready");
      // Stopping the engine removes the forward (master) and its process.
      await env.registry.stopRemote(env.host.id);
      if (platform === "darwin")
        assert.match(fs.readFileSync(cancelled, "utf8"), /^\d+\n$/);
    } finally {
      await env.close();
    }
  });

test("a message written while the host reconnects waits and is sent once when it is back", async () => {
  if (!posix) return;
  const env = setup("win32");
  try {
    const cwd = path.join(fakeHome, "code", "app");
    const first = await env.local.send({
      text: "first message",
      mode: "code",
      cwd,
      attachments: [],
      providerId: "p",
      model: MODEL,
      environment: env.environment,
    });
    await completed(env, first.id);
    const remote = env.registry.forConversation(first.id);
    // The connection drops (on Windows the engine's channel is the connection).
    const child = (remote.rpc as any).process;
    child.kill("SIGKILL");
    await until(
      () => env.service.existing(env.host.id)?.status.state === "reconnecting",
      "reconnecting",
      10_000,
    );
    const before = mock.requests.length;
    const queued = await env.local.send({
      conversationId: first.id,
      text: "written offline",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: MODEL,
    });
    const waiting = queued.turns.at(-1)!;
    assert.match(waiting.id, /^outbox-/);
    assert.equal(waiting.status, "inProgress");
    assert.equal(waiting.reconnecting, "Will send when box reconnects");
    // Nothing runs yet: settings and the like are not blocked.
    assert.equal(env.registry.isBusy(), false);
    // Back again: it is sent once.
    await until(
      () => mock.requests.length > before,
      "sent after reconnect",
      30_000,
    );
    const turn = await completed(env, first.id);
    assert.equal(turn.status, "completed", turn.error);
    assert.equal(turn.prompt, "written offline");
    await delay(300);
    assert.equal(
      mock.requests.filter(
        (r) =>
          JSON.stringify(r.input).includes("written offline") &&
          // A title-offer check or the session's classification quotes the
          // transcript, as does the new-task check; none is a resend.
          !JSON.stringify(r).includes("topic has substantially changed") &&
          !JSON.stringify(r).includes("new_task") &&
          !JSON.stringify(r).includes("untrusted session data"),
      ).length,
      1,
    );
    const c = env.conversationOf(first.id) as Conversation;
    assert.equal(
      c.turns.filter((t) => t.prompt === "written offline").length,
      1,
    );
    assert.ok(!c.turns.some((t) => t.id.startsWith("outbox-")));
    assert.equal(
      fs.existsSync(path.join(env.store.root, "ssh-outbox.json")),
      false,
    );
  } finally {
    await env.close();
  }
});

test("a forward the host refuses fails the send and shows on the connection", async () => {
  if (!posix) return;
  const env = setup("darwin");
  process.env.FAKE_SSH_FORWARD_FAIL = "1";
  try {
    await assert.rejects(
      env.local.send({
        text: "hello",
        mode: "code",
        cwd: path.join(fakeHome, "code", "app"),
        attachments: [],
        providerId: "p",
        model: MODEL,
        environment: env.environment,
      }),
      /Couldn't open the connection Claudex needs on box/,
    );
    const status = env.service.existing(env.host.id)?.status;
    assert.equal(status?.state, "error");
    assert.equal(
      status?.state === "error" ? status.code : undefined,
      "forward-failed",
    );
    // The window's engine status stays this computer's.
    assert.ok(!env.events.some((e) => e.type === "engine"));
  } finally {
    delete process.env.FAKE_SSH_FORWARD_FAIL;
    await env.close();
  }
});
