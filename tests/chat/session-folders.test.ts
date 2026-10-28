import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ =
  "desktop";
const calls: [string, ...unknown[]][] = [];
let chosen: string[] = [];
Object.assign(globalThis, {
  window: {
    desktop: {
      chooseFolders: async (title: string) => {
        calls.push(["chooseFolders", title]);
        return chosen;
      },
      updateConversation: async (id: string, patch: unknown) => {
        calls.push(["updateConversation", id, patch]);
      },
    },
  },
});
const { chooseSessionFolders, sessionFoldersChoosable } =
  await import("../../src/session-rail/session-folders");

const session = (extra: Partial<Conversation> = {}) =>
  ({ id: "c1", mode: "code", turns: [], ...extra }) as Conversation;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a session on this computer or an SSH host can take more folders, a cloud one cannot", () => {
  assert.equal(sessionFoldersChoosable(session()), true);
  assert.equal(
    sessionFoldersChoosable(
      session({ environment: { kind: "ssh", hostId: "h" } }),
    ),
    true,
  );
  assert.equal(
    sessionFoldersChoosable(
      session({ environment: { kind: "space", spaceId: "s" } as never }),
    ),
    false,
  );
});

test("Add folder to session adds the chosen folders after the ones it has", async () => {
  chosen = ["/b", "/c"];
  chooseSessionFolders(
    session({ cwd: "/a", additionalFolders: ["/x"] }),
    "Add folders to this session",
    (error) => assert.fail(String(error)),
  );
  await settle();
  assert.deepEqual(calls.splice(0), [
    ["chooseFolders", "Add folders to this session"],
    ["updateConversation", "c1", { additionalFolders: ["/x", "/b", "/c"] }],
  ]);
  // A session without a folder takes the first as its working folder.
  chooseSessionFolders(session(), "Add folders to this session", () => {});
  await settle();
  assert.deepEqual(calls.splice(0)[1], [
    "updateConversation",
    "c1",
    { cwd: "/b", additionalFolders: ["/c"] },
  ]);
  // Cancelling the picker changes nothing.
  chosen = [];
  chooseSessionFolders(
    session({ cwd: "/a" }),
    "Add folders to this session",
    () => {},
  );
  await settle();
  assert.deepEqual(
    calls.splice(0).map((call) => call[0]),
    ["chooseFolders"],
  );
});
