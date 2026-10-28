import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler } from "../../electron/routines/scheduler";
import { SitePermissions } from "../../electron/browser/site-permissions";
import {
  BrowserTools,
  type BrowserToolsService,
} from "../../electron/browser/mcp-tools";
import {
  registerBrowserTools,
  routineBrowserAvailable,
} from "../../electron/browser/browser-tools-registration";
import {
  routineBrowserPermissions,
  clearRoutineBrowserPermissions,
} from "../../electron/routines/routine-browser";
import { validRoutineBrowserGrant } from "../../shared/routine-browser";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import type { Routine, RoutineInput } from "../../shared/routines";
const origin = "https://example.com";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b35-browser-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const conversations: Conversation[] = [];
  let scheduler: Scheduler;
  const options = {
    now: () => 1000000,
    isBusy: () => false,
    policy: () => openPolicy,
    run: async (task: Routine) => {
      const c = {
        id: `c-${conversations.length}`,
        title: "Synthetic Browser run",
        providerId: task.providerId,
        model: task.model,
        pinned: false,
        archived: false,
        updatedAt: 1000000,
        mode: task.mode,
        cwd: task.cwd,
        environment: task.environment,
        scheduledRun: true,
        scheduledTaskId: task.id,
        createdAt: 1000000,
        turns: [
          {
            id: "turn",
            createdAt: 1000000,
            prompt: task.prompt,
            status: "inProgress",
            items: [],
            attachments: [],
          },
        ],
      } as Conversation;
      conversations.push(c);
      return c;
    },
  };
  scheduler = new Scheduler(root, options);
  const input: RoutineInput = {
    name: "Browser task",
    prompt: "Inspect the website",
    mode: "code",
    providerId: "p",
    model: "m",
    enabled: true,
    frequency: "hourly",
    nextRunAt: 1000001,
  };
  const task = scheduler.save(input);
  return { root, task, input, options, scheduler, conversations };
}
function browser(
  f: ReturnType<typeof fixture>,
  conversation: Conversation,
  patch: {
    risk?: () => Promise<any>;
    text?: () => Promise<string>;
    focus?: () => Promise<void>;
    owner?: () => boolean;
  } = {},
) {
  let url = origin;
  let globals: string[] = [origin];
  let active = true;
  let bound = true;
  let questions = 0;
  let reads = 0;
  const permissions = new SitePermissions({
    allowedSites: () => globals,
    setAllowedSites: (next) => {
      globals = next;
    },
    allowAllBrowserActions: () => true,
    policy: () => openPolicy.browser!,
    routine: () =>
      bound
        ? {
            taskId: f.task.id,
            active:
              active && f.scheduler.browserTask(conversation) === f.task.id,
            revision: f.scheduler.browserRevision(f.task.id),
            grant: f.scheduler.browserGrant(f.task.id),
            allow: (site) => f.scheduler.allowBrowserSite(f.task.id, site),
          }
        : undefined,
  });
  const driver = {
    send: patch.focus ?? (async () => {}),
    text: async () => {
      reads++;
      return patch.text ? patch.text() : "actual page content";
    },
  };
  const host = {
    state: () => ({ tabs: [{ id: "tab-1", url }], activeTabId: "tab-1" }),
    driver: () => ({ tabId: "tab-1", url, state: {}, driver }),
    navigate: (_id: string, next: string) => {
      url = next;
      return { ok: true };
    },
  };
  const service = {
    host,
    devServers: () => undefined,
  } as unknown as BrowserToolsService;
  const tools = new BrowserTools({
    service: async () => service,
    permissions,
    loadTimeoutMs: 0,
    siteRisk: patch.risk ?? (async () => undefined),
    policy: () => openPolicy.browser!,
    toolsAvailable: patch.owner ?? (() => true),
    codeConversation: () => true,
    alwaysAllowOffered: () => true,
    unattended: () => true,
  });
  const invoke = (
    name: string,
    args: Record<string, unknown> = {},
    elicit = true,
    answer: "once" | "always" = "always",
  ) =>
    tools.call(name, args, {
      conversationId: conversation.id,
      canElicit: elicit,
      signal: new AbortController().signal,
      meta: undefined,
      elicit: async () => {
        questions++;
        return { action: "accept", content: { decision: answer } };
      },
    });
  return {
    permissions,
    call: (elicit = true, answer: "once" | "always" = "always") =>
      invoke("get_text", {}, elicit, answer),
    navigate: () => invoke("navigate", { url: origin }),
    service,
    tools,
    questions: () => questions,
    reads: () => reads,
    globals: () => globals,
    retire: () => {
      active = false;
    },
    unbind: () => {
      bound = false;
    },
    move: (next: string) => {
      url = next;
    },
  };
}
const text = (result: any) =>
  result.content.map((part: any) => part.text ?? "").join("\n");
