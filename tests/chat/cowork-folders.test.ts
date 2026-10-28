/**
 * Cowork folder grants (R11-A): what Cowork may use without asking, how
 * "Allow" and "Always allow" are kept, and what can never be granted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import {
  CoworkFolderGrants,
  assertCoworkFolder,
  coworkFolderPermissionMessage,
  pendingGrantMs,
} from "../../electron/workspace/cowork-folders";
import {
  extraLimit,
  protectCoworkFolders,
} from "../../electron/workspace/cowork-folders-support";

function temporary(t: any) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cowork-folders-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "profile");
  const folder = (name: string) => {
    const value = path.join(base, name);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  fs.mkdirSync(root);
  return { base, root, folder };
}
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c-1",
    title: "Folder notes",
    mode: "cowork",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    ...overrides,
  };
}

test("an isolated space's own workspace never asks; the rest of the space is still the app's", (t) => {
  const { root } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const space = path.join(root, "spaces", "c-5f0c", "workspace");
  fs.mkdirSync(path.join(space, "out"), { recursive: true });
  fs.mkdirSync(path.join(root, "spaces", "c-5f0c", "codex-home"), {
    recursive: true,
  });
  assert.equal(grants.access(space).state, "default");
  assert.equal(grants.access(path.join(space, "out")).state, "default");
  assert.notEqual(
    grants.access(path.join(root, "spaces", "c-5f0c", "codex-home")).state,
    "default",
  );
});

test("the app's own workspace never asks; any other folder asks", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
  assert.equal(grants.access(workspace).state, "default");
  assert.equal(grants.access(path.join(workspace, "notes")).state, "default");
  const notes = folder("notes");
  const access = grants.access(notes);
  assert.equal(access.state, "ask");
  assert.equal(access.name, "notes");
  assert.equal(access.folder, notes);
  assert.equal(access.home, undefined);
});

test("Allow before the task exists is used once, by the next new task, within 15 minutes", (t) => {
  const { root, folder } = temporary(t);
  let now = 1_000;
  const grants = new CoworkFolderGrants(root, { now: () => now });
  const notes = folder("notes");
  fs.mkdirSync(path.join(notes, "drafts"));
  grants.allowOnce(notes);
  assert.equal(grants.access(notes).state, "granted");
  // The task that starts there keeps it (and the folders inside it)…
  const task = conversation({ cwd: notes });
  assert.equal(
    assertCoworkFolder(grants, { mode: "cowork", cwd: notes }),
    notes,
  );
  grants.bind(task, notes);
  assert.equal(grants.access(notes, task.id).state, "granted");
  assert.equal(
    grants.access(path.join(notes, "drafts"), task.id).state,
    "granted",
  );
  // …but the one-time grant is gone: another new task asks again.
  assert.equal(grants.access(notes).state, "ask");
  assert.equal(grants.access(notes, "other").state, "ask");
  // An unused one expires.
  grants.allowOnce(notes);
  now += pendingGrantMs + 1;
  assert.equal(grants.access(notes).state, "ask");
  assert.throws(
    () => assertCoworkFolder(grants, { mode: "cowork", cwd: notes }),
    new RegExp(coworkFolderPermissionMessage),
  );
  // Kept across restarts.
  assert.equal(
    new CoworkFolderGrants(root).access(notes, task.id).state,
    "granted",
  );
});

test("Always allow trusts the folder and every folder inside it, and survives a restart", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const projects = folder("projects");
  const inner = folder("projects/site");
  grants.trust(inner);
  assert.deepEqual(grants.trusted(), [inner]);
  assert.equal(grants.access(projects).state, "ask");
  // A parent replaces the trusted folders inside it.
  grants.trust(projects);
  assert.deepEqual(grants.trusted(), [projects]);
  grants.trust(inner);
  assert.deepEqual(grants.trusted(), [projects]);
  assert.equal(grants.access(inner).state, "trusted");
  const restarted = new CoworkFolderGrants(root);
  assert.equal(restarted.access(inner).state, "trusted");
  // A task in a trusted folder records nothing: removing trust closes it again.
  const task = conversation({ cwd: inner });
  restarted.bind(task, inner);
  restarted.untrust(projects);
  assert.deepEqual(restarted.trusted(), []);
  assert.equal(restarted.access(inner, task.id).state, "ask");
  const file = JSON.parse(
    fs.readFileSync(path.join(root, "cowork-folders.json"), "utf8"),
  );
  assert.deepEqual(file.trusted, []);
  assert.equal(
    fs.statSync(path.join(root, "cowork-folders.json")).mode & 0o777,
    0o600,
  );
});

test("a symbolic link is judged by where it points", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const allowed = folder("allowed");
  const secret = folder("secret");
  fs.symlinkSync(secret, path.join(allowed, "link"));
  grants.trust(allowed);
  const through = grants.access(path.join(allowed, "link"));
  assert.equal(through.state, "ask");
  assert.equal(through.folder, secret);
  // Trusting a link trusts its target, never the link's name.
  const link = path.join(folder("links"), "to-secret");
  fs.symlinkSync(secret, link);
  assert.equal(grants.trust(link), secret);
});

test("drive roots, system folders, the app's data and missing folders are refused", (t) => {
  const { base, root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root, { platform: "linux" });
  assert.equal(grants.access("/").state, "refused");
  assert.match(
    grants.access("/usr").reason!,
    /is a protected location on your device/,
  );
  assert.match(
    grants.access("/etc").reason!,
    /is a protected location on your device/,
  );
  assert.match(
    grants.access(path.join(base, "missing")).reason!,
    /no longer exists/,
  );
  const data = folder("userData");
  fs.mkdirSync(path.join(data, "profiles"));
  protectCoworkFolders(data);
  assert.match(
    grants.access(path.join(data, "profiles")).reason!,
    /contains Claudex’s app data/,
  );
  assert.throws(() => grants.trust(data), /contains Claudex’s app data/);
  assert.throws(
    () => grants.allowOnce("/usr"),
    /is a protected location on your device/,
  );
  assert.throws(
    () => assertCoworkFolder(grants, { mode: "cowork", cwd: "/usr" }),
    /is a protected location on your device/,
  );
  assert.deepEqual(grants.trusted(), []);
});

test("the home folder can be allowed, with a warning", (t) => {
  const { root, folder } = temporary(t);
  const home = folder("home");
  const grants = new CoworkFolderGrants(root, { home });
  const access = grants.access(home);
  assert.equal(access.state, "ask");
  assert.equal(access.home, true);
});

test("macOS and Windows compare folders without case; Linux keeps it", (t) => {
  const { root, folder } = temporary(t);
  const upper = folder("Reports");
  fs.writeFileSync(
    path.join(root, "cowork-folders.json"),
    JSON.stringify({
      version: 1,
      trusted: [path.join(path.dirname(upper), "reports")],
      sessions: {},
      routines: {},
    }),
  );
  assert.equal(
    new CoworkFolderGrants(root, { platform: "darwin" }).access(upper).state,
    "trusted",
  );
  assert.equal(
    new CoworkFolderGrants(root, { platform: "linux" }).access(upper).state,
    "ask",
  );
});

test("a task's added folders are kept, capped, and removed with the task", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const primary = folder("primary");
  const task = conversation({ cwd: primary });
  grants.grantConversation(task, primary);
  assert.deepEqual(grants.extraFolders(task.id), []);
  assert.equal(grants.access(primary, task.id).state, "granted");
  const added = folder("added");
  grants.grantConversation(task, added);
  grants.grantConversation(task, added);
  assert.deepEqual(grants.extraFolders(task.id), [added]);
  assert.equal(grants.access(added, task.id).state, "granted");
  for (let i = 1; i < extraLimit; i++)
    grants.grantConversation(task, folder(`extra-${i}`));
  assert.throws(
    () => grants.grantConversation(task, folder("one-too-many")),
    /up to 20/,
  );
  assert.equal(new CoworkFolderGrants(root).extraFolders(task.id).length, 20);
  grants.forgetConversation(task.id);
  assert.deepEqual(grants.extraFolders(task.id), []);
  assert.equal(
    new CoworkFolderGrants(root).access(primary, task.id).state,
    "ask",
  );
});

test("an incognito task's grants never reach disk", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const notes = folder("notes");
  const task = conversation({ id: "secret", cwd: notes, incognito: true });
  grants.allowOnce(notes);
  grants.bind(task, notes);
  assert.equal(grants.access(notes, task.id).state, "granted");
  const file = fs.readFileSync(path.join(root, "cowork-folders.json"), "utf8");
  assert.equal(file.includes("secret"), false);
  assert.equal(file.includes(notes), false);
  grants.forgetConversation(task.id);
  assert.equal(grants.access(notes, task.id).state, "ask");
});

test("the first run adopts the Cowork folders people already used, and only then", (t) => {
  const { root, folder } = temporary(t);
  const used = folder("used");
  const routineFolder = folder("routine");
  fs.writeFileSync(
    path.join(root, "conversations.json"),
    JSON.stringify([
      conversation({ id: "cowork-old", cwd: used }),
      conversation({ id: "chat-old", mode: "chat", cwd: folder("chat") }),
      conversation({ id: "code-old", mode: "code", cwd: folder("code") }),
      conversation({ id: "gone", cwd: path.join(root, "missing") }),
    ]),
  );
  fs.writeFileSync(
    path.join(root, "schedules.json"),
    JSON.stringify([
      { id: "r-cowork", mode: "cowork", cwd: routineFolder },
      { id: "r-code", mode: "code", cwd: folder("code") },
    ]),
  );
  const grants = new CoworkFolderGrants(root);
  grants.ensureLoaded();
  assert.equal(grants.access(used, "cowork-old").state, "granted");
  assert.equal(grants.access(folder("chat"), "chat-old").state, "ask");
  assert.equal(grants.access(folder("code"), "code-old").state, "ask");
  assert.equal(grants.routineAllowed("r-cowork", routineFolder), true);
  assert.equal(grants.routineAllowed("r-code", folder("code")), false);
  assert.deepEqual(grants.trusted(), []);
  // Later tasks are not adopted: the file exists now.
  fs.writeFileSync(
    path.join(root, "conversations.json"),
    JSON.stringify([conversation({ id: "cowork-new", cwd: used })]),
  );
  assert.equal(
    new CoworkFolderGrants(root).access(used, "cowork-new").state,
    "ask",
  );
});

test("a damaged file starts empty and is kept aside", (t) => {
  const { root, folder } = temporary(t);
  fs.writeFileSync(path.join(root, "cowork-folders.json"), "{not json");
  const grants = new CoworkFolderGrants(root, { now: () => 42 });
  assert.equal(grants.access(folder("notes")).state, "ask");
  assert.equal(
    fs.readFileSync(path.join(root, "cowork-folders.json.damaged-42"), "utf8"),
    "{not json",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, "cowork-folders.json"), "utf8"))
      .version,
    1,
  );
});

test("a routine runs unattended only in a trusted folder or the one allowed for it", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const reports = folder("reports");
  assert.equal(grants.routineAllowed("r-1", undefined), true);
  assert.equal(
    grants.routineAllowed("r-1", path.join(root, "workspace")),
    true,
  );
  assert.equal(grants.routineAllowed("r-1", reports), false);
  grants.grantRoutine("r-1", reports);
  assert.equal(grants.routineAllowed("r-1", reports), true);
  assert.equal(grants.routineAllowed("r-2", reports), false);
  grants.forgetRoutine("r-1");
  assert.equal(grants.routineAllowed("r-1", reports), false);
  grants.trust(reports);
  assert.equal(grants.routineAllowed("r-2", reports), true);
});

test("the send check leaves Chat and Code alone and checks a Cowork task's own folder", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const notes = folder("notes");
  assert.equal(
    assertCoworkFolder(grants, { mode: "chat", cwd: notes }),
    undefined,
  );
  assert.equal(
    assertCoworkFolder(grants, { mode: "code", cwd: notes }),
    undefined,
  );
  assert.equal(assertCoworkFolder(grants, { mode: "cowork" }), undefined);
  const task = conversation({ cwd: notes });
  assert.throws(
    () => assertCoworkFolder(grants, { mode: "cowork", conversation: task }),
    new RegExp(coworkFolderPermissionMessage),
  );
  // The task's folder decides, not a folder the page names.
  grants.grantConversation(task, notes);
  assert.equal(
    assertCoworkFolder(grants, {
      mode: "cowork",
      conversation: task,
      cwd: "/usr",
    }),
    undefined,
  );
  // A task with no folder uses the app's workspace.
  assert.equal(
    assertCoworkFolder(grants, {
      mode: "cowork",
      conversation: conversation({ id: "c-2" }),
    }),
    undefined,
  );
});

test("folders that hold the app's data are refused, except the home folder", (t) => {
  const { base, root, folder } = temporary(t);
  const home = folder("people/me");
  const data = folder("people/me/Library/Application Support/Claudex");
  protectCoworkFolders(data);
  const grants = new CoworkFolderGrants(root, { platform: "linux", home });
  // ~/Library, ~/Library/Application Support and /Users-like parents.
  for (const parent of [
    path.join(home, "Library"),
    path.dirname(data),
    path.join(base, "people"),
  ]) {
    assert.match(grants.access(parent).reason!, /contains Claudex’s app data/);
    assert.throws(() => grants.trust(parent), /contains Claudex’s app data/);
  }
  const access = grants.access(home);
  assert.equal(access.state, "ask");
  assert.equal(access.home, true);
  assert.equal(grants.access(folder("people/me/Documents")).state, "ask");
});

test("a mounted volume's root is a whole drive on macOS", (t) => {
  const { root } = temporary(t);
  const grants = new CoworkFolderGrants(root, { platform: "darwin" });
  assert.equal(
    grants
      .refusal("/Volumes/Backup")
      ?.includes("contains a protected location"),
    true,
  );
  assert.equal(grants.refusal("/Volumes/Backup/Reports"), undefined);
});

test("a routine run's binding leaves a pending Allow for the next task", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  const notes = folder("notes");
  grants.allowOnce(notes);
  grants.grantRoutine("r-1", notes);
  grants.bind(conversation({ id: "run-1", cwd: notes }), notes, {
    consumeAllow: false,
  });
  assert.equal(grants.access(notes, "run-1").state, "granted");
  assert.equal(grants.access(notes).state, "granted");
  grants.bind(conversation({ id: "c-2", cwd: notes }), notes);
  assert.equal(grants.access(notes).state, "ask");
});
