import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createCodeCommandPermissionHost,
  type CodeExecutionApprovalResult,
} from "../electron/official-ui/code-command-permission-host";
import type { Approval, Conversation, Item, Turn } from "../shared/types";

const target = path.join(process.cwd(), "example.txt");
const content = "@@ -1 +1 @@\n第一行 café\n\n";

function fixture(text = content, lasting = false) {
  const change = { path: target, kind: { type: "add" }, diff: text };
  const item: Item = {
    id: "patch",
    type: "fileChange",
    status: "inProgress",
    changes: [change],
  };
  const turn: Turn = {
    id: "turn",
    prompt: "Create example.txt",
    createdAt: 2,
    attachments: [],
    status: "inProgress",
    items: [item],
  };
  const c: Conversation = {
    id: "code",
    mode: "code",
    title: "Create a file",
    cwd: process.cwd(),
    threadId: "thread",
    createdAt: 1,
    updatedAt: 2,
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    turns: [turn],
  };
  const approval: Approval = {
    id: 1,
    conversationId: c.id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: c.threadId,
      turnId: turn.id,
      itemId: item.id,
      startedAtMs: 2,
      reason: null,
      grantRoot: null,
    },
  };
  let pending = [approval];
  const answers: { approval: Approval; result: CodeExecutionApprovalResult }[] =
    [];
  const runtime = {};
  const host = createCodeCommandPermissionHost({
    current: () => true,
    runtime: () => runtime,
    approvals: () => pending,
    conversation: () => c,
    allowPersistent: () => lasting,
    respondExact(approval, result) {
      answers.push({ approval, result });
      pending = pending.filter((request) => request !== approval);
    },
  });
  return {
    approval,
    answers,
    change,
    host,
    item,
    project: () => host.project(approval.id, c.id),
    replaceApproval: () => {
      pending = [structuredClone(approval)];
    },
    turn,
  };
}

test("the original Write permission sends only the exact single-file approval", () => {
  const { approval, answers, host, project } = fixture();
  const request = project();
  assert.ok(request);
  assert.match(request.requestId, /^code-write:/);
  assert.equal(request.toolName, "Write");
  assert.equal(request.cliToolUseId, "turn:file:patch:0");
  assert.equal(request.suppressAlwaysAllowRule, true);
  assert.deepEqual(request.input, { file_path: target, content });
  assert.throws(
    () => host.respond(String(approval.id), "once"),
    /no longer available/,
  );
  assert.throws(
    () => host.respond(request.requestId, "always"),
    /allow once or deny/,
  );
  assert.throws(
    () =>
      host.respond(request.requestId, "once", {
        file_path: target,
        content: "",
      }),
    /Edited approval/,
  );
  assert.deepEqual(answers, []);
  host.respond(request.requestId, "once", { content, file_path: target });
  host.respond(request.requestId, "once");
  assert.deepEqual(answers, [{ approval, result: { decision: "accept" } }]);
});

test("an empty file can be shown and declined", () => {
  const { approval, answers, host, project } = fixture("");
  const request = project();
  assert.ok(request);
  assert.deepEqual(request.input, { file_path: target, content: "" });
  host.respond(request.requestId, "deny");
  assert.deepEqual(answers, [{ approval, result: { decision: "decline" } }]);
});

test("an all-Add batch names every file and answers one approval", () => {
  const { approval, answers, change, host, item, project } = fixture();
  const second = { ...change, path: target + ".second", diff: "" };
  item.changes = [change, second];
  const request = project();
  assert.ok(request);
  assert.equal(request.toolName, "apply_patch");
  assert.equal(request.cliToolUseId, "turn:patch:patch");
  assert.deepEqual(request.input, {
    files: [
      { path: target, content },
      { path: second.path, content: "" },
    ],
  });
  assert.throws(
    () =>
      host.respond(request.requestId, "once", {
        files: [{ path: target, content }],
      }),
    /Edited approval/,
  );
  host.respond(request.requestId, "once", request.input);
  assert.deepEqual(answers, [{ approval, result: { decision: "accept" } }]);
});

test("mixed edits and a directory grant have no Write permission", () => {
  const { approval, change, item, project } = fixture();
  item.changes = [
    change,
    { ...change, path: target + ".second", kind: { type: "update" } },
  ];
  assert.equal(project(), undefined);
  item.changes = [change];
  approval.params.grantRoot = path.dirname(target);
  assert.equal(project(), undefined);
});

test("a Write receipt cannot answer a changed item, finished turn, or replacement request", () => {
  for (const changeRequest of [
    (f: ReturnType<typeof fixture>) => {
      f.change.diff = "different contents\n";
    },
    (f: ReturnType<typeof fixture>) => {
      f.turn.status = "completed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.replaceApproval();
    },
  ]) {
    const f = fixture();
    const request = f.project();
    assert.ok(request);
    changeRequest(f);
    assert.throws(
      () => f.host.respond(request.requestId, "once"),
      /no longer available/,
    );
    assert.deepEqual(f.answers, []);
  }
});

test("the native Edit card shows the proposed change and grants session approval for the file", () => {
  const { approval, answers, item, host, project } = fixture(content, true);
  item.changes = [
    {
      path: target,
      kind: { type: "update" },
      diff: "@@ -1 +1 @@\n-old\n+new\n",
    },
  ];
  const request = project()!;
  assert.equal(request.toolName, "Edit");
  assert.equal(request.cliToolUseId, "turn:file:patch:0");
  assert.deepEqual(request.input, {
    file_path: target,
    old_string: "old\n",
    new_string: "new\n",
    replace_all: false,
  });
  assert.equal(request.alwaysAllowEndsWithSession, true);
  assert.deepEqual(request.suggestions?.[0].rules, [
    { toolName: "Edit", ruleContent: target },
  ]);
  assert.throws(
    () =>
      host.respond(request.requestId, "always", {
        ...request.input,
        new_string: "unapproved",
      }),
    /Edited approval/,
  );
  host.respond(request.requestId, "always", request.input);
  assert.deepEqual(answers, [
    { approval, result: { decision: "acceptForSession" } },
  ]);
});
