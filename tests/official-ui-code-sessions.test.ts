import { codeReadSnapshot } from "../shared/code-read-state";
import { createCodeCommandPermissionHost } from "../electron/official-ui/code-command-permission-host";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectorUuid, permissionKeys } from "../electron/official-ui/api/connectors";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { convertCodeTranscript } from "../electron/official-ui/native/code-transcript";
import { defaultSettings } from "../electron/store/store";
import type { McpServerState } from "../shared/settings-desktop-api";
import type { AppEvent, Approval, Conversation, SessionPullRequest } from "../shared/types";
import type { SkillReference } from "../shared/skill-references";

function codePreferenceHost(options: {
  stateDirectory?: string;
  readPullRequests?: (c: Conversation) => Promise<SessionPullRequest[] | undefined>;
  beforeConversationRead?: () => Promise<void>;
} = {}) {
  const conversation: Conversation = {
    id: "code-preferences", title: "Code preferences", mode: "code", cwd: process.cwd(),
    providerId: "p", model: "m", createdAt: 1, updatedAt: 2, archived: false, pinned: false,
    turns: [{ id: "finished", prompt: "Review the settings", status: "completed",
      attachments: [], items: [], createdAt: 2 }],
    sessionAuthors: { ownerAccountUuid: "owner", viewerAccountUuid: "owner" },
  };
  const settings = { ...defaultSettings };
  let owner = "owner";
  let listener: ((event: AppEvent) => void) | undefined;
  let held: ((id: string) => boolean) | undefined;
  const events: Array<{ type: string; sessionId: string; data?: string; session?: unknown }> = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const updates: unknown[][] = [];
  const manualKeepAwake = new Set<string>();
  const stop = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: owner }),
      stateDirectory: () => options.stateDirectory,
      readOfficialCodeArchivePullRequests: options.readPullRequests,
      settings: () => settings,
      localLoadConversation: async (id: string) => {
        if (options.beforeConversationRead) await options.beforeConversationRead();
        if (id === conversation.id) return structuredClone(conversation);
      },
      localListConversations: async () => [structuredClone(conversation)],
      officialCodeManualKeepAwake: (id: string) => manualKeepAwake.has(id),
      setOfficialCodeManualKeepAwake: (id: string, enabled: boolean) => {
        if (enabled) manualKeepAwake.add(id);
        else manualKeepAwake.delete(id);
        listener?.({ type: "conversation", conversation });
      },
      localCall: async (method: string, ...args: unknown[]) => {
        if (method === "snapshot") return { approvals: [] };
        if (method === "updateConversation") {
          updates.push(args);
          Object.assign(conversation, args[1]);
          return structuredClone(conversation);
        }
        if (method === "officialUpdateSessionPullRequests") {
          const { current, next } = args[1] as { current: SessionPullRequest[]; next: SessionPullRequest[] };
          assert.deepEqual(current, conversation.pullRequests ?? []);
          conversation.pullRequests = structuredClone(next);
          listener?.({ type: "conversation", conversation: structuredClone(conversation) });
          return next;
        }
        if (method === "officialSetPrAutoFixIntent") {
          const { arm, own } = args[1] as { arm?: Conversation["prAutoFixArm"]; own?: boolean };
          if (arm) conversation.prAutoFixArm = arm;
          if (own !== undefined) conversation.prAutoFixOwnPrs = own;
          listener?.({ type: "conversation", conversation: structuredClone(conversation) });
          return;
        }
        throw Error("Unexpected local method: " + method);
      },
      registerOfficialCodeArchiveHold: (check: (id: string) => boolean) => {
        held = check;
        return () => { held = undefined; };
      },
      onEvent: (callback: (event: AppEvent) => void) => {
        listener = callback;
        return () => { listener = undefined; };
      },
      log: () => {},
    },
    on: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler),
    emit: (_module: string, _event: string, value: (typeof events)[number]) => events.push(value),
  } as never);
  const sessionId = "local_" + conversation.id;
  const publish = async (...changes: AppEvent[]) => {
    for (const change of changes.length ? changes : [{ type: "conversation", conversation } satisfies AppEvent])
      listener?.(change);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    conversation, settings, events, updates, sessionId, publish, stop,
    switchOwner: () => { owner = "other"; manualKeepAwake.clear(); },
    keepAwake: (...args: unknown[]) => handlers.get("LocalSessions.setManualKeepAwake")!(...args),
    list: () => handlers.get("LocalSessions.getSessionList")!(),
    call: (method: string, ...args: unknown[]) => handlers.get("LocalSessions." + method)!(sessionId, ...args),
    clearOwnPrPreference: () => handlers.get("LocalSessions.setAutoFixOwnPrsWanted")!(null, false),
    readPr: (cwd: string, branch: string) =>
      handlers.get("LocalSessions.getPrStateForBranch")!(cwd, branch, sessionId, "fixture/review"),
    hasArchiveHold: () => held?.(conversation.id),
  };
}

