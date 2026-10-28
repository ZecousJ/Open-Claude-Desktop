import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import { openChangedFile } from "../../src/changes/diff-file-request";
import { onFileOpenRequest } from "../../src/files/file-open-request";

const conversation = {
  id: "c-open",
  mode: "code",
  cwd: "/work/sessions/abc",
  environment: { kind: "local" },
  turns: [],
} as unknown as Conversation;

async function open(state: "ready" | "not-git" | "no-folder") {
  const g = globalThis as Record<string, unknown>;
  const previous = g.window;
  g.window = {
    desktop: {
      listProjectFolder: async () => ({ entries: [], truncated: false }),
      codeGitStatus: async () => ({ state, ahead: 0, behind: 0 }),
    },
    dispatchEvent: () => true,
  };
  const panels: string[] = [];
  const files: string[] = [];
  const stop = onFileOpenRequest("c-open", (path) => files.push(path));
  try {
    openChangedFile(conversation, "/work/sessions/abc/site/index.html", {
      setPanel: (panel) => panels.push(String(panel)),
      setArtifact: () => {},
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    stop();
    g.window = previous;
  }
  return { panels, files };
}

test("a changed file opens its diff in a repository and the file elsewhere", async () => {
  assert.deepEqual(await open("ready"), { panels: ["changes"], files: [] });
  assert.deepEqual(await open("not-git"), {
    panels: ["files"],
    files: ["site/index.html"],
  });
});
