import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import { registerResources } from "../electron/official-ui/native/resources";
import { connectionRunner, RemoteWorkspace } from "../electron/ssh/remote-workspace";
import { sshSlashCommands } from "../electron/ssh/slash-commands";
const pause = () => new Promise<void>((r) => setTimeout(r, 10));
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-code-slash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "one",
    identity = 1,
    body: string | null = "Review $1",
    sourceError = false,
    unknownSend = false,
    unknownSteer = false;
  let onRead = async () => {};
  let deleted = false;
  const c: any = {
    id: "session",
    title: "Commands",
    mode: "code",
    cwd: root,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "base",
        prompt: "base",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
  const draftId = "00000000-0000-4000-8000-000000000105";
  let draft: any;
  let settings = { activeProviderId: "p", providers: [{ id: "p", model: "m" }], mcpServers: {}, codeAutoCompactTokens: 0 };
  const calls: Array<{ name: string; args: any[] }> = [];
  const ctx: any = {
    account: () => ({ id: owner }),
    settings: () => settings,
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    localListConversations: async () => [...(deleted ? [] : [structuredClone(c)]), ...(draft ? [structuredClone(draft)] : [])],
    localLoadConversation: async (id: string) =>
      id === draftId && draft ? structuredClone(draft) :
        !deleted && id === c.id ? structuredClone(c) : undefined,
    localCall: async (name: string, ...args: any[]) => {
      calls.push({ name, args });
      if (name === "snapshot") return { approvals: [] };
      if (name === "listSlashCommands") {
        assert.equal(args[0].strictSources, true);
        if (args[0].conversationId) assert.equal(args[0].conversationId, c.id);
        if (args[0].folder && args[0].folder !== root) throw Error("Folder not allowed");
        if (sourceError) throw Error("command catalog offline");
        return {
          commands: [
            { name: "review-pr", description: "Review", source: "prompt", argumentHint: "[PR]" },
            { name: "lint", description: "Lint", source: "skill" },
            { name: "Side", description: "Must not shadow /side", source: "prompt" },
          ],
          usageCredits: false,
        };
      }
      if (name === "readCustomPrompt") {
        await onRead();
        return body;
      }
      if (name === "send") {
        if (unknownSend) throw Error("delivery timeout");
        const target = args[0].newConversationId ? draft = { ...c, id: draftId, turns: [] } : c;
        target.turns.push({
          id: `turn-${calls.length}`,
          prompt: args[0].text,
          ...(args[1]?.slashInput && {
            officialCodeDisplayText: args[1].slashInput.text,
            officialCodeEventId: args[1].slashInput.uuid,
          }),
          attachments: [],
          items: [],
          status: "completed",
          createdAt: calls.length,
        });
        return structuredClone(target);
      }
      if (name === "updateConversation") {
        Object.assign(c, args[1]);
        return structuredClone(c);
      }
      if (name === "saveSettings") return settings = args[0];
      if (name === "startReview") return structuredClone(c);
      if (name === "steerTurn") {
        if (unknownSteer) return null;
        const messageId = `steer-${calls.length}`;
        c.turns.at(-1).items.push({
          id: messageId,
          type: "userMessage",
          text: args[1],
          clientId: messageId,
          steered: true,
        });
        return { messageId, conversation: structuredClone(c) };
      }
      if (name === "deleteConversation") { deleted = true; return; }
      if (name === "compactConversation") return;
      if (name === "stopWorkflowAgent") return structuredClone(c);
      if (name === "readCodeAgent") return {
        id: "child",
        turns: [{
          id: "child-turn", prompt: "Child instruction", attachments: [],
          items: [{ id: "answer", type: "agentMessage", text: "Child finding" }],
          status: "completed", createdAt: 1,
        }],
      };
      throw Error(`Unexpected ${name}`);
    },
    log() {},
    onEvent: () => () => {},
  };
  const attach = () => {
    identity++;
    const handlers = new Map<string, (...a: any[]) => any>();
    const host = {
      ctx,
      on: (n: string, f: (...a: any[]) => any) => handlers.set(n, f),
      emit() {},
    } as never;
    registerExperimentalCodeSessions(host);
    registerResources(host);
    return {
      run: (method: string, ...args: any[]) =>
        Promise.resolve().then(() =>
          handlers.get(`LocalSessions.${method}`)!("local_session", ...args),
        ),
      start: (message: string, options?: object) => handlers.get("LocalSessions.start")!({
        cwd: root, sessionId: `local_${draftId}`, message, messageUuid: "draft-command",
        ...options,
      }),
      listSshDraft: (hostId: string, cwd?: string) =>
        handlers.get("LocalSessions.getSSHDraftCommandNames")!(hostId, cwd),
      draftTranscript: () => handlers.get("LocalSessions.getTranscript")!(`local_${draftId}`),
      list: (options?: unknown) =>
        Promise.resolve().then(() =>
          handlers.get("LocalSessions.getSupportedCommands")!(options),
        ),
    };
  };
  return {
    c,
    ctx,
    calls,
    attach,
    store: codeSessionState(ctx),
    setBody: (value: string | null) => (body = value),
    sourceError: () => (sourceError = true),
    unknownSend: () => (unknownSend = true),
    unknownSteer: () => (unknownSteer = true),
    onRead: (fn: typeof onRead) => (onRead = fn),
    switch: () => {
      owner = "two";
      identity++;
    },
    activate: () => identity++,
    sends: () => calls.filter((c) => c.name === "send"),
    reads: () => calls.filter((c) => c.name === "readCustomPrompt").length,
  };
}
const send = (
  a: ReturnType<ReturnType<typeof fixture>["attach"]>,
  message: string,
  uuid: string,
  priority = "later",
) => a.run("sendMessage", message, [], [], [], priority, {}, uuid);
test("official command catalog accepts global, folder and owned saved scopes", async (t) => {
  const f = fixture(t),
    a = f.attach();
  const rows = [
    { name: "review-pr", description: "Review", argumentHint: "[PR]", kind: "skill" },
    { name: "lint", description: "Lint", kind: "skill" },
  ];
  assert.deepEqual(await a.list(), rows);
  assert.deepEqual(await a.list({ cwd: f.c.cwd, sessionId: undefined }), rows);
  assert.deepEqual(await a.list({ cwd: undefined, sessionId: "local_session" }), rows);
  f.c.threadId = "thread";
  assert.deepEqual((await a.list({ sessionId: "local_session" })).map((row: {name: string}) => row.name), ["review-pr", "lint", "compact", "review"]);
  f.c.turns[0].status = "inProgress";
  assert.deepEqual((await a.list({ sessionId: "local_session" })).map((row: {name: string}) => row.name), ["review-pr", "lint", "compact", "review"]);
  await assert.rejects(a.list({ cwd: "/untrusted" }), /Folder not allowed/);
  await assert.rejects(a.list({ cwd: f.c.cwd, sessionId: "local_session" }), /Choose one/);
  await assert.rejects(a.list({ sessionId: "local_other" }), /not found/);
  assert.equal(f.sends().length, 0);
});
test("official draft sends the expanded prompt and preserves the visible invocation after reopening", async (t) => {
  const f = fixture(t), a = f.attach();
  assert.deepEqual(await a.start("/review-pr PR9"), {
    sessionId: "local_00000000-0000-4000-8000-000000000105",
  });
  assert.equal(f.sends()[0].args[0].text, "Review PR9");
  assert.equal(f.sends()[0].args[1].slashInput.text, "/review-pr PR9");
  assert.equal(f.reads(), 1);
  const reopened = f.attach();
  assert.equal((await reopened.draftTranscript())[0].message.content, "/review-pr PR9");
  await assert.rejects(reopened.start("/review-pr PR9"), /already exists/);
  assert.equal(f.sends().length, 1);
});