test("native Code toggles the temporary manual hold in session reads and updates", async (t) => {
  const f = codePreferenceHost();
  t.after(f.stop);
  f.conversation.keepAwake = true;
  const sessionUpdates = () => f.events.filter(event => event.type === "session_updated");
  assert.partialDeepStrictEqual(await f.call("getSession"), { manualKeepAwake: undefined });

  assert.equal(await f.keepAwake(f.sessionId, true), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.partialDeepStrictEqual(await f.call("getSession"), { manualKeepAwake: true });
  assert.partialDeepStrictEqual(await f.list(), { sessions: [{ manualKeepAwake: true }] });
  assert.partialDeepStrictEqual(sessionUpdates(), [{
    type: "session_updated", sessionId: f.sessionId, session: { manualKeepAwake: true },
  }]);

  await f.keepAwake(f.sessionId, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessionUpdates().length, 1);

  await f.keepAwake(f.sessionId, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.partialDeepStrictEqual(await f.call("getSession"), { manualKeepAwake: undefined });
  assert.partialDeepStrictEqual(sessionUpdates().at(-1), {
    type: "session_updated", sessionId: f.sessionId, session: { manualKeepAwake: undefined },
  });
  assert.equal(sessionUpdates().length, 2);
  assert.equal(f.conversation.keepAwake, true);
  assert.deepEqual(f.updates, []);
});

test("native Code validates manual holds and ignores unavailable sessions", async (t) => {
  const f = codePreferenceHost();
  t.after(f.stop);
  await assert.rejects(f.keepAwake(42, true));
  await assert.rejects(f.keepAwake(f.sessionId, "on"));
  await f.keepAwake("ses_cloud", true);
  await f.keepAwake("local_missing", true);
  f.conversation.archived = true;
  await f.keepAwake(f.sessionId, true);
  f.conversation.archived = false;
  f.conversation.cloudHosted = true;
  await f.keepAwake(f.sessionId, true);
  f.conversation.cloudHosted = false;
  f.conversation.cloudEnvironmentId = "cloud-environment";
  await f.keepAwake(f.sessionId, true);
  delete f.conversation.cloudEnvironmentId;
  assert.partialDeepStrictEqual(await f.call("getSession"), { manualKeepAwake: undefined });
  f.switchOwner();
  await f.keepAwake(f.sessionId, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, []);
});

test("native Code cannot acquire a manual hold after the calling account changes", async (t) => {
  let startingRead: () => void = () => {};
  let finishRead: () => void = () => {};
  const readStarted = new Promise<void>(resolve => { startingRead = resolve; });
  const readMayFinish = new Promise<void>(resolve => { finishRead = resolve; });
  const f = codePreferenceHost({
    beforeConversationRead: async () => { startingRead(); await readMayFinish; },
  });
  t.after(f.stop);
  const request = f.keepAwake(f.sessionId, true);
  await readStarted;
  f.switchOwner();
  finishRead();
  await assert.rejects(request, /account changed/);
  f.conversation.sessionAuthors = { ownerAccountUuid: "other", viewerAccountUuid: "other" };
  assert.partialDeepStrictEqual(await f.call("getSession"), { manualKeepAwake: undefined });
  assert.deepEqual(f.events, []);
});

test("native Code reads, updates and clears the current turn's prompt suggestion", async (t) => {
  const f = codePreferenceHost();
  t.after(f.stop);
  const suggestion = "Apply the review comments";
  f.conversation.promptSuggestion = { turnId: "finished", text: suggestion };
  assert.partialDeepStrictEqual(await f.call("getSession"), { promptSuggestion: suggestion });

  const suggestionEvents = () => f.events.filter(event => event.type === "prompt_suggestion");
  await f.publish();
  await f.publish();
  assert.deepEqual(suggestionEvents(), [
    { type: "prompt_suggestion", sessionId: f.sessionId, data: suggestion },
  ]);

  f.conversation.turns.push({ ...f.conversation.turns[0], id: "newest", status: "inProgress" });
  await f.publish();
  assert.equal(suggestionEvents().at(-1)?.data, "");
  f.conversation.turns[1].status = "completed";
  await f.publish();
  assert.equal(suggestionEvents().length, 2);
  assert.equal(Object.hasOwn(await f.call("getSession") as object, "promptSuggestion"), false);

  f.conversation.promptSuggestion = { turnId: "newest", text: "Run the tests" };
  await f.publish();
  assert.equal(suggestionEvents().at(-1)?.data, "Run the tests");
  f.settings.ccPromptSuggestions = false;
  await f.publish({ type: "settings", settings: f.settings });
  assert.equal(suggestionEvents().at(-1)?.data, "");
  assert.equal(Object.hasOwn(await f.call("getSession") as object, "promptSuggestion"), false);

  f.settings.ccPromptSuggestions = true;
  f.switchOwner();
  await f.publish();
  assert.equal(await f.call("getSession"), null);
  assert.equal(suggestionEvents().length, 4);
});

test("native Code persists the session PR switch and announces automatic archive once", async (t) => {
  const f = codePreferenceHost();
  t.after(f.stop);
  const url = "https://github.com/fixture/review/pull/3";
  f.conversation.pullRequests = [{
    repository: "fixture/review", number: 3, url, title: "Fixture change",
    headRef: "claude/review", own: true, state: "open", checkedAt: 2,
  }];
  f.conversation.codeAutoArchiveExempt = true;
  assert.partialDeepStrictEqual(await f.call("getSession"), {
    autoArchiveOnPrClose: false,
    prs: [{
      prNumber: 3, repo: "fixture/review", url, host: "github.com", title: "Fixture change",
      branch: "claude/review", state: "OPEN", own: true,
    }],
  });
  await assert.rejects(f.call("setSessionAutoArchiveOnPrClose", "off"));
  await f.call("setSessionAutoArchiveOnPrClose", false);
  await f.call("setSessionAutoArchiveOnPrClose", true);
  assert.deepEqual(f.updates, [
    [f.conversation.id, { prAutoArchive: false }],
    [f.conversation.id, { prAutoArchive: true }],
  ]);
  assert.partialDeepStrictEqual(await f.call("getSession"), { autoArchiveOnPrClose: true });

  f.conversation.archived = true;
  await f.publish(
    { type: "conversation", conversation: f.conversation, codeAutoArchived: true },
    { type: "conversation", conversation: f.conversation },
  );
  await f.publish();
  const archives = f.events.filter(event => event.type === "archived");
  assert.equal(archives.length, 1);
  assert.partialDeepStrictEqual(archives[0], {
    type: "archived", sessionId: f.sessionId, session: { isArchived: true },
  });
  f.switchOwner();
  await assert.rejects(f.call("setSessionAutoArchiveOnPrClose", false), /not found/);
  assert.equal(f.updates.length, 2);
});

test("the native PR panel reads the session's real branch and discards a retired read", async (t) => {
  const headRef = "claude/review";
  const url = "https://github.com/fixture/review/pull/3";
  const pullRequests = [{
    repository: "fixture/review", number: 3, url, headRef, state: "draft", checkedAt: 2,
  }] satisfies SessionPullRequest[];
  let reads = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const f = codePreferenceHost({
    readPullRequests: async () => {
      reads++;
      if (entered) await new Promise<void>(resolve => { release = resolve; entered?.(); });
      return pullRequests;
    },
  });
  t.after(f.stop);
  const cwd = f.conversation.cwd!;
  assert.deepEqual(await f.readPr(path.dirname(cwd), headRef), { success: false, errorKind: "unavailable" });
  assert.equal(reads, 0);
  assert.deepEqual(await f.readPr(cwd, "claude/unrelated"), { success: true });
  assert.partialDeepStrictEqual(await f.readPr(cwd, headRef), {
    success: true, number: 3, url, state: "open", isDraft: true,
  });
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const request = f.readPr(cwd, headRef);
  await pending;
  f.switchOwner();
  release?.();
  await assert.rejects(request, /account changed/);
});

test("native Code renders, toggles and dismisses the authenticated PR binding", async (t) => {
  const headRef = "claude/review";
  const url = "https://github.com/fixture/review/pull/3";
  const f = codePreferenceHost({
    readPullRequests: async () => [{
      repository: "fixture/review", number: 3, url, headRef, baseRef: "main",
      own: true, state: "draft", checkedAt: 2,
    }],
  });
  t.after(f.stop);
  f.conversation.turns[0].items.push({
    id: "reply", type: "agentMessage", text: `<pr-created>${url}</pr-created>`,
  });
  await f.publish({ type: "conversation", conversation: f.conversation, settledCodeTurnId: "finished" });
  assert.partialDeepStrictEqual(f.events.filter(event => event.type === "session_updated").at(-1)?.session, {
    prs: [{ prNumber: 3, provider: "github", branch: headRef, baseRef: "main", state: "OPEN", own: true }],
  });
  await f.call("setBoundPrAutoFix", "other/repo", 3, true, "github.com");
  await f.call("setBoundPrAutoFix", "fixture/review", 3, true, "other.example");
  assert.partialDeepStrictEqual(await f.call("getSession"), { prs: [{ autoFix: undefined }] });
  await f.call("setBoundPrAutoFix", "FIXTURE/Review", 3, true, "github.com");
  assert.partialDeepStrictEqual(await f.call("getSession"), { prs: [{ autoFix: true }] });
  await f.call("setBoundPrAutoFix", "fixture/review", 3, false);
  await f.call("dismissBoundPr", "fixture/review", 3);
  await f.call("setBoundPrAutoFix", "fixture/review", 3, true);
  assert.partialDeepStrictEqual(await f.call("getSession"), { prs: [{ autoFix: false, dismissed: true }] });
  f.switchOwner();
  await f.call("setBoundPrAutoFix", "fixture/review", 3, true);
  assert.equal(await f.call("armAutoFixOnNextPr", headRef), "refused");
});

test("native Code resolves a Create PR arm after its branch is armed and clears own intent", async (t) => {
  const f = codePreferenceHost();
  t.after(f.stop);
  const branch = "claude/next";
  await f.call("setAutoFixOwnPrsWanted", true);
  assert.equal(f.conversation.prAutoFixOwnPrs, true);
  const result = f.call("armAutoFixOnNextPr", branch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.conversation.prAutoFixArm?.branch, branch);
  f.conversation.pullRequests = [{
    repository: "fixture/review", number: 3, url: "https://github.com/fixture/review/pull/3",
    headRef: branch, state: "open", checkedAt: 2, autoFix: { ci: true, comments: true },
  }];
  delete f.conversation.prAutoFixArm;
  await f.publish();
  assert.equal(await result, "armed");
  await f.clearOwnPrPreference();
  assert.equal(f.conversation.prAutoFixOwnPrs, false);
});

test("off-host Code exposes saved PR state without acting through the desktop GitHub account", async (t) => {
  const f = codePreferenceHost({
    readPullRequests: async () => { throw Error("The desktop cannot read this checkout."); },
  });
  t.after(f.stop);
  const branch = "claude/remote";
  f.conversation.environment = { kind: "wsl", distro: "Ubuntu" };
  f.conversation.pullRequests = [{
    repository: "fixture/review", number: 3, url: "https://github.com/fixture/review/pull/3",
    headRef: branch, state: "open", checkedAt: 2,
  }];
  assert.partialDeepStrictEqual(await f.readPr(f.conversation.cwd!, branch), {
    success: true, number: 3, headRefName: branch,
  });
  await f.call("setBoundPrAutoFix", "fixture/review", 3, true);
  await f.call("dismissBoundPr", "fixture/review", 3);
  await f.call("setAutoFixOwnPrsWanted", true);
  assert.equal(await f.call("armAutoFixOnNextPr", branch), "refused");
  assert.equal(f.conversation.pullRequests[0].autoFix, undefined);
  assert.equal(f.conversation.pullRequests[0].dismissed, undefined);
  assert.equal(f.conversation.prAutoFixOwnPrs, undefined);
});

test("automatic Code archive respects a pending queue after reopening the host", async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-native-archive-"));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const f = codePreferenceHost({ stateDirectory });
  try {
    assert.equal(f.hasArchiveHold(), false);
    f.conversation.turns[0].status = "inProgress";
    await f.call("sendMessage", "Queued follow-up", [], [], [], "later", {}, "archive-hold");
    assert.equal(f.hasArchiveHold(), true);
  } finally {
    f.stop();
  }
  assert.equal(f.hasArchiveHold(), undefined);
  const reopened = codePreferenceHost({ stateDirectory });
  t.after(reopened.stop);
  assert.equal(reopened.hasArchiveHold(), true);
});

test("a selected Code skill cannot steer and keeps its exact span when the queue dispatches", async () => {
  const text = "Use /fixture after /fixture";
  const skillReferences: SkillReference[] = [{ kind: "local", name: "fixture", start: 19, end: 27 }];
  const c: Conversation = {
    id: "queued-skill", title: "Skills", mode: "code", providerId: "p", model: "m",
    cwd: process.cwd(), archived: false, pinned: false, createdAt: 1, updatedAt: 1,
    turns: [{ id: "first", prompt: "first", status: "inProgress", items: [], attachments: [], createdAt: 1 }],
  };
  const calls: unknown[][] = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async () => c,
      onEvent: () => () => {},
      localCall: async (...args: unknown[]) => {
        if (args[0] === "snapshot") return { approvals: [] };
        calls.push(args);
        if (args[0] === "send") c.turns.push({ id: "next", prompt: text,
          status: "inProgress", items: [], attachments: [], createdAt: 2 });
        return c;
      },
    },
    on(name: string, handler: (...args: unknown[]) => Promise<unknown>) { handlers.set(name, handler); },
    emit() {},
  } as never);
  const call = (method: string, ...args: unknown[]) => handlers.get(`LocalSessions.${method}`)!("local_queued-skill", ...args);
  const send = (marks: object) => call("sendMessage", text, [], [], [], "next", { ccdSteering: true }, "skill-uuid",
    undefined, undefined, undefined, undefined, undefined, undefined, marks);
  await send({ skillReferences });
  assert.equal(await call("sendSteeredNow", "skill-uuid"), false);
  assert.equal(calls.length, 0);
  await assert.rejects(send({ skillReferences: [{ ...skillReferences[0], start: 4, end: 12 }] }), /already belongs/);
  c.turns[0].status = "completed";
  assert.equal(await call("sendSteeredNow", "skill-uuid"), true);
  assert.deepEqual(calls[0]?.slice(0, 2), ["send", {
    conversationId: c.id, continueCodeSession: true, mode: "code", text, skillReferences,
    attachments: [], providerId: "p", model: "m",
  }]);
  await send({ skillReferences });
  await assert.rejects(send({ skillReferences: [{ ...skillReferences[0], start: 4, end: 12 }] }), /already belongs/);
  assert.equal(calls.length, 1);
});
test("legacy new-task input is visible, preserved, and never sent without confirmation",async()=>{
 const handlers=new Map<string,any>(),calls:any[]=[],events:any[]=[];
 const c:any={id:'legacy',mode:'code',cwd:'/work',providerId:'p',model:'m',updatedAt:1,turns:[],codeNewTask:{id:'offer',text:'Original saved request',attachments:[],providerId:'p',model:'m'}};
 registerExperimentalCodeSessions({ctx:{account:()=>({id:'a'}),localLoadConversation:async()=>structuredClone(c),localCall:async(name:string,...args:any[])=>{
  calls.push([name,...args]);if(name==='snapshot')return {approvals:[]};
  if(name==='officialReleaseCodeNewTask'){delete c.codeNewTask;return true;}
  if(name==='send'){assert.equal(args[0].continueCodeSession,true);c.turns.push({id:'sent',status:'completed',prompt:args[0].text,attachments:[],items:[],createdAt:2});return structuredClone(c);}
 },onEvent:()=>()=>{}},on:(n:string,f:any)=>handlers.set(n,f),emit:(...args:any[])=>events.push(args)} as never);
 const view=await handlers.get('LocalSessions.getSession')('local_legacy');
 assert.deepEqual(view.sendsHeldAfterError,['legacy-task-offer']);
 assert.equal(c.codeNewTask,undefined);
 const rows=await handlers.get('LocalSessions.getTranscript')('local_legacy');
 assert.ok(JSON.stringify(rows).includes('Original saved request'));
 assert.equal(calls.filter(a=>a[0]==='send').length,0);
 await handlers.get('LocalSessions.sendSteeredNow')('local_legacy','legacy-task-offer');
 assert.equal(calls.filter(a=>a[0]==='send').length,1);
 assert.equal(c.turns[0].prompt,'Original saved request');
});

