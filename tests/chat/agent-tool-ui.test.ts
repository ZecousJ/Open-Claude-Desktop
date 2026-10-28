import { common, createLowlight } from "lowlight";
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Conversation, Item, Turn } from "../../shared/types";
import {
  changedRanges,
  fileChangeDiff,
  hiddenGaps,
  parseUnifiedDiff,
} from "../../src/diff/diff-model";
import { lineSegments } from "../../src/diff/highlight";
import {
  approvalResponse,
  commandTitle,
  fileChangeTitle,
  grantedPermissions,
  permissionRows,
  permissionTitle,
} from "../../src/approval/approval-model";
import {
  elicitationContent,
  elicitationFields,
} from "../../src/approval/elicitation-form";
import { questionAnswers } from "../../src/approval/QuestionsBody";
import {
  codeSegments,
  formatElapsed,
  formatTokens,
  toolSummary,
} from "../../src/code-tools/code-tool-model";
import {
  CodeTurnChanges,
  fileChangeLabel,
  turnChanges,
  undoChangesPrompt,
} from "../../src/code-tools/CodeFileChange";
import { CodeCommandActivity } from "../../src/code-tools/CodeCommandActivity";
import { ApprovalCard } from "../../src/ui/ApprovalCard";
import { latestPlan } from "../../src/plan/PlanPanel";
import { workingTreeChanges } from "../../electron/git/working-tree";
import {
  approvalConversation,
  mixedToolsConversation,
  workingTreeDiff,
} from "../../scripts/preview/agent-tool-fixtures";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { chatSegments } from "../../src/transcript/ChatActivityGroup";

const approval = (method: string, params: any = {}): Approval => ({
  id: 7,
  conversationId: "c",
  method,
  params,
});

test("unified diffs split into files with numbered lines and totals", () => {
  const files = parseUnifiedDiff(workingTreeDiff());
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions]),
    [
      ["app.js", "modified", 2, 1],
      ["utils.js", "added", 3, 0],
    ],
  );
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(
    lines.slice(0, 4).map((l) => [l.kind, l.oldNo, l.newNo]),
    [
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
    ],
  );
  // The rewritten line is emphasised as one change; the unchanged "trimmed = (name" is not.
  assert.ok(lines[1].changed?.length);
  assert.ok(lines[2].changed?.length);
  assert.equal(lines[3].changed, undefined);
});

test("hidden lines are reported before, between and after hunks", () => {
  const [app] = parseUnifiedDiff(workingTreeDiff());
  assert.deepEqual(hiddenGaps(app, 9), { before: [false], after: true });
  const [full] = parseUnifiedDiff(workingTreeDiff(20));
  assert.deepEqual(hiddenGaps(full, 9), { before: [false], after: false });
  const two = parseUnifiedDiff(
    "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d\n",
    "x.txt",
  )[0];
  assert.equal(two.path, "x.txt");
  assert.deepEqual(hiddenGaps(two).before, [false, true]);
});

test("Codex file changes become diffs: whole files for adds, hunks for updates", () => {
  const added = fileChangeDiff({
    path: "/p/utils.js",
    kind: { type: "add" },
    diff: "a\nb\n",
  });
  assert.equal(added.status, "added");
  assert.equal(added.additions, 2);
  assert.deepEqual(
    added.hunks[0].lines.map((l) => l.newNo),
    [1, 2],
  );
  const moved = fileChangeDiff({
    path: "/p/a.js",
    kind: { type: "update", move_path: "/p/b.js" },
    diff: "@@ -1 +1 @@\n-x\n+y\n",
  });
  assert.equal(moved.path, "/p/b.js");
  assert.equal(moved.status, "renamed");
});

test("word ranges merge across short unchanged gaps and skip indentation", () => {
  assert.deepEqual(changedRanges("  return a + b;", "  return a - b;"), [
    [11, 12],
  ]);
  const ranges = changedRanges(
    "  return `Hello, ${name}`;",
    '  const trimmed = (name ?? "").trim();',
  );
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0][0], 2);
});