test("SSH draft and session selections send Markdown instructions and keep native Codex skill references", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const home = path.join(f.c.cwd, "host-home");
  const project = path.join(f.c.cwd, "host-project");
  const write = (root: string, file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  const userSkill = write(home, ".claude/skills/report/SKILL.md", "---\narguments: [target]\n---\nReport on $target using ${CLAUDE_SKILL_DIR}/template.md.");
  write(project, ".claude/skills/report/SKILL.md", "Lower precedence");
  const projectCommand = write(
    project,
    ".claude/commands/example.md",
    "---\nargument-hint: [first, second]\n---\nRun the first argument $ARGUMENTS[0] after $1.",
  );
  const nativeSkill = write(project, ".agents/skills/format-code/SKILL.md", "---\nname: format-code\ndescription: Format code.\n---\nFormat.");
  write(project, ".claude/commands/fork.md", "---\ncontext: fork\n---\nFork a subagent.");
  write(project, ".claude/commands/disabled.md", "---\nuser-invocable: false\n---\nUnavailable.");
  write(project, ".claude/commands/shell.md", "Show !`git status`");
  const exec = promisify(execFile);
  const run = connectionRunner({
    async exec(script) {
      const result = await exec("/bin/sh", ["-c", script]).catch(error => error);
      return { code: typeof result.code === "number" ? result.code : 0, stdout: result.stdout, stderr: result.stderr };
    },
  });
  const workspace = new RemoteWorkspace("selected-host", "Selected host", () => run);
  const remote = { kind: "ssh", hostId: "selected-host" };
  f.c.environment = remote;
  f.ctx.sshCodeEnvironment = () => ({ remoteTarget: { kind: "ssh", sshHost: "remote" }, homePath: home });
  const localCall = f.ctx.localCall;
  f.ctx.localCall = async (method: string, ...args: any[]) => {
    if (method === "officialSshTarget") return remote;
    if (method === "officialSshSlashCommands") {
      const [target, names] = args;
      if (target.kind === "draft" && target.hostId !== remote.hostId) return null;
      if (target.kind === "session") assert.equal(target.conversationId, "session");
      const trusted = target.kind === "session" || target.cwd === project ? project : undefined;
      const commands = await sshSlashCommands({
        workspace, home, project: trusted, names,
        ...(target.kind === "session" ? { codexSkills: { data: [{ skills: [
          { name: "format-code", path: nativeSkill },
          { name: "local-only", path: "/local/skills/local-only/SKILL.md" },
        ] }] } } : {}),
      });
      return { commands, project: trusted };
    }
    assert.notEqual(method, "listSlashCommands");
    assert.notEqual(method, "readCustomPrompt");
    return localCall(method, ...args);
  };
  const a = f.attach();
  const rows = [
    { name: "report", description: "(user)" },
    { name: "example", description: "(project)" },
    { name: "format-code", description: "(project)" },
  ];
  assert.deepEqual(await a.listSshDraft("other-host", project), null);
  assert.deepEqual(await a.listSshDraft(remote.hostId, "/other-folder"), rows.slice(0, 1));
  assert.deepEqual(await a.listSshDraft(remote.hostId, project), rows);
  assert.deepEqual(await a.list({ sessionId: "local_session" }), rows.map(row => ({ ...row, kind: "skill" })));

  const ref = (name: string, start = 0) => ({ kind: "local", name, start, end: start + name.length + 1 });
  const draftMessage = '/example "hello world" before';
  await a.start(draftMessage, {
    cwd: project, remoteTarget: { kind: "ssh", sshHost: "remote" },
    skillReferences: [ref("example")],
  });
  const draft = f.sends()[0];
  assert.ok(draft.args[0].text.includes(projectCommand));
  assert.ok(draft.args[0].text.endsWith("Run the first argument hello world after before."));
  assert.equal(draft.args[0].skillReferences, undefined);
  assert.equal(draft.args[1].slashInput.text, draftMessage);
  assert.equal((await a.draftTranscript())[0].message.content, draftMessage);

  const message = "Use /format-code and /report";
  const nativeRef = ref("format-code", message.indexOf("/format-code"));
  await a.run("sendMessage", message, [], [], [], "later", {}, "ssh-followup",
    undefined, undefined, undefined, undefined, undefined, undefined,
    { skillReferences: [nativeRef, ref("report", message.indexOf("/report"))] });
  const followup = f.sends()[1];
  assert.equal(followup.args[0].conversationId, "session");
  assert.ok(followup.args[0].text.startsWith(message));
  assert.ok(followup.args[0].text.includes(userSkill));
  assert.ok(followup.args[0].text.includes(path.join(path.dirname(userSkill), "template.md")));
  assert.deepEqual(followup.args[0].skillReferences, [nativeRef]);
  assert.equal(followup.args[1].slashInput.text, message);
});