test('official Context Compact invokes engine compaction and never sends a slash prompt',async()=>{
 const calls:any[]=[],handlers=new Map<string,any>(),c:any={id:'compact',mode:'code',cwd:'/work',turns:[]};
 registerExperimentalCodeSessions({ctx:{account:()=>({id:'a'}),localLoadConversation:async()=>c,localCall:async(...a:any[])=>calls.push(a),onEvent:()=>()=>{}},on:(n:string,f:any)=>handlers.set(n,f),emit(){}} as never);
 await handlers.get('LocalSessions.sendMessage')('local_compact','/compact',[],[],[],'later',{},'compact-id');
 assert.deepEqual(calls.map(call=>call.slice(0,3)),[['compactConversation','compact','compact-id']]);
 c.turns=[{status:'inProgress'}];await assert.rejects(handlers.get('LocalSessions.sendMessage')('local_compact','/compact',[],[],[],'later',{},'compact-2'),/finish/);assert.equal(calls.length,1);
});

test("cloud-hosted mirrors cannot be sent, interrupted or reconfigured through local native methods",async()=>{
 const handlers=new Map<string,(...args:any[])=>any>(),calls:any[]=[];
 const c={id:'cloud-mirror',mode:'code',cloudHosted:true,cwd:'/authorized',turns:[]};
 registerExperimentalCodeSessions({ctx:{account:()=>({id:'a'}),localListConversations:async()=>[c],localLoadConversation:async()=>c,localCall:async(...args:any[])=>{calls.push(args);},on:(name:string,fn:any)=>handlers.set(name,fn),onEvent:()=>()=>{}},on:(name:string,fn:any)=>handlers.set(name,fn),emit(){}} as never);
 assert.equal(await handlers.get('LocalSessions.getSession')!('local_cloud-mirror'),null);
 assert.deepEqual((await handlers.get('LocalSessions.getSessionList')!()).sessions,[]);
 for(const [method,args]of [
  ['sendMessage',['local_cloud-mirror','hello',[],[],[],'later',{},'uuid']],
  ['interrupt',['local_cloud-mirror']],['stop',['local_cloud-mirror']],
  ['setModel',['local_cloud-mirror','model']],['setEffort',['local_cloud-mirror','low']],
  ['getTranscript',['local_cloud-mirror']]
 ] as [string,any[]][]){await assert.rejects(Promise.resolve().then(()=>handlers.get('LocalSessions.'+method)!(...args)),/not found/);}
 assert.deepEqual(calls,[], 'No mirror request may reach a local engine call');
});

test("starting local Code cannot reuse an existing cloud session ID", async () => {
  const cloudId = "4c62cba1-577c-48df-b9d5-cf195d740ff5";
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: unknown[] = [];
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      isCloudConversation: (id: string) => id === cloudId,
      localLoadConversation: async () => undefined,
      settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "m" }] }),
      localCall: async (method: string, input: unknown) => {
        if (method === "send") sent.push(input);
        return { id: cloudId, mode: "code", cwd: "/project", turns: [] };
      },
      onEvent: () => () => {},
    },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    emit() {},
  } as never);

  await assert.rejects(handlers.get("LocalSessions.start")!({
    sessionId: `local_${cloudId}`,
    cwd: "/project",
    message: "This ID belongs to the cloud session",
  }), /session already exists/i);
  assert.deepEqual(sent, []);
});

test("the original Remote Control picker applies its override and reports a live link", async () => {
  const id = "a9fae600-57a3-4ab7-af66-71178d74feca";
  const handlers = new Map<string, (...args: any[]) => any>();
  const settings = { ...defaultSettings, remoteControl: true, remoteControlNewSessions: true,
    activeProviderId: "test", providers: [{ id: "test", model: "test" }] };
  let conversation: { id: string; mode: "code"; cwd: string; turns: []; remoteControlOff?: boolean } | undefined;
  let online = true;
  let override: boolean | undefined;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      settings: () => settings,
      localRemoteControlStatus: () => ({ id: "pc-test-device", online }),
      officialRemoteControlOrigin: () => "https://test.example",
      localLoadConversation: async () => conversation,
      localCall: async (name: string, ...args: any[]) => {
        if (name === "send") {
          override = args[0].codeRemoteControlAtStart;
          conversation = { id, mode: "code", cwd: "/test", turns: [], remoteControlOff: override === false };
          return conversation;
        }
        if (name === "updateConversation" && conversation) {
          conversation.remoteControlOff = !args[1].remoteControl;
          return conversation;
        }
        if (name === "snapshot") return { approvals: [] };
        throw Error(name);
      },
      onEvent: () => () => {},
    },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    emit() {},
  } as never);
  const call = (name: string, ...args: unknown[]) => handlers.get("LocalSessions." + name)!(...args);
  assert.deepEqual(await call("getRemoteControlStartState"), { defaultOn: true, overridable: true });
  const start = await call("start", { cwd: "/test", message: "Start here", remoteControlAtStart: false });
  assert.equal(override, false);
  assert.equal((await call("getSession", start.sessionId)).bridgeSessionUrl, undefined);
  assert.deepEqual(await call("toggleRemoteControl", start.sessionId, true), { ok: true });
  assert.equal((await call("getSession", start.sessionId)).bridgeSessionUrl,
    "https://test.example/code/session_a9fae60057a34ab7af6671178d74feca?device=pc-test-device");
  online = false;
  assert.equal((await call("getSession", start.sessionId)).remoteControlConnecting, true);
  assert.deepEqual(await call("toggleRemoteControl", start.sessionId, false), { ok: true });
  assert.equal((await call("getSession", start.sessionId)).remoteControlConnecting, undefined);
});

test("opening existing local history clears unread without resending an interrupted turn",async()=>{
  const handlers=new Map<string,(...a:any[])=>any>(),calls:any[]=[];
  const c={id:'opened',mode:'code',cwd:'/authorized',unread:true,createdAt:1,updatedAt:2,turns:[{id:'t',status:'interrupted',createdAt:2,stopReason:'restart',prompt:'original',items:[]}]};
  registerExperimentalCodeSessions({ctx:{account:()=>({id:'a'}),localLoadConversation:async(id:string)=>id==='opened'?c:undefined,localCall:async(...args:any[])=>{calls.push(args);return {...c,unread:false,readStateRevision:1};},onEvent:()=>()=>{}},on(name:string,fn:any){handlers.set(name,fn);},emit(){}} as never);
  await handlers.get('LocalSessions.personOpenedSession')!('local_opened');
  assert.deepEqual(calls,[['updateConversation','opened',{unread:{version:1,expected:codeReadSnapshot(c as unknown as Conversation)}}]]);
  assert.equal(c.turns[0].status,'interrupted');
  await assert.rejects(handlers.get('LocalSessions.personOpenedSession')!('local_unknown'),/not found/);
  assert.equal(calls.length,1);
});

