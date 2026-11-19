import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { Store } from "../../electron/store/store";
import { useElectronShim } from "../runner/runner-core-support.test";

useElectronShim();
const fixture = {
  result: { canceled: false, filePaths: [] as string[] },
  duringPicker: () => {},
  selectedFolders: new Set<string>(),
  remoteFolders: new Map(),
  mainState: { store: undefined as unknown as Store },
};
(globalThis as any).__folderGrantFixture = fixture;
registerHooks({ resolve(specifier, context, next) {
  let source: string | undefined;
  if (context.parentURL?.endsWith("/electron/ipc/workspace.ts") && specifier === "electron")
    source = `export const app={},shell={}; export const dialog={showOpenDialog:async()=>{const f=globalThis.__folderGrantFixture;f.duringPicker();return f.result}};`;
  if (context.parentURL?.endsWith("/electron/app/main-folders.ts")) {
    if (specifier === "./main-state") source = `export const mainState=globalThis.__folderGrantFixture.mainState;`;
    if (specifier === "../main") source = `export const {selectedFolders,remoteFolders}=globalThis.__folderGrantFixture; export const sshHost=e=>e?.kind==='ssh'?e.hostId:undefined;`;
  }
  return source ? { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) } : next(specifier, context);
} });
const { registerWorkspaceHandlers } = await import("../../electron/ipc/workspace");
const { allowedFolder } = await import("../../electron/app/main-folders");
const { registerOfficialFileHandlers } = await import("../../electron/ipc/official-files");

test("picker grants survive a cold restart for their account and authorize landing list, search and full text", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-folder-grants-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, "workspace");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "note.txt"), "RESTORED_LANDING_FILE\n");
  const profile = path.join(root, "account-a");
  fixture.mainState.store = new Store(profile);
  fixture.result = { canceled: false, filePaths: [folder] };
  const handlers = new Map<string, (...args: any[]) => any>();
  const context = {
    get store() { return fixture.mainState.store; },
    selectedFolders: fixture.selectedFolders,
    selectedAttachments: new Map(), allowedFolder, policy: () => ({}),
  };
  registerWorkspaceHandlers((name, fn) => handlers.set(name, fn), context as never);
  registerOfficialFileHandlers((name, fn) => handlers.set(name, fn), context as never);
  await handlers.get("chooseFolder")!();
  fixture.selectedFolders.clear();
  fixture.mainState.store = new Store(profile);
  assert.equal(fixture.mainState.store.conversations.length, 0);
  assert.equal(fixture.mainState.store.projects.length, 0);
  assert.equal((await handlers.get("listProjectFolder")!({ cwd: folder }, "")).entries[0].path, "note.txt");
  assert.equal((await handlers.get("searchProjectFiles")!({ cwd: folder }, "RESTORED")).matches.length, 1);
  assert.equal(handlers.get("officialSessionFile")!({ operation: "read", cwd: folder, path: "note.txt" }).file.contents, "RESTORED_LANDING_FILE\n");
  assert.throws(() => allowedFolder(folder, { kind: "ssh", hostId: "remote" }), /folder picker/);
  assert.throws(() => allowedFolder(folder, { kind: "space", spaceId: "remote" }), /folder picker/);
  fixture.mainState.store = new Store(path.join(root, "account-b"));
  assert.throws(() => allowedFolder(folder), /folder picker/);
  await assert.rejects(handlers.get("searchProjectFiles")!({ cwd: folder }, "RESTORED"), /folder picker/);
  fixture.result = { canceled: true, filePaths: [folder] };
  assert.equal(await handlers.get("chooseFolder")!(), null);
  assert.deepEqual(fixture.mainState.store.localFolderGrants, []);
  fixture.result = { canceled: false, filePaths: [folder] };
  const accountB = fixture.mainState.store;
  fixture.duringPicker = () => { fixture.mainState.store = new Store(profile); };
  await assert.rejects(handlers.get("chooseFolders")!(), /account changed/);
  assert.deepEqual(accountB.localFolderGrants, []);
  fixture.duringPicker = () => {};
});
