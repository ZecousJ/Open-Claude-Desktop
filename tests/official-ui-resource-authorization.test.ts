import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerResources } from "../electron/official-ui/native/resources";
import type { EnvironmentRef } from "../shared/types";
import { useElectronShim } from "./runner/runner-core-support.test";

useElectronShim();
const { registerWorkspaceHandlers } = await import("../electron/ipc/workspace");

test("Code draft reads accept local workspace grants, never cloud or SSH records alone", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-resource-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "secret.txt"), "SEARCH_AUTH_TEST_MARKER\n");
  const selectedFolders = new Set<string>();
  const projects: { cwd: string; environment?: EnvironmentRef }[] = [];
  const conversations: { cwd: string; environment?: EnvironmentRef; cloudHosted?: boolean }[] = [];
  const ipc = new Map<string, (...args: any[]) => any>();
  const handlers = new Map<string, (...args: any[]) => any>();
  registerWorkspaceHandlers((name, handler) => { ipc.set(name, handler); }, {
    store: { projects, conversations, conversation: () => { throw Error("There is no Code session yet."); } },
    selectedFolders,
    selectedAttachments: new Map(),
    allowedFolder() { throw Error("A local draft must use the local workspace grants."); },
    policy: () => ({}),
  } as unknown as Parameters<typeof registerWorkspaceHandlers>[1]);
  const host = { ctx: { account: () => ({ id: "a" }),
      localListConversations: async () => [],
      localLoadConversation: async () => { throw Error("There is no Code session yet."); },
      localCall: (method: string, ...args: any[]) => ipc.get(method)!(...args),
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); return this; } };
  registerResources(host as never);
  await handlers.get("Resources.setFocusedCwd")!(root);
  const list = () => handlers.get("Resources.getProjectFileList")!();
  const search = () => handlers.get("Resources.searchFileContents")!("SEARCH_AUTH_TEST_MARKER");
  const denied = async () => {
    await assert.rejects(list(), /folder picker/);
    await assert.rejects(search(), /folder picker/);
  };
  const readable = async () => {
    assert.equal(await list(), "secret.txt");
    assert.deepEqual(await search(), [{
      relativePath: "secret.txt", absPath: path.join(root, "secret.txt"), line: 1, column: 1,
      preview: "SEARCH_AUTH_TEST_MARKER",
    }]);
  };
  await denied();
  conversations.push({ cwd: root, cloudHosted: true });
  await denied();
  conversations.push({ cwd: root, environment: { kind: "space", spaceId: "fixture" } });
  projects.push({ cwd: root, environment: { kind: "ssh", hostId: "fixture" } });
  await denied();
  projects.push({ cwd: root, environment: { kind: "space", spaceId: "fixture" } });
  await denied();
  projects.push({ cwd: root });
  await readable();
  projects.pop();
  conversations.push({ cwd: root, environment: { kind: "local" } });
  await readable();
  conversations.pop();
  selectedFolders.add(root);
  await readable();
  fs.symlinkSync(root, path.join(root, "loop"), "junction");
  assert.equal(await list(), "loop/\nsecret.txt");
});

test("content search stops when the account changes while authorization is pending", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let identity = {};
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const host = { ctx: { account: () => ({ id: "a" }), sessionIdentity: () => identity, call: async () => { throw Error("Unexpected remote call"); },
    localListConversations: async () => { await wait; return [{ id: "c", mode: "code", cwd: "/tmp" }]; },
    localLoadConversation: async () => { throw Error("Stale request reached conversation read"); },
    localCall: async () => { throw Error("Stale request reached file read"); } },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); return this; } };
  registerResources(host as never);
  await handlers.get("Resources.setFocusedCwd")!("/tmp");
  const searching = handlers.get("Resources.searchFileContents")!("secret");
  identity = {}; release();
  await assert.rejects(searching, /account changed/);
});

test("file mentions and cached project lists do not survive an account activation change", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let identity = {};
  const host = { ctx: { account: () => ({ id: "a" }), sessionIdentity: () => identity,
    call: async () => [{ path: "private.txt", kind: "file" }],
    localListConversations: async () => [{ id: "c", mode: "code", cwd: "/tmp/a" }],
    localLoadConversation: async () => ({ id: "c", mode: "code", cwd: "/tmp/a" }),
    localCall: async (method: string) => { assert.equal(method, "listProjectFolder"); return { entries: [{ path: "private.txt", kind: "file" }], truncated: false }; } },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); return this; } };
  registerResources(host as never);
  await handlers.get("Resources.setFocusedCwd")!("/tmp/a");
  const options = await handlers.get("Resources.fetchMentionOptions")!("");
  assert.equal(options.length, 1);
  const cached = await handlers.get("Resources.getProjectFileListIfChanged")!();
  assert.equal(cached.paths, "private.txt");
  identity = {};
  await assert.rejects(handlers.get("Resources.handleMentionSelect")!(options[0].id), /expired/);
  assert.equal(await handlers.get("Resources.getProjectFileListIfChanged")!(), null);
  assert.deepEqual(await handlers.get("Resources.fetchMentionOptions")!(""), []);
});

test("an in-flight file search cannot populate another folder's cache", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const host = { ctx: { account: () => ({ id: "a" }), sessionIdentity: () => 1,
    call: async () => { await wait; return [{ path: "old-private.txt", kind: "file" }]; } },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); return this; } };
  registerResources(host as never);
  await handlers.get("Resources.setFocusedCwd")!("/tmp/a");
  const searching = handlers.get("Resources.fetchMentionOptions")!("");
  await handlers.get("Resources.setFocusedCwd")!("/tmp/b");
  release();
  await assert.rejects(searching, /focused folder changed/);
  await assert.rejects(handlers.get("Resources.handleMentionSelect")!("file-/tmp/a/old-private.txt"), /expired/);
});