test("the landing page starts in its authorized scratch folder with empty connector maps and keeps its optimistic session id", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const rawId = "2f3a06f5-a30a-46a0-a914-5021272f6c23";
  let sent: any;
  registerExperimentalCodeSessions({
    ctx: {
      createScratchWorkspace: () => ({ cwd: "/authorized-scratch" }),
      settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "m" }] }),
      localLoadConversation: async () => undefined,
      onEvent: () => () => {},
      localCall: async (method: string, input: any) => {
        assert.equal(method, "send");
        sent = input;
        return { id: input.newConversationId, mode: "code", cwd: input.cwd, turns: [], createdAt: 1, updatedAt: 1 };
      },
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit() {},
  } as never);
  const workspace = handlers.get("LocalSessions.createScratchWorkspace")!();
  assert.equal(workspace.cwd, "/authorized-scratch");
  await handlers.get("LocalSessions.updateSession")!(`local_${rawId}`, { title: "", titleSource: "auto" });
  const result = await handlers.get("LocalSessions.start")!({
    sessionId: `local_${rawId}`, cwd: workspace.cwd, message: "hello", mcpServers: {}, remoteMcpServers: [],
  });
  assert.equal(result.sessionId, `local_${rawId}`);
  assert.equal(sent.newConversationId, rawId);
  assert.equal(sent.cwd, workspace.cwd);
  await assert.rejects(
    handlers.get("LocalSessions.start")!({
      cwd: workspace.cwd,
      message: "hello",
      mcpServers: { forged: { command: "bad" } },
    }),
    /local MCP server configuration changed/,
  );
});

test("the landing page starts Code with the account's local MCP configuration snapshot", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: Record<string, unknown>[] = [];
  registerExperimentalCodeSessions({
    ctx: {
      settings: () => ({
        activeProviderId: "p",
        providers: [{ id: "p", model: "m" }],
        mcpServers: {
          demo: {
            command: "node",
            args: ["server.cjs"],
            env: { MODE: "demo" },
          },
          helper: { command: "helper" },
          disabled: { command: "node", enabled: false },
          extension: { command: "node", claudex_extension: "/extension" },
        },
      }),
      onEvent: () => () => {},
      localCall: async (method: string, input: Record<string, unknown>) => {
        assert.equal(method, "send");
        sent.push(input);
        return {
          id: "code",
          mode: "code",
          cwd: input.cwd,
          turns: [],
          createdAt: 1,
          updatedAt: 1,
        };
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);

  const start = handlers.get("LocalSessions.start")!;
  const input = {
    cwd: "/authorized-scratch",
    message: "hello",
    remoteMcpServers: [],
    enabledMcpTools: {},
  };
  const mcpServers = {
    demo: { command: "node", args: ["server.cjs"], env: { MODE: "demo" } },
    helper: { command: "helper", args: [] },
  };
  assert.deepEqual(await start({ ...input, mcpServers }), {
    sessionId: "local_code",
  });
  assert.equal(sent[0].text, input.message);
  assert.equal(Object.hasOwn(sent[0], "mcpServers"), false);
  await assert.rejects(
    start({
      ...input,
      mcpServers: {
        ...mcpServers,
        demo: { ...mcpServers.demo, env: { MODE: "changed" } },
      },
    }),
    /local MCP server configuration changed/,
  );
  assert.equal(sent.length, 1);
});

test("Code starts with installed extension tool choices and URL-backed connector selections", async () => {
  const local = {
    name: "f048-fixture",
    command: "node server.cjs",
    desktopExtension: true,
    state: "ready",
    tools: 1,
    toolList: [
      {
        name: "f048_echo",
        description: "Echo",
        enabled: true,
        definition: { name: "f048_echo" },
      },
    ],
  } satisfies McpServerState;
  const remote = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    tools: 1,
    toolList: [
      {
        name: "lookup",
        description: "Lookup",
        enabled: true,
        definition: { name: "lookup" },
      },
    ],
  } satisfies McpServerState;
  const mcpServers = {
    [local.name]: {
      command: "node",
      args: ["server.cjs"],
      claudex_extension: "/account/extensions/f048-fixture",
      claudex_extension_id: "local.mcpb.f048.f048-fixture",
    },
    [remote.name]: { url: remote.url },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  let conversation: Conversation | undefined;
  let discoveredLocal: McpServerState = local;
  registerExperimentalCodeSessions({
    ctx: {
      settings: () => ({
        mcpServers,
        activeProviderId: "p",
        providers: [{ id: "p", model: "m" }],
      }),
      localMcpConfig: () =>
        JSON.stringify({ [local.name]: mcpServers[local.name] }),
      localLoadConversation: async (id: string) =>
        conversation?.id === id ? conversation : undefined,
      onEvent: () => () => {},
      localCall: async (method: string, input: Partial<Conversation>) => {
        if (method === "mcpServers")
          return { servers: [discoveredLocal, remote] };
        if (method === "snapshot") return { approvals: [] };
        assert.equal(method, "send");
        conversation = {
          id: "code",
          mode: "code",
          title: "Code",
          providerId: "p",
          model: "m",
          pinned: false,
          archived: false,
          cwd: input.cwd,
          turns: [],
          createdAt: 1,
          updatedAt: 1,
          connectorOverrides: input.connectorOverrides,
          connectorToolOverrides: input.connectorToolOverrides,
        };
        return conversation;
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);

  const localKey = "local:local.mcpb.f048.f048-fixture:f048_echo";
  const remoteKey = permissionKeys(remote, remote.toolList[0]).enabled;
  const input = {
    cwd: "/authorized-scratch",
    message: "hello",
    remoteMcpServers: [{ uuid: connectorUuid(remote.name), url: remote.url }],
    enabledMcpTools: { [localKey]: true, [remoteKey]: false },
  };
  const start = handlers.get("LocalSessions.start")!;
  assert.deepEqual(await start(input), { sessionId: "local_code" });
  assert.deepEqual(conversation?.connectorOverrides, {});
  assert.deepEqual(conversation?.connectorToolOverrides, {
    wiki: { lookup: false },
  });

  discoveredLocal = { ...local, state: "starting", tools: 0, toolList: [] };
  const refreshed = await handlers.get("LocalSessions.replaceRemoteMcpServers")!(
    "local_code",
    input.remoteMcpServers,
  );
  assert.equal(refreshed.enabledMcpTools[localKey], true);
  const restored = await handlers.get("LocalSessions.getSession")!(
    "local_code",
  );
  assert.equal(restored.enabledMcpTools[localKey], true);
  assert.equal(restored.enabledMcpTools[remoteKey], false);
  await assert.rejects(
    start({ ...input, enabledMcpTools: { [localKey + "_unknown"]: true } }),
    /no longer available/,
  );
  const localRow = { uuid: connectorUuid(local.name), enabled: true };
  await assert.rejects(
    start({ ...input, remoteMcpServers: [localRow] }),
    /connector list changed/,
  );
  await assert.rejects(
    handlers.get("LocalSessions.setMcpServers")!("local_code", [localRow]),
    /connector list changed/,
  );
});

test("original Ultracode and effort settings update the next turn independently", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: Array<{ model: { expected: unknown; choice: object } }> = [];
  const c: Conversation = {
    id: "code-one", title: "Example", mode: "code", model: "m", providerId: "p", cwd: process.cwd(),
    createdAt: 1, updatedAt: 1, archived: false, pinned: false,
    turns: [{ id: "running", status: "inProgress", prompt: "Working", attachments: [], items: [],
      createdAt: 1, codeUltracode: false }],
  };
  const runningTurn = structuredClone(c.turns[0]);
  let available = true;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      settings: () => ({ codeEffort: "high" }),
      modelCatalog: async () => ({ items: [{ id: "m", efforts: ["low", "high", "xhigh"] }] }),
      codeUltracodeAvailable: (providerId: string, model: string, sessionId: string) =>
        available && providerId === c.providerId && model === c.model && sessionId === c.id,
      localLoadConversation: async (id: string) => id === c.id ? structuredClone(c) : undefined,
      localListConversations: async () => [structuredClone(c)],
      localCall: async (method: string, id?: string, patch?: (typeof calls)[number]) => {
        if (method === "snapshot") return { approvals: [] };
        assert.equal(method, "updateConversation");
        assert.equal(id, c.id);
        assert.ok(patch);
        calls.push(patch);
        Object.assign(c, patch.model.choice);
        return structuredClone(c);
      },
      onEvent: () => () => {},
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit() {},
  } as never);
  const apply = handlers.get("LocalSessions.applyFlagSettings")!;
  const get = () => handlers.get("LocalSessions.getSession")!("local_code-one");
  assert.equal((await get()).ultracode, false);
  await apply("local_code-one", { ultracode: true });
  assert.deepEqual(calls[0].model.choice, { codeUltracode: true });
  assert.equal((await get()).ultracode, true);
  const list = await handlers.get("LocalSessions.getSessionList")!();
  assert.equal(list.sessions[0].ultracode, true);
  await apply("local_code-one", { effortLevel: "low", ultracode: true });
  assert.deepEqual(calls[1], { model: { version: 1,
    expected: { providerId: "p", model: "m", effort: null, codeUltracode: true },
    choice: { effort: "low", codeUltracode: true },
  } });
  assert.equal((await get()).effort, "low");
  assert.deepEqual(c.turns[0], runningTurn);

  available = false;
  assert.equal((await get()).ultracode, false);
  await assert.rejects(apply("local_code-one", { effortLevel: "high", ultracode: true }), /not supported/);
  await assert.rejects(apply("local_code-one", { effortLevel: 123 }), /not supported/);
  await assert.rejects(apply("local_code-one", { effortLevel: "high", bypassPermissions: true }), /not supported/);
  await assert.rejects(apply("local_code-one", { ultracode: "true" }), /not supported/);
  await assert.rejects(apply("local_other", { effortLevel: "high" }), /not found/);
  assert.equal(calls.length, 2, "failed flag changes must not partially update the session");
  await apply("local_code-one", { ultracode: false });
  assert.deepEqual(calls[2].model.choice, { codeUltracode: false });
  available = true;
  assert.equal((await get()).ultracode, false);
  assert.equal((await get()).effort, "low");
});

test("original Code start uses the selected Ultracode mode and refuses Fast before dispatch", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: Record<string, unknown>[] = [];
  let c: Conversation | undefined;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "ordinary" }] }),
      codeUltracodeAvailable: (providerId: string, model: string) => providerId === "p" && model === "capable",
      localLoadConversation: async (id: string) => c?.id === id ? c : undefined,
      onEvent: () => () => {},
      localCall: async (method: string, input: Pick<Conversation, "cwd" | "providerId" | "model" | "codeUltracode">) => {
        if (method === "snapshot") return { approvals: [] };
        assert.equal(method, "send");
        sent.push(input);
        c = { ...input, id: "code-modes", mode: "code", title: "Example", turns: [],
          createdAt: 1, updatedAt: 1, archived: false, pinned: false };
        return c;
      },
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit() {},
  } as never);
  const call = (name: string, ...args: unknown[]) => handlers.get("LocalSessions." + name)!(...args);
  const draft = { cwd: process.cwd(), message: "Create a plan" };
  await assert.rejects(call("start", { ...draft, ultracode: true }), /Ultracode is not supported/);
  await assert.rejects(call("start", {
    ...draft, model: "capable", ultracode: true, fastMode: true,
    useWorktree: true, attachments: [{ name: "notes.txt", base64: "aGk=" }],
  }), /Fast mode is unavailable/);
  await assert.rejects(call("start", { ...draft, fastMode: "false" }), /boolean/);
  assert.equal(sent.length, 0);
  await call("start", { ...draft, fastMode: false, ultracode: false });
  assert.equal(sent[0].codeUltracode, undefined);
  assert.equal(sent[0].fastMode, undefined);
  const { sessionId } = await call("start", { ...draft, model: "capable", effort: "high", ultracode: true });
  assert.equal(sent[1].codeUltracode, true);
  assert.equal(sent[1].effort, "high");
  assert.equal((await call("getSession", sessionId)).ultracode, true);
  await assert.rejects(call("setFastMode", sessionId, true), /Fast mode is unavailable/);
  await assert.rejects(call("setFastMode", "local_other", false), /not found/);
  assert.equal(await call("setFastMode", sessionId, false), undefined);
  assert.equal(sent.length, 2);
});

