import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { startOfficialFrame } from "../../src-web/official/frame-entry";
import type { OfficialFrameBindings } from "../../src-web/official/frame-lifecycle";
import type { AppEvent, Conversation } from "../../shared/types";

const stale = "11111111-1111-4111-8111-111111111111";
const current = "22222222-2222-4222-8222-222222222222";
const account = {
  status: 200,
  contentType: "application/json",
  body: new TextEncoder().encode(JSON.stringify({
    uuid: "account-fixture",
    memberships: [
      { organization: { uuid: stale, capabilities: ["console"] } },
      { organization: { uuid: current, capabilities: ["chat"] } },
    ],
  })),
};

for (const theme of ["light", "dark", "auto"] as const) {
  for (const systemDark of [false, true]) {
    test(`official ${theme} theme stays consistent on a ${systemDark ? "dark" : "light"} system`, async t => {
      const { frame } = fixture(t, async () => account);
      frame.matchMedia = () => ({ matches: systemDark }) as MediaQueryList;
      frame.localStorage.setItem("claudex:official:account-fixture:LSS-userThemeMode", JSON.stringify({ value: theme }));
      await startOfficialFrame();
      const resolved = theme === "auto" ? systemDark ? "dark" : "light" : theme;
      assert.equal(frame.document.body.dataset.modeAtImport, resolved);
      assert.equal(frame.parent.document.documentElement.dataset.theme, theme === "auto" ? undefined : theme);
      frame.localStorage.setItem("LSS-userThemeMode", JSON.stringify({ value: "dark" }));
      assert.equal(frame.document.documentElement.dataset.mode, "dark");
      assert.equal(frame.parent.document.documentElement.dataset.theme, "dark");
    });
  }
}

function fixture(
  t: TestContext,
  read: OfficialFrameBindings["read"],
  action: OfficialFrameBindings["action"] = async () => { throw Error("Unexpected action"); },
) {
  const dom = new JSDOM('<iframe src="/official-frame.html"></iframe>', { url: "https://fixture.invalid/new" });
  const frame = dom.window.document.querySelector("iframe")!.contentDocument!.defaultView!;
  frame.document.write('<!doctype html><html data-build-id="79979f1379"><head></head><body><div id="root"></div><div id="portal-root"></div></body></html>');
  Object.defineProperty(frame.document, "fonts", { value: { load: async () => [] } });
  Object.defineProperty(frame, "indexedDB", { configurable: true, value: {} });
  frame.fetch = async () => { throw Error("Unexpected browser fetch."); };
  frame.matchMedia = () => ({ matches: false }) as MediaQueryList;
  let live = true;
  let exits = 0;
  const navigations: [route: string, replace: boolean][] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  dom.window.__claudexOfficialFrameBindings = () => ({
    read,
    action,
    account: {
      activeSessions: async () => [],
      endActiveSession: async () => ({ ended: false }),
      browserAccounts: async () => ({ accounts: [], max_accounts: 1 }),
      switchAccount: async () => { throw Error("Unexpected account switch"); },
      addAccount: async () => { throw Error("Unexpected account addition"); },
      signOut: async () => { throw Error("Unexpected sign-out"); },
    },
    events(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isCurrent: () => live,
    route: "/new",
    userContentOrigin: "https://preview.fixture.invalid",
    onNavigate(route, replace) { navigations.push([route, replace]); },
    onDocumentExit() { exits++; },
  });
  const replacements = {
    window: frame,
    document: frame.document,
    history: frame.history,
    location: frame.location,
    AbortSignal: frame.AbortSignal,
    Element: frame.Element,
    HTMLAnchorElement: frame.HTMLAnchorElement,
    __OFFICIAL_ENTRY__: "data:text/javascript," + encodeURIComponent(
      "document.body.dataset.orgAtImport = window.__claudexOfficialAccountContext.orgUuid;" +
      "document.body.dataset.previewAtImport = window.__claudexOfficialUserContentOrigin;" +
      "document.body.dataset.listsAtImport = String(window.__claudexConversationListsRevision);" +
      "document.body.dataset.modeAtImport = document.documentElement.dataset.mode",
    ) + "#" + encodeURIComponent(t.name),
  };
  const globals = globalThis as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(replacements).map((key) => [key, globals[key]]));
  Object.assign(globalThis, replacements);
  t.after(() => {
    Object.assign(globalThis, previous);
    dom.window.close();
  });
  frame.document.cookie = `lastActiveOrg=${stale}; Path=/`;
  return {
    frame, listeners, Event: dom.window.Event, exits: () => exits, navigations,
    emit: (event: AppEvent) => { for (const listener of listeners) listener(event); },
    retire: () => { live = false; },
  };
}