test("first-turn skill syntax and failed draft prompt stay on the native start route", async (t) => {
  const skill = fixture(t), broken = fixture(t);
  await skill.attach().start("/lint src");
  assert.equal(skill.sends()[0].args[0].text, "$lint src");
  assert.equal(skill.reads(), 0);
  const a = broken.attach();
  broken.setBody(null);
  await assert.rejects(a.start("/review-pr PR9"), /no longer available/);
  assert.equal(broken.sends().length, 0);
  broken.setBody("Review $1");
  await a.start("/review-pr PR9");
  assert.equal(broken.sends().length, 1);
});

test("native output style, permission mode and auto-compact arguments persist through their existing host operations", async (t) => {
  const f = fixture(t), a = f.attach();
  await a.run("applyFlagSettings", { outputStyle: "Concise" });
  assert.equal((await a.run("getSession")).outputStyle, "Concise");
  assert.ok((await a.run("getSession")).availableOutputStyles.includes("Learning"));
  await assert.rejects(a.run("applyFlagSettings", { outputStyle: "missing" }), /unavailable/);
  assert.equal(await a.run("setPermissionMode", "plan"), true);
  assert.equal(await a.run("setPermissionMode", "unsupported"), false);
  assert.equal((await a.run("getSession")).permissionMode, "plan");
  await send(a, "/autocompact 1.5k", "limit");
  await send(a, "/autocompact auto", "auto");
  await assert.rejects(send(a, "/autocompact 999", "invalid"), /at least 1,000/);
  assert.deepEqual(f.calls.filter((call) => call.name === "saveSettings").map((call) => call.args[0].codeAutoCompactTokens), [1500, 0]);
  assert.equal(f.sends().length, 0);
});