test("the official stop button's interrupt method reaches the engine and preserves failures", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: unknown[][] = [];
  let failure: Error | undefined;
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async (id: string) => id === "code" ? { id, mode: "code", cwd: "/project", threadId: "thread", createdAt: 1, turns: [{id:"turn",createdAt:2,status:"inProgress",items:[]}] } : undefined,
      localCall: async (...args: unknown[]) => { calls.push(args); if(failure) throw failure; return {status:"accepted"}; },
      onEvent: () => () => {},
    },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit() {},
  } as never);
  await handlers.get("LocalSessions.interrupt")!("local_code");
  assert.deepEqual(calls, [["interrupt", "code", {turnId:"turn",turnCreatedAt:2,conversationCreatedAt:1,threadId:"thread"}]]);
  await assert.rejects(handlers.get("LocalSessions.interrupt")!("local_other"), /not found/);
  failure = Error("engine disconnected");
  await assert.rejects(handlers.get("LocalSessions.interrupt")!("local_code"), /engine disconnected/);
});

test("local Code session list and transcript use the real account data and enforce the mode boundary", async () => {
  const c: Conversation = {
    id: "code-one",
    title: "Code one",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 2000,
    turns: [
      {
        id: "turn",
        prompt: "Hello",
        attachments: [],
        status: "completed",
        createdAt: 1000,
        items: [{ id: "answer", type: "agentMessage", text: "World" }],
      },
    ],
  };
  const conversations = [
    c,
    { ...c, id: "cloud-mirror", cloudHosted: true },
    { ...c, id: "chat-one", mode: "chat" as const },
    {
      ...c,
      id: "remote-one",
      environment: { kind: "ssh" as const, hostId: "host" },
    },
  ];
  const connector = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    toolList: [{ name: "search", enabled: true, approval: "prompt" }],
  } as McpServerState;
  c.connectorOverrides = { wiki: false };
  c.connectorToolOverrides = { wiki: { search: false } };
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  let listener: ((event: any) => void) | undefined;
  let connectorReads = 0;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => undefined,
      localListConversations: async () => conversations,
      localLoadConversation: async (id: string) =>
        conversations.find((row) => row.id === id),
      onEvent: (fn: (event: any) => void) => {
        listener = fn;
        return () => {};
      },
      defaultWorkspace: () => process.cwd(),
      settings: () =>
        ({ mcpServers: { wiki: { url: connector.url } } }) as never,
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals: [] };
        if (name === "mcpServers") {
          connectorReads++;
          return { servers: [connector] };
        }
        return { trusted: false, sources: [] };
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      events.push(event);
    },
  } as never);
  const list = await handlers.get("LocalSessions.getSessionList")!();
  assert.deepEqual(
    list.sessions.map((s: { sessionId: string }) => s.sessionId),
    ["local_code-one"],
  );
  assert.equal(
    await handlers.get("LocalSessions.getSession")!("local_chat-one"),
    null,
  );
  assert.equal(
    await handlers.get("LocalSessions.getSession")!("code-one"),
    null,
  );
  const hydrated = await handlers.get("LocalSessions.getSession")!(
    "local_code-one",
  );
  assert.equal(
    hydrated.enabledMcpTools[
      permissionKeys(connector, connector.toolList![0]).enabled
    ],
    false,
    "Code session detail must restore saved connector state after renderer reload",
  );
  assert.equal(
    connectorReads,
    0,
    "session restore must not wait for live connector discovery",
  );
  assert.equal(
    (await handlers.get("LocalSessions.checkTrust")!(process.cwd())).trusted,
    true,
  );
  assert.equal(
    (
      await handlers.get("LocalSessions.checkTrust")!(
        "/definitely-not-a-test-workspace",
      )
    ).trusted,
    false,
  );
  const tail = await handlers.get("LocalSessions.getTranscriptTail")!(
    "local_code-one",
    20,
  );
  assert.equal(tail.messages.length, 2);
  assert.equal(tail.messages[0].message.content, "Hello");
  listener!({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.map((e) => e.type),
    ["session_updated"],
  );
  await assert.rejects(
    handlers.get("LocalSessions.getTranscript")!("local_remote-one"),
    /not found/,
  );
  c.turns[0].items.push({ id: "change", type: "fileChange" });
  const degraded = await handlers.get("LocalSessions.getTranscript")!("local_code-one");
  assert.equal(degraded.length, 3);
  assert.deepEqual(degraded.at(-1).claudexUnsupported, ["fileChange"]);
  assert.equal(degraded.at(-1).type, "system");
  assert.deepEqual(degraded.at(-1).message.content, []);
  listener!({
    type: "conversation",
    conversation: c,
    settledCodeTurnId: c.turns[0].id,
  });
  listener!({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  listener!({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  const results = events.filter((event) => event.message?.type === "result");
  assert.equal(results.length, 1);
  assert.equal(results[0].message.uuid, c.turns[0].id + ":result");
  assert.equal(results[0].message.parent_tool_use_id, null);
  assert.deepEqual(await handlers.get("LocalSessions.getTranscript")!("local_code-one"), degraded);

  const reasoning = {
    id: "thinking", type: "reasoning", lifecycleStatus: "inProgress", summary: ["Public preview"],
  } satisfies Conversation["turns"][number]["items"][number];
  c.turns.push({
    id: "new-turn", prompt: "Think", attachments: [], status: "inProgress",
    createdAt: 2000, items: [reasoning],
  });
  listener!({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.message?.uuid === "new-turn:item:thinking"));
  events.length = 0;
  Object.assign(reasoning, { summary: [], lifecycleStatus: "completed" });
  listener!({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event.type === "held_input_withdrawn").map((event) => event.withdrawnUuids),
    [["new-turn:item:thinking"]],
  );
  assert.ok(!events.some((event) => event.type === "close"));
  const remaining = await handlers.get("LocalSessions.getTranscript")!("local_code-one");
  assert.ok(remaining.every((row: { uuid: string }) => row.uuid !== "new-turn:item:thinking"));

  const active = c.turns.at(-1)!;
  const retryEvents = () => events.flatMap((event) =>
    event.message?.subtype?.startsWith("api_retry") ? [event.message] : [],
  );
  const publish = async () => {
    listener!({ type: "conversation", conversation: c });
    await new Promise((resolve) => setImmediate(resolve));
  };
  events.length = 0;
  active.streamRetry = { attempt: 1, maxRetries: 2, cause: "rate_limit" };
  await publish();
  await publish();
  assert.deepEqual(retryEvents(), [{
    type: "system",
    subtype: "api_retry",
    uuid: "new-turn:api-retry:1",
    session_id: "local_code-one",
    parent_tool_use_id: null,
    claudex_transient: true,
    attempt: 1,
    max_retries: 2,
    error: "rate_limit",
  }]);
  const openedDuringRetry = await handlers.get("LocalSessions.getTranscript")!("local_code-one");
  assert.deepEqual(openedDuringRetry, remaining);
  assert.equal(retryEvents().length, 2);
  const page = await handlers.get("LocalSessions.getTranscriptPage")!("local_code-one", "", 20);
  assert.deepEqual(page.messages, remaining);
  assert.equal(retryEvents().length, 3);
  await handlers.get("LocalSessions.getTranscriptPage")!("local_code-one", page.messages.at(-1).uuid, 20);
  assert.equal(retryEvents().length, 3);
  events.length = 0;
  delete active.streamRetry;
  active.items.push({ id: "new-output", type: "agentMessage", text: "Recovered" });
  await publish();
  assert.equal(retryEvents()[0].subtype, "api_retry_cleared");
  assert.ok(events.some((event) => event.message?.message?.content?.[0]?.text === "Recovered"));

  active.streamRetry = { attempt: 2, maxRetries: 2 };
  await publish();
  events.length = 0;
  active.status = "interrupted";
  await publish();
  assert.deepEqual(events.filter((event) => event.type === "close" || event.message?.subtype?.startsWith("api_retry"))
    .map((event) => event.message?.subtype ?? event.type), ["api_retry_cleared", "close"]);
});

test("a UI message keeps the optimistic UUID when its real turn arrives", async () => {
  const c: Conversation = {
    id: "id",
    title: "Test",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  let listener: ((event: any) => void) | undefined;
  const emitted: any[] = [];
  registerExperimentalCodeSessions({
    ctx: {
      localListConversations: async () => [c],
      localLoadConversation: async () => c,
      onEvent: (fn: (event: any) => void) => {
        listener = fn;
        return () => {};
      },
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals: [] };
        c.turns.push({
          id: "turn",
          prompt: "hello",
          attachments: [],
          items: [],
          createdAt: 2,
          status: "inProgress",
        });
        listener!({ type: "conversation", conversation: c });
        return c;
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      emitted.push(event);
    },
  } as never);
  await handlers.get("LocalSessions.sendMessage")!(
    "local_id",
    "hello",
    [],
    [],
    [],
    "later",
    { ccdSteering: true, asides: false },
    "optimistic-uuid",
    false,
    "hello",
    [],
    { uuids: ["optimistic-uuid"] },
    undefined,
    [],
    { personSent: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const message = emitted.find((event) => event.type === "message");
  assert.equal(message.message.uuid, "optimistic-uuid");
  const page = await handlers.get("LocalSessions.getTranscriptTail")!(
    "local_id",
    10,
  );
  assert.equal(page.messages[0].uuid, "optimistic-uuid");
});

test("a follow-up keeps its UUID and never replays loaded history as live messages", async () => {
  const message = "A pasted paragraph.\n\n".repeat(80).trim();
  const sentAt = Date.now();
  const previousTurnAt = sentAt - 25 * 60_000;
  const c: Conversation = {
    id: "id",
    title: "Test",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: previousTurnAt,
    updatedAt: previousTurnAt + 1000,
    turns: [
      {
        id: "previous",
        prompt: "earlier prompt",
        attachments: [],
        items: [{ id: "answer", type: "agentMessage", text: "earlier answer" }],
        createdAt: previousTurnAt,
        status: "completed",
      },
      {
        id: "compacted",
        compaction: "manual",
        prompt: "",
        attachments: [],
        items: [{ id: "compact", type: "contextCompaction", lifecycleStatus: "completed" }],
        createdAt: previousTurnAt + 1000,
        status: "completed",
      },
    ],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const emitted: any[] = [];
  let listener!: (event: any) => void;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => undefined,
      localLoadConversation: async () => structuredClone(c),
      onEvent: (fn: (event: any) => void) => {
        listener = fn;
        return () => {};
      },
      log() {},
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals: [] };
        c.title = "Updated title";
        listener({ type: "conversation", conversation: c });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(emitted.some(event => event.type === "close"), false);
        const turn = {
          id: "pending-provisional",
          prompt: message,
          attachments: [],
          items: [],
          createdAt: sentAt,
          status: "inProgress" as const,
        };
        c.turns.push(turn);
        listener({ type: "conversation", conversation: c });
        await new Promise((resolve) => setImmediate(resolve));
        turn.id = "real-turn";
        listener({ type: "conversation", conversation: c });
        throw new Error("Channel closed after the turn started");
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      emitted.push(event);
    },
  } as never);
  const initial = await handlers.get("LocalSessions.getTranscriptTail")!(
    "local_id",
    10,
  );
  assert.deepEqual(
    initial.messages.map((row: { uuid: string }) => row.uuid),
    ["previous:user", "previous:item:answer", "compacted:item:compact"],
  );
  assert.equal(initial.messages[1].message.stop_reason, "end_turn");
  const send = (uuids: string[]) => handlers.get("LocalSessions.sendMessage")!(
    "local_id",
    message,
    [],
    [],
    [],
    "later",
    {},
    "optimistic-uuid",
    false,
    message,
    undefined,
    { uuids },
    undefined,
    [message],
  );
  await assert.rejects(send(["foreign:result"]), /paneHolds/);
  await send(["previous:user", "previous:item:answer", "previous:result", "compacted:item:compact:compacting"]);
  await new Promise((resolve) => setImmediate(resolve));
  const messages = emitted.filter((event) => event.type === "message");
  assert.deepEqual(
    messages.map((event) => event.message.uuid),
    ["optimistic-uuid"],
  );
  assert.equal(messages[0].message.message.content, message);
  assert.equal(messages[0].message.timestamp, new Date(sentAt).toISOString());
  const active = emitted.find(event => event.type === "session_updated" && event.session.turnRunning);
  assert.equal(active?.session.claudexTurnStartedAt, sentAt);
  assert.doesNotMatch(JSON.stringify(emitted), /pending-provisional/);
  c.turns.at(-1)!.status = "completed";
  listener({ type: "conversation", conversation: c, settledCodeTurnId: "real-turn" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.some((event) => event.type === "transcript_loaded"), false);
  assert.equal(emitted.at(-1)?.type, "close");
  assert.equal(
    emitted.find(event => event.message?.type === "result")?.message.timestamp,
    new Date(sentAt).toISOString(),
  );
  const transcript = await handlers.get("LocalSessions.getTranscript")!("local_id");
  assert.deepEqual(
    transcript.map((row: { uuid: string }) => row.uuid),
    ["previous:user", "previous:item:answer", "compacted:item:compact", "optimistic-uuid"],
  );
});

test("native history only opens images inside the requested page", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-code-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/1vnp0AAAAABJRU5ErkJggg==",
    "base64",
  );
  const makeTurn = (id: string) => {
    const image = path.join(root, "attachments", id, id + ".png");
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, bytes);
    return {
      id,
      status: "completed" as const,
      createdAt: 1,
      prompt: id,
      attachments: [{ id, name: id + ".png", path: image, size: bytes.length, kind: "image" as const }],
      items: [],
    };
  };
  const c: Conversation = {
    id: "pages", mode: "code", title: "Pages", cwd: root, providerId: "p", model: "m",
    createdAt: 1, updatedAt: 2, archived: false, pinned: false,
    turns: [makeTurn("old"), makeTurn("new")],
  };
  const handlers = new Map<string, (...args: unknown[]) => any>();
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      stateDirectory: () => root,
      localLoadConversation: async () => c,
      onEvent: () => () => {},
    },
    on: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
    emit() {},
  } as never);
  const opened: string[] = [];
  const realRoot = fs.realpathSync(root);
  const readFile = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (typeof args[0] === "string" && args[0].startsWith(realRoot) && args[0].endsWith(".png"))
      opened.push(path.basename(args[0]));
    return readFile(...args);
  });
  const session = "local_pages";
  const tail = await handlers.get("LocalSessions.getTranscriptTail")!(session, 1);
  assert.deepEqual(opened, ["new.png"]);
  assert.equal(tail.hasMore, true);
  assert.equal(tail.messages[0].message.content[0].source.data, bytes.toString("base64"));
  const before = await handlers.get("LocalSessions.getTranscriptPage")!(session, tail.messages[0].uuid, 1);
  assert.deepEqual(opened, ["new.png", "old.png"]);
  assert.equal(before.hasMore, false);
  assert.deepEqual(before.messages[0].message.content[1], { type: "text", text: "old" });
});

