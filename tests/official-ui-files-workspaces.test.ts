import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Conversation, EnvironmentRef } from "../shared/types";
import type { AppContext } from "../electron/app/app-context";
import type { NativeHost } from "../electron/official-ui/native/host";
import { registerResources } from "../electron/official-ui/native/resources";
import { registerCodeFiles } from "../electron/official-ui/native/files";
import { registerOfficialFileHandlers } from "../electron/ipc/official-files";
import { registerOfficialGitHandlers } from "../electron/ipc/official-git";

function project(cwd: string) {
  fs.mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(cwd, "README.md"), "BASE\n");
  git("add", "README.md");
  git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "initial");
  return git;
}

function fixture(
  conversations: Pick<Conversation, "id" | "mode" | "cwd" | "worktree" | "environment" | "additionalFolders" | "sessionAuthors">[],
  authorize: (cwd: string, environment?: EnvironmentRef) => void,
  services: object = {},
) {
  type Handler = (...args: any[]) => any;
  const ipc = new Map<string, Handler>();
  const native = new Map<string, Handler>();
  const events: unknown[][] = [];
  const published = new EventEmitter();
  const store = {
    conversation(id: string) {
      const row = conversations.find(row => row.id === id);
      if (!row) throw Error("Unknown session");
      return row;
    },
  };
  const context = {
    store, services,
    activeAccount: { id: "account" },
    allowedFolder: authorize,
    engines: { all: () => [] },
  } as unknown as AppContext;
  const handle = (name: string, fn: Handler) => { ipc.set(name, fn); };
  registerOfficialFileHandlers(handle, context);
  registerOfficialGitHandlers(handle, context);
  const localCall = async (name: string, ...args: unknown[]) => ipc.get(name)!(...args);
  const host = {
    ctx: { localCall, account: () => context.activeAccount, localLoadConversation: async (id: string) => store.conversation(id) },
    on(name: string, fn: Handler) { native.set(name, fn); },
    emit(domain: string, event: string, ...args: unknown[]) {
      events.push([domain, event, ...args]);
      published.emit(`${domain}.${event}`, ...args);
    },
  } as unknown as NativeHost;
  return {
    events, published, localCall, focusSession: registerResources(host), close: registerCodeFiles(host),
    resource: async (method: string, ...args: unknown[]) => native.get(`Resources.${method}`)!(...args),
    session: async (method: string, ...args: unknown[]) => native.get(`LocalSessions.${method}`)!(...args),
  };
}

