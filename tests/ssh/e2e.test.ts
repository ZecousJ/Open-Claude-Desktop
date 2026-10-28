/**
 * R9-S7: SSH remote environments end to end against a real host. Skipped
 * unless CLAUDEX_SSH_E2E=1; scripts/ssh-e2e/run.sh starts the host (sshd in
 * Docker, Alpine/musl), writes a throwaway key, password, ssh_config and
 * known_hosts in a temporary folder, and runs this file.
 *
 * Everything on this side is the product's own code: the computer's real
 * OpenSSH (through a wrapper that only adds `-F <the test's config>`), the
 * askpass broker with its bundled helper, SshConnection with a real master,
 * RemoteRuntime installing the real Codex Linux package on the host (by
 * upload, and by the host's own download), SshLauncher with a real remote
 * forward (`ssh -O forward` over the master, and the Windows way: the
 * engine's own ssh with `-R` and the "Allocated port" line), the real
 * gateway (provider-service) and a real conversation whose shell command
 * runs on the host, then the remote workspace (git, files) over both
 * channels, reconnects, the outbox, password sign-in and the errors.
 *
 * Nothing here reads ~/.ssh or the person's ssh-agent: the config names the
 * key, known_hosts and "IdentityAgent none".
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { AppEvent, Conversation } from "../../shared/types";
import type {
  SshEvent,
  SshHost,
  SshPrompt,
  SshStatus,
} from "../../shared/ssh-api";
import { openPolicy } from "../../shared/client-policy";
import { Engine } from "../../electron/engine/engine";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import { Store } from "../../electron/store/store";
import { resolveRuntime } from "../../electron/engine/runtime";
import { AskpassBroker } from "../../electron/ssh/askpass";
import {
  SshConnection,
  privateRuntimeDir,
  testSshHost,
} from "../../electron/ssh/connection";
import { controlPath } from "../../electron/ssh/connection-support";
import { SshHostStore } from "../../electron/ssh/host-store";
import {
  RemoteRuntime,
  clientIdFor,
  remoteTriple,
  type RemoteRuntimeLayout,
} from "../../electron/ssh/remote-runtime";
import {
  RUNTIME_CACHE_DIR,
  RuntimeCache,
  packageFileName,
  runtimeManifest,
} from "../../electron/ssh/runtime-cache";
import { SshLauncher } from "../../electron/ssh/ssh-launcher";
import {
  RemoteWorkspace,
  connectionRunner,
  rpcRunner,
} from "../../electron/ssh/remote-workspace";
import { workingTreeChanges } from "../../electron/git/working-tree";
import { TerminalController } from "../../electron/terminal/terminal-controller";
import { deviceId } from "../../electron/sub2api/provision";
import type { SshServiceApi } from "../../electron/ipc/ssh";
import {
  FAKE_KEY,
  MODEL,
  MockResponses,
  findTool,
  functionCall,
  message,
  type Json,
} from "../spikes/harness";

const enabled = process.env.CLAUDEX_SSH_E2E === "1";
const env = (name: string) => {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (use scripts/ssh-e2e/run.sh)`);
  return value;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}

// ------------------------------------------------------------- the service

/**
 * The SSH service as the app has it (electron/ipc/ssh.ts), minus IPC: saved
 * hosts, one connection per host with the real askpass broker.
 */