test("history preserves a user-run shell command as one original Bash row", () => {
  const c: Conversation = {
    id: "shell", mode: "code", title: "Shell", cwd: "/workspace", providerId: "p", model: "m",
    createdAt: 1, updatedAt: 1, archived: false, pinned: false,
    turns: [{
      id: "turn", shell: true, prompt: "printf '<output>'", attachments: [], createdAt: 1,
      status: "completed",
      items: [{
        id: "command", type: "commandExecution", source: "userShell", status: "completed",
        command: "printf '<output>'", aggregatedOutput: "<output>", exitCode: 0,
      }],
    }],
  };
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, "turn:user");
  assert.equal(rows[0].type, "user");
  assert.equal(rows[0].message.content,
    "<bash-input>printf '<output>'</bash-input><bash-stdout>&lt;output&gt;</bash-stdout><bash-stderr></bash-stderr><bash-exit-code>0</bash-exit-code>");
});

test("a single apply_patch history item keeps its Write and Edit rows in order", () => {
  const c: Conversation = {
    id: "mixed", mode: "code", title: "Mixed edits", cwd: "/workspace", providerId: "p", model: "m",
    createdAt: 1, updatedAt: 1, archived: false, pinned: false,
    turns: [{
      id: "turn", prompt: "Make two changes", attachments: [], createdAt: 1, status: "completed",
      items: [{
        id: "patch", type: "fileChange", status: "completed",
        changes: [
          { path: "new.txt", kind: { type: "add" }, diff: "hello\n" },
          { path: "edit.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
        ],
      }],
    }],
  };
  const { rows, unsupported } = convertCodeTranscript(c);
  assert.deepEqual(unsupported, []);
  assert.deepEqual(rows.slice(1).map((row) => row.uuid), [
    "turn:file:patch:0:use", "turn:file:patch:0:result",
    "turn:file:patch:1:use", "turn:file:patch:1:result",
  ]);
  assert.match(JSON.stringify(rows[1].message.content), /"name":"Write"/);
  assert.match(JSON.stringify(rows[3].message.content), /"name":"Edit"/);
});

test("running Code messages follow official steer and queue controls", async () => {
  const c: Conversation = {
    id: "running",
    title: "Running",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "work",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: unknown[][] = [];
  const emitted: any[] = [];
  let current = c;
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async () => current,
      onEvent: () => () => {},
      localCall: async (...args: unknown[]) => {
        calls.push(args);
        if (args[0] === "snapshot") return { approvals: [] };
        if (args[0] === "steerTurn")
          return args[2] === "second"
            ? null
            : { messageId: "steer-1", conversation: current };
        return current;
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      emitted.push(event);
    },
  } as never);

  await handlers.get("LocalSessions.sendMessage")!(
    "local_running",
    "steer me",
    [],
    [],
    [],
    "next",
    {},
    "uuid-steer",
  );
  assert.deepEqual(calls.at(-1), ["steerTurn", "running", "steer me", []]);
  await handlers.get("LocalSessions.sendMessage")!(
    "local_running",
    "later one",
    [],
    [],
    [],
    "later",
    {},
    "uuid-later",
  );
  assert.equal(calls.filter((call) => call[0] === "steerTurn").length, 1);
  assert.equal(
    await handlers.get("LocalSessions.cancelQueuedMessage")!(
      "local_running",
      "uuid-later",
    ),
    true,
  );
  assert.equal(
    await handlers.get("LocalSessions.cancelQueuedMessage")!(
      "local_running",
      "uuid-steer",
    ),
    false,
  );
  assert.equal(
    emitted.some(
      (event) =>
        event.type === "message" && event.message.uuid === "uuid-later",
    ),
    true,
  );
  assert.equal(
    emitted.some(
      (event) =>
        event.type === "held_input_withdrawn" &&
        event.withdrawnUuids.includes("uuid-later"),
    ),
    true,
  );

  await handlers.get("LocalSessions.sendMessage")!(
    "local_running",
    "first",
    [],
    [],
    [],
    "later",
    {},
    "uuid-first",
  );
  await handlers.get("LocalSessions.sendMessage")!(
    "local_running",
    "second",
    [],
    [],
    [],
    "later",
    {},
    "uuid-second",
  );
  assert.equal(
    await handlers.get("LocalSessions.reorderQueuedMessage")!(
      "local_running",
      "uuid-steer",
      "uuid-first",
    ),
    false,
  );
  assert.equal(
    await handlers.get("LocalSessions.reorderQueuedMessage")!(
      "local_running",
      "uuid-first",
      "uuid-steer",
    ),
    false,
  );
  assert.equal(
    await handlers.get("LocalSessions.promoteQueuedMessage")!(
      "local_running",
      "uuid-steer",
    ),
    false,
  );
  assert.equal(
    await handlers.get("LocalSessions.reorderQueuedMessage")!(
      "local_running",
      "uuid-first",
      "uuid-second",
    ),
    true,
  );
  assert.equal(
    await handlers.get("LocalSessions.promoteQueuedMessage")!(
      "local_running",
      "uuid-second",
    ),
    true,
  );
  assert.deepEqual(calls.at(-1), ["steerTurn", "running", "second", []]);
  const transcript = await handlers.get("LocalSessions.getTranscript")!(
    "local_running",
  );
  assert.deepEqual(
    transcript.slice(-3).map((row: { uuid: string; priority: string }) => [
      row.uuid,
      row.priority,
    ]),
    [
      ["uuid-second", "later"],
      ["uuid-steer", "next"],
      ["uuid-first", "later"],
    ],
  );
  assert.equal(
    emitted.some((event) => event.type === "session_updated"),
    true,
  );
});

