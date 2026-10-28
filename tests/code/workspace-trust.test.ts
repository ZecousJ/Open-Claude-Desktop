/**
 * Code's workspace trust, recorded in Codex's own config
 * (shared/workspace-trust-api.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceTrustStore,
  codexProjectRoot,
  readCodexProjects,
  trustSources,
  untrustedRootsFromLayers,
  writeCodexProjectsFile,
} from "../../electron/workspace/workspace-trust";
import { workspaceTrustGate } from "../../electron/ipc/workspace-trust";
import {
  isWorkspaceTrustError,
  workspaceTrustMessage,
  type WorkspaceTrust,
} from "../../shared/workspace-trust-api";
import {
  askWorkspaceTrust,
  currentTrustQuestion,
  ensureWorkspaceTrusted,
  mountTrustHost,
  trustCheckFailed,
} from "../../src/workspace-trust/trust-request";
import { watchTrustedWorkspaces } from "../../src/settings/tabs/TrustedWorkspaces";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";

function tempRoot() {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-trust-")),
  );
}

test("Codex's project root: the repository, a worktree's main checkout, or the folder", () => {
  const root = tempRoot();
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    assert.equal(codexProjectRoot(path.join(repo, "src", "deep")), repo);
    const worktree = path.join(root, "wt");
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "wt")}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".git", "worktrees", "wt", "commondir"),
      "../..\n",
    );
    assert.equal(codexProjectRoot(worktree), repo);
    const plain = path.join(root, "plain", "inner");
    fs.mkdirSync(plain, { recursive: true });
    assert.equal(codexProjectRoot(plain), plain);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the sources are the folder's own .codex files up to its root", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, ".codex", "rules"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "");
    const sub = path.join(root, "pkg");
    fs.mkdirSync(path.join(sub, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(sub, ".codex", "hooks.json"), "{}");
    assert.deepEqual(trustSources(sub, root), [
      path.join(sub, ".codex", "hooks.json"),
      path.join(root, ".codex", "config.toml"),
      path.join(root, ".codex", "rules"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trust is written to Codex's config file, keeping the rest of it", async () => {
  const root = tempRoot();
  try {
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "config.toml"),
      'model = "m"\n[projects."/elsewhere"]\ntrust_level = "untrusted"\n',
    );
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    const written: unknown[] = [];
    let running = false;
    const store = new WorkspaceTrustStore(() => ({
      codexHome: home,
      async writeCodexProjects(projects) {
        written.push(projects);
        if (running)
          writeCodexProjectsFile(
            path.join(home, "config.toml"),
            projects as any,
          );
        return running;
      },
    }));
    const before = store.check(path.join(repo, "src"));
    assert.equal(before.trusted, false);
    assert.equal(before.root, repo);
    assert.equal(await store.trust(path.join(repo, "src")), repo);
    assert.deepEqual(store.list(), [repo]);
    assert.equal(store.check(path.join(repo, "src")).trusted, true);
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.match(text, /model = "m"/);
    assert.equal(
      readCodexProjects(path.join(home, "config.toml"))["/elsewhere"]
        .trust_level,
      "untrusted",
    );
    // While Codex runs, it writes the file itself (and reloads it).
    running = true;
    await store.remove(repo);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(written.at(-1), {
      "/elsewhere": { trust_level: "untrusted" },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only a Code turn on this computer in a folder Codex doesn't trust is refused", () => {
  const trusted = new Set(["/trusted"]);
  const gate = workspaceTrustGate(
    {
      check: (folder: string) => ({
        folder,
        root: folder,
        trusted: trusted.has(folder),
        sources: [],
      }),
      trust: async (folder: string) => folder,
    },
    () => "/app/workspace",
  );
  assert.throws(
    () => gate.assert({ mode: "code", cwd: "/untrusted" }),
    (error: Error) => isWorkspaceTrustError(error),
  );
  gate.assert({ mode: "code", cwd: "/trusted" });
  gate.assert({ mode: "cowork", cwd: "/untrusted" });
  gate.assert({ mode: "chat", cwd: "/untrusted" });
  gate.assert({ mode: "code" });
  gate.assert({ mode: "code", cwd: "/app/workspace" });
  gate.assert({
    mode: "",
    conversation: {
      mode: "code",
      cwd: "/untrusted",
      environment: { kind: "ssh", hostId: "h" },
    },
  });
  assert.throws(() =>
    gate.assert({
      mode: "",
      conversation: { mode: "code", cwd: "/untrusted" },
    }),
  );
});

test("the roots Codex asks to trust are read from its config layers", () => {
  assert.deepEqual(
    untrustedRootsFromLayers([
      { name: { type: "sessionFlags" } },
      {
        name: { type: "project", dotCodexFolder: "/w/repo/.codex" },
        disabledReason:
          "To load project-local config, hooks, and exec policies, add /w/repo as a trusted project in /codex-home/config.toml.",
      },
      { name: { type: "project", dotCodexFolder: "/w/ok/.codex" } },
    ]),
    ["/w/repo"],
  );
  assert.deepEqual(untrustedRootsFromLayers(undefined), []);
});

function engineWith(answer: (method: string, params: any) => any) {
  const root = tempRoot();
  const store = new Store(root);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const calls: { method: string; params: any }[] = [];
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return answer(method, params);
    },
  } as any;
  return {
    engine,
    calls,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("the running engine records trust through Codex's config/batchWrite", async () => {
  const { engine, calls, close } = engineWith(() => ({ status: "ok" }));
  try {
    assert.equal(await engine.writeCodexProjects({}), false);
    engine.state = { state: "ready" } as any;
    assert.equal(
      await engine.writeCodexProjects({ "/r": { trust_level: "trusted" } }),
      true,
    );
    assert.deepEqual(calls.at(-1), {
      method: "config/batchWrite",
      params: {
        edits: [
          {
            keyPath: "projects",
            value: { "/r": { trust_level: "trusted" } },
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      },
    });
  } finally {
    close();
  }
});

test("a runner engine trusts a session's folder before Codex starts its thread", async () => {
  const { engine, calls, close } = engineWith((method) =>
    method === "config/read"
      ? {
          layers: [
            {
              name: { type: "project", dotCodexFolder: "/w/repo/.codex" },
              disabledReason:
                "To load project-local config, hooks, and exec policies, add /w/repo as a trusted project in /h/config.toml.",
            },
          ],
        }
      : method === "thread/start"
        ? { thread: { id: "t" } }
        : {},
  );
  try {
    const conversation: any = { id: "c", turns: [] };
    await (engine as any).ensureThread(conversation, {
      cwd: "/w/repo/src",
      config: {},
    });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["thread/start"],
    );
    engine.trustEveryWorkspace = true;
    calls.length = 0;
    await (engine as any).ensureThread(
      { id: "d", turns: [] },
      { cwd: "/w/repo/src", config: {} },
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["config/read", "config/batchWrite", "thread/start"],
    );
    assert.deepEqual(calls[1].params.edits[0], {
      keyPath: "projects",
      value: { "/w/repo": { trust_level: "trusted" } },
      mergeStrategy: "upsert",
    });
  } finally {
    close();
  }
});

const untrusted: WorkspaceTrust = {
  folder: "/f",
  root: "/f",
  trusted: false,
  sources: [],
};

test("the window asks, records the answer, and only one question shows at a time", async () => {
  const saved: string[] = [];
  const notes: string[] = [];
  const api = {
    checkWorkspaceTrust: async (folder: string) => ({ ...untrusted, folder }),
    saveWorkspaceTrust: async (folder: string) => {
      saved.push(folder);
      return { ...untrusted, folder, trusted: true };
    },
  };
  const notify = (message: string) => notes.push(message);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // No host mounted: declined, nothing saved.
  assert.equal(await ensureWorkspaceTrusted("/f", { api, notify }), false);
  const unmount = mountTrustHost();
  try {
    // Cancel: nothing saved.
    const declined = ensureWorkspaceTrusted("/f", { api, notify });
    await tick();
    // Another folder while this one is asked is declined; the same one waits.
    assert.equal(
      await askWorkspaceTrust({ ...untrusted, folder: "/g", root: "/g" }),
      "declined",
    );
    const same = askWorkspaceTrust(untrusted);
    currentTrustQuestion()!.answer(false);
    assert.equal(await declined, false);
    assert.equal(await same, "declined");
    assert.deepEqual(saved, []);
    // Trust workspace: saved, and the send may go on.
    const accepted = ensureWorkspaceTrusted("/f", { api, notify });
    await tick();
    assert.equal(currentTrustQuestion()!.trust.folder, "/f");
    currentTrustQuestion()!.answer(true);
    assert.equal(await accepted, true);
    assert.deepEqual(saved, ["/f"]);
    assert.equal(currentTrustQuestion(), undefined);
    // Unmounting the last host declines what it showed.
    const left = ensureWorkspaceTrusted("/f", { api, notify });
    await tick();
    unmount();
    assert.equal(await left, false);
  } finally {
    unmount();
  }
  const failing = await ensureWorkspaceTrusted("/f", {
    api: {
      ...api,
      checkWorkspaceTrust: async () => {
        throw new Error("boom");
      },
    },
    notify,
  });
  assert.equal(failing, false);
  assert.deepEqual(notes, [trustCheckFailed]);
});

test("the refusal names Codex's rule", () => {
  assert.ok(
    isWorkspaceTrustError(
      new Error(`Error invoking: ${workspaceTrustMessage}`),
    ),
  );
  assert.ok(!isWorkspaceTrustError(new Error("other")));
});

test("Settings follows the trusted folders and stays hidden without them", async () => {
  let listener: ((event: any) => void) | undefined;
  let list = ["/a"];
  const seen: string[][] = [];
  const stop = watchTrustedWorkspaces(
    {
      trustedWorkspaces: async () => list,
      onEvent: (fn: any) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as any,
    (folders) => seen.push(folders),
    () => assert.fail("no error"),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  list = ["/a", "/b"];
  listener?.({ type: "workspace-trust" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  assert.deepEqual(seen, [["/a"], ["/a", "/b"]]);
  assert.equal(listener, undefined);
});
