import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { codeSessionState } from "../electron/official-ui/native/code-session-state";
import type { Conversation } from "../shared/types";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-followup-"));
  let owner = "alice",
    identity = {},
    sends = 0;
  const c = {
    id: "session",
    title: "History",
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
        prompt: "original",
        attachments: [],
        items: [{ id: "answer", type: "agentMessage", text: "answer" }],
        status: "completed",
        createdAt: 1,
      },
    ],
  } as Conversation;
  let send = async (input: any): Promise<any> => {
    c.turns.push({
      id: "turn-" + sends,
      prompt: input.text,
      attachments: [],
      items: [{ id: "reply-" + sends, type: "agentMessage", text: "reply" }],
      status: "completed",
      createdAt: sends + 1,
    });
    return structuredClone(c);
  };
  const ctx = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    localLoadConversation: async () => structuredClone(c),
    localListConversations: async () => [structuredClone(c)],
    async localCall(name: string, input: any): Promise<any> {
      if (name === "snapshot") return { approvals: [] };
      if (name === "send") {
        sends++;
        return send(input);
      }
      throw Error("Unexpected call: " + name);
    },
    onEvent: (_fn: any) => () => {},
    log() {},
  };
  const attach = () => {
    identity = {};
    const handlers = new Map<string, any>();
    registerExperimentalCodeSessions({
      ctx,
      on: (n: string, f: any) => handlers.set(n, f),
      emit() {},
    } as never);
    return (method: string, ...args: any[]) =>
      handlers.get("LocalSessions." + method)("local_session", ...args);
  };
  return {
    root,
    c,
    ctx,
    attach,
    sends: () => sends,
    setSend(fn: typeof send) {
      send = fn;
    },
    owner(value: string) {
      owner = value;
      identity = {};
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const send = (run: any, text: string, id: string, ...extra: any[]) =>
  run("sendMessage", text, [], [], [], "later", {}, id, ...extra);

test("completed plain-text request IDs are idempotent across restart, while new IDs may repeat text", async () => {
  const f = fixture();
  try {
    const run = f.attach();
    await send(run, "same text", "one");
    await send(run, "same text", "one");
    assert.equal(f.sends(), 1);
    const reopened = f.attach();
    await send(reopened, "same text", "one");
    assert.equal(f.sends(), 1);
    await assert.rejects(
      send(reopened, "different text", "one"),
      /already belongs/,
    );
    await send(reopened, "same text", "two");
    assert.equal(f.sends(), 2);
    const rows = await reopened("getTranscript");
    assert.equal(rows.filter((r: any) => r.uuid === "one").length, 1);
    assert.equal(rows.filter((r: any) => r.uuid === "two").length, 1);
  } finally {
    f.cleanup();
  }
});

test("a failed provisional follow-up keeps one history row and remains unconfirmed after restart", async () => {
  const f = fixture();
  try {
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "pending-failed",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "failed",
        error: "Service unavailable",
        createdAt: 2,
      });
      throw Error("Service unavailable");
    });
    await assert.rejects(
      send(f.attach(), "multiline\nfollow-up", "failed-input"),
      /Service unavailable/,
    );
    const run = f.attach(),
      rows = await run("getTranscript");
    assert.equal(rows.filter((r: any) => r.uuid === "failed-input").length, 1);
    assert.ok(
      rows.some(
        (r: any) =>
          r.isApiErrorMessage &&
          JSON.stringify(r).includes("Service unavailable"),
      ),
    );
    assert.equal(rows.at(-1).parentUuid, "failed-input");
    assert.deepEqual((await run("getSession")).sendsHeldAfterError, [
      "failed-input",
    ]);
    await send(run, "multiline\nfollow-up", "failed-input");
    assert.equal(f.sends(), 1);
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "retry",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 3,
      });
      return structuredClone(f.c);
    });
    await send(run, "multiline\nfollow-up", "explicit-retry");
    assert.equal(f.sends(), 1);
    assert.equal(await run("sendSteeredNow", "failed-input"), false);
    assert.equal(await run("cancelQueuedMessage", "failed-input"), true);
    assert.equal(await run("sendSteeredNow", "explicit-retry"), true);
    assert.equal(f.sends(), 2);
    assert.deepEqual(
      (await f.attach()("getTranscript"))
        .filter((r: any) => r.message.content === "multiline\nfollow-up")
        .map((r: any) => r.uuid),
      ["failed-input", "explicit-retry"],
    );
  } finally {
    f.cleanup();
  }
});

