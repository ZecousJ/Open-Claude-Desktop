/**
 * Workspace trust beyond the main composer (batch 11): SSH hosts keep
 * their trust on this computer and get it back at every start, a granted
 * Cowork folder is trusted for Code too, and queued sends, split panes,
 * edits and retries ask "Trust this workspace?" before going again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPolicy } from "../../shared/client-policy";
import {
  workspaceTrustMessage,
  type WorkspaceTrust,
} from "../../shared/workspace-trust-api";
import {
  SshWorkspaceTrustStore,
  parseRemoteTrust,
  sshWorkspaceTrustFile,
} from "../../electron/workspace/workspace-trust";
import { workspaceTrustScript } from "../../electron/ssh/remote-scripts";
import { workspaceTrustGate } from "../../electron/ipc/workspace-trust";
import { Engine } from "../../electron/engine/engine";
import { type EngineLauncher } from "../../electron/engine/engine-types";
import { Store } from "../../electron/store/store";
import { Outbox } from "../../electron/ssh/outbox";
import {
  askWorkspaceTrust,
  currentTrustQuestion,
  mountTrustHost,
  trustDeclined,
  trustTarget,
  withWorkspaceTrust,
} from "../../src/workspace-trust/trust-request";

const temp = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cx-trust-")));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("an SSH host's trusted roots are kept on this computer, per host", () => {
  const root = temp();
  try {
    const file = sshWorkspaceTrustFile(root);
    const store = new SshWorkspaceTrustStore(file);
    assert.deepEqual(store.roots("h1"), []);
    store.trust("h1", "/srv/b");
    store.trust("h1", "/srv/a");
    store.trust("h1", "/srv/a");
    store.trust("h2", "/home/x");
    assert.deepEqual(store.roots("h1"), ["/srv/a", "/srv/b"]);
    assert.deepEqual(store.projects("h2"), {
      "/home/x": { trust_level: "trusted" },
    });
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    store.forget("h1");
    assert.deepEqual(store.roots("h1"), []);
    assert.deepEqual(store.roots("h2"), ["/home/x"]);
    fs.writeFileSync(file, "{broken");
    assert.deepEqual(store.roots("h2"), []);
    fs.writeFileSync(
      file,
      JSON.stringify({ hosts: { h3: ["relative", 5, "/ok"] } }),
    );
    assert.deepEqual(store.roots("h3"), ["/ok"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the host's script finds Codex's project root and the files trusting allows", () => {
  const root = temp();
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "pkg", "sub", ".codex"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".codex", "config.toml"), "");
    fs.writeFileSync(path.join(repo, "pkg", "sub", ".codex", "hooks.json"), "");
    // A worktree: its `.git` file points into the main checkout.
    const gitDir = path.join(repo, ".git", "worktrees", "wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    const worktree = path.join(root, "wt");
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const run = (folder: string) => {
      const result = spawnSync(
        "/bin/sh",
        ["-c", workspaceTrustScript(folder)],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: root },
        },
      );
      return { code: result.status, found: parseRemoteTrust(result.stdout) };
    };
    assert.deepEqual(run(path.join(repo, "pkg", "sub")).found, {
      folder: path.join(repo, "pkg", "sub"),
      root: repo,
      sources: [
        path.join(repo, "pkg", "sub", ".codex", "hooks.json"),
        path.join(repo, ".codex", "config.toml"),
      ],
    });
    assert.equal(run(worktree).found?.root, repo);
    assert.deepEqual(run(plain).found, {
      folder: plain,
      root: plain,
      sources: [],
    });
    // "~/…" is the host's home.
    assert.equal(run("~/plain").found?.folder, plain);
    assert.equal(run(path.join(root, "missing")).code, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sshEngine() {
  const root = temp();
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
  const asked: string[] = [];
  const launcher: EngineLauncher = {
    environment: { kind: "ssh", hostId: "h1" },
    label: "box",
    platform: "linux",
    waiting: () => false,
    defaultCwd: async () => "/home/me",
    workspaceTrust: async (folder) => {
      asked.push(folder);
      return {
        folder,
        root: folder.startsWith("/srv/repo") ? "/srv/repo" : folder,
        sources: ["/srv/repo/.codex/config.toml"],
      };
    },
    launch: async () => {
      throw new Error("not used");
    },
    started() {},
    exited() {},
    failed() {},
    dispose: async () => {},
  };
  const remote = local.createPeer({
    environment: { kind: "ssh", hostId: "h1" },
    launcher,
    outbox: new Outbox(root),
  });
  const calls: { method: string; params: any }[] = [];
  const rpc = {
    connected: true,
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
  };
  remote.ensure = async () => {
    remote.rpc = rpc as any;
    remote.state = { state: "ready" } as any;
  };
  return {
    store,
    remote,
    asked,
    calls,
    input: (patch: Record<string, unknown> = {}) => ({
      text: "hello",
      mode: "code" as const,
      cwd: "/srv/repo/app",
      attachments: [],
      providerId: "p",
      model: "m",
      environment: { kind: "ssh" as const, hostId: "h1" },
      ...patch,
    }),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Code on an SSH host is refused before it shows in a workspace not trusted there", async () => {
  const env = sshEngine();
  try {
    await assert.rejects(
      env.remote.send(env.input()),
      (error: Error) => error.message === workspaceTrustMessage,
    );
    // Nothing started: the window asks, then sends the same message again.
    assert.equal(env.store.conversations.length, 0);
    assert.equal(env.calls.length, 0);
    const trust = await env.remote.remoteWorkspaceTrust("/srv/repo/app");
    assert.deepEqual(trust, {
      folder: "/srv/repo/app",
      root: "/srv/repo",
      trusted: false,
      sources: ["/srv/repo/.codex/config.toml"],
      host: "box",
    });
    // Without a folder, the host's default one.
    assert.equal((await env.remote.remoteWorkspaceTrust()).folder, "/home/me");
    const saved = await env.remote.trustRemoteWorkspace("/srv/repo/app");
    assert.equal(saved.trusted, true);
    assert.deepEqual(
      new SshWorkspaceTrustStore(sshWorkspaceTrustFile(env.store.root)).roots(
        "h1",
      ),
      ["/srv/repo"],
    );
    const c = await env.remote.send(env.input());
    assert.equal(c.cwd, "/srv/repo/app");
    assert.ok(env.calls.some((call) => call.method === "turn/start"));
    // Another folder of the same repository is trusted with it; a folder
    // once found trusted isn't asked about again.
    const before = env.asked.length;
    await env.remote.send(env.input({ text: "again" }));
    assert.equal(env.asked.length, before);
    assert.equal(
      (await env.remote.remoteWorkspaceTrust("/srv/repo/other")).trusted,
      true,
    );
    // A folder outside it is not.
    assert.equal(
      (await env.remote.remoteWorkspaceTrust("/elsewhere")).trusted,
      false,
    );
  } finally {
    env.close();
  }
});

test("a running host's Codex gets the new trust at once", async () => {
  const env = sshEngine();
  try {
    await env.remote.ensure(env.store.settings.providers[0]);
    await env.remote.trustRemoteWorkspace("/srv/repo/app");
    assert.deepEqual(env.calls.at(-1), {
      method: "config/batchWrite",
      params: {
        edits: [
          {
            keyPath: "projects",
            value: { "/srv/repo": { trust_level: "trusted" } },
            mergeStrategy: "upsert",
          },
        ],
        reloadUserConfig: true,
      },
    });
  } finally {
    env.close();
  }
});

test("a Cowork folder the person allowed is trusted for Code too", async () => {
  const trusted = new Set(["/trusted"]);
  const saved: string[] = [];
  let changes = 0;
  const gate = workspaceTrustGate(
    {
      check: (folder: string) => ({
        folder,
        root: folder,
        trusted: trusted.has(folder),
        sources: [],
      }),
      trust: async (folder: string) => {
        if (folder === "/broken") throw new Error("disk full");
        saved.push(folder);
        trusted.add(folder);
        return folder;
      },
    },
    () => "/app/workspace",
    () => changes++,
  );
  await gate.trust("/project");
  await gate.trust("/trusted");
  await gate.trust("/app/workspace");
  const errors = console.error;
  console.error = () => {};
  try {
    // A failure never fails the grant it follows.
    await gate.trust("/broken");
  } finally {
    console.error = errors;
  }
  assert.deepEqual(saved, ["/project"]);
  assert.equal(changes, 1);
});

const untrusted: WorkspaceTrust = {
  folder: "/f",
  root: "/f",
  trusted: false,
  sources: [],
};

test("only the oldest mounted host shows the question (split panes)", async () => {
  const first = mountTrustHost();
  const second = mountTrustHost();
  try {
    const asked = askWorkspaceTrust(untrusted);
    assert.equal(currentTrustQuestion()?.trust.folder, "/f");
    // The primary pane closing hands the question to the next host.
    first();
    assert.equal(currentTrustQuestion()?.trust.folder, "/f");
    // The same root on another SSH host is another workspace.
    assert.equal(
      await askWorkspaceTrust({ ...untrusted, host: "box" }),
      "declined",
    );
    second();
    assert.equal(await asked, "declined");
  } finally {
    first();
    second();
  }
});

test("a queued send, an edit or a retry refused for trust asks, then runs again", async () => {
  const unmount = mountTrustHost();
  try {
    const checked: unknown[][] = [];
    const saved: unknown[][] = [];
    const api = {
      checkWorkspaceTrust: async (...args: unknown[]) => {
        checked.push(args);
        return { ...untrusted, folder: "/srv/x", root: "/srv", host: "box" };
      },
      saveWorkspaceTrust: async (...args: unknown[]) => {
        saved.push(args);
        return { ...untrusted, trusted: true };
      },
    };
    let runs = 0;
    const run = async () => {
      runs += 1;
      if (runs === 1)
        throw new Error(`Error invoking: ${workspaceTrustMessage}`);
      return "sent";
    };
    const target = {
      cwd: undefined,
      environment: { kind: "ssh" as const, hostId: "h1" },
    };
    const result = withWorkspaceTrust(run, target, { api, notify: () => {} });
    await tick();
    assert.equal(currentTrustQuestion()?.trust.host, "box");
    currentTrustQuestion()!.answer(true);
    assert.equal(await result, "sent");
    assert.equal(runs, 2);
    // The host's default folder is asked about, and its real path saved.
    assert.deepEqual(checked, [["", { kind: "ssh", hostId: "h1" }]]);
    assert.deepEqual(saved, [["/srv/x", { kind: "ssh", hostId: "h1" }]]);
    // Cancel: nothing runs again.
    runs = 0;
    const declined = withWorkspaceTrust(
      run,
      { cwd: "/local" },
      { api, notify: () => {} },
    );
    await tick();
    currentTrustQuestion()!.answer(false);
    assert.equal(await declined, trustDeclined);
    assert.equal(runs, 1);
    // Other failures, and places without a trust check, go to the caller.
    await assert.rejects(
      withWorkspaceTrust(
        async () => {
          throw new Error("other");
        },
        { cwd: "/local" },
        { api, notify: () => {} },
      ),
      /other/,
    );
    await assert.rejects(
      withWorkspaceTrust(
        async () => {
          throw new Error(workspaceTrustMessage);
        },
        { cwd: "/local" },
        { notify: () => {} },
      ),
    );
  } finally {
    unmount();
  }
});

test("a conversation's workspace: its folder here, or its SSH host's", () => {
  assert.deepEqual(trustTarget({ cwd: "/a" }), { folder: "/a" });
  assert.deepEqual(trustTarget({ cwd: "/a", environment: { kind: "local" } }), {
    folder: "/a",
  });
  assert.equal(trustTarget({}), undefined);
  assert.deepEqual(trustTarget({ environment: { kind: "ssh", hostId: "h" } }), {
    folder: "",
    place: { kind: "ssh", hostId: "h" },
  });
  assert.equal(
    trustTarget({ cwd: "/a", environment: { kind: "space", spaceId: "s" } }),
    undefined,
  );
});
