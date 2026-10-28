/**
 * A project's folders: the person's "Allow" for the project lets each new
 * Cowork task in it use them, and a folder that leaves the project stops
 * counting.
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
} from "../../electron/workspace/cowork-folders";
import { projectGrantLimit } from "../../electron/workspace/cowork-folders-support";

function temporary(t: any) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-project-folders-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "profile");
  fs.mkdirSync(root);
  const folder = (name: string) => {
    const value = path.join(base, name);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  return { root, folder };
}

const task = (id: string, cwd?: string): Conversation => ({
  id,
  title: "Task",
  mode: "cowork",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  ...(cwd ? { cwd } : {}),
});

test("a folder allowed for a project passes for the project's new tasks only", (t) => {
  const { root, folder } = temporary(t);
  const garden = folder("Garden");
  const grants = new CoworkFolderGrants(root);
  assert.equal(grants.access(garden, undefined, "p1").state, "ask");
  grants.grantProject("p1", garden);
  assert.equal(grants.access(garden, undefined, "p1").state, "granted");
  // Another project, or no project, still asks.
  assert.equal(grants.access(garden, undefined, "p2").state, "ask");
  assert.equal(grants.access(garden).state, "ask");
  // The send check takes the project.
  assert.equal(
    assertCoworkFolder(grants, {
      mode: "cowork",
      cwd: garden,
      projectId: "p1",
    }),
    garden,
  );
  assert.throws(
    () => assertCoworkFolder(grants, { mode: "cowork", cwd: garden }),
    new RegExp(coworkFolderPermissionMessage.slice(0, 20)),
  );
  // Kept on disk.
  assert.deepEqual(new CoworkFolderGrants(root).projectFolders("p1"), [garden]);
});

test("a new task gets the project's other folders as added folders", (t) => {
  const { root, folder } = temporary(t);
  const [a, b, c] = [folder("a"), folder("b"), folder("c")];
  const grants = new CoworkFolderGrants(root);
  grants.grantProject("p1", a);
  grants.grantProject("p1", b);
  const conversation = task("t1", a);
  // c was never allowed: it is left out.
  assert.deepEqual(grants.bindProjectFolders(conversation, "p1", [b, c]), [b]);
  assert.deepEqual(grants.extraFolders("t1"), [b]);
});

test("a folder that leaves the project stops counting; deleting the project drops all", (t) => {
  const { root, folder } = temporary(t);
  const [a, b] = [folder("a"), folder("b")];
  const grants = new CoworkFolderGrants(root);
  grants.grantProject("p1", a);
  grants.grantProject("p1", b);
  grants.releaseProject("p1", a);
  assert.deepEqual(grants.projectFolders("p1"), [b]);
  assert.equal(grants.access(a, undefined, "p1").state, "ask");
  grants.releaseProject("p1");
  assert.deepEqual(grants.projectFolders("p1"), []);
});

test("a project keeps at most 16 folders", (t) => {
  const { root, folder } = temporary(t);
  const grants = new CoworkFolderGrants(root);
  for (let i = 0; i < projectGrantLimit; i++)
    grants.grantProject("p1", folder(`f${i}`));
  assert.throws(() => grants.grantProject("p1", folder("one-more")), /16/);
});
