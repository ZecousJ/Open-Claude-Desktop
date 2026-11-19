import assert from "node:assert/strict";
import { test } from "node:test";
import { codeSession } from "../electron/official-ui/native/code-sessions";
import type { Conversation } from "../shared/types";

const id = "4c62cba1-577c-48df-b9d5-cf195d740ff5";
const session = (cwd: string) => ({ id, cwd, mode: "code", turns: [], title: "Task" }) as unknown as Conversation;

test("managed scratch sessions retain their isolated cwd while the official UI hides internal folder groups", () => {
  for (const [workspace, cwd] of [
    ["/profile/workspace", `/profile/workspace/sessions/${id}`],
    ["C:\\Profile\\workspace", `C:\\Profile\\workspace\\sessions\\${id}`],
    ["\\\\host\\profile\\workspace", `\\\\host\\profile\\workspace\\sessions\\${id}`],
  ]) {
    const result = codeSession(session(cwd), [], workspace);
    assert.equal(result.isScratchWorkspace, true);
    assert.equal(result.cwd, cwd, "the grouping correction must not merge or move task files");
    assert.equal(result.originCwd, cwd);
  }
});

test("real folders, UUID-named user projects and directories outside the account scratch layout remain projects", () => {
  for (const cwd of [
    `/user/projects/${id}`, `/profile/workspace-copy/sessions/${id}`,
    `/profile/workspace/sessions/${id}/subproject`, "/profile/workspace", "/profile/workspace/sessions/project",
  ]) assert.equal(codeSession(session(cwd), [], "/profile/workspace").isScratchWorkspace, false, cwd);
  assert.equal(codeSession(session(`/profile/workspace/sessions/${id}`)).isScratchWorkspace, false, "a name alone is not workspace provenance");
});

test("a moved scratch session exposes its original file-link mapping", () => {
  const moved = session("/project");
  moved.scratchCarried = {
    from: [`/profile/workspace/sessions/${id}`],
    to: "/project",
    left: ["existing.txt"],
  };
  const details = codeSession(moved, [], "/profile/workspace");
  assert.equal(details.isScratchWorkspace, false);
  assert.deepEqual(details.scratchCarried, moved.scratchCarried);
});