test("a proven pre-dispatch failure releases the queue and retains its receipt across restart", async () => {
  const f = fixture();
  try {
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "pending-ambiguous-same-text",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "failed",
        sendFailed: true,
        error: "Unknown delivery",
        createdAt: 2,
      });
      f.c.turns.push({
        id: "pending-failed-before-dispatch",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "failed",
        sendFailed: true,
        undispatchedCodeSendUuid: "first-id",
        error: "Resume timed out",
        createdAt: 2,
      });
      throw Error("Resume timed out");
    });
    await assert.rejects(send(f.attach(), "first", "first-id"), /Resume timed out/);
    const run = f.attach();
    assert.equal((await run("getSession")).sendsHeldAfterError, undefined);
    assert.equal((await run("getTranscript")).filter((r: any) => r.uuid === "first-id").length, 1);
    await send(run, "first", "first-id");
    assert.equal(f.sends(), 1);
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "followup",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 3,
      });
      return structuredClone(f.c);
    });
    await send(run, "followup", "second-id");
    assert.equal(f.sends(), 2);
    const reopened = f.attach();
    await send(reopened, "first", "first-id");
    assert.equal(f.sends(), 2);
    assert.equal((await reopened("getSession")).sendsHeldAfterError, undefined);
  } finally {
    f.cleanup();
  }
});

test("unknown direct-send outcome is durably held and never replayed by reopening or duplicate submission", async () => {
  const f = fixture();
  try {
    f.setSend(async () => {
      throw Error("acknowledgement lost");
    });
    await assert.rejects(
      send(f.attach(), "unknown delivery", "unknown"),
      /acknowledgement lost/,
    );
    const run = f.attach();
    assert.deepEqual((await run("getSession")).sendsHeldAfterError, [
      "unknown",
    ]);
    assert.ok(
      (await run("getTranscript")).some((r: any) => r.uuid === "unknown"),
    );
    await send(run, "unknown delivery", "unknown");
    assert.equal(await run("sendSteeredNow", "unknown"), false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.sends(), 1);
    assert.equal(
      codeSessionState(f.ctx as never).read().queues[0][1][0].state,
      "submitting",
    );
  } finally {
    f.cleanup();
  }
});

test("taking back a failed expanded command preserves its request identity", async () => {
  const f = fixture();
  try {
    codeSessionState(f.ctx as never).write({
      version: 1,
      messageIds: [],
      queues: [
        [
          "session",
          [
            {
              uuid: "command",
              message: "/review",
              sendText: "Inspect these changes",
              command: { name: "review", source: "prompt" },
              state: "submitting",
              before: ["base"],
              createdAt: 2,
            },
          ],
        ],
      ],
    });
    f.c.turns.push({
      id: "pending-command",
      prompt: "Inspect these changes",
      attachments: [],
      items: [],
      status: "failed",
      error: "Service unavailable",
      createdAt: 2,
    });
    const run = f.attach();
    assert.equal(await run("cancelQueuedMessage", "command"), true);
    const reopened = f.attach();
    await send(reopened, "/review", "command");
    await assert.rejects(
      send(reopened, "/review changed", "command"),
      /already belongs/,
    );
    assert.equal(f.sends(), 0);
  } finally {
    f.cleanup();
  }
});

test("a direct send acknowledged before a stable turn ID keeps its recoverable optimistic identity", async () => {
  const f = fixture();
  try {
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "pending-live",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 2,
      });
      return structuredClone(f.c);
    });
    const run = f.attach();
    await send(run, "live input", "live");
    const rows = await run("getTranscript");
    assert.equal(rows.filter((r: any) => r.uuid === "live").length, 1);
    assert.ok(!rows.some((r: any) => r.uuid.includes("pending-live")));
    f.c.turns.at(-1)!.id = "stable-live";
    f.c.turns.at(-1)!.status = "completed";
    const reopened = f.attach();
    assert.equal(
      (await reopened("getTranscript")).filter((r: any) => r.uuid === "live")
        .length,
      1,
    );
    await send(reopened, "live input", "live");
    assert.equal(f.sends(), 1);
    assert.deepEqual(codeSessionState(f.ctx as never).read().queues, []);
  } finally {
    f.cleanup();
  }
});

test("pane-held queued anchors are valid but foreign anchors cannot authorize a send", async () => {
  const f = fixture();
  try {
    f.c.turns[0].status = "inProgress";
    const run = f.attach();
    await send(run, "queued first", "queued-one");
    await send(
      run,
      "queued second",
      "queued-two",
      undefined,
      undefined,
      undefined,
      {
        uuids: ["base:user", "queued-one", "queued-two"],
        earlierCursor: "queued-one",
      },
    );
    assert.deepEqual(
      codeSessionState(f.ctx as never)
        .read()
        .queues[0][1].map((e) => e.uuid),
      ["queued-one", "queued-two"],
    );
    await assert.rejects(
      send(run, "forged", "forged", undefined, undefined, undefined, {
        uuids: ["other-account"],
      }),
      /paneHolds/,
    );
    assert.equal(f.sends(), 0);
  } finally {
    f.cleanup();
  }
});

