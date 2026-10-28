/**
 * R9-S4: a Code conversation's folder on an SSH host. The Changes panel,
 * the branch chip, the `@` list, generated file snapshots and terminals ask
 * the host, never this computer's files.
 *
 * The "host" is this computer: through the real Codex app-server
 * (`command/exec`, as an SSH engine's), through a stand-in app-server that
 * runs the commands here, and through a stand-in SSH connection that runs
 * each script with `sh`. The answers must equal the local implementation's.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AppEvent,
  Conversation,
  Item,
  WorkingTreeChanges,
} from "../../shared/types";
import { openPolicy } from "../../shared/client-policy";
import { CodexRPC } from "../../electron/engine/rpc";
import { resolveRuntime } from "../../electron/engine/runtime";
import { Engine } from "../../electron/engine/engine";
import { type EngineLauncher } from "../../electron/engine/engine-types";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import { Store } from "../../electron/store/store";
import { TerminalController } from "../../electron/terminal/terminal-controller";
import { workingTreeChanges } from "../../electron/git/working-tree";
import { workspaceGit } from "../../electron/git/git-branch";
import { listFolder, mentionFiles } from "../../electron/engine/composer-files";
import {
  captureGeneratedFiles,
  captureGeneratedFilesWith,
} from "../../electron/artifacts/generated-files";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";
import {
  RemoteUnavailableError,
  RemoteWorkspace,
  connectionRunner,
  remoteWorkspace,
  rpcRunner,
  type ExecConnection,
  type RemoteRunner,
} from "../../electron/ssh/remote-workspace";
import { watchRemoteGeneratedFiles } from "../../electron/ssh/remote-workspace-watch";
import {
  conversationWorkspace,
  localWorkspaceFs,
} from "../../electron/workspace/workspace-fs";
import { registerPanelHandlers } from "../../electron/ipc/panels";
import { registerComposerHandlers } from "../../electron/ipc/composer";
import { registerCodeUsageHandlers } from "../../electron/ipc/code-usage";
import { registerBackgroundTerminalHandlers } from "../../electron/ipc/background-terminals";
import type { AppContext } from "../../electron/app/app-context";
import type { SshServiceApi } from "../../electron/ipc/ssh";

const temp = (name: string) =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cx-rws-${name}-`)));

/** Runs a command here as a host would, with command/exec's options. */
function runHere(params: {
  command: string[];
  cwd?: string | null;
  env?: Record<string, string | null>;
  outputBytesCap?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(params.env ?? {}))
    if (value === null) delete env[name];
    else env[name] = value;
  return new Promise((resolve, reject) => {
    const child = spawn(params.command[0], params.command.slice(1), {
      cwd: params.cwd ?? undefined,
      env,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      let stdout = Buffer.concat(out).toString("utf8");
      if (params.outputBytesCap !== undefined)
        stdout = stdout.slice(0, params.outputBytesCap);
      resolve({ exitCode: code ?? -1, stdout, stderr: err });
    });
  });
}

/** An app-server stand-in: `command/exec` runs here; everything is recorded. */
class HereRpc extends EventEmitter {
  connected = true;
  calls: { method: string; params: any }[] = [];
  shell = "/bin/bash";
  async call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "fs/getMetadata") {
      const stat = fs.statSync(params.path, { throwIfNoEntry: false });
      if (!stat) throw new Error("No such file or directory (os error 2)");
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile() };
    }
    if (method !== "command/exec") return {};
    // A terminal tab runs until closed.
    if (params.tty) return new Promise(() => {});
    if (params.command[0] === "/bin/sh" && /SHELL/.test(params.command[2]))
      return { exitCode: 0, stdout: this.shell, stderr: "" };
    return runHere(params);
  }
}