test("Files reads session roots and refreshes Changes for permitted local worktree edits", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claudex-files-roots-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const git = project(origin);
  const worktree = path.join(root, "worktree");
  git("worktree", "add", "-qb", "feature", worktree);
  const cwd = path.join(worktree, "nested");
  fs.mkdirSync(cwd);
  const additional = path.join(root, "additional");
  fs.mkdirSync(additional);
  const extraFile = path.join(additional, "notes.txt");
  fs.writeFileSync(extraFile, "ADDITIONAL ROOT\n");
  fs.mkdirSync(path.join(worktree, ".claude"));
  fs.writeFileSync(path.join(worktree, ".claude", "settings.json"), "{}");
  const packageFile = path.join(worktree, "package.json");
  fs.writeFileSync(packageFile, '{"name":"fixture","husky":{"hooks":{}}}');
  const app = fixture([
    { id: "worktree", mode: "code", cwd, additionalFolders: [additional],
      worktree: { path: worktree, origin, repository: origin, name: "worktree", branch: "feature" } },
    { id: "foreign", mode: "code", cwd, sessionAuthors: { ownerAccountUuid: "foreign", viewerAccountUuid: "account" } },
  ], (folder) => { assert.ok(folder === cwd || folder === worktree); });
  t.after(app.close);
  const call = (method: string, ...args: unknown[]) => app.session(method, "local_worktree", ...args);

  assert.equal((await call("listSessionDirectory", additional))[0].path, extraFile);
  assert.equal((await call("readSessionFile", extraFile)).contents, "ADDITIONAL ROOT\n");
  assert.equal((await call("readSessionFile", extraFile)).hash, undefined);
  assert.equal((await call("readSessionFile", path.join(origin, "README.md"))).hash, undefined);
  assert.equal((await call("writeSessionFile", extraFile, "BAD")).status, "denied");
  assert.deepEqual(await call("readSessionFileWithStatus", path.join(additional, "missing.txt")),
    { status: "notFound", creatable: false });
  assert.equal((await call("createSessionFile", path.join(additional, "new.txt"))).status, "denied");
  await assert.rejects(app.session("readSessionFile", "local_foreign", extraFile), /unavailable/);

  const readme = path.join(worktree, "README.md");
  assert.equal((await call("readSessionFile", "README.md")).absPath, readme);
  assert.equal((await call("readSessionFile", readme, { includeHash: false, tailBytes: 2 })).contents, "E\n");
  assert.equal((await call("readSessionFile", readme, { includeHash: false })).hash, undefined);
  const log = path.join(worktree, "large.log");
  const cap = 10 * 1024 * 1024;
  const suffix = Buffer.from("中\n");
  const fd = fs.openSync(log, "w");
  try {
    fs.writeSync(fd, suffix, 0, suffix.length, cap);
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(await call("readSessionFileWithStatus", log), { status: "tooLarge", maxBytes: cap });
  assert.deepEqual(await call("readSessionFile", log, { tailBytes: 2 }), {
    absPath: log, contents: "\n", fileSize: cap + suffix.length, inSessionFolders: true, isTail: true,
  });
  const file = await call("readSessionFile", readme);
  assert.equal((await call("writeSessionFile", readme, "EDITED\n", file.hash)).status, "ok");
  const changes = await app.localCall("officialGitRead", { kind: "diff", cwd: worktree, base: "HEAD" });
  assert.match(JSON.stringify(changes), /\+EDITED/);
  assert.ok(app.events.some(event => JSON.stringify(event).includes("git_state_changed")));

  const settings = path.join(worktree, ".claude", "settings.json");
  assert.equal((await call("writeSessionFile", settings, "malformed")).status, "denied");
  assert.equal(fs.readFileSync(settings, "utf8"), "{}");
  const manifest = await call("readSessionFile", packageFile);
  assert.deepEqual(await call("writeSessionFile", packageFile, '{"name":"fixture","husky":{}}', manifest.hash),
    { status: "denied", deniedReason: "hook_manager_package_key" });
  assert.equal((await call("writeSessionFile", packageFile, '{"name":"renamed","husky":{"hooks":{}}}', manifest.hash)).status, "ok");
  assert.equal(JSON.parse(fs.readFileSync(packageFile, "utf8")).name, "renamed");

  const watch = { sessionId: "local_worktree", watchId: "expanded-root", dirPaths: [additional] };
  await app.session("watchSessionDirectories", watch);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(deadline));
  const changed = once(app.published, "LocalSessions.sessionDirectoryChanged", { signal: controller.signal });
  fs.writeFileSync(path.join(additional, "new.md"), "NEW\n");
  assert.deepEqual(await changed, [watch.sessionId, additional]);
  await app.session("watchSessionDirectories", { ...watch, dirPaths: [] });
});