test("240-turn history pages preserve every row, parent link, and multiline follow-up without resend", async () => {
  const f = fixture();
  try {
    f.c.turns = Array.from({ length: 240 }, (_, i) => ({
      id: "history-" + i,
      prompt: "prompt " + i,
      attachments: [],
      items: [{ id: "answer-" + i, type: "agentMessage", text: "answer " + i }],
      status: "completed",
      createdAt: i + 1,
    }));
    const run = f.attach();
    let page = await run("getTranscriptTail", 37),
      all = [...page.messages];
    while (page.hasMore) {
      page = await run("getTranscriptPage", all[0].uuid, 37);
      assert.equal(page.found, true);
      all = [...page.messages, ...all];
    }
    assert.equal(all.length, 480);
    assert.equal(new Set(all.map((r) => r.uuid)).size, 480);
    for (let i = 1; i < all.length; i++)
      assert.equal(all[i].parentUuid, all[i - 1].uuid);
    await send(run, "line one\nline two", "followup");
    const reopened = f.attach();
    const rows = await reopened("getTranscript");
    assert.equal(rows.length, 482);
    assert.equal(rows.at(-2).uuid, "followup");
    assert.equal(rows.at(-2).message.content, "line one\nline two");
    assert.equal(f.sends(), 1);
    assert.equal(
      (await reopened("getTranscriptPage", "missing", 37)).found,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("an old account direct-send completion cannot clear or copy another account queue", async () => {
  const f = fixture();
  try {
    let release!: (c: Conversation) => void, started!: () => void;
    const reached = new Promise<void>((r) => (started = r));
    f.setSend(async () => {
      started();
      return new Promise((r) => (release = r));
    });
    const run = f.attach(),
      old = assert.rejects(
        send(run, "alice input", "alice"),
        /account changed/,
      );
    await reached;
    f.owner("bob");
    f.c.turns[0].status = "inProgress";
    await send(run, "bob draft", "bob");
    release(structuredClone(f.c));
    await old;
    assert.deepEqual(
      codeSessionState(f.ctx as never)
        .read()
        .queues[0][1].map((e) => e.uuid),
      ["bob"],
    );
    f.owner("alice");
    const restored = f.attach();
    assert.ok(
      (await restored("getTranscript")).some((r: any) => r.uuid === "alice"),
    );
    assert.ok(
      !(await restored("getTranscript")).some((r: any) => r.uuid === "bob"),
    );
  } finally {
    f.cleanup();
  }
});

test("plain-text optimistic IDs persisted by older hosts cannot be replayed without receipts", async () => {
  const f = fixture();
  try {
    const text = "Use /fixture";
    f.c.turns[0].prompt = text;
    codeSessionState(f.ctx as never).write({
      version: 1,
      queues: [],
      messageIds: [["session", [["base:user", "old-id"]]]],
    });
    const run = f.attach();
    await send(run, text, "old-id");
    await assert.rejects(send(
      run, text, "old-id", undefined, undefined, undefined, undefined, undefined, undefined,
      { skillReferences: [{ kind: "local", name: "fixture", start: 4, end: 12 }] },
    ), /already belongs/);
    assert.equal(f.sends(), 0);
    await assert.rejects(send(run, "changed", "old-id"), /already belongs/);
  } finally {
    f.cleanup();
  }
});

test("an interrupted provisional queued send stays unconfirmed with its original UUID", async () => {
  const f = fixture();
  try {
    f.c.turns[0].status = "inProgress";
    const run = f.attach();
    await send(run, "queued request", "queued");
    f.c.turns[0].status = "completed";
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "pending-queued",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 2,
      });
      return structuredClone(f.c);
    });
    assert.equal(await run("sendSteeredNow", "queued"), true);
    assert.equal(
      codeSessionState(f.ctx as never).read().queues[0][1][0].state,
      "submitting",
    );
    assert.equal(
      (await run("getTranscript")).filter((r: any) => r.uuid === "queued")
        .length,
      1,
    );
    assert.equal(
      (await run("getSession")).sendsHeldAfterError,
      undefined,
      "a known running provisional turn is not an unknown-delivery error",
    );
    f.c.turns.at(-1)!.status = "interrupted";
    f.c.turns.at(-1)!.stopReason = "restart";
    const reopened = f.attach(),
      rows = await reopened("getTranscript");
    assert.equal(rows.filter((r: any) => r.uuid === "queued").length, 1);
    assert.ok(rows.at(-1).isApiErrorMessage);
    assert.deepEqual((await reopened("getSession")).sendsHeldAfterError, [
      "queued",
    ]);
    assert.equal(await reopened("sendSteeredNow", "queued"), false);
    await send(reopened, "queued request", "queued");
    assert.equal(f.sends(), 1);
  } finally {
    f.cleanup();
  }
});