test("exact, bounded HTTP origins and all-websites inventory validate without wildcard widening", () => {
  for (const domain of [
    "https://example.com/",
    "https://example.com/path",
    "file:///tmp",
    "https://*.example.com",
    "https://user@example.com",
    "javascript:alert(1)",
  ]) {
    assert.throws(() =>
      validRoutineBrowserGrant({
        mode: "domains",
        domains: [domain],
        approvedAt: 1,
      }),
    );
  }
  assert.deepEqual(
    validRoutineBrowserGrant({ mode: "all-websites", approvedAt: 1 }),
    { mode: "all-websites", approvedAt: 1 },
  );
  assert.throws(() =>
    validRoutineBrowserGrant({
      mode: "domains",
      domains: Array(201).fill(origin),
      approvedAt: 1,
    }),
  );
});
test("actual Browser approval persists on only the dispatched routine; ordinary save cannot forge/restore revoked grant", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  const c = f.conversations[0];
  const b = browser(f, c);
  assert.equal(
    b.permissions.decide(c.id, origin).access,
    "ask",
    "account Allowed sites/Allow-all cannot grant a routine",
  );
  assert.equal((await b.call()).isError, undefined);
  assert.equal(b.questions(), 1);
  assert.equal(b.reads(), 1);
  assert.deepEqual(f.scheduler.browserGrant(f.task.id), {
    mode: "domains",
    domains: [origin],
    approvedAt: 1000000,
  });
  assert.deepEqual(b.globals(), [origin]);
  assert.equal((await b.call(false)).isError, undefined);
  const fresh = new Scheduler(f.root, f.options);
  assert.deepEqual(
    fresh.browserGrant(f.task.id),
    f.scheduler.browserGrant(f.task.id),
  );
  assert.equal(
    fresh.browserTask(c),
    undefined,
    "restart never revives a run binding",
  );
  const other = f.scheduler.save({
    ...f.input,
    name: "Other",
    browserGrant: { mode: "all-websites", approvedAt: 1 },
    browserGrantRevision: 999,
  });
  assert.equal(other.browserGrant, undefined);
  assert.equal(other.browserGrantRevision, undefined);
  const stale = f.scheduler.list()[0];
  f.scheduler.clearBrowserGrant(f.task.id);
  f.scheduler.save(stale);
  assert.equal(f.scheduler.browserGrant(f.task.id), undefined);
  assert.equal((await b.call(false)).isError, true);
  assert.equal(b.reads(), 2);
});
test("dispatch binding rejects stale/wrong task, folder, environment and completed run", async (t) => {
  const f = fixture(t);
  let during: Conversation | undefined;
  const scheduler: Scheduler = new Scheduler(f.root + "-dispatch", {
    ...f.options,
    run: async (task): Promise<Conversation> => {
      const c = await f.options.run(task);
      during = c;
      assert.equal(scheduler.browserTask(c), task.id);
      for (const patch of [
        { scheduledTaskId: "foreign" },
        { cwd: "/other" },
        { environment: { kind: "ssh", hostId: "other" } },
        { scheduledRun: false },
      ])
        assert.equal(
          scheduler.browserTask({ ...c, ...patch } as Conversation),
          undefined,
        );
      return c;
    },
  });
  t.after(() =>
    fs.rmSync(f.root + "-dispatch", { recursive: true, force: true }),
  );
  const task = scheduler.save(f.input);
  await scheduler.runNow(task.id);
  assert.equal(scheduler.browserTask(during!), task.id);
  during!.turns[0].status = "completed";
  scheduler.observeConversation(during!);
  assert.equal(scheduler.browserTask(during!), undefined);
});
for (const boundary of ["risk", "focus", "read"] as const)
  test(`revocation at actual ${boundary} await refuses further Browser use/result`, async (t) => {
    const f = fixture(t);
    await f.scheduler.runNow(f.task.id);
    f.scheduler.allowBrowserSite(f.task.id, origin);
    const entered = deferred<void>();
    const release = deferred<any>();
    const hook = async () => {
      entered.resolve();
      return release.promise;
    };
    const b = browser(f, f.conversations[0], {
      ...(boundary === "risk"
        ? { risk: hook }
        : boundary === "focus"
          ? { focus: hook }
          : { text: hook }),
    });
    const pending = b.call(false);
    await entered.promise;
    f.scheduler.clearBrowserGrant(f.task.id);
    release.resolve(boundary === "read" ? "secret page result" : undefined);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.doesNotMatch(text(result), /secret page result/);
    assert.equal(b.reads(), boundary === "read" ? 1 : 0);
  });
