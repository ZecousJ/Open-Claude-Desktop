import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import {
  changedFileTree,
  changesRoot,
  conversationTurnChanges,
} from "../../src/changes/turn-changes";

const diff = (path: string, add: number) =>
  `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${add + 1} @@\n x\n${"+y\n".repeat(add)}`;

test("a conversation's turns list what each changed, without Git", () => {
  const conversation = {
    turns: [
      {
        id: "t1",
        prompt: "make the page\nwith a header",
        createdAt: 1,
        items: [
          {
            id: "a",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/app.ts",
                kind: { type: "update" },
                diff: diff("src/app.ts", 2),
              },
            ],
          },
          {
            id: "b",
            type: "fileChange",
            status: "failed",
            changes: [{ path: "x.ts", diff: diff("x.ts", 9) }],
          },
        ],
      },
      {
        id: "t2",
        prompt: "just talk",
        createdAt: 2,
        items: [{ id: "m", type: "agentMessage", text: "hi" }],
      },
      {
        id: "t3",
        prompt: "add a readme",
        createdAt: 3,
        items: [
          {
            id: "c",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "README.md", kind: { type: "add" }, diff: "one\ntwo\n" },
            ],
          },
        ],
      },
    ],
  } as unknown as Conversation;
  const turns = conversationTurnChanges(conversation);
  assert.deepEqual(
    turns.map((t) => t.turnId),
    ["t1", "t3"],
    "turns without file changes are left out",
  );
  assert.equal(turns[0].prompt, "make the page\nwith a header");
  assert.deepEqual(
    turns[0].files.map((f) => f.path),
    ["src/app.ts"],
    "a failed write is not a change",
  );
  assert.equal(turns[0].additions, 2);
  assert.equal(turns[1].files[0].status, "added");
  assert.equal(turns[1].additions, 2);
});

test("changed files form a tree, folders first, with summed counts", () => {
  const file = (path: string, additions: number, deletions = 0) =>
    ({ path, status: "modified", hunks: [], additions, deletions }) as never;
  const tree = changedFileTree([
    file("src/app/ToolDock.tsx", 86),
    file("electron/main.ts", 5),
    file("src/app/useToolPanels.ts", 67, 15),
    file("README.md", 1),
    file("src/app/ToolDock.tsx", 4, 2),
  ]);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["electron", "src", "README.md"],
  );
  const app = tree[1].children[0];
  assert.equal(app.name, "app");
  assert.deepEqual(
    app.children.map((n) => [n.name, n.additions, n.deletions]),
    [
      ["ToolDock.tsx", 90, 2],
      ["useToolPanels.ts", 67, 15],
    ],
  );
  assert.equal(tree[1].additions, 157);
});

test("the tree starts at the conversation's folder or the profile's workspace", () => {
  const file = (path: string) =>
    ({ path, status: "added", hunks: [], additions: 1, deletions: 0 }) as never;
  const workspace =
    "/Users/me/Library/Application Support/Claudex/profiles/da5ec718/workspace";
  const chat = [file(`${workspace}/i`), file(`${workspace}/models/mac.scad`)];
  assert.equal(changesRoot(chat), workspace);
  const names = (nodes: { name: string; children: any[] }[]): unknown =>
    nodes.map((node) =>
      node.children.length ? [node.name, names(node.children)] : node.name,
    );
  assert.deepEqual(names(changedFileTree(chat, changesRoot(chat))), [
    ["models", ["mac.scad"]],
    "i",
  ]);
  const code = [file("C:\\work\\app\\src\\a.ts"), file("/elsewhere/b.ts")];
  assert.deepEqual(
    names(changedFileTree(code, changesRoot(code, "C:\\work\\app\\"))),
    [
      ["elsewhere", ["b.ts"]],
      ["src", ["a.ts"]],
    ],
  );
  // The file keeps its own path for opening its diff.
  assert.equal(
    changedFileTree(chat, workspace).find((node) => node.name === "i")?.path,
    `${workspace}/i`,
  );
});