test("native /review sends structured review targets and rejects invalid or busy commands without a model prompt", async (t) => {
  const f = fixture(t), a = f.attach();
  f.c.threadId = "thread";
  await send(a, "/review", "review-1");
  await send(a, "/review base main", "review-2");
  await send(a, "/review commit abcd1234", "review-3");
  await send(a, "/review Inspect the login page", "review-4");
  await assert.rejects(send(a, "/review commit unknown", "invalid"), /commit to review/);
  await assert.rejects(a.start("/review"), /before a local Code session starts/);
  f.c.turns[0].status = "inProgress";
  await assert.rejects(send(a, "/review", "busy"), /current turn/);
  assert.deepEqual(f.calls.filter((call) => call.name === "startReview").map((call) => call.args.slice(1, 3)), [
    [{ type: "uncommittedChanges" }, "/review"],
    [{ type: "baseBranch", branch: "main" }, "/review base main"],
    [{ type: "commit", sha: "abcd1234" }, "/review commit abcd1234"],
    [{ type: "custom", instructions: "Inspect the login page" }, "/review Inspect the login page"],
  ]);
  assert.equal(f.sends().length, 0);
});
test("task stop forwards only a child belonging to the owned local session", async (t) => {
  const f = fixture(t), a = f.attach();
  f.c.turns[0].items.push({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" });
  await a.run("stopTask", "child");
  assert.deepEqual(await a.run("getTaskOutput", "child"), { output: "Child finding", truncated: false });
  const childRows = (await a.run("getTranscript")).filter((r: any) => r.agentId === "child");
  assert.ok(childRows.some((r: any) => JSON.stringify(r.message).includes("Child finding") && r.parent_tool_use_id === "base:agent:spawn:child"));
  assert.deepEqual(f.calls.filter(c => c.name === "stopWorkflowAgent").map(c => c.args), [["session", "child"]]);
  await assert.rejects(a.run("stopTask", "other"), /not part/);
  await assert.rejects(a.run("getTaskOutput", "other"), /not part/);
  await assert.rejects(a.run("stopTask", "child\nwrong"), /not part/);
  f.c.sessionAuthors = { ownerAccountUuid: "other", viewerAccountUuid: "one" };
  await assert.rejects(a.run("stopTask", "child"), /not found/);
  assert.equal(f.calls.filter(c => c.name === "stopWorkflowAgent").length, 1);
});
test("known command expands once, acknowledges only confirmed receipt, and survives duplicate UUID after restart", async (t) => {
  const f = fixture(t),
    a = f.attach();
  await send(a, "/review-pr PR7", "uuid-1");
  assert.equal(f.sends()[0].args[0].text, "Review PR7");
  assert.equal((await a.run("getTranscript")).at(-1).message.content, "/review-pr PR7");
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.store.read().queues, []);
  assert.equal(f.store.read().commandReceipts?.[0][1][0][0], "uuid-1");
  f.setBody("CHANGED $1");
  await send(a, "/review-pr PR7", "uuid-1");
  const b = f.attach();
  await send(b, "/review-pr PR7", "uuid-1");
  assert.equal(f.sends().length, 1);
  assert.equal(f.reads(), 1);
  await assert.rejects(
    send(b, "/review-pr other", "uuid-1"),
    /already belongs/,
  );
  await pause();
});
test("queued command preserves original display and persisted expanded snapshot across prompt edits/restart", async (t) => {
  const f = fixture(t);
  f.c.turns[0].status = "inProgress";
  const a = f.attach();
  await send(a, "/review-pr PR8", "queued");
  const saved = f.store.read().queues[0][1][0];
  assert.equal(saved.message, "/review-pr PR8");
  assert.equal(saved.sendText, "Review PR8");
  assert.equal(saved.command?.source, "prompt");
  f.setBody("changed $ARGUMENTS");
  const b = f.attach();
  await send(b, "/review-pr PR8", "queued");
  const transcript = await b.run("getTranscript");
  assert.equal(transcript.at(-1).message.content, "/review-pr PR8");
  f.c.turns[0].status = "completed";
  await b.run("sendSteeredNow", "queued");
  assert.equal(f.sends().length, 1);
  assert.equal(f.sends()[0].args[0].text, "Review PR8");
  assert.equal(f.reads(), 1);
  await pause();
});
test("unknown delivery stays submitting and neither restart nor duplicate UUID auto-replays", async (t) => {
  const f = fixture(t);
  f.unknownSend();
  const a = f.attach();
  await assert.rejects(send(a, "/review-pr PR9", "unknown"), /unconfirmed/);
  assert.equal(f.sends().length, 1);
  assert.equal(f.store.read().queues[0][1][0].state, "submitting");
  f.setBody("changed");
  const b = f.attach();
  await b.run("getSession");
  await pause();
  assert.equal(await b.run("sendSteeredNow", "unknown"), false);
  await send(b, "/review-pr PR9", "unknown");
  assert.equal(f.sends().length, 1);
  assert.equal(f.reads(), 1);
  f.c.turns.push({
    id: "late",
    prompt: "Review PR9",
    attachments: [],
    items: [],
    status: "completed",
    createdAt: 5,
  });
  await b.run("getSession");
  await send(b, "/review-pr PR9", "unknown");
  assert.equal(f.sends().length, 1);
  assert.deepEqual(f.store.read().queues, []);
  await pause();
});
test("ordinary, unknown, escaped, nonleading and near-prefix literals remain unchanged; skills use explicit $ syntax", async (t) => {
  const f = fixture(t),
    a = f.attach();
  for (const [i, text] of [
    "hello",
    "\\/review-pr x",
    "text /review-pr x",
    " /review-pr x",
    "//review-pr x",
    "/review-prer x",
    "/unknown x",
  ].entries())
    await send(a, text, `literal-${i}`);
  assert.deepEqual(
    f.sends().map((c) => c.args[0].text),
    [
      "hello",
      "\\/review-pr x",
      "text /review-pr x",
      " /review-pr x",
      "//review-pr x",
      "/review-prer x",
      "/unknown x",
    ],
  );
  assert.equal(f.reads(), 0);
  await send(a, "/lint src", "skill");
  assert.equal(f.sends().at(-1)!.args[0].text, "$lint src");
  assert.equal(f.reads(), 0);
});
test("catalog failure, missing prompt and account switch during read cannot send or leave a new-owner queued command", async (t) => {
  const f = fixture(t),
    a = f.attach();
  f.sourceError();
  await assert.rejects(send(a, "/review-pr x", "failed"), /catalog offline/);
  await send(a, "ordinary literal", "plain");
  assert.equal(f.sends().length, 1);
  const g = fixture(t),
    b = g.attach();
  g.setBody(null);
  await assert.rejects(
    send(b, "/review-pr x", "missing"),
    /no longer available/,
  );
  assert.equal(g.sends().length, 0);
  const h = fixture(t),
    c = h.attach();
  h.onRead(async () => h.switch());
  await assert.rejects(send(c, "/review-pr x", "retired"), /account changed/);
  assert.equal(h.sends().length, 0);
  assert.deepEqual(h.store.read().queues, []);
});
test("unconfirmed steering is retained without a second automatic send", async (t) => {
  const f = fixture(t);
  f.c.turns[0].status = "inProgress";
  f.unknownSteer();
  const a = f.attach();
  await assert.rejects(send(a, "/review-pr x", "steer", "now"), /unknown/);
  assert.equal(f.store.read().queues[0][1][0].state, "submitting");
  const b = f.attach();
  f.c.turns[0].status = "completed";
  await b.run("getSession");
  await pause();
  assert.equal(f.calls.filter((c) => c.name === "steerTurn").length, 1);
  assert.equal(f.sends().length, 0);
  assert.equal(await b.run("sendSteeredNow", "steer"), false);
});

test("command UUID replay rejects changed attachment payload and successful delete clears receipts", async (t) => {
  const f = fixture(t),
    a = f.attach();
  await send(a, "/review-pr x", "same");
  await assert.rejects(
    a.run(
      "sendMessage",
      "/review-pr x",
      [{ base64: "eA==", mimeType: "image/png" }],
      [],
      [],
      "later",
      {},
      "same",
    ),
    /already belongs/,
  );
  assert.equal(f.sends().length, 1);
  await a.run("delete");
  assert.deepEqual(f.store.read().commandReceipts, []);
});
test("concurrent repeated command is locked while its prompt content is pending", async (t) => {
  const f = fixture(t),
    a = f.attach();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    hold = new Promise<void>((r) => (release = r));
  f.onRead(async () => {
    started();
    await hold;
  });
  const first = send(a, "/review-pr x", "pending");
  await ready;
  await assert.rejects(
    send(a, "/review-pr x", "pending"),
    /still being submitted/,
  );
  release();
  await first;
  assert.equal(f.reads(), 1);
  assert.equal(f.sends().length, 1);
});
test("malformed durable command snapshot fails closed; receipt resource cap never silently evicts idempotency", async (t) => {
  const f = fixture(t);
  f.store.write({
    version: 1,
    messageIds: [],
    queues: [
      [
        "session",
        [
          {
            uuid: "bad",
            message: "/review-pr x",
            sendText: "expanded without source",
            state: "queued",
            createdAt: 1,
          },
        ],
      ],
    ],
  } as never);
  assert.throws(() => f.store.read(), /invalid/);
  f.store.write({
    version: 1,
    queues: [],
    messageIds: [],
    commandReceipts: [
      [
        "session",
        Array.from({ length: 2000 }, (_, i) => [
          String(i),
          { inputHash: "0".repeat(64), payloadHash: "1".repeat(64) },
        ]),
      ],
    ],
  });
  const a = f.attach();
  await assert.rejects(send(a, "/review-pr x", "overflow"), /receipt limit/);
  assert.equal(f.sends().length, 0);
});