test("once approval stays session-only, and administrator blocks win over routine grants", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  const b = browser(f, f.conversations[0]);
  await b.call(true, "once");
  assert.equal(f.scheduler.browserGrant(f.task.id), undefined);
  assert.equal((await b.call(false)).isError, undefined);
  f.scheduler.allowBrowserSite(f.task.id, origin);
  const p = new SitePermissions({
    allowedSites: () => [],
    setAllowedSites() {},
    policy: () => ({ externalSites: true, blockedDomains: ["example.com"] }),
    routine: () => ({
      taskId: f.task.id,
      active: true,
      revision: 1,
      grant: f.scheduler.browserGrant(f.task.id),
      allow() {},
    }),
  });
  assert.equal(p.decide("c", origin).access, "deny");
  b.retire();
  assert.equal((await b.call()).isError, true);
});
test("a late owner change cannot return page data or write an approval", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  const entered = deferred<void>();
  const release = deferred<void>();
  let owner = true;
  const b = browser(f, f.conversations[0], {
    owner: () => owner,
    risk: async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    },
  });
  const pending = b.call();
  await entered.promise;
  owner = false;
  release.resolve();
  assert.equal((await pending).isError, true);
  assert.equal(b.questions(), 0);
  assert.equal(f.scheduler.browserGrant(f.task.id), undefined);
});
test("registered native Browser service backs real routine API; cloud/SSH/Chat and stopped service refuse", async (t) => {
  const f = fixture(t);
  let activate!: () => void;
  let deactivate!: () => Promise<void>;
  let extension: any;
  const ready = deferred<void>();
  const ctx = {
    store: {
      root: f.root,
      conversations: f.conversations,
      settings: { browserTools: true },
      flush() {},
    },
    scheduler: f.scheduler,
    policy: () => openPolicy,
    settingsChanged() {},
    engine: {
      extensions: {
        add(value: any) {
          extension = value;
          ready.resolve();
          return () => {};
        },
      },
    },
    onAccountActivated(cb: () => void) {
      activate = cb;
    },
    onAccountDeactivating(cb: () => Promise<void>) {
      deactivate = cb;
    },
    onSettingsChanged() {},
  } as any;
  const b = browser(f, {} as Conversation);
  registerBrowserTools(ctx, {
    service: async () => b.service,
    siteRisk: async () => undefined,
  });
  activate();
  await ready.promise;
  t.after(async () => {
    await deactivate();
  });
  assert.equal(routineBrowserPermissions(ctx, f.task.id).status, "supported");
  await f.scheduler.runNow(f.task.id);
  const c = f.conversations[0];
  const builtin = extension.builtinMcpServers({
    mode: c.mode,
    conversation: c,
    settings: ctx.store.settings,
    policy: openPolicy,
  });
  assert.equal(builtin.length, 1);
  const token = extension.processEnv().CLAUDEX_BROWSER_MCP_TOKEN;
  const post = async (body: object, session?: string) => {
    const res = await fetch(builtin[0].url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    return { response: res, body: (await res.json()) as any };
  };
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: { form: {} } },
    },
  });
  assert.equal(init.response.status, 200);
  const session = init.response.headers.get("mcp-session-id")!;
  const call = () =>
    post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_text", arguments: {} },
      },
      session,
    );
  assert.equal((await call()).body.result.isError, true);
  // The real registered MCP endpoint, not a direct grant helper, receives
  // and persists the actual Always allow answer for this scheduler dispatch.
  const stream = await fetch(builtin[0].url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Mcp-Session-Id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_text", arguments: {} },
    }),
  });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    asked = false,
    result: any;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const message = JSON.parse(data.slice(6));
      if (message.method === "elicitation/create") {
        asked = true;
        const ack = await fetch(builtin[0].url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Mcp-Session-Id": session,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { action: "accept", content: { decision: "always" } },
          }),
        });
        assert.equal(ack.status, 202);
        await ack.arrayBuffer();
      } else if (message.id === 3) result = message.result;
    }
  }
  assert.equal(asked, true);
  assert.match(text(result), /actual page content/);
  assert.deepEqual(f.scheduler.browserGrant(f.task.id), {
    mode: "domains",
    domains: [origin],
    approvedAt: 1000000,
  });
  assert.match(text((await call()).body.result), /actual page content/);
  clearRoutineBrowserPermissions(ctx, f.task.id);
  assert.equal((await call()).body.result.isError, true);
  assert.throws(
    () => f.scheduler.save({ ...f.input, mode: "chat" } as never),
    /Choose Code or Cowork/,
  );
  for (const patch of [
    { environment: { kind: "ssh", hostId: "x" } },
    { executionLocation: "remote" },
  ]) {
    const unsupported = f.scheduler.save({
      ...f.input,
      name: `Unsupported ${JSON.stringify(patch)}`,
      ...patch,
    } as RoutineInput);
    assert.equal(
      routineBrowserPermissions(ctx, unsupported.id).status,
      "unsupported",
    );
    assert.throws(() => clearRoutineBrowserPermissions(ctx, unsupported.id));
  }
  f.conversations[0].turns[0].status = "completed";
  f.scheduler.observeConversation(f.conversations[0]);
  const key = "rm1-" + "a".repeat(64);
  f.scheduler.beginMigration({
    key,
    id: f.task.id,
    expectedUpdatedAt: f.scheduler.list().find((row) => row.id === f.task.id)!
      .updatedAt,
  });
  const locked = routineBrowserPermissions(ctx, f.task.id);
  assert.equal(locked.status === "supported" && locked.readOnly, true);
  assert.throws(
    () => clearRoutineBrowserPermissions(ctx, f.task.id),
    /read-only/,
  );
  await deactivate();
  assert.equal(routineBrowserPermissions(ctx, f.task.id).status, "unsupported");
});
test("failed durable revocation keeps the real grant/version; account roots never share grants", (t) => {
  const f = fixture(t);
  f.scheduler.allowBrowserSite(f.task.id, origin);
  const revision = f.scheduler.browserRevision(f.task.id);
  const temporary = path.join(f.root, "schedules.json.tmp");
  fs.mkdirSync(temporary);
  assert.throws(() => f.scheduler.clearBrowserGrant(f.task.id));
  assert.equal(f.scheduler.browserRevision(f.task.id), revision);
  assert.deepEqual(f.scheduler.browserGrant(f.task.id)?.mode, "domains");
  fs.rmdirSync(temporary);
  assert.deepEqual(
    new Scheduler(f.root, f.options).browserGrant(f.task.id),
    f.scheduler.browserGrant(f.task.id),
  );
  const otherRoot = f.root + "-other-account";
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  const other = new Scheduler(otherRoot, f.options);
  assert.equal(other.browserGrant(f.task.id), undefined);
  assert.throws(() => other.clearBrowserGrant(f.task.id));
});
test("saved all-websites inventory remains bounded by live administrative policy and can be durably revoked", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "schedules.json");
  const tasks = JSON.parse(fs.readFileSync(file, "utf8"));
  tasks[0].browserGrant = { mode: "all-websites", approvedAt: 1 };
  fs.writeFileSync(file, JSON.stringify(tasks));
  const scheduler = new Scheduler(f.root, f.options);
  let policy = { externalSites: true, blockedDomains: [] as string[] };
  const permissions = new SitePermissions({
    allowedSites: () => [],
    setAllowedSites() {},
    policy: () => policy,
    routine: () => ({
      taskId: f.task.id,
      active: true,
      revision: scheduler.browserRevision(f.task.id),
      grant: scheduler.browserGrant(f.task.id),
      allow() {},
    }),
  });
  assert.equal(
    permissions.decide("c", "https://elsewhere.test").access,
    "allow",
  );
  policy = { ...policy, externalSites: false };
  assert.equal(permissions.decide("c", origin).access, "deny");
  policy = { externalSites: true, blockedDomains: ["example.com"] };
  assert.equal(permissions.decide("c", origin).access, "deny");
  scheduler.clearBrowserGrant(f.task.id);
  assert.equal(
    new Scheduler(f.root, f.options).browserGrant(f.task.id),
    undefined,
  );
  tasks[0].browserGrant = {
    mode: "domains",
    approvedAt: 1,
    domains: ["javascript:bad"],
  };
  fs.writeFileSync(file, JSON.stringify(tasks));
  assert.throws(() => new Scheduler(f.root, f.options), /not been overwritten/);
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8"))[0].browserGrant.domains[0],
    "javascript:bad",
  );
});