test("highlighted segments split where a word change starts and ends", () => {
  const lowlight = createLowlight(common);
  const segments = lineSegments(
    "const a = 1;",
    "javascript",
    [[6, 7]],
    lowlight,
  );
  assert.equal(segments.map((s) => s.text).join(""), "const a = 1;");
  assert.equal(segments.find((s) => s.changed)?.text, "a");
  assert.equal(segments[0].className, "hljs-keyword");
  // Before the highlighter has loaded the line is plain, still split.
  const plain = lineSegments("const a = 1;", "javascript", [[6, 7]]);
  assert.equal(plain.find((s) => s.changed)?.text, "a");
  assert.equal(plain[0].className, undefined);
});

test("approval buttons send the matching Codex decisions", () => {
  const command = approval("item/commandExecution/requestApproval", {
    command: "node app.js",
  });
  assert.deepEqual(approvalResponse(command, "deny"), { decision: "decline" });
  assert.deepEqual(approvalResponse(command, "always"), {
    decision: "acceptForSession",
  });
  assert.deepEqual(approvalResponse(command, "once"), { decision: "accept" });
  const perms = approval("item/permissions/requestApproval", {
    permissions: {
      network: { enabled: true },
      fileSystem: { read: null, write: ["/tmp/x"] },
    },
  });
  assert.deepEqual(approvalResponse(perms, "always"), {
    permissions: {
      network: { enabled: true },
      fileSystem: { read: null, write: ["/tmp/x"] },
    },
    scope: "session",
  });
  assert.deepEqual(approvalResponse(perms, "deny"), {
    permissions: {},
    scope: "turn",
  });
  assert.deepEqual(grantedPermissions({ network: null, fileSystem: null }), {});
  assert.deepEqual(
    approvalResponse(approval("mcpServer/elicitation/request"), "deny"),
    { action: "decline", content: null, _meta: null },
  );
});

test("approval titles name the file or command", () => {
  const { conversation } = approvalConversation(0, "write");
  const item = conversation.turns[0].items.find((i) => i.type === "fileChange");
  assert.equal(fileChangeTitle(item), "Allow Claudex to write utils.js?");
  assert.equal(
    commandTitle({ command: "node app.js" }),
    "Allow Claudex to run node app.js?",
  );
  // A long command stays whole; the card clamps the title to two lines.
  assert.equal(
    commandTitle({ command: "x".repeat(80) }),
    `Allow Claudex to run ${"x".repeat(80)}?`,
  );
  assert.equal(
    commandTitle({ command: "npm i\n  && npm test" }),
    "Allow Claudex to run npm i && npm test?",
  );
  assert.equal(commandTitle({}), "Allow Claudex to run this command?");
  const rows = permissionRows({
    network: { enabled: true },
    fileSystem: {
      read: ["/r"],
      write: null,
      entries: [
        {
          path: { type: "special", value: { kind: "tmpdir" } },
          access: "write",
        },
      ],
    },
  });
  assert.deepEqual(rows, [
    { label: "Network", value: "Access the internet" },
    { label: "Read", value: "/r" },
    { label: "Write", value: "The temporary folder" },
  ]);
  assert.equal(
    permissionTitle({ network: { enabled: true } }),
    "Allow Claudex to access the network?",
  );
});