/** An SSH connection stand-in: each script runs with sh, like ssh's remote command. */
function hereConnection(scripts: string[] = []): ExecConnection {
  return {
    exec: async (script, options = {}) => {
      scripts.push(script);
      const result = await runHere({
        command: ["/bin/sh", "-c", script],
        outputBytesCap: options.maxOutput,
      });
      return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

function hostWith(runner: RemoteRunner) {
  return new RemoteWorkspace("box", "box", () => runner);
}

/** A repository with edits, an untracked file, a link out and odd names. */
function repository() {
  const dir = temp("repo");
  const outside = temp("outside");
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=probe\n");
  fs.writeFileSync(path.join(dir, "app.js"), "a\nb\nc\n");
  fs.writeFileSync(path.join(dir, "it's $(touch PWNED).js"), "1\n2");
  run("add", ".");
  run("commit", "-qm", "base");
  fs.writeFileSync(path.join(dir, "app.js"), "a\nB\nc\nd");
  fs.writeFileSync(path.join(dir, "it's $(touch PWNED).js"), "1\n2\n3\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "x\ny\n");
  fs.writeFileSync(path.join(dir, "-rf"), "dash\n");
  fs.writeFileSync(path.join(outside, "secret"), "one\ntwo\nthree\n");
  fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "link"));
  run("remote", "add", "origin", "git@github.com:example/app.git");
  // Programs the agent could have configured; no query may run them.
  run("config", "core.fsmonitor", "sh -c 'touch FSMONITOR'");
  run("config", "diff.probe.textconv", "sh -c 'touch TEXTCONV; cat \"$0\"'");
  return {
    dir,
    outside,
    run,
    close() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

function noProgramsRan(dir: string) {
  for (const marker of ["FSMONITOR", "TEXTCONV", "PWNED"])
    assert.equal(fs.existsSync(path.join(dir, marker)), false, marker);
}

async function sameAsLocal(host: RemoteWorkspace, dir: string) {
  const local = await workingTreeChanges(dir, 3);
  const remote = await workingTreeChanges(dir, 3, host);
  assert.equal(remote.state, "ready");
  assert.deepEqual(remote, local);
  return remote;
}

function expectChanges(result: WorkingTreeChanges) {
  assert.equal(result.base, "main");
  assert.match(result.diff, /\+B/);
  assert.match(result.diff, /\+\+\+ b\/new\.txt/);
  assert.match(result.diff, /\+\+\+ b\/-rf/);
  // The link's diff is its target path, never the file it points at.
  assert.doesNotMatch(result.diff, /two/);
  assert.deepEqual(result.lineCounts["app.js"], 4);
  assert.deepEqual(result.lineCounts["it's $(touch PWNED).js"], 3);
  assert.deepEqual(result.lineCounts["new.txt"], 2);
  assert.equal(result.lineCounts.link, undefined);
}

test("the Changes panel on a host equals the local answer, through a Codex stand-in and through SSH", async () => {
  const repo = repository();
  try {
    const rpc = new HereRpc();
    expectChanges(await sameAsLocal(hostWith(rpcRunner(rpc)), repo.dir));
    // Commands go as argv, without the gateway token or API keys, unsandboxed
    // like the local git (a macOS host's git shim fails inside the sandbox).
    const exec = rpc.calls.find((call) => call.method === "command/exec")!;
    assert.equal(exec.params.command[0], "git");
    assert.deepEqual(exec.params.command.slice(1, 7), [
      "-c",
      "core.quotepath=off",
      "-c",
      "color.ui=false",
      "-c",
      "core.fsmonitor=false",
    ]);
    assert.equal(exec.params.env.CLAUDEX_GATEWAY_TOKEN, null);
    assert.equal(exec.params.env.OPENAI_API_KEY, null);
    assert.equal(exec.params.env.GIT_OPTIONAL_LOCKS, "0");
    assert.deepEqual(exec.params.sandboxPolicy, { type: "dangerFullAccess" });

    const scripts: string[] = [];
    expectChanges(
      await sameAsLocal(
        hostWith(connectionRunner(hereConnection(scripts))),
        repo.dir,
      ),
    );
    assert.ok(
      scripts.every((script) => script.includes("unset CLAUDEX_GATEWAY_TOKEN")),
    );
    noProgramsRan(repo.dir);
    // Unborn branch, not a repository, no folder.
    const empty = temp("empty");
    try {
      const host = hostWith(connectionRunner(hereConnection()));
      assert.equal((await workingTreeChanges(empty, 3, host)).state, "not-git");
      assert.equal(
        (await workingTreeChanges(undefined, 3, host)).state,
        "no-folder",
      );
      execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: empty });
      fs.writeFileSync(path.join(empty, "a.md"), "hi\n");
      const unborn = await workingTreeChanges(empty, 3, host);
      assert.deepEqual(unborn, await workingTreeChanges(empty, 3));
      assert.equal(unborn.base, "trunk");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    repo.close();
  }
});

test("a host that can't be reached is an error, not 'not a Git repository'", async () => {
  const host = new RemoteWorkspace("box", "box", () => {
    throw new RemoteUnavailableError("Connect to box first.");
  });
  await assert.rejects(
    workingTreeChanges("/srv/app", 3, host),
    /Connect to box first/,
  );
  const gone = hostWith(
    connectionRunner({
      exec: async () => {
        throw new Error("Reconnecting to box…");
      },
    }),
  );
  await assert.rejects(workingTreeChanges("/srv/app", 3, gone), /Reconnecting/);
  const dead = new HereRpc();
  dead.connected = false;
  dead.call = async () => {
    throw new Error("The Codex engine is not connected.");
  };
  await assert.rejects(
    workingTreeChanges("/srv/app", 3, hostWith(rpcRunner(dead))),
    /not connected/,
  );
  // Host paths are absolute and plain.
  await assert.rejects(host.isDirectory("relative/path"), /usable path/);
  await assert.rejects(
    hostWith(rpcRunner(new HereRpc())).isDirectory("/srv/a\nb"),
    /usable path/,
  );
});

test("the branch chip reads a host's repository through git, like the local file read", async () => {
  const repo = repository();
  try {
    for (const host of [
      hostWith(rpcRunner(new HereRpc())),
      hostWith(connectionRunner(hereConnection())),
    ]) {
      assert.deepEqual(
        await host.workspaceGit(repo.dir),
        workspaceGit(repo.dir),
      );
      assert.deepEqual(await host.workspaceGit(repo.dir), {
        branch: "main",
        githubRemote: true,
      });
    }
    noProgramsRan(repo.dir);
    // The test's own checkout below would run it.
    repo.run("config", "--unset", "core.fsmonitor");
    const host = hostWith(connectionRunner(hereConnection()));
    const head = repo.run("rev-parse", "HEAD").toString().trim();
    repo.run("checkout", "-q", "--detach");
    assert.deepEqual(await host.workspaceGit(repo.dir), {
      branch: head.slice(0, 7),
      githubRemote: true,
    });
    repo.run("remote", "set-url", "origin", "https://gitlab.com/x/y.git");
    assert.equal((await host.workspaceGit(repo.dir)).githubRemote, false);
    const plain = temp("plain");
    try {
      assert.deepEqual(await host.workspaceGit(plain), {
        branch: null,
        githubRemote: false,
      });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    noProgramsRan(repo.dir);
  } finally {
    repo.close();
  }
});

test("@ on a host lists and ranks like a local folder, skipping dependencies and links", async () => {
  const dir = temp("mention");
  const outside = temp("mention-out");
  try {
    fs.mkdirSync(path.join(dir, "src/deep/er"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules/pkg"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, "src/deep/er/needle.ts"), "x");
    fs.writeFileSync(path.join(dir, "src/app.ts"), "x");
    fs.writeFileSync(path.join(dir, "node_modules/pkg/needle.js"), "x");
    fs.writeFileSync(path.join(dir, ".git/needle"), "x");
    fs.writeFileSync(path.join(dir, "a b'c.md"), "x");
    fs.writeFileSync(path.join(outside, "needle.secret"), "x");
    fs.symlinkSync(outside, path.join(dir, "out"));
    for (const host of [
      hostWith(rpcRunner(new HereRpc())),
      hostWith(connectionRunner(hereConnection())),
    ]) {
      const listed = await host.listFolder(dir);
      const local = listFolder(dir).filter((f) => f.path !== "out");
      assert.deepEqual(
        [...listed].sort((a, b) => a.path.localeCompare(b.path)),
        [...local].sort((a, b) => a.path.localeCompare(b.path)),
      );
      assert.deepEqual(await host.mentionFiles(dir, "needle"), [
        { path: "src/deep/er/needle.ts", kind: "file" },
      ]);
      assert.deepEqual(
        await host.mentionFiles(dir, "needle"),
        mentionFiles(dir, "needle").filter((f) => !f.path.startsWith("out")),
      );
      assert.deepEqual(await host.mentionFiles(dir, "../etc"), []);
      assert.deepEqual(await host.mentionFiles(dir, "/etc"), []);
      await assert.rejects(
        host.listFolder(path.join(dir, "missing")),
        /no longer available/,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("generated files on a host are snapshotted like local ones, never outside the folder", async () => {
  const root = temp("gen");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const outside = path.join(root, "outside.txt");
  try {
    fs.writeFileSync(path.join(cwd, "card.html"), "<title>Card</title>一\n");
    fs.writeFileSync(
      path.join(cwd, "pic.png"),
      Buffer.from([137, 80, 0, 1, 2]),
    );
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(cwd, "link.txt"));
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.writeFileSync(path.join(root, "elsewhere/x.txt"), "no");
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(cwd, "dirlink"));
    fs.writeFileSync(path.join(cwd, "binary.txt"), Buffer.from([65, 0]));
    fs.writeFileSync(
      path.join(cwd, "large.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    );
    const item = (paths: string[]): Item => ({
      id: "patch",
      type: "fileChange",
      status: "completed",
      changes: paths.map((p) => ({ path: p, kind: { type: "add" }, diff: "" })),
    });
    const blobsLocal = new GeneratedBlobs(path.join(root, "local-profile"));
    const blobsRemote = new GeneratedBlobs(path.join(root, "remote-profile"));
    const good = item(["card.html", path.join(cwd, "pic.png")]);
    const host = hostWith(connectionRunner(hereConnection()));
    const local = captureGeneratedFiles(good, cwd, blobsLocal);
    const remote = await captureGeneratedFilesWith(
      good,
      cwd,
      host.readFileInside,
      blobsRemote,
    );
    const strip = (files: typeof local) =>
      files.map(({ capturedAt, ...rest }) => rest);
    assert.deepEqual(strip(remote), strip(local));
    assert.equal(remote[0].content, "<title>Card</title>一\n");
    assert.equal(remote[1].blob, true);
    assert.deepEqual(
      blobsRemote.read(remote[1].digest!),
      fs.readFileSync(path.join(cwd, "pic.png")),
    );

    const bad = await captureGeneratedFilesWith(
      item([
        "../outside.txt",
        "link.txt",
        "dirlink/x.txt",
        "binary.txt",
        "large.txt",
        "missing.txt",
      ]),
      cwd,
      hostWith(rpcRunner(new HereRpc())).readFileInside,
    );
    assert.deepEqual(
      bad.map((file) => [file.state, file.error]),
      [
        ["unavailable", "This file is outside the conversation workspace."],
        ["unavailable", "Only regular files can be previewed."],
        [
          "unavailable",
          "This file resolves outside the conversation workspace.",
        ],
        ["unavailable", "Binary content cannot be previewed as text."],
        ["ready", undefined],
        ["unavailable", "This file no longer exists."],
      ],
    );
    // Too large is a state, not an error; the reader here knows the size.
    assert.equal(bad[4].tooLarge, true);
    assert.equal(bad[4].content, undefined);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    // The local reader keeps the same rules.
    await assert.rejects(
      localWorkspaceFs.readFileInside(
        cwd,
        path.join(cwd, "dirlink/x.txt"),
        100,
      ),
      /outside/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "c1",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...patch,
  };
}

/** An SSH service stand-in whose host "box" is connected through `connection`. */
function sshService(
  connection: ExecConnection | undefined,
  state = "ready",
  allowed = true,
): SshServiceApi {
  return {
    hosts: {
      get: (id: string) =>
        id === "box" ? ({ id, label: "gpu-box" } as any) : undefined,
    } as any,
    connection: () => {
      throw new Error("not used");
    },
    existing: (id: string) =>
      id === "box" && connection
        ? ({ ...connection, status: { state } } as any)
        : undefined,
    connect: async () => ({ state: "ready" }),
    allowed: () => allowed,
  };
}

test("a host's folder is asked through its running Codex, else its SSH connection, else refused", async () => {
  const dir = temp("route");
  try {
    const scripts: string[] = [];
    const rpc = new HereRpc();
    const remoteEngine = {
      environment: { kind: "ssh", hostId: "box" },
      rpc,
      state: { state: "ready" },
    } as unknown as Engine;
    let engines: Engine[] = [];
    let service = sshService(hereConnection(scripts));
    const sources = { engines: () => engines, ssh: () => service };
    const host = remoteWorkspace(sources, "box");
    assert.equal(host.label, "gpu-box");
    assert.equal(await host.isDirectory(dir), true);
    assert.equal(scripts.length, 1);
    engines = [remoteEngine];
    assert.equal(await host.isDirectory(path.join(dir, "nope")), false);
    assert.equal(scripts.length, 1);
    assert.equal(rpc.calls.length, 1);
    // A host's engine that isn't ready is not asked.
    (remoteEngine as any).state = { state: "starting" };
    assert.equal(await host.isDirectory(dir), true);
    assert.equal(scripts.length, 2);
    service = sshService(hereConnection(), "reconnecting");
    await assert.rejects(host.isDirectory(dir), /Reconnecting to gpu-box/);
    service = sshService(undefined);
    await assert.rejects(host.isDirectory(dir), /Connect to gpu-box first/);
    service = sshService(hereConnection(), "ready", false);
    await assert.rejects(host.isDirectory(dir), /aren't available/);
    // A conversation's folder follows its environment.
    assert.equal(
      conversationWorkspace(sources, conversation()),
      localWorkspaceFs,
    );
    assert.ok(
      conversationWorkspace(
        sources,
        conversation({ environment: { kind: "ssh", hostId: "box" } }),
      ) instanceof RemoteWorkspace,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real Codex app-server answers the host's questions (command/exec)", async () => {
  const repo = repository();
  const home = temp("codex-home");
  const rpc = new CodexRPC();
  try {
    await rpc.start(resolveRuntime(), ["app-server", "--listen", "stdio://"], {
      ...process.env,
      CODEX_HOME: home,
      CLAUDEX_GATEWAY_TOKEN: "gateway-secret",
    });
    const host = hostWith(rpcRunner(rpc));
    expectChanges(await sameAsLocal(host, repo.dir));
    assert.deepEqual(await host.workspaceGit(repo.dir), {
      branch: "main",
      githubRemote: true,
    });
    assert.deepEqual(await host.mentionFiles(repo.dir, "new"), [
      { path: "new.txt", kind: "file" },
    ]);
    const data = await host.readFileInside(
      repo.dir,
      path.join(repo.dir, "app.js"),
      100,
    );
    assert.equal(data.toString(), "a\nB\nc\nd");
    // The commands never see the gateway token.
    const echo = await rpcRunner(rpc)({
      argv: ["/bin/sh", "-c", 'printf "%s" "${CLAUDEX_GATEWAY_TOKEN-unset}"'],
    });
    assert.equal(echo.stdout, "unset");
    noProgramsRan(repo.dir);
  } finally {
    await rpc.stop();
    repo.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A registry with this computer's engine and a stand-in engine for host "box". */
function registrySetup(root: string) {
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Fixture",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const local = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  local.policy = () => openPolicy;
  const localRpc = new HereRpc();
  local.ensure = async () => {
    local.rpc = localRpc as any;
    local.state = { state: "ready" };
  };
  const hostRpc = new HereRpc();
  const registry = new EngineRegistry(() => local);
  let ensured = 0;
  registry.bind({
    ssh: () => sshService(hereConnection()),
    dataRoot: root,
    onEvent: () => () => {},
    launcher: (hostId): EngineLauncher => ({
      environment: { kind: "ssh", hostId },
      label: "gpu-box",
      platform: "linux",
      waiting: () => false,
      launch: async () => {
        throw new Error("not used");
      },
      started() {},
      exited() {},
      failed() {},
      dispose: async () => {},
    }),
  });
  const remote = registry.forEnvironment({ kind: "ssh", hostId: "box" });
  remote.ensure = async () => {
    ensured++;
    remote.rpc = hostRpc as any;
    remote.state = { state: "ready" };
  };
  return {
    store,
    local,
    localRpc,
    remote,
    hostRpc,
    registry,
    ensured: () => ensured,
  };
}

test("a terminal of an SSH conversation runs on the host, in its folder, with its shell", async () => {
  const root = temp("term");
  const hostFolder = temp("host-folder");
  try {
    const s = registrySetup(root);
    const events: AppEvent[] = [];
    s.store.conversations.push(
      conversation({ id: "here", cwd: root }),
      conversation({
        id: "there",
        cwd: hostFolder,
        environment: { kind: "ssh", hostId: "box" },
      }),
      conversation({
        id: "nofolder",
        environment: { kind: "ssh", hostId: "box" },
      }),
      conversation({
        id: "gone",
        cwd: path.join(hostFolder, "removed"),
        environment: { kind: "ssh", hostId: "box" },
      }),
    );
    const controller = new TerminalController(
      s.store,
      s.local,
      (event) => events.push(event),
      "darwin",
    );
    const [tab] = await controller.ensure("there");
    assert.equal(s.ensured(), 1);
    assert.equal(tab.title, "bash — gpu-box");
    assert.equal(tab.cwd, hostFolder);
    const exec = s.hostRpc.calls.find(
      (call) => call.method === "command/exec" && call.params.tty,
    )!;
    // The host's bash, started by a small sh script that gives it the
    // command marks (terminal-shell-integration.ts).
    assert.equal(exec.params.command[0], "/bin/sh");
    assert.equal(exec.params.command.at(-1), "/bin/bash");
    assert.match(exec.params.command[2], /--rcfile/);
    assert.match(exec.params.env.CLAUDEX_SI_BASHRC, /133;C/);
    assert.equal(exec.params.cwd, hostFolder);
    assert.equal(exec.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(exec.params.env.CLAUDEX_GATEWAY_TOKEN, null);
    assert.equal(
      s.localRpc.calls.filter((call) => call.method === "command/exec").length,
      0,
    );
    // Two calls at once share the first tab; the shell is asked once.
    const again = await Promise.all([
      controller.ensure("there"),
      controller.ensure("there"),
    ]);
    assert.equal(again[0][0].id, tab.id);
    await controller.start("there");
    assert.equal(
      s.hostRpc.calls.filter(
        (call) => call.method === "command/exec" && !call.params.tty,
      ).length,
      1,
    );
    await controller.write(
      "there",
      tab.id,
      Buffer.from("ls\n").toString("base64"),
    );
    assert.equal(s.hostRpc.calls.at(-1)!.method, "command/exec/write");
    // A local conversation still runs here.
    const [mine] = await controller.ensure("here");
    assert.equal(mine.cwd, root);
    assert.ok(s.localRpc.calls.some((call) => call.method === "command/exec"));
    // No folder on the host, or one that is gone: refused, never created here.
    await assert.rejects(
      controller.ensure("nofolder"),
      /Choose a folder on gpu-box/,
    );
    await assert.rejects(controller.ensure("gone"), /no longer available/);
    assert.equal(fs.existsSync(path.join(hostFolder, "removed")), false);
    // Typing into a tab of a host whose engine isn't running never creates one.
    s.store.conversations.push(
      conversation({
        id: "elsewhere",
        cwd: hostFolder,
        environment: { kind: "ssh", hostId: "other" },
      }),
    );
    assert.throws(
      () =>
        controller.write(
          "elsewhere",
          tab.id,
          Buffer.from("ls\n").toString("base64"),
        ),
      /SSH host isn't available/,
    );
    assert.equal(s.registry.running("elsewhere"), undefined);
    await controller.closeConversation("there");
    assert.ok(
      s.hostRpc.calls.some((call) => call.method === "command/exec/terminate"),
    );
    controller.reset();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hostFolder, { recursive: true, force: true });
  }
});

test("an SSH conversation's terminal never falls back to this computer", async () => {
  const root = temp("term-unbound");
  try {
    const store = new Store(root);
    store.conversations.push(
      conversation({
        id: "there",
        cwd: root,
        environment: { kind: "ssh", hostId: "box" },
      }),
    );
    const rpc = new HereRpc();
    const engine = { rpc, state: { state: "ready" } } as unknown as Engine;
    const controller = new TerminalController(
      store,
      engine,
      () => {},
      "darwin",
    );
    await assert.rejects(
      controller.ensure("there"),
      /SSH host isn't available/,
    );
    assert.equal(rpc.calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the window's calls take an SSH conversation's folder on its host", async () => {
  const root = temp("ipc");
  const repo = repository();
  try {
    const s = registrySetup(root);
    s.store.conversations.push(
      conversation({
        id: "there",
        cwd: repo.dir,
        environment: { kind: "ssh", hostId: "box" },
        threadId: "thread-1",
      }),
      conversation({ id: "chat", mode: "chat" }),
    );
    const scripts: string[] = [];
    let connection: ExecConnection | undefined = hereConnection(scripts);
    const folders: { folder?: string; env?: string }[] = [];
    const pushes: AppEvent[] = [];
    const ctx = {
      store: s.store,
      engine: s.local,
      engines: s.registry,
      services: {
        get ssh() {
          return sshService(connection);
        },
      },
      policy: () => openPolicy,
      selectedAttachments: new Map(),
      selectedFolders: new Set(),
      allowedFolder: (folder?: string, environment?: any) => {
        folders.push({ folder, env: environment?.kind });
        if (environment?.kind === "ssh" && folder !== repo.dir)
          throw new Error("Choose the remote folder with the folder picker.");
      },
      push: (event: AppEvent) => pushes.push(event),
      onEvent: () => () => {},
      callerWindow: () => undefined,
    } as unknown as AppContext;
    const handlers = new Map<string, (...args: any[]) => any>();
    const handle = (name: string, fn: (...args: any[]) => any) =>
      handlers.set(name, fn);
    const detected: string[] = [];
    registerPanelHandlers(
      handle,
      ctx,
      async () =>
        ({
          service: () => ({
            policy: () => ({ enabled: true, devServers: true }),
            devServers: () => ({
              detect: (id: string) => {
                detected.push(id);
                return [];
              },
            }),
          }),
        }) as any,
    );
    registerComposerHandlers(handle, ctx);
    registerCodeUsageHandlers(handle, ctx);
    registerBackgroundTerminalHandlers(handle, ctx as any);
    const call = async (name: string, ...args: unknown[]) =>
      handlers.get(name)!(...args);

    const changes = (await call(
      "workingTreeChanges",
      "there",
      3,
    )) as WorkingTreeChanges;
    expectChanges(changes);
    assert.ok(scripts.length > 0, "asked through the SSH connection");
    assert.deepEqual(
      await call("mentionFiles", { conversationId: "there" }, "new"),
      [{ path: "new.txt", kind: "file" }],
    );
    assert.deepEqual(
      await call(
        "mentionFiles",
        { folder: repo.dir, environment: { kind: "ssh", hostId: "box" } },
        "app",
      ),
      [{ path: "app.js", kind: "file" }],
    );
    await assert.rejects(
      call(
        "mentionFiles",
        { folder: "/etc", environment: { kind: "ssh", hostId: "box" } },
        "p",
      ),
      /remote folder/,
    );
    assert.deepEqual(
      await call("workspaceGit", repo.dir, { kind: "ssh", hostId: "box" }),
      { branch: "main", githubRemote: true },
    );
    assert.equal(
      await call("workspaceGit", "/etc", { kind: "ssh", hostId: "box" }),
      null,
    );
    await assert.rejects(
      call("devServersDetect", "there"),
      /Dev servers aren't available in SSH sessions/,
    );
    // The host's engine isn't running: its background terminals aren't listed
    // from this computer's Codex.
    const listed = (await call("listBackgroundTerminals", "there")) as any;
    assert.deepEqual(listed.items, []);
    assert.equal(s.localRpc.calls.length, 0);
    // Disconnected: the panel shows why.
    connection = undefined;
    await assert.rejects(
      call("workingTreeChanges", "there", 3),
      /Connect to gpu-box first/,
    );
    assert.equal(
      await call("workspaceGit", repo.dir, { kind: "ssh", hostId: "box" }),
      null,
    );
    // Once the host's Codex runs, it is asked instead of the SSH connection.
    await s.remote.ensure(s.store.settings.providers[0]);
    await call("listBackgroundTerminals", "there");
    assert.ok(s.hostRpc.calls.some((c) => c.method === "thread/loaded/list"));
    expectChanges(await call("workingTreeChanges", "there", 3));
    assert.ok(s.hostRpc.calls.some((c) => c.method === "command/exec"));
    assert.equal(s.localRpc.calls.length, 0);
    assert.deepEqual(detected, []);
    noProgramsRan(repo.dir);
  } finally {
    repo.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("files an SSH conversation's change wrote are snapshotted once, as the change completes", async () => {
  const root = temp("watch");
  const hostFolder = temp("watch-host");
  try {
    fs.writeFileSync(path.join(hostFolder, "notes.md"), "# Notes\n");
    const store = new Store(root);
    const change: Item = {
      id: "patch",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "notes.md", kind: { type: "add" }, diff: "" }],
      completedAt: 90_000,
    };
    const there = conversation({
      id: "there",
      cwd: hostFolder,
      environment: { kind: "ssh", hostId: "box" },
      turns: [
        {
          id: "t1",
          prompt: "p",
          attachments: [],
          items: [structuredClone(change)],
          status: "inProgress",
          createdAt: 1,
        },
      ],
    });
    const here = conversation({
      id: "here",
      cwd: hostFolder,
      turns: structuredClone(there.turns),
    });
    const old = conversation({
      id: "old",
      cwd: hostFolder,
      environment: { kind: "ssh", hostId: "box" },
      turns: structuredClone(there.turns).map((t) => ({
        ...t,
        items: t.items.map((i) => ({ ...i, completedAt: 1 })),
      })),
    });
    store.conversations.push(there, here, old);
    const listeners = new Set<(event: AppEvent) => void>();
    const pushes: AppEvent[] = [];
    const scripts: string[] = [];
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const stop = watchRemoteGeneratedFiles(
      {
        engines: () => [],
        ssh: () => sshService(hereConnection(scripts)),
        store,
        push: (event) => {
          pushes.push(event);
          complete();
        },
        onEvent: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      () => 100_000,
    );
    const emit = (c: Conversation) => {
      for (const cb of listeners)
        cb({ type: "conversation", conversation: structuredClone(c) });
    };
    emit(there);
    emit(there);
    emit(here);
    emit(old);
    // Wait for the actual persisted snapshot event, not a machine-speed guess.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Snapshot event did not arrive")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(scripts.length, 1, "read once, only the fresh SSH change");
    const files = store.conversations[0].turns[0].items[0].generatedFiles!;
    assert.equal(files[0].state, "ready");
    assert.equal(files[0].content, "# Notes\n");
    assert.equal(pushes.length, 1);
    assert.equal(
      (pushes[0] as any).conversation.turns[0].items[0].generatedFiles[0]
        .content,
      "# Notes\n",
    );
    assert.equal(
      store.conversations[1].turns[0].items[0].generatedFiles,
      undefined,
    );
    assert.equal(
      store.conversations[2].turns[0].items[0].generatedFiles,
      undefined,
    );
    stop();
    assert.equal(listeners.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hostFolder, { recursive: true, force: true });
  }
});