test("account retirement during native Browser activation cannot install a late extension or advertise capability", async () => {
  let activate!: () => void;
  let deactivate!: () => Promise<void>;
  let installs = 0;
  const ctx = {
    store: { conversations: [], settings: {} },
    scheduler: {},
    engine: {
      extensions: {
        add() {
          installs++;
          return () => {};
        },
      },
    },
    policy: () => openPolicy,
    onSettingsChanged() {},
    onAccountActivated(cb: () => void) {
      activate = cb;
    },
    onAccountDeactivating(cb: () => Promise<void>) {
      deactivate = cb;
    },
  } as any;
  registerBrowserTools(ctx, {
    service: async () => {
      throw Error("Retired activation cannot create a Browser");
    },
    siteRisk: async () => undefined,
  });
  activate();
  await deactivate();
  assert.equal(installs, 0);
  assert.equal(routineBrowserAvailable(ctx), false);
});

test("an in-flight routine call cannot inherit global Browser permissions when an attended follow-up replaces its binding", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  f.scheduler.allowBrowserSite(f.task.id, origin);
  const entered = deferred<void>(),
    release = deferred<void>();
  const b = browser(f, f.conversations[0], {
    risk: async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    },
  });
  const pending = b.call(false);
  await entered.promise;
  b.unbind();
  release.resolve();
  assert.equal((await pending).isError, true);
  assert.equal(b.reads(), 0);
});