test("standalone Design links open a new browser tab from the official frame", async (t) => {
  const { frame, navigations } = fixture(t, async (request) => {
    assert.equal(request.path, "/api/account");
    return account;
  });
  const opened: { address?: string | URL; target?: string }[] = [];
  frame.open = (address, target) => {
    opened.push({ address, target });
    return null;
  };
  await startOfficialFrame();
  const project = `/design/p/${current}`;
  const link = frame.document.createElement("a");
  link.href = `${project}?noredir=1&org=local`;
  link.target = "_blank";
  frame.document.body.append(link);
  const click = () => link.dispatchEvent(new frame.MouseEvent("click", { bubbles: true, cancelable: true }));
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  assert.equal(click(), false);
  assert.deepEqual(opened, []);

  assert.equal(click(), false);
  const auxclick = (button: number) => link.dispatchEvent(new frame.MouseEvent("auxclick", { bubbles: true, cancelable: true, button }));
  assert.equal(auxclick(2), true);
  assert.equal(auxclick(1), false);
  frame.open(`${project}?move=review&org=local`, "_blank");
  frame.open("/settings/design-systems", "_blank");
  assert.deepEqual(opened, [
    { address: `https://claude.ai${project}?noredir=1`, target: "_blank" },
    { address: `https://claude.ai${project}?noredir=1`, target: "_blank" },
    { address: `https://claude.ai${project}?move=review`, target: "_blank" },
    { address: "/settings/design-systems", target: "_blank" },
  ]);
  assert.deepEqual(navigations, []);
});

test("Project tabs update the frame query without leaving Projects", async (t) => {
  const { frame, navigations } = fixture(t, async (request) => {
    assert.equal(request.path, "/api/account");
    return account;
  });
  await startOfficialFrame();
  frame.history.pushState(null, "", "/projects");
  frame.history.pushState(null, "", "?category=team");
  frame.history.replaceState(null, "", "#results");
  assert.equal(frame.location.pathname, "/projects");
  assert.equal(frame.location.search, "?category=team");
  assert.equal(frame.location.hash, "#results");
  assert.deepEqual(navigations, [
    ["/projects", false],
    ["/projects?category=team", false],
    ["/projects?category=team#results", true],
  ]);
});