test("the approval card renders Deny and Allow once with More allow options and shortcuts", () => {
  const { conversation, approval: pending } = approvalConversation(0, "edit");
  const html = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: pending,
      conversation,
      frontmost: true,
      mac: true,
      onError: () => {},
    }),
  );
  assert.match(html, /Allow Claudex to edit app\.js\?/);
  assert.match(html, />Deny<\/span>.*>1<\/kbd>.*>Esc<\/kbd>/s);
  assert.match(
    html,
    />Allow once<\/span>.*>3<\/kbd>.*aria-label="More allow options"/s,
  );
  assert.match(html, /class="diff-row" data-kind="del"/);
  const form = renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval: approvalConversation(0, "form").approval,
      frontmost: false,
      mac: false,
      onError: () => {},
    }),
  );
  assert.match(form, /docs needs more information/);
  // A choice is the settings SelectField, not a native select (R13-C).
  assert.match(form, /class="settings-select /);
  assert.doesNotMatch(form, /<select/);
  assert.match(form, />Submit<\/span>/);
  assert.match(form, />Ctrl<\/kbd>/);
  assert.doesNotMatch(form, /Always allow/);
});

test("elicitation schemas become fields and validated content", () => {
  const fields = elicitationFields({
    type: "object",
    properties: {
      title: { type: "string", title: "Title", minLength: 3 },
      count: { type: "integer", minimum: 1 },
      kind: { type: "string", enum: ["a", "b"], enumNames: ["A", "B"] },
      tags: { type: "array", items: { enum: ["x", "y"] } },
      ok: { type: "boolean", default: true },
    },
    required: ["title"],
  });
  assert.deepEqual(
    fields.map((f) => f.type),
    ["string", "integer", "enum", "multi", "boolean"],
  );
  assert.deepEqual(fields[2].options[1], { value: "b", label: "B" });
  assert.deepEqual(elicitationContent(fields, {}), {
    error: "Title is required.",
  });
  assert.deepEqual(elicitationContent(fields, { title: "Hi" }), {
    error: "Title needs at least 3 characters.",
  });
  assert.deepEqual(elicitationContent(fields, { title: "Hey", count: "1.5" }), {
    error: "count must be a whole number.",
  });
  assert.deepEqual(
    elicitationContent(fields, { title: " Hey ", count: "2", tags: ["x"] }),
    { content: { title: "Hey", count: 2, tags: ["x"], ok: true } },
  );
  assert.deepEqual(questionAnswers([{ id: "q", question: "?" }], {}), {
    error: "Answer every question to continue.",
  });
  assert.deepEqual(
    questionAnswers([{ id: "q", question: "?" }], { q: " a " }),
    {
      answers: { q: { answers: ["a"] } },
    },
  );
});

const cmd = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  type: "commandExecution",
  command: "x",
  status: "completed",
  lifecycleStatus: "completed",
  exitCode: 0,
  ...extra,
});
const read = (id: string, name: string) =>
  cmd(id, {
    commandActions: [
      { type: "read", command: `cat ${name}`, name, path: `/p/${name}` },
    ],
  });

test("consecutive tool calls fold into one counted summary", () => {
  const items: Item[] = [
    read("r1", "README.md"),
    { id: "think", type: "reasoning", summary: [] },
    read("r2", "app.js"),
    { id: "m", type: "agentMessage", text: "ok" },
    cmd("c1"),
    cmd("c2", { exitCode: 1 }),
    cmd("c3"),
    { id: "f", type: "fileChange", changes: [] },
    cmd("c4"),
    {
      id: "t",
      type: "mcpToolCall",
      server: "docs",
      tool: "search",
      status: "completed",
    },
  ];
  const segments = codeSegments(items);
  assert.deepEqual(
    segments.map((s) =>
      s.type === "tools" ? toolSummary(s.items) : s.item.id,
    ),
    [
      "Read 2 files",
      "m",
      // A file edit joins the run and kinds keep their first-seen order.
      "Ran 4 commands (1 failed), edited a file, used a tool",
    ],
  );
  assert.equal(toolSummary([read("r", "app.js")]), "Read app.js");
  assert.equal(
    toolSummary([
      cmd("s", {
        commandActions: [
          { type: "search", command: "rg TODO", query: "TODO", path: null },
        ],
      }),
    ]),
    "Searched TODO",
  );
  assert.equal(
    toolSummary([
      cmd("l", {
        commandActions: [{ type: "listFiles", command: "ls", path: null }],
      }),
    ]),
    "Listed files",
  );
  assert.equal(
    toolSummary([
      read("r", "a.js"),
      cmd("run", { lifecycleStatus: "inProgress", status: "inProgress" }),
    ]),
    "Running a command",
  );
});