test("SSH file resources and Changes use the selected host even when its path exists locally", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claudex-files-hosts-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "shared-path");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "LOCAL_PRIVATE\n");
  const hosts = ["alpha", "beta"].map(id => ({ id, label: id, destination: id, port: 22 }));
  const hostFolders = new Map(hosts.map(host => {
    const folder = path.join(root, host.id);
    project(folder);
    fs.writeFileSync(path.join(folder, "README.md"), `${host.id} REMOTE EDIT\n`);
    fs.writeFileSync(path.join(folder, `${host.id}.txt`), "REMOTE\n");
    return [host.id, folder];
  }));
  fs.symlinkSync(root, path.join(hostFolders.get("alpha")!, "escape"));
  fs.symlinkSync("README.md", path.join(hostFolders.get("alpha")!, "alias.md"));
  fs.symlinkSync(path.join(cwd, "README.md"), path.join(hostFolders.get("alpha")!, "outside.md"));
  let connected = true;
  const service = {
    allowed: () => true,
    hosts: { get: (id: string) => hosts.find(host => host.id === id), list: () => hosts },
    existing(id: string) {
      const directory = hostFolders.get(id);
      if (!connected || !directory) return;
      return {
        status: { state: "ready" },
        async exec(script: string) {
          const result = spawnSync("/bin/sh", ["-c", script.replaceAll(cwd, directory)], {
            encoding: "utf8", env: { ...process.env, HOME: root },
          });
          return { code: result.status, stdout: result.stdout, stderr: result.stderr };
        },
      };
    },
  };
  const alpha = { kind: "ssh", hostId: "alpha" } as const;
  const beta = { kind: "ssh", hostId: "beta" } as const;
  const app = fixture([
    { id: "alpha", mode: "code", cwd, environment: alpha },
    { id: "beta", mode: "code", cwd, environment: beta },
  ], (folder, environment) => {
    if (folder !== cwd || environment?.kind !== "ssh" || !hostFolders.has(environment.hostId))
      throw Error("Choose the remote folder on this host.");
  }, { ssh: service });
  t.after(app.close);

  await app.resource("setFocusedSshTarget", cwd, "alpha");
  const first = await app.resource("getProjectFileListIfChanged");
  assert.equal(first.paths, "README.md\nalpha.txt");
  assert.deepEqual(await app.resource("getProjectFileListIfChanged", first.version), { version: first.version, paths: null });
  const [suggestion] = await app.resource("fetchMentionOptions", "alpha", "files");
  assert.equal(suggestion.id, `file-${path.posix.join(cwd, "alpha.txt")}`);
  assert.deepEqual(await app.resource("handleMentionSelect", suggestion.id), { chipText: "alpha.txt" });
  assert.deepEqual(await app.resource("searchFileContentsWithOptions", { query: "REMOTE" }),
    { matches: [], patternRefused: false });

  app.focusSession("local_beta");
  const next = await app.resource("getProjectFileListIfChanged", first.version);
  assert.notEqual(next.version, first.version);
  assert.equal(next.paths, "README.md\nbeta.txt");
  await assert.rejects(app.resource("handleMentionSelect", suggestion.id), /expired/);
  assert.equal((await app.session("readSessionFile", "local_beta", path.join(cwd, "README.md"))).contents, "beta REMOTE EDIT\n");
  const readme = await app.session("readSessionFile", "local_alpha", "README.md");
  assert.equal(readme.contents, "alpha REMOTE EDIT\n");
  assert.equal(readme.hash, undefined);
  assert.equal((await app.session("readSessionFile", "local_alpha", "alias.md")).contents, "alpha REMOTE EDIT\n");
  assert.equal((await app.session("readSessionFile", "local_alpha", "~/shared-path/README.md")).contents, "alpha REMOTE EDIT\n");
  assert.equal((await app.session("readSessionFileWithStatus", "local_alpha", "outside.md")).status, "outsideSessionFolders");
  assert.equal((await app.session("writeSessionFile", "local_alpha", "README.md", "BAD")).status, "denied");
  assert.equal((await app.session("readSessionFileWithStatus", "local_alpha", "escape/shared-path/README.md")).status, "outsideSessionFolders");
  assert.match(JSON.stringify(await app.localCall("officialGitRead", { kind: "diff", cwd, base: "HEAD" },
    { sshConfig: { sshHost: "beta", sshPort: 22 } })), /\+beta REMOTE EDIT/);
  assert.equal(fs.readFileSync(path.join(cwd, "README.md"), "utf8"), "LOCAL_PRIVATE\n");

  app.focusSession(null);
  await app.resource("setFocusedSshTarget", cwd, "ungranted");
  await assert.rejects(app.resource("getProjectFileList"), /Choose the remote folder/);
  connected = false;
  await assert.rejects(app.session("readSessionFile", "local_alpha", "README.md"), /Connect to alpha/);
});