test("Code mark-read uses the revision that accompanied the visible result", async (t) => {
  const key = "ab".repeat(16);
  const session = "/v1/code/sessions/session_" + key;
  const eventId = "completed:result";
  const answer = (value: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  const observed: Parameters<OfficialFrameBindings["action"]>[0][] = [];
  const { frame } = fixture(t, async (request) => {
    if (request.path === "/api/account") return account;
    if (request.path === session + "/events") return answer({
      data: [{ payload: { type: "result", uuid: eventId } }],
      claudex_read_event: { id: eventId, revision: 1 },
    });
    assert.equal(request.path, "/v1/code/sessions");
    return answer({ data: [{ id: "session_" + key, claudex_read_revision: 2 }] });
  }, async (request) => {
    observed.push(request);
    return answer({});
  });
  await startOfficialFrame();
  await frame.fetch(session + "/events");
  await frame.fetch("/v1/code/sessions");
  const mark = (body: unknown) => frame.fetch(session + "/mark_read", {
    method: "POST",
    headers: { "content-type": "application/json", "x-organization-uuid": current },
    body: JSON.stringify(body),
  });
  assert.equal((await mark({ event_id: eventId })).status, 200);
  assert.equal((await mark({})).status, 200);
  assert.deepEqual(observed.map(({ codeReadRevision }) => codeReadRevision), [1, 2]);
  assert.deepEqual(observed.map(({ body }) => JSON.parse(new TextDecoder().decode(body))), [
    { event_id: eventId },
    {},
  ]);
});

test("official frame binds its authenticated organization and preview origin before importing the original frontend", async (t) => {
  const { frame } = fixture(t, async (request) => {
    assert.deepEqual(request, { method: "GET", path: "/api/account" });
    return account;
  });
  const root = frame.document.getElementById("root");
  const portals = frame.document.getElementById("portal-root");
  frame.localStorage.setItem('claudex:official:account-fixture:LSS-userThemeMode', JSON.stringify("dark"));
  await startOfficialFrame();
  assert.equal(frame.document.getElementById("root"), root);
  assert.equal(frame.document.getElementById("portal-root"), portals);
  assert.equal(frame.document.body.dataset.modeAtImport, "dark");
  assert.equal(frame.parent.document.documentElement.dataset.theme, "dark");
  frame.localStorage.setItem("LSS-userThemeMode", JSON.stringify("light"));
  assert.equal(frame.parent.document.documentElement.dataset.theme, "light");
  assert.equal(frame.document.documentElement.dataset.mode, "light");
  assert.equal(frame.document.body.dataset.orgAtImport, current);
  assert.equal(frame.document.body.dataset.previewAtImport, "https://preview.fixture.invalid");
  assert.equal(frame.document.cookie, `lastActiveOrg=${stale}`);
  const context = Object.getOwnPropertyDescriptor(frame, "__claudexOfficialAccountContext")!;
  assert.equal(context.value.orgUuid, current);
  assert.equal(context.value.accountUuid, "account-fixture");
  assert.equal(context.writable, false);
  assert.ok(Object.isFrozen(context.value));
});

test("official Code history notifies the frame only for processed input", async (t) => {
  const key = "a".repeat(32);
  const processed = "6d94e215-e2ac-437f-aa79-97da1808426e";
  const waiting = "a7535a40-c951-47d7-bacd-51956bc6b9b8";
  const { frame, retire } = fixture(t, async (request) => {
    if (request.path === "/api/account") return account;
    assert.equal(request.path, `/v1/code/sessions/session_${key}/events`);
    return {
      status: 200,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify({ data: [
        { payload: { type: "user", uuid: waiting } },
        { processing_at: "2026-11-12T10:00:00Z", payload: { type: "user", uuid: processed } },
      ] })),
    };
  });
  await startOfficialFrame();
  const context = frame.__claudexOfficialAccountContext!;
  let updates = 0;
  const off = context.subscribeCodeInputReceipts(() => updates++);
  assert.equal(context.isCodeInputProcessed(`session_${key}`, processed), false);
  assert.equal((await frame.fetch(`/v1/code/sessions/session_${key}/events`)).status, 200);
  assert.equal(context.isCodeInputProcessed(`cse_${key}`, processed), true);
  assert.equal(context.isCodeInputProcessed(`session_${key}`, waiting), false);
  assert.equal(updates, 1);
  off();
  retire();
  assert.equal(context.isCodeInputProcessed(`session_${key}`, processed), false);
});