test("status line formats long turns and token counts like the reference", () => {
  assert.equal(formatElapsed(9), "9s");
  assert.equal(formatElapsed(293), "4m 53s");
  assert.equal(formatElapsed(2209), "36m 49s");
  assert.equal(formatElapsed(3720), "1h 2m");
  assert.equal(formatTokens(46), "46 tokens");
  assert.equal(formatTokens(4012), "4.0k tokens");
  assert.equal(formatTokens(1_250_000), "1.3M tokens");
});

test("file rows name the file and the turn totals come from Codex's turn diff", () => {
  const change = (kind: string, status = "completed"): Item => ({
    id: kind,
    type: "fileChange",
    status,
    lifecycleStatus: status === "inProgress" ? "inProgress" : "completed",
    changes: [{ path: "/p/app.js", kind: { type: kind }, diff: "a\n" }],
  });
  assert.equal(
    fileChangeLabel(change("update", "inProgress")),
    "Editing app.js",
  );
  assert.equal(fileChangeLabel(change("add")), "Created app.js");
  // A write that did not happen names the file.
  assert.equal(
    fileChangeLabel(change("update", "declined")),
    "Failed to edit app.js",
  );
  assert.equal(
    fileChangeLabel(change("add", "failed")),
    "Failed to write app.js",
  );
  const turn: Turn = {
    id: "t",
    prompt: "",
    attachments: [],
    status: "completed",
    createdAt: 0,
    items: [change("add"), { id: "d", type: "diff", text: workingTreeDiff() }],
  };
  assert.deepEqual(turnChanges(turn), { files: 2, additions: 5, deletions: 1 });
  // The turn's edits card: "Edited 2 files  +5 −1", then each file.
  const summary = renderToStaticMarkup(
    createElement(CodeTurnChanges, { turn, onOpen: () => {} }),
  );
  assert.match(summary, /turn-edits-card/);
  assert.match(summary, />Edited 2 files</);
  assert.match(summary, />app\.js</);
  assert.match(summary, /\+5/);
  // No Undo unless the latest turn offers it.
  assert.doesNotMatch(summary, />Undo</);
  const latest = renderToStaticMarkup(
    createElement(CodeTurnChanges, {
      turn,
      onOpen: () => {},
      onUndo: () => {},
    }),
  );
  assert.match(latest, /turn-edits-undo[^>]*>Undo</);
});

test("Undo on a turn's changes asks Claude to restore each file", () => {
  assert.equal(
    undoChangesPrompt(["src/app.js"]),
    "Undo the changes you made to `src/app.js` in your last turn and restore it to its previous state.",
  );
  assert.equal(
    undoChangesPrompt(["a.ts", "b`c.ts"]),
    [
      "Undo the changes you made to these 2 files in your last turn and restore them to their previous state:",
      "- `a.ts`",
      "- `bc.ts`",
    ].join("\n"),
  );
});

test("a command still running as a background terminal links to the task panel", () => {
  const html = renderToStaticMarkup(
    createElement(CodeCommandActivity, {
      item: cmd("bg", {
        command: "sleep 600",
        processId: "p1",
        exitCode: null,
      }),
      background: true,
      onOpenBackground: () => {},
    }),
  );
  assert.match(html, /Background command started · sleep 600/);
  assert.match(html, /title="Task p1"/);
});