test("sending a selected held Code message leaves the other messages in order", async () => {
  const c: Conversation = {
    id: "send-selected",
    title: "Send selected",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "base",
        prompt: "work",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  };
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const sent: string[] = [];
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async () => structuredClone(c),
      onEvent: () => () => {},
      async localCall(name: string, input: { text: string }) {
        if (name !== "send") throw Error(`Unexpected call: ${name}`);
        sent.push(input.text);
        c.turns.push({
          id: "selected-turn",
          prompt: input.text,
          attachments: [],
          items: [],
          createdAt: 2,
          status: "inProgress",
        });
        return structuredClone(c);
      },
    },
    on(name: string, fn: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);
  const run = (method: string, ...args: unknown[]) =>
    handlers.get(`LocalSessions.${method}`)!("local_send-selected", ...args);
  for (const text of ["first", "selected", "third"]) {
    await run("sendMessage", text, [], [], [], "later", {}, `${text}-uuid`);
  }
  c.turns[0].status = "interrupted";

  assert.equal(await run("sendSteeredNow", "selected-uuid"), true);
  assert.deepEqual(sent, ["selected"]);
  const transcript = await run("getTranscript");
  assert.ok(Array.isArray(transcript));
  assert.deepEqual(
    transcript.filter((row) => row.priority === "later").map((row) => row.uuid),
    ["first-uuid", "third-uuid"],
  );
});

test("an unconfirmed queued Code send is preserved and never retried on unrelated events", async () => {
  const c: Conversation = {
    id: "retry-queue",
    title: "Retry queue",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "work",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  let listener!: (event: any) => void;
  let attempts = 0;
  let current = c;
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async () => current,
      onEvent: (fn: (event: any) => void) => {
        listener = fn;
        return () => {};
      },
      log() {},
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals: [] };
        if (name === "send") {
          attempts++;
          if (attempts === 1) throw Error("temporary send failure");
          return current;
        }
        return current;
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      events.push(event);
    },
  } as never);

  await handlers.get("LocalSessions.sendMessage")!(
    "local_retry-queue",
    "send after the turn",
    [],
    [],
    [],
    "later",
    {},
    "uuid-retry",
  );
  current = {
    ...c,
    turns: [{ ...c.turns[0], status: "completed" }],
  };
  listener({ type: "conversation", conversation: current });
  for (let i = 0; i < 20 && attempts < 1; i++)
    await new Promise((resolve) => setImmediate(resolve));
  for (
    let i = 0;
    i < 20 && !events.some((event) => event.type === "error");
    i++
  )
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    true,
  );

  listener({ type: "conversation", conversation: current });
  for (let i = 0; i < 20 && attempts < 2; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  const session = await handlers.get("LocalSessions.getSession")!(
    "local_retry-queue",
  );
  assert.deepEqual(session.sendsHeldAfterError, ["uuid-retry"]);
  assert.equal(
    await handlers.get("LocalSessions.sendSteeredNow")!(
      "local_retry-queue",
      "uuid-retry",
    ),
    false,
  );
  await handlers.get("LocalSessions.sendMessage")!(
    "local_retry-queue",
    "send after the turn",
    [],
    [],
    [],
    "later",
    {},
    "uuid-held",
  );
  for (const method of ["sendSteeredNow", "promoteQueuedMessage"]) {
    assert.equal(
      await handlers.get(`LocalSessions.${method}`)!(
        "local_retry-queue",
        "uuid-held",
      ),
      false,
    );
  }
  assert.equal(attempts, 1);
  assert.equal(
    await handlers.get("LocalSessions.cancelQueuedMessage")!(
      "local_retry-queue",
      "uuid-retry",
    ),
    true,
  );
});

test("a queued Code message cannot be cancelled or steered again once submission starts", async () => {
  const c = {
    id: "queue-race",
    title: "Queue",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "base",
        prompt: "work",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  } as Conversation;
  const handlers = new Map<string, (...args: any[]) => any>();
  let listener!: (event: any) => void;
  let started!: () => void, release!: (value: Conversation) => void;
  const submitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sending = new Promise<Conversation>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: async () => c,
      onEvent(fn: (event: any) => void) {
        listener = fn;
        return () => {};
      },
      log() {},
      async localCall(name: string) {
        if (name === "snapshot") return { approvals: [] };
        if (name === "send") {
          sends++;
          started();
          return sending;
        }
        throw Error(`Unexpected call: ${name}`);
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);
  const run = (method: string, ...args: unknown[]) =>
    handlers.get(`LocalSessions.${method}`)!("local_queue-race", ...args);
  await run("sendMessage", "first", [], [], [], "later", {}, "first-uuid");
  await run("sendMessage", "second", [], [], [], "later", {}, "second-uuid");
  c.turns[0].status = "completed";
  listener({ type: "conversation", conversation: c });
  await submitted;
  assert.equal(await run("cancelQueuedMessage", "first-uuid"), false);
  assert.equal(
    await run("reorderQueuedMessage", "first-uuid", "second-uuid"),
    false,
  );
  assert.equal(await run("promoteQueuedMessage", "first-uuid"), false);
  assert.equal(await run("sendSteeredNow", "first-uuid"), false);
  assert.equal(
    await run("cancelQueuedMessage", "second-uuid"),
    true,
    "a different message can still be cancelled",
  );
  c.turns.push({
    id: "queued-real",
    prompt: "first",
    attachments: [],
    items: [],
    createdAt: 2,
    status: "completed",
  });
  release(c);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  const transcript = await run("getTranscript");
  assert.ok(
    transcript.some(
      (row: any) =>
        row.uuid === "first-uuid" && row.message.content === "first",
    ),
  );
});