test("a real once-only high-risk navigation works for the bound run without saving a domain grant", async (t) => {
  const f = fixture(t);
  await f.scheduler.runNow(f.task.id);
  const b = browser(f, f.conversations[0], { risk: async () => "high-risk" });
  const result = await b.navigate();
  assert.equal(result.isError, undefined, text(result));
  assert.equal(b.questions(), 1);
  assert.equal(f.scheduler.browserGrant(f.task.id), undefined);
});
test("desktop Browser routine API routes explicit execution source, including same-ID tasks, and retires late reads", async () => {
  const { CloudRoutines } = await import("../../electron/cloud/cloud-routines");
  const pending = deferred<any>();
  const entered = deferred<void>();
  const remoteCalls: any[] = [],
    localCalls: any[] = [];
  let connected = true;
  const client = {
    call: async (method: string, args: unknown[]) => {
      remoteCalls.push([method, args]);
      if (method === "routineBrowserPermissions") {
        entered.resolve();
        return pending.promise;
      }
    },
  };
  const router = new CloudRoutines(() =>
    connected ? (client as any) : undefined,
  );
  const read = router.route("routineBrowserPermissions", (id) => {
    localCalls.push(id);
    return { status: "supported", readOnly: false };
  })!;
  const revoke = router.route("clearRoutineBrowserPermissions", (id) => {
    localCalls.push(`revoke:${id}`);
  })!;
  router.update([{ id: "same" } as Routine], "local");
  router.update([{ id: "same" } as Routine], "remote");
  assert.equal((await read("same", "local")).status, "supported");
  await revoke("same", "local");
  await revoke("same", "remote");
  assert.deepEqual(localCalls, ["same", "revoke:same"]);
  assert.deepEqual(remoteCalls, [["clearRoutineBrowserPermissions", ["same"]]]);
  const late = read("same", "remote");
  await entered.promise;
  router.reset();
  pending.resolve({ status: "unsupported", message: "Retired host" });
  await assert.rejects(late);
  connected = false;
  await assert.rejects(read("same", "remote"));
  await assert.rejects(revoke("same", "remote"));
  await assert.rejects(read("same", "unknown"));
});