test("the Plan panel reads the latest task list", () => {
  const conversation = {
    turns: [
      {
        items: [
          {
            id: "a",
            type: "taskPlan",
            plan: [{ step: "old", status: "completed" }],
          },
        ],
      },
      {
        items: [
          {
            id: "b",
            type: "taskPlan",
            plan: [{ step: "new", status: "pending" }],
          },
        ],
      },
    ],
  } as unknown as Conversation;
  assert.deepEqual(latestPlan(conversation), [
    { step: "new", status: "pending" },
  ]);
});

test("working tree changes list tracked edits and untracked files against the branch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.invalid");
    run("config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "app.js"), "a\nb\nc\n");
    run("add", ".");
    run("commit", "-qm", "base");
    fs.writeFileSync(path.join(dir, "app.js"), "a\nB\nc\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "x\ny\n");
    const result = await workingTreeChanges(dir);
    assert.equal(result.state, "ready");
    assert.equal(result.base, "main");
    const files = parseUnifiedDiff(result.diff);
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.additions, f.deletions]),
      [
        ["app.js", "modified", 1, 1],
        ["new.txt", "added", 2, 0],
      ],
    );
    assert.deepEqual(result.lineCounts, { "app.js": 3, "new.txt": 2 });
    assert.equal((await workingTreeChanges(os.tmpdir())).state, "not-git");
    assert.equal((await workingTreeChanges(undefined)).state, "no-folder");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("working tree reads never run repository-configured programs or follow symlinks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-wt-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-out-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    run("init", "-q", "-b", "main");
    // A textconv driver and fsmonitor hook the agent could have configured.
    run("config", "diff.probe.textconv", "sh -c 'touch TEXTCONV; cat \"$0\"'");
    run("config", "core.fsmonitor", "sh -c 'touch FSMONITOR'");
    fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt diff=probe\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "x\n");
    fs.writeFileSync(path.join(outside, "secret"), "one\ntwo\nthree\n");
    fs.symlinkSync(path.join(outside, "secret"), path.join(dir, "link"));
    const result = await workingTreeChanges(dir);
    assert.equal(fs.existsSync(path.join(dir, "TEXTCONV")), false);
    assert.equal(fs.existsSync(path.join(dir, "FSMONITOR")), false);
    assert.doesNotMatch(result.diff, /two/);
    assert.match(result.diff, new RegExp(`\\+${outside}/secret`));
    assert.equal(result.lineCounts.link, undefined);
    assert.equal(result.lineCounts["new.txt"], 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Chat folds a command and a connector call into one mixed summary", () => {
  const turn = mixedToolsConversation(0).turns[0];
  assert.deepEqual(
    chatSegments(turn.items).map((s) => [s.id, s.activity, s.items.length]),
    [
      ["cmd-echo", true, 2],
      ["msg-mixed", false, 1],
    ],
  );
  const html = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      turn,
      awaitingApproval: false,
      onArtifact: () => {},
    }),
  );
  assert.match(html, /Ran a command, used docs integration/);
  // A tool that introduces an agent keeps its own row.
  assert.equal(chatSegments(turn.items, new Set(["mcp-docs"])).length, 3);
});

test("a plan can be accepted into auto mode, and into bypass where the folder allows it", async () => {
  const { planAcceptTargets } = await import("../../src/plan/PlanApprovalCard");
  assert.deepEqual(planAcceptTargets({ bypassFolders: [] }, "/p"), ["auto"]);
  // Bypass permissions never saved: the default is on, as in the permission menu.
  assert.deepEqual(planAcceptTargets({ bypassFolders: ["/p"] }, "/p"), [
    "auto",
    "bypass",
  ]);
  assert.deepEqual(
    planAcceptTargets(
      { bypassFolders: ["/p"], allowBypassPermissions: true },
      "/p",
    ),
    ["auto", "bypass"],
  );
  assert.deepEqual(
    planAcceptTargets(
      { bypassFolders: ["/p"], allowBypassPermissions: false },
      "/p",
    ),
    ["auto"],
  );
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