test("command approval preserves the requested command and never upgrades the choice", async () => {
  const c: Conversation = {
    id: "id",
    title: "Test",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread",
    turns: [{ id: "turn", prompt: "test", createdAt: 1, attachments: [], status: "inProgress", items: [{ id: "item", type: "commandExecution", command: "pwd", status: "inProgress" }] }],
  };
  const approval = {
    id: 42,
    conversationId: "id",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item", command: "pwd" },
  };
  let pending = [approval];
  const calls: unknown[][] = [];
  const runtime = {};
  const commandPermissions = createCodeCommandPermissionHost({ runtime: () => runtime, current: () => true, approvals: () => pending, conversation: () => c, respondExact: (a, decision) => { calls.push(["exact", a, { decision }]); pending = []; } });
  const handlers = new Map<string, (...args: any[]) => any>();
  registerExperimentalCodeSessions({
    ctx: {
      codeCommandPermissions: commandPermissions,
      localListConversations: async () => [c],
      localLoadConversation: async () => c,
      onEvent: () => () => {},
      localCall: async (...args: unknown[]) => {
        if (args[0] === "snapshot") return { approvals: pending };
        if (args[0] === "mcpServers") return { servers: [] };
        calls.push(args);
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
  } as never);
  const session = await handlers.get("LocalSessions.getSession")!("local_id");
  assert.deepEqual(session.pendingToolPermissions[0].input, { command: "pwd" });
  const requestId = session.pendingToolPermissions[0].requestId;
  assert.match(requestId, /^code-command:/);
  await assert.rejects(
    handlers.get("LocalSessions.respondToToolPermission")!(requestId, "always"),
    /allow once or deny/,
  );
  await assert.rejects(
    handlers.get("LocalSessions.respondToToolPermission")!(requestId, "once", {
      command: "rm -rf /",
    }),
    /Edited approval/,
  );
  assert.equal(calls.length, 0);
  await handlers.get("LocalSessions.respondToToolPermission")!(requestId, "deny");
  assert.deepEqual(calls, [["exact", approval, { decision: "decline" }]]);
});

test("an approval resolved while its session is loading is never shown again", async () => {
  const c: Conversation = {
    id: "id",
    title: "Test",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const approval = {
    id: 7,
    conversationId: "id",
    method: "item/commandExecution/requestApproval",
    params: { command: "pwd" },
  };
  let resolve!: (c: Conversation) => void;
  const waiting = new Promise<Conversation>((r) => {
    resolve = r;
  });
  let listener: ((event: any) => void) | undefined;
  const events: any[] = [];
  registerExperimentalCodeSessions({
    ctx: {
      localLoadConversation: () => waiting,
      onEvent: (fn: (event: any) => void) => {
        listener = fn;
        return () => {};
      },
    },
    on() {},
    emit(_domain: string, _channel: string, event: unknown) {
      events.push(event);
    },
  } as never);
  listener!({ type: "approval", approval });
  listener!({ type: "approval-resolved", id: 7 });
  resolve(c);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    events.some((event) => event.type === "tool_permission_request"),
    false,
  );
});

test("local Code answers the exact pending MCP form or link", async () => {
  const c: Conversation = {
    id: "id",
    title: "MCP session",
    mode: "code",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread",
    turns: [{ id: "turn", status: "inProgress", prompt: "Ask", attachments: [], items: [], createdAt: 1 }],
  };
  const requestedSchema = {
    type: "object",
    properties: {
      name: { type: "string", title: "Name" },
      count: { type: "integer", minimum: 2 },
      confirmed: { type: "boolean" },
    },
    required: ["name", "count", "confirmed"],
  };
  const form: Approval = {
    id: 7,
    conversationId: c.id,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: c.threadId,
      turnId: "turn",
      mode: "form",
      serverName: "mcp_probe",
      message: "Choose the parameters.",
      requestedSchema,
      _meta: null,
    },
  };
  const url = "https://example.com/connect";
  const link: Approval = {
    ...form,
    params: {
      threadId: c.threadId,
      turnId: "turn",
      mode: "url",
      serverName: "mcp_probe",
      message: "Connect the account.",
      elicitationId: "oauth",
      url,
      _meta: null,
    },
  };
  let listener: (event: AppEvent) => void = () => {};
  let approvals = [form];
  let owner = "account";
  let connected = true;
  const calls: unknown[][] = [];
  const events: unknown[] = [];
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: owner }),
      localLoadConversation: async (id: string) => id === c.id ? structuredClone(c) : undefined,
      localCall: async (name: string) => {
        assert.equal(name, "snapshot");
        return { approvals };
      },
      respondToLocalCodeElicitation: (resolved: Approval, response: unknown) => {
        if (!connected) throw Error("The engine disconnected.");
        assert.ok(approvals.includes(resolved));
        calls.push([resolved.id, response]);
        approvals = approvals.filter((approval) => approval !== resolved);
        listener({ type: "approval-resolved", id: resolved.id });
      },
      onEvent: (fn: typeof listener) => { listener = fn; return () => {}; },
    },
    on(name: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(name, handler);
    },
    emit(_domain: string, _channel: string, event: unknown) { events.push(event); },
  } as never);
  const get = async () => await handlers.get("LocalSessions.getSession")!("local_id") as {
    pendingToolPermissions: { requestId: string; toolName: string }[];
  };
  const respond = handlers.get("LocalSessions.respondToToolPermission")!;
  const [offer] = (await get()).pendingToolPermissions;
  assert.match(offer.requestId, /^code-mcp-elicitation:/);
  assert.deepEqual(offer, {
    requestId: offer.requestId,
    sessionId: "local_id",
    toolName: "mcp_probe",
    input: {},
    isElicitation: true,
    requiresUserInteraction: true,
    suppressAlwaysAllowRule: true,
    elicitationForm: {
      message: "Choose the parameters.",
      requestedSchema,
      fieldNames: ["name", "count", "confirmed"],
    },
  });
  assert.deepEqual((await get()).pendingToolPermissions, [offer]);
  const content = { name: "Taylor", count: 3, confirmed: false };
  const accept = { action: "accept", content };
  await assert.rejects(respond("7", "once", accept));
  await assert.rejects(respond(offer.requestId, "once"));
  await assert.rejects(respond(offer.requestId, "deny", accept));
  await assert.rejects(respond(offer.requestId, "once", { action: "accept", content: { ...content, count: "3" } }));
  await assert.rejects(respond(offer.requestId, "once", { action: "accept", content: { ...content, extra: "x" } }));
  c.turns[0].status = "completed";
  await assert.rejects(respond(offer.requestId, "once", accept));
  assert.deepEqual(calls, []);
  c.turns[0].status = "inProgress";
  connected = false;
  await assert.rejects(respond(offer.requestId, "once", accept), /disconnected/);
  assert.deepEqual((await get()).pendingToolPermissions, [offer]);
  connected = true;
  await respond(offer.requestId, "once", accept);
  assert.deepEqual(calls, [[7, { action: "accept", content, _meta: null }]]);
  assert.deepEqual(events, [{ type: "tool_permission_resolved", sessionId: "local_id", request: offer }]);

  approvals = [link];
  listener({ type: "approval", approval: link });
  await new Promise((resolve) => setImmediate(resolve));
  const [linkOffer] = (await get()).pendingToolPermissions;
  assert.notEqual(linkOffer.requestId, offer.requestId);
  assert.deepEqual(linkOffer, {
    requestId: linkOffer.requestId,
    sessionId: "local_id",
    toolName: "mcp_probe",
    input: {},
    isElicitation: true,
    requiresUserInteraction: true,
    suppressAlwaysAllowRule: true,
    elicitationLink: { message: "Connect the account.", href: url, host: "example.com" },
  });
  assert.deepEqual(events.at(-1), { type: "tool_permission_request", sessionId: "local_id", request: linkOffer });
  await assert.rejects(respond(offer.requestId, "once", { action: "accept" }));
  await assert.rejects(respond(linkOffer.requestId, "once", accept));
  owner = "another-account";
  await assert.rejects(respond(linkOffer.requestId, "deny", { action: "decline" }));
  assert.equal(calls.length, 1);
  owner = "account";
  const [activeLink] = (await get()).pendingToolPermissions;
  await respond(activeLink.requestId, "deny", { action: "decline" });
  assert.deepEqual(calls[1], [7, { action: "decline", content: null, _meta: null }]);

  approvals = [{ ...link, id: 8 }];
  const [nextLink] = (await get()).pendingToolPermissions;
  await respond(nextLink.requestId, "once", { action: "accept" });
  assert.deepEqual(calls[2], [8, { action: "accept", content: null, _meta: null }]);
});