test("plain-text receipt rejects changed attachment payload before touching attachment storage", async () => {
  const f = fixture();
  try {
    const run = f.attach();
    await send(run, "plain", "id");
    await assert.rejects(
      run(
        "sendMessage",
        "plain",
        [],
        [],
        [{ name: "changed.txt" }],
        "later",
        {},
        "id",
      ),
      /already belongs/,
    );
    assert.equal(f.sends(), 1);
  } finally {
    f.cleanup();
  }
});

test("failed follow-up identity and 240-turn history survive a separate Node process without automatic replay", () => {
  const f = fixture();
  try {
    const script = path.join(f.root, "restart.mjs");
    fs.writeFileSync(
      script,
      `
      import fs from 'node:fs';
      import {registerExperimentalCodeSessions} from ${JSON.stringify(pathToFileURL(path.resolve("electron/official-ui/native/code-sessions.ts")).href)};
      const root=process.argv[2], phase=process.argv[3], file=root+'/conversation.json';
      let c=phase==='seed'?{id:'process',mode:'code',cwd:root,title:'Long history',providerId:'p',model:'m',createdAt:1,updatedAt:1,turns:Array.from({length:240},(_,i)=>({id:'turn-'+i,prompt:'prompt '+i,status:'completed',createdAt:i+1,attachments:[],items:[{id:'answer-'+i,type:'agentMessage',text:'answer '+i}]}))}:JSON.parse(fs.readFileSync(file,'utf8'));
      let sends=0; const handlers=new Map();
      registerExperimentalCodeSessions({ctx:{account:()=>({id:'owner'}),stateDirectory:()=>root,localLoadConversation:async()=>structuredClone(c),log(){},onEvent:()=>()=>{},localCall:async(name,input)=>{
        if(name==='snapshot')return {approvals:[]};
        if(name==='send'){sends++;if(phase!=='seed')throw Error('Unexpected replay');c.turns.push({id:'pending-process',prompt:input.text,attachments:[],items:[],status:'failed',error:'Offline',createdAt:241});fs.writeFileSync(file,JSON.stringify(c));throw Error('Offline');}
        throw Error('Unexpected '+name);
      }},on:(name,fn)=>handlers.set(name,fn),emit(){}});
      const call=(method,...args)=>handlers.get('LocalSessions.'+method)('local_process',...args);
      if(phase==='seed'){try{await call('sendMessage','saved follow-up',[],[],[],'later',{},'saved');}catch(error){if(error.message!=='Offline')throw error;}}
      else {const rows=await call('getTranscript');await call('sendMessage','saved follow-up',[],[],[],'later',{},'saved');await new Promise(r=>setTimeout(r,300));console.log(JSON.stringify({rows:rows.length,first:rows[0].uuid,last:rows.at(-1).isApiErrorMessage,saved:rows.filter(r=>r.uuid==='saved').length,sends}));}
    `,
    );
    for (const phase of ["seed", "read"]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", script, f.root, phase],
        { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      if (phase === "read")
        assert.deepEqual(JSON.parse(result.stdout.trim()), {
          rows: 482,
          first: "turn-0:user",
          last: true,
          saved: 1,
          sends: 0,
        });
    }
  } finally {
    f.cleanup();
  }
});

test("new input cannot erase an older unknown delivery by matching its text", async () => {
  const f = fixture();
  try {
    const run = f.attach();
    f.setSend(async () => {
      throw Error("unknown");
    });
    await assert.rejects(send(run, "same", "unknown-id"), /unknown/);
    f.setSend(async (input) => {
      f.c.turns.push({
        id: "confirmed",
        prompt: input.text,
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 2,
      });
      return structuredClone(f.c);
    });
    await send(run, "same", "new-id");
    assert.equal(f.sends(), 1);
    const saved = codeSessionState(f.ctx as never).read().queues[0][1];
    assert.deepEqual(
      saved.map((e) => [e.uuid, e.state]),
      [
        ["unknown-id", "submitting"],
        ["new-id", "queued"],
      ],
    );
    assert.equal(saved[1].requiresConfirmation, true);
    assert.equal(await run("cancelQueuedMessage", "unknown-id"), true);
    assert.equal(await run("sendSteeredNow", "new-id"), true);
    assert.equal(f.sends(), 2);
    assert.equal(
      (await run("getTranscript")).filter((r: any) => r.uuid === "new-id")
        .length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("removing a prior history turn cannot make its submitted UUID reusable", async () => {
  const f = fixture();
  try {
    const run = f.attach();
    await send(run, "previous", "submitted-id");
    f.c.turns.pop();
    await assert.rejects(
      send(f.attach(), "previous", "submitted-id"),
      /already submitted/,
    );
    assert.equal(f.sends(), 1);
  } finally {
    f.cleanup();
  }
});