test("Code queue history hydrates held and unknown inputs without reloading unchanged payloads", async (t) => {
  const key = "b".repeat(32);
  const sessionId = `session_${key}`;
  const historyPath = `/v1/code/sessions/${sessionId}/events`;
  const held = "6d94e215-e2ac-437f-aa79-97da1808426e";
  const unknown = "a7535a40-c951-47d7-bacd-51956bc6b9b8";
  let queue = [{ uuid: held, state: "held" }, { uuid: unknown, state: "unknown" }];
  const requested: string[] = [];
  const { frame } = fixture(t, async (request) => {
    if (request.path === "/api/account") return account;
    let body: unknown;
    if (request.path === historyPath) {
      body = { data: [], queue };
    } else {
      const uuid = request.path.slice(`${historyPath}/queue/`.length);
      const item = queue.find((entry) => entry.uuid === uuid);
      assert.ok(request.path.startsWith(`${historyPath}/queue/`) && item);
      requested.push(uuid);
      body = { type: "user", uuid, claudexQueueState: item.state, message: { role: "user", content: uuid } };
    }
    return { status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(body)) };
  });
  await startOfficialFrame();
  const receive = () => new Promise<string[]>((resolve) => {
    const off = frame.__claudexOfficialAccountContext!.subscribeCodeQueue((id, messages) => {
      assert.equal(id, sessionId);
      off();
      resolve(messages.map((message) => `${message.uuid}:${message.claudexQueueState}`));
    });
  });
  const first = receive();
  await frame.fetch(historyPath);
  assert.deepEqual(await first, [`${held}:held`, `${unknown}:unknown`]);
  queue = [{ uuid: held, state: "sending" }];
  const second = receive();
  await frame.fetch(historyPath);
  assert.deepEqual(await second, [`${held}:sending`]);
  queue = [];
  const cleared = receive();
  await frame.fetch(historyPath);
  assert.deepEqual(await cleared, []);
  assert.deepEqual(requested, [held, unknown]);
});

test("a retired frame cannot publish the account context and releases its events", async (t) => {
  let release!: (value: typeof account) => void;
  const { frame, retire, emit, listeners } = fixture(t, () => new Promise((resolve) => { release = resolve; }));
  const opening = startOfficialFrame();
  retire();
  emit({ type: "resync" });
  release(account);
  await assert.rejects(opening, { name: "AbortError" });
  assert.equal(frame.__claudexOfficialAccountContext, undefined);
  assert.equal(Object.hasOwn(frame, "__claudexOfficialUserContentOrigin"), false);
  assert.equal(frame.document.cookie, `lastActiveOrg=${stale}`);
  assert.equal(frame.__claudexConversationListsRevision, 0);
  assert.equal(listeners.size, 0);
});

test("the production Web frame retains early resync and removes its listener at page exit", async (t) => {
  let release!: (value: typeof account) => void;
  const { frame, emit, listeners, Event, exits } = fixture(t, () => new Promise((resolve) => { release = resolve; }));
  const opening = startOfficialFrame();
  emit({ type: "resync" });
  release(account);
  await opening;
  assert.equal(frame.document.body.dataset.listsAtImport, "1");
  const observed: (number | undefined)[] = [];
  frame.addEventListener("claudex:conversation-lists-invalidated",
    () => observed.push(frame.__claudexConversationListsRevision));
  emit({ type: "resync" });
  assert.deepEqual(observed, [2]);
  frame.dispatchEvent(new Event("pagehide"));
  assert.equal(exits(), 1);
  assert.equal(listeners.size, 0);
  emit({ type: "resync" });
  assert.deepEqual(observed, [2]);
});

test("sign-out retires the Web list notification with the frame's other subscriptions", async (t) => {
  const { frame, emit, listeners, retire } = fixture(t, async () => account);
  await startOfficialFrame();
  emit({ type: "resync" });
  retire();
  emit({ type: "signed-out", reason: "session-expired", message: "The active account changed." });
  assert.equal(listeners.size, 0);
  emit({ type: "resync" });
  assert.equal(frame.__claudexConversationListsRevision, 1);
});

test("metadata events reach the existing Web list bridge without a frame reload", async (t) => {
  const { frame, emit, retire } = fixture(t, async () => account);
  await startOfficialFrame();
  const chat: Conversation = {
    id: "chat", title: "Before", mode: "chat", model: "fixture", providerId: "fixture",
    createdAt: 1, updatedAt: 1, pinned: false, archived: false, turns: [],
  };
  const revisions: (number | undefined)[] = [];
  frame.addEventListener("claudex:conversation-lists-invalidated",
    () => revisions.push(frame.__claudexConversationListsRevision));
  emit({ type: "conversation", conversation: chat });
  emit({ type: "conversation", conversation: { ...chat, title: "After" } });
  emit({ type: "conversation", conversation: { ...chat, title: "After" } });
  retire();
  emit({ type: "conversation", conversation: { ...chat, title: "Retired" } });
  assert.deepEqual(revisions, [1, 2]);
});