class E2eSshService implements SshServiceApi {
  readonly hosts: SshHostStore;
  readonly connections = new Map<string, SshConnection>();
  readonly statuses = new Map<string, SshStatus[]>();
  readonly listeners = new Set<(event: AppEvent) => void>();
  constructor(
    readonly dataRoot: string,
    readonly platform: NodeJS.Platform,
    readonly sshPath: string,
    readonly broker: AskpassBroker,
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
    connection = new SshConnection({
      host: this.hosts.get(hostId)!,
      sshPath: this.sshPath,
      platform: this.platform,
      runtimeDir: privateRuntimeDir(this.dataRoot),
      askpass: this.broker,
      backoff: () => 500,
      onStatus: (status) => {
        const list = this.statuses.get(hostId) ?? [];
        list.push(status);
        this.statuses.set(hostId, list);
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
  add(destination: string, label: string): SshHost {
    return this.hosts.save({ label, destination, sshPath: this.sshPath });
  }
  async closeAll() {
    for (const connection of this.connections.values())
      await connection.disconnect();
    this.connections.clear();
  }
}

// ------------------------------------------------------------- shared state

let E: {
  dir: string;
  ssh: string;
  password: string;
  fingerprint: string;
  arch: string;
  cache: string;
  log: string;
};
let work = "";
let dataRoot = "";
let broker: AskpassBroker;
let service: E2eSshService;
let serviceScript = "";
let mock: MockResponses;
const prompts: SshPrompt[] = [];
/** How the "person" answers ssh's questions (null cancels). */
let answer: (prompt: SshPrompt) => string | null = () => null;

function sshRuns(): string[] {
  return fs.existsSync(E.log)
    ? fs.readFileSync(E.log, "utf8").split("\n").filter(Boolean)
    : [];
}

/** Every file under a folder, as text (for "nothing was saved" checks). */
function allText(root: string): string {
  let out = "";
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && fs.statSync(file).size < 50 * 1024 * 1024)
        out += fs.readFileSync(file).toString("latin1");
    }
  };
  walk(root);
  return out;
}

/** netstat -ltn's TCP listeners. */
function listeners(netstat: string) {
  return [...netstat.matchAll(/^tcp6?\s+\d+\s+\d+\s+(\S+):(\d+)\s/gm)].map(
    ([, address, port]) => ({ address, port }),
  );
}

/** Runs a shell line on the host over a ready connection. */
async function onHost(connection: SshConnection, script: string) {
  const result = await connection.exec(script, { timeoutMs: 60_000 });
  assert.equal(result.code, 0, `${script}\n${result.stderr}`);
  return result.stdout;
}

/** The engine setup the app has (ipc/agent.ts binds the registry the same way). */
function engineSetup(
  svc: E2eSshService,
  platform: NodeJS.Platform,
  runtime?: (connection: SshConnection) => RemoteRuntime,
) {
  const profile = path.join(svc.dataRoot, "profile");
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
  const registry = new EngineRegistry(() => local);
  registry.bind({
    ssh: () => svc,
    dataRoot: svc.dataRoot,
    allowedFolder: () => {},
    onEvent: (cb) => {
      const listener = (event: AppEvent) => cb(event);
      svc.listeners.add(listener);
      return () => svc.listeners.delete(listener);
    },
    launcher: (hostId) =>
      new SshLauncher({
        hostId,
        ssh: () => svc,
        dataRoot: svc.dataRoot,
        platform,
        exitGraceMs: 200,
        ...(runtime ? { runtime } : {}),
      }),
  });
  const conversationOf = (id: string) =>
    store.conversations.find((c) => c.id === id)! as Conversation;
  return {
    store,
    local,
    registry,
    events,
    conversationOf,
    async completed(id: string) {
      await until(
        () => conversationOf(id).turns.at(-1)?.status !== "inProgress",
        "turn finished",
        180_000,
      );
      return conversationOf(id).turns.at(-1)!;
    },
    async close() {
      await registry.stopRemote();
      await local.stop();
      store.flush();
    },
  };
}

/** The fixture model runs one shell command, then answers "done". */
function scriptShellCommand(command: string) {
  let asked = -1;
  mock.script = (body: Json, index: number) => {
    const shell = findTool(body, (name) =>
      ["exec_command", "shell_command", "shell"].includes(name),
    );
    if (asked < 0 && shell) {
      asked = index;
      return [
        functionCall(
          shell,
          `call_${index}`,
          shell.name === "exec_command" ? { cmd: command } : { command },
        ),
      ];
    }
    return [message("done")];
  };
}

function commandOutput(conversation: Conversation) {
  const item = conversation.turns
    .at(-1)!
    .items.find((i) => i.type === "commandExecution") as
    { aggregatedOutput?: string; exitCode?: number } | undefined;
  return item;
}

// ------------------------------------------------------------------ tests

describe(
  "SSH remote environments against a real OpenSSH host",
  {
    skip: enabled
      ? false
      : "set CLAUDEX_SSH_E2E=1 (run scripts/ssh-e2e/run.sh)",
  },
  () => {
    let dev: SshHost;
    let layout: RemoteRuntimeLayout;

    before(async () => {
      E = {
        dir: env("CLAUDEX_SSH_E2E_DIR"),
        ssh: env("CLAUDEX_SSH_E2E_SSH"),
        password: env("CLAUDEX_SSH_E2E_PASSWORD"),
        fingerprint: env("CLAUDEX_SSH_E2E_FINGERPRINT"),
        arch: env("CLAUDEX_SSH_E2E_ARCH"),
        cache: env("CLAUDEX_SSH_E2E_CACHE"),
        log: path.join(env("CLAUDEX_SSH_E2E_DIR"), "ssh-runs.log"),
      };
      process.env.CLAUDEX_SSH_E2E_LOG = E.log;
      // Short paths: control and askpass sockets live under the data folder.
      work = fs.mkdtempSync(path.join(E.dir, "w"));
      dataRoot = path.join(work, "d");
      fs.mkdirSync(dataRoot, { mode: 0o700 });
      // The sockets stay in the test's folder (not the app's /tmp fallback).
      assert.ok(privateRuntimeDir(dataRoot).startsWith(dataRoot));
      const helper = path.join(work, "ssh-askpass.cjs");
      await build({
        entryPoints: [
          path.resolve(
            import.meta.dirname,
            "../../electron/ssh/askpass-helper.ts",
          ),
        ],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22",
        outfile: helper,
        logLevel: "silent",
      });
      serviceScript = path.join(work, "provider-service.cjs");
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
      broker = new AskpassBroker({
        dir: path.join(privateRuntimeDir(dataRoot), "askpass"),
        helperScript: helper,
        execPath: process.execPath,
        emit: (event: SshEvent) => {
          if (event.type !== "ssh-prompt") return;
          prompts.push(event.prompt);
          // The person answers a moment later, as in the window.
          setTimeout(() => {
            try {
              broker.answer(event.prompt.id, answer(event.prompt));
            } catch {
              // Already closed.
            }
          }, 50);
        },
      });
      await broker.start();
      service = new E2eSshService(dataRoot, process.platform, E.ssh, broker);
      dev = service.add("claudex-e2e", "e2e box");
      mock = await new MockResponses().start();
    });

    after(async () => {
      await service?.closeAll();
      broker?.close();
      await mock?.close();
      delete process.env.CLAUDEX_SSH_E2E_LOG;
      await delay(300);
      // No ssh process of the test's config outlives it.
      const left = spawnSync("pgrep", ["-f", `${E.dir}/ssh_config`], {
        encoding: "utf8",
      }).stdout.trim();
      if (work) fs.rmSync(work, { recursive: true, force: true });
      assert.equal(left, "", "ssh processes left running");
    });

    test("Test connection: a refused host key is not saved", async () => {
      answer = () => null;
      const result = await testSshHost({
        host: { destination: "claudex-e2e", label: "e2e box" },
        sshPath: E.ssh,
        askpass: broker,
      });
      assert.equal(result.ok, false);
      const asked = prompts.at(-1)!;
      assert.equal(asked.kind, "hostkey");
      assert.equal(asked.fingerprint, E.fingerprint);
      assert.equal(
        fs.readFileSync(path.join(E.dir, "known_hosts"), "utf8"),
        "",
      );
    });

    test("Test connection: the new host key shows its fingerprint, is trusted once and the platform is reported", async () => {
      const before = prompts.length;
      answer = (prompt) =>
        prompt.kind === "hostkey" && prompt.fingerprint === E.fingerprint
          ? "yes"
          : null;
      const result = await testSshHost({
        host: { destination: "claudex-e2e", label: "e2e box" },
        sshPath: E.ssh,
        askpass: broker,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(
        result.platform,
        `Linux ${E.arch === "amd64" ? "x86_64" : "aarch64"}`,
      );
      const asked = prompts.slice(before);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].kind, "hostkey");
      assert.equal(asked[0].confirm, true);
      assert.equal(asked[0].hostId, "");
      assert.match(
        fs.readFileSync(path.join(E.dir, "known_hosts"), "utf8"),
        /^\[127\.0\.0\.1\]:\d+ ssh-ed25519 /,
      );
      // Known now: a second test asks nothing.
      const again = await testSshHost({
        host: { destination: "claudex-e2e", label: "e2e box" },
        sshPath: E.ssh,
        askpass: broker,
      });
      assert.equal(again.ok, true);
      assert.equal(prompts.length, before + 1);
    });

    test("the master connection signs in once and every command rides on it", async () => {
      answer = () => null;
      const before = prompts.length;
      fs.rmSync(E.log, { force: true });
      const status = await service.connect(dev.id);
      assert.deepEqual(status, { state: "ready" });
      const connection = service.connection(dev.id);
      assert.equal(connection.probe?.os, "Linux");
      assert.equal(
        connection.probe?.arch,
        E.arch === "amd64" ? "x86_64" : "aarch64",
      );
      assert.ok(connection.probe?.tools.includes("curl"));
      assert.equal(prompts.length, before, "a key sign-in asks nothing");
      assert.equal((await onHost(connection, "id -un")).trim(), "dev");
      // The control socket answers `ssh -O check`.
      const socket = controlPath(privateRuntimeDir(dataRoot), dev.id);
      const check = spawnSync(E.ssh, [
        "-o",
        `ControlPath=${socket}`,
        "-O",
        "check",
        "--",
        "claudex-e2e",
      ]);
      assert.equal(check.status, 0, check.stderr?.toString());
      const runs = sshRuns();
      // Agent and X11 forwarding are off on every process; commands share the master.
      for (const run of runs.filter((r) => !r.includes("-O ")))
        assert.match(run, /ForwardAgent=no .*ForwardX11=no/);
      assert.equal(runs.filter((r) => / -M /.test(` ${r} `)).length, 1);
      assert.ok(runs.filter((r) => r.includes("ControlMaster=no")).length >= 2);
    });

    test("the runtime is uploaded from this computer when the host can't download it", async (t) => {
      const connection = service.connection(dev.id);
      const manifest = runtimeManifest();
      const triple = remoteTriple(connection.probe!)!;
      const pkg = manifest.platforms[triple];
      assert.ok(pkg, `no package for ${triple}`);
      // Downloaded once (with retries) into scripts/ssh-e2e/.cache.
      const shared = await new RuntimeCache({ dir: E.cache }).ensure(pkg);
      const localCache = path.join(dataRoot, RUNTIME_CACHE_DIR);
      fs.mkdirSync(localCache, { recursive: true });
      fs.copyFileSync(shared, path.join(localCache, packageFileName(pkg)));
      // The host's address for the package is dead, so it must be uploaded.
      const dead = {
        ...manifest,
        platforms: {
          ...manifest.platforms,
          [triple]: { ...pkg, url: "http://127.0.0.1:9/codex.tgz" },
        },
      };
      const statuses: SshStatus[] = [];
      const runtime = new RemoteRuntime({
        shell: connection,
        probe: connection.probe!,
        label: "e2e box",
        clientId: clientIdFor(deviceId(dataRoot)),
        cache: new RuntimeCache({
          dir: localCache,
          fetch: () => Promise.reject(new Error("no network in this test")),
        }),
        manifest: dead,
        chunkBytes: 16 * 1024 * 1024,
        onStatus: (status) => statuses.push(status),
      });
      const started = Date.now();
      layout = await runtime.ensure();
      t.diagnostic(`installed by upload in ${Date.now() - started} ms`);
      const phases = statuses.map((s) =>
        s.state === "installing" ? s.phase : s.state,
      );
      assert.ok(phases.includes("upload"), phases.join(","));
      const uploads = statuses.filter(
        (s) => s.state === "installing" && s.phase === "upload",
      ) as { progress?: number }[];
      assert.ok(uploads.length >= 2, "upload progress is reported");
      assert.match(
        layout.root,
        new RegExp(
          `^/home/dev/\\.claudex-remote/${clientIdFor(deviceId(dataRoot))}$`,
        ),
      );
      // The engine runs on the host and the folders are private.
      const version = await onHost(
        connection,
        `'${layout.codex}' --version; stat -c '%a' '${layout.root}' '${layout.home}'`,
      );
      assert.match(version, /0\.144\.1/);
      // Owner only (a setgid bit inherited from the home folder may show as 2700).
      assert.deepEqual(
        version
          .trim()
          .split("\n")
          .slice(-2)
          .map((mode) => mode.slice(-3)),
        ["700", "700"],
      );
      // Nothing is left in tmp/ and the install lock is gone.
      assert.equal(
        (
          await onHost(
            connection,
            `ls -A '${layout.root}/tmp'; ls -A '${layout.run}'`,
          )
        ).trim(),
        "",
      );
      // Installed: the next check changes nothing.
      const again: SshStatus[] = [];
      const second = await new RemoteRuntime({
        shell: connection,
        probe: connection.probe!,
        label: "e2e box",
        clientId: clientIdFor(deviceId(dataRoot)),
        cache: new RuntimeCache({ dir: localCache }),
        onStatus: (status) => again.push(status),
      }).ensure();
      assert.deepEqual(second, layout);
      assert.ok(
        again.every((s) => s.state === "installing" && s.phase === "verify"),
      );
    });

    test("a Code conversation runs on the host through ssh -O forward, and its command runs there", async (t) => {
      const setup = engineSetup(service, process.platform);
      try {
        const cwd = "/home/dev/work/app";
        const connection = service.connection(dev.id);
        await onHost(
          connection,
          [
            `mkdir -p ${cwd} && cd ${cwd}`,
            `git init -q -b main . && printf 'one\\ntwo\\n' > notes.txt && mkdir -p src && printf 'x\\n' > src/a.ts`,
            `git add -A && git commit -qm init`,
          ].join("\n"),
        );
        const listenersBefore = listeners(
          await onHost(connection, "netstat -ltn"),
        );
        fs.rmSync(E.log, { force: true });
        scriptShellCommand("uname -s > ran-on.txt; cat ran-on.txt; pwd");
        const before = mock.requests.length;
        // "Trust workspace" for the repository on the host (asked first).
        await setup.registry
          .forEnvironment({ kind: "ssh", hostId: dev.id })
          .trustRemoteWorkspace(cwd);
        const conversation = await setup.local.send({
          text: "Where are you?",
          mode: "code",
          cwd,
          attachments: [],
          providerId: "p",
          model: MODEL,
          environment: { kind: "ssh", hostId: dev.id },
        });
        const remote = setup.registry.forConversation(conversation.id);
        assert.notEqual(remote, setup.local);
        const turn = await setup.completed(conversation.id);
        assert.equal(turn.status, "completed", turn.error);
        const command = commandOutput(setup.conversationOf(conversation.id));
        t.diagnostic(`command item: ${JSON.stringify(command)}`);
        assert.equal(command?.exitCode, 0);
        assert.match(String(command?.aggregatedOutput), /Linux/);
        assert.match(
          String(command?.aggregatedOutput),
          /\/home\/dev\/work\/app/,
        );
        assert.ok(
          turn.items.some(
            (i) => i.type === "agentMessage" && i.text === "done",
          ),
        );
        // Both model requests went through this computer's gateway.
        assert.equal(mock.requests.length, before + 2);
        // The workspace-write sandbox let it write in the folder on the host.
        assert.equal(
          (await onHost(connection, `cat ${cwd}/ran-on.txt`)).trim(),
          "Linux",
        );

        // The token: on no ssh command line here, on no command line on the host.
        const token = (remote as any).gateway.token as string;
        assert.ok(token.length > 10);
        const runs = sshRuns();
        assert.ok(!runs.join("\n").includes(token));
        const forward = runs.find((r) => r.includes("-O forward"));
        assert.ok(forward, runs.join("\n"));
        assert.match(forward!, /-R 127\.0\.0\.1:0:127\.0\.0\.1:\d+/);
        const processes = await onHost(
          connection,
          "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done",
        );
        assert.match(processes, /codex app-server --listen stdio:\/\//);
        assert.ok(!processes.includes(token), "the token is on a command line");
        // The remote forward listens on the host's loopback only.
        const listening = await onHost(connection, "netstat -ltn");
        const forwarded = listeners(listening).filter(
          (l) => !listenersBefore.some((b) => b.port === l.port),
        );
        assert.equal(forwarded.length, 1, listening);
        assert.equal(forwarded[0].address, "127.0.0.1", listening);
        // The engine's pid file.
        const pids = (await onHost(connection, `ls '${layout.run}'`))
          .trim()
          .split("\n");
        assert.equal(pids.length, 1);
        assert.match(pids[0], /^e[0-9a-f]{16}\.pid$/);

        // The workspace over the host's Codex (command/exec)…
        const viaCodex = new RemoteWorkspace(dev.id, "e2e box", () =>
          rpcRunner(remote.rpc!),
        );
        await onHost(
          connection,
          `cd ${cwd} && printf 'one\\nTWO\\nthree\\n' > notes.txt && printf 'new\\n' > "it's new.txt"`,
        );
        const changes = await workingTreeChanges(cwd, 3, viaCodex);
        assert.equal(changes.state, "ready");
        assert.match(changes.diff, /-two\n\+TWO\n\+three/);
        assert.match(changes.diff, /it's new\.txt/);
        assert.deepEqual(await viaCodex.workspaceGit(cwd), {
          branch: "main",
          githubRemote: false,
        });
        const names = (await viaCodex.listFolder(cwd)).map((f) => f.path);
        assert.ok(
          names.includes("notes.txt") && names.includes("src/a.ts"),
          names.join(","),
        );
        assert.ok(!names.some((n) => n === ".git" || n.startsWith(".git/")));
        assert.equal(
          (
            await viaCodex.readFileInside(cwd, `${cwd}/notes.txt`, 1024)
          ).toString(),
          "one\nTWO\nthree\n",
        );
        await assert.rejects(viaCodex.readFileInside(cwd, "/etc/passwd", 1024));

        // A terminal tab runs the host account's login shell in the folder.
        const terminalEvents: AppEvent[] = [];
        const terminals = new TerminalController(
          setup.store,
          setup.local,
          (event) => terminalEvents.push(event),
          process.platform,
        );
        const [tab] = await terminals.ensure(conversation.id);
        assert.equal(tab.title, "bash — e2e box");
        assert.equal(tab.cwd, cwd);
        const typed = () =>
          terminalEvents
            .map((event) =>
              event.type === "terminal-output" && event.id === tab.id
                ? Buffer.from(event.deltaBase64, "base64").toString()
                : "",
            )
            .join("");
        await terminals.write(
          conversation.id,
          tab.id,
          Buffer.from('echo "sum=$((6*7)) $(uname -s) $(pwd)"\n').toString(
            "base64",
          ),
        );
        await until(
          () => /sum=42 Linux \/home\/dev\/work\/app/.test(typed()),
          "terminal output from the host",
          30_000,
        );
        await terminals.closeConversation(conversation.id);

        // Stopping the engine ends Codex on the host and removes the forward.
        await setup.registry.stopRemote(dev.id);
        await delay(500);
        const afterStop = await onHost(
          connection,
          "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done; netstat -ltn",
        );
        assert.ok(!/codex app-server/.test(afterStop), afterStop);
        for (const { port } of forwarded)
          assert.ok(
            !afterStop.includes(`:${port} `),
            `forward ${port} still open`,
          );

        // …and over the SSH connection when Codex isn't running: same answer.
        const viaSsh = new RemoteWorkspace(dev.id, "e2e box", () =>
          connectionRunner(connection),
        );
        assert.deepEqual(await workingTreeChanges(cwd, 3, viaSsh), changes);
      } finally {
        await setup.close();
      }
    });

    test("the master drops and comes back by itself", async () => {
      const connection = service.connection(dev.id);
      assert.equal(connection.status.state, "ready");
      const socket = controlPath(privateRuntimeDir(dataRoot), dev.id);
      const statuses = (service.statuses.get(dev.id) ?? []).length;
      const exit = spawnSync(E.ssh, [
        "-o",
        `ControlPath=${socket}`,
        "-O",
        "exit",
        "--",
        "claudex-e2e",
      ]);
      assert.equal(exit.status, 0, exit.stderr?.toString());
      await until(
        () =>
          (service.statuses.get(dev.id) ?? [])
            .slice(statuses)
            .some((s) => s.state === "reconnecting"),
        "reconnecting",
        10_000,
      );
      await until(
        () => connection.status.state === "ready",
        "ready again",
        30_000,
      );
      assert.equal((await onHost(connection, "echo back")).trim(), "back");
    });

    test("Windows way: no master, the engine's own ssh carries -R and reports the Allocated port; a message written while it reconnects is sent once", async (t) => {
      const winRoot = path.join(work, "win");
      fs.mkdirSync(winRoot, { mode: 0o700 });
      const winService = new E2eSshService(winRoot, "win32", E.ssh, broker);
      const host = winService.add("claudex-e2e", "e2e box");
      const runtime = (connection: SshConnection) =>
        new RemoteRuntime({
          shell: connection,
          probe: connection.probe!,
          label: "e2e box",
          clientId: clientIdFor(deviceId(dataRoot)),
          cache: new RuntimeCache({
            dir: path.join(dataRoot, RUNTIME_CACHE_DIR),
          }),
        });
      // Another computer's data folder, using the first client's runtime folder
      // on the host (already installed there: only checked).
      const setup = engineSetup(winService, "win32", runtime);
      try {
        fs.rmSync(E.log, { force: true });
        mock.script = () => [message("ok")];
        const cwd = "/home/dev/work/app";
        await setup.registry
          .forEnvironment({ kind: "ssh", hostId: host.id })
          .trustRemoteWorkspace(cwd);
        const first = await setup.local.send({
          text: "hello the Windows way",
          mode: "code",
          cwd,
          attachments: [],
          providerId: "p",
          model: MODEL,
          environment: { kind: "ssh", hostId: host.id },
        });
        const turn = await setup.completed(first.id);
        assert.equal(turn.status, "completed", turn.error);
        const runs = sshRuns();
        assert.ok(
          !runs.some((r) => / -M /.test(` ${r} `)),
          "no master on Windows",
        );
        const engineRun = runs.find((r) => r.includes(" -R "));
        assert.ok(engineRun, runs.join("\n"));
        assert.match(engineRun!, /LogLevel=INFO/);
        assert.match(engineRun!, /ExitOnForwardFailure=yes/);
        assert.match(engineRun!, /ControlPath=none/);
        const token = (setup.registry.forConversation(first.id) as any).gateway
          .token as string;
        assert.ok(!runs.join("\n").includes(token));
        t.diagnostic(
          `${runs.length} ssh processes for connect + probe + engine`,
        );

        // The channel drops (on Windows it is the connection).
        const remote = setup.registry.forConversation(first.id);
        (remote.rpc as any).process.kill("SIGKILL");
        const connection = winService.existing(host.id)!;
        await until(
          () => connection.status.state === "reconnecting",
          "reconnecting",
          10_000,
        );
        const before = mock.requests.length;
        const queued = await setup.local.send({
          conversationId: first.id,
          text: "written while reconnecting",
          mode: "code",
          attachments: [],
          providerId: "p",
          model: MODEL,
        });
        assert.match(queued.turns.at(-1)!.id, /^outbox-/);
        await until(
          () => mock.requests.length > before,
          "sent after reconnect",
          120_000,
        );
        const sent = await setup.completed(first.id);
        assert.equal(sent.status, "completed", sent.error);
        await delay(500);
        assert.equal(
          mock.requests.filter((r) =>
            JSON.stringify(r.input).includes("written while reconnecting"),
          ).length,
          1,
        );
        const c = setup.conversationOf(first.id);
        assert.equal(
          c.turns.filter((x) => x.prompt === "written while reconnecting")
            .length,
          1,
        );
      } finally {
        await setup.close();
        await winService.closeAll();
      }
    });

    test("a password account: a wrong password fails, the right one signs in, nothing is saved, and a background attempt never asks", async () => {
      const pw = service.add("claudex-e2e-pw", "pw box");
      const before = prompts.length;
      answer = (prompt) =>
        prompt.kind === "password" ? "wrong-password" : null;
      const wrong = await service.connect(pw.id);
      assert.equal(wrong.state, "error");
      assert.equal(wrong.state === "error" && wrong.code, "auth-failed");
      assert.equal(prompts.at(-1)?.kind, "password");
      assert.equal(prompts.at(-1)?.hostId, pw.id);

      answer = (prompt) => (prompt.kind === "password" ? E.password : null);
      const right = await service.connect(pw.id);
      assert.deepEqual(right, { state: "ready" });
      const connection = service.connection(pw.id);
      assert.equal((await onHost(connection, "id -un")).trim(), "pw");
      // One question per attempt: the commands ride on the master.
      assert.equal(prompts.length, before + 2);
      assert.ok(
        !allText(dataRoot).includes(E.password),
        "the password was written somewhere",
      );
      assert.ok(!sshRuns().join("\n").includes(E.password));

      // A background attempt (reconnect) refuses the question and waits for the person.
      await connection.disconnect();
      const background = await service.connect(pw.id, false);
      assert.deepEqual(background, { state: "needs-auth" });
      assert.equal(prompts.length, before + 2, "a background attempt asked");
      await connection.disconnect();
    });

    test("a changed host key is a hard error and known_hosts is left alone", async () => {
      const changed = service.add("claudex-e2e-changed", "changed box");
      const file = path.join(E.dir, "known_hosts_changed");
      const saved = fs.readFileSync(file, "utf8");
      const before = prompts.length;
      answer = () => "yes";
      const status = await service.connect(changed.id);
      assert.equal(status.state, "error");
      assert.equal(status.state === "error" && status.code, "host-key-changed");
      assert.equal(prompts.length, before, "no way to accept a changed key");
      assert.equal(fs.readFileSync(file, "utf8"), saved);
    });

    test("a host that refuses connections reports it can't be reached", async () => {
      const closed = service.add("claudex-e2e-closed", "closed box");
      const status = await service.connect(closed.id);
      assert.equal(status.state, "error");
      assert.equal(status.state === "error" && status.code, "host-unreachable");
    });

    test("disconnecting closes the master and every ssh process", async () => {
      await service.closeAll();
      await delay(300);
      const left = spawnSync("pgrep", ["-f", `${E.dir}/ssh_config`], {
        encoding: "utf8",
      }).stdout.trim();
      assert.equal(left, "");
      assert.ok(
        !fs.existsSync(controlPath(privateRuntimeDir(dataRoot), dev.id)),
      );
      // Nothing of the host's password or the test key's contents is in the data folder.
      const key = fs.readFileSync(path.join(E.dir, "id_ed25519"), "utf8");
      const text = allText(dataRoot);
      assert.ok(!text.includes(key.split("\n")[1]));
    });
  },
);
