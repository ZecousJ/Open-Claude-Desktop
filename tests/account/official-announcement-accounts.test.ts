import assert from "node:assert/strict";
import test from "node:test";
import type { AppContext } from "../../electron/app/app-context";
import { registerAnnouncementHandlers } from "../../electron/ipc/announcements";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { RemoteSession, SessionFile } from "../../electron/sub2api/session";
import { createWebBridge } from "../../src-web/bridge";
import { fakeTab, json, type Route } from "../app/web-bridge-fakes.test.ts";

const origin = "https://fixture.invalid";
const noticePath = "/api/v1/announcements";
const popupPath = "/api/v1/claudex/announcements";
const postedAt = "2026-01-01T00:00:00Z";
const readAt = "2026-01-02T00:00:00Z";
const users = [
  { id: 1, email: "one@fixture.invalid", username: "One" },
  { id: 2, email: "two@fixture.invalid", username: "Two" },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const ordinaryReads = new Set<number>();
  const popupActions = new Map<number, unknown>();
  let popupReplyFails = false;
  let listGate:
    | { sent: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> }
    | undefined;
  const route: Route = async (request) => {
    const path = new URL(request.url, origin).pathname;
    if (
      path.endsWith("/web/auth/login") ||
      path.endsWith("/web/auth/refresh")
    ) {
      const body = request.body as { email?: string; account?: string };
      const user = users.find(
        (item) => item.email === body.email || String(item.id) === body.account,
      );
      assert.ok(user);
      return json({
        code: 0,
        data: { user, access_token: `fixture-${user.id}`, expires_in: 3600 },
      });
    }
    if (path.includes("/web/rpc/")) return json({ ok: true, value: null });
    const token = request.headers.get("Authorization");
    const user = users.find((item) => token === `Bearer fixture-${item.id}`);
    assert.ok(user, `${path} uses the signed-in account's token`);
    if (path === noticePath && request.method === "GET") {
      const blocked = listGate;
      if (blocked) {
        listGate = undefined;
        blocked.sent.resolve();
        await blocked.resume.promise;
      }
      return json({
        code: 0,
        data: [
          {
            id: 7,
            title: "Release note",
            content: "**Full Markdown**",
            notify_mode: "silent",
            created_at: postedAt,
            ...(ordinaryReads.has(user.id) ? { read_at: readAt } : {}),
          },
        ],
      });
    }
    if (path === `${noticePath}/7/read` && request.method === "POST") {
      ordinaryReads.add(user.id);
      return json({ code: 0, data: { message: "ok" } });
    }
    if (path === `${popupPath}/pending` && request.method === "GET") {
      return json({
        code: 0,
        data: {
          items: [
            ...(popupActions.has(user.id)
              ? []
              : [
                  {
                    id: 7,
                    title: "Oldest pop-up",
                    body_html: "<p>Notice</p>",
                    body_format: "html",
                  },
                ]),
            { id: 6, title: "Next pop-up", body_html: "Next" },
          ],
        },
      });
    }
    if (path === `${popupPath}/7/read` && request.method === "POST") {
      if (popupReplyFails) {
        popupReplyFails = false;
        return json({ code: 503, message: "Try again." }, 503);
      }
      popupActions.set(user.id, request.body);
      return json({ code: 0, data: { recorded: true } });
    }
    return undefined;
  };
  const tab = fakeTab();
  tab.routes.push(route);
  const bridge = createWebBridge(tab.env);
  const client = new Sub2ApiClient(origin, async (input, init) => {
    const request = new Request(input, init);
    const body = request.body ? await request.json() : undefined;
    return (
      (await route({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      })) ?? json({}, 404)
    );
  });
  const file = new SessionFile("unused", {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error("Unexpected file write");
    },
    decryptString: () => {
      throw Error("Unexpected file read");
    },
  });
  const nextRemote = (user: (typeof users)[number]) => ({
    ready: true,
    accounts: { client },
    session: new RemoteSession(
      client,
      file,
      {
        version: 1,
        baseUrl: origin,
        accountId: String(user.id),
        userId: user.id,
        email: user.email,
        refreshToken: "fixture-refresh",
      },
      {
        accessToken: `fixture-${user.id}`,
        refreshToken: "fixture-refresh",
        expiresIn: 3600,
      },
    ),
  });
  const ctx = {
    remote: nextRemote(users[0]),
    accountRetiring: false,
    accountActivationIdentity: {},
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerAnnouncementHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx as unknown as AppContext,
  );
  const native = (name: string, ...args: unknown[]) => {
    const handler = handlers.get(name);
    assert.ok(handler);
    return Promise.resolve(handler(...args));
  };
  return {
    bridge,
    native,
    popupActions,
    selectNative: (index: number) => {
      ctx.remote = nextRemote(users[index]);
      ctx.accountActivationIdentity = {};
    },
    failPopupClose: () => {
      popupReplyFails = true;
    },
    holdOrdinaryList: () => {
      const gate = { sent: deferred(), resume: deferred() };
      listGate = gate;
      return gate;
    },
  };
}

test("native and Web share server read state, independently for each account and announcement stream", async (t) => {
  const { bridge, native, popupActions, selectNative, failPopupClose } =
    setup();
  t.after(() => bridge.dispose());
  await bridge.api.loginAccount(users[0].email, "fixture-password");
  const web = bridge.officialAnnouncements;
  assert.deepEqual(await web.notices(), [
    {
      id: "7",
      title: "Release note",
      content: "**Full Markdown**",
      popup: false,
      createdAt: Date.parse(postedAt),
      readAt: null,
      read: false,
    },
  ]);
  assert.deepEqual(
    (await web.pending()).map(({ id, bodyFormat }) => [id, bodyFormat]),
    [
      [7, "html"],
      [6, "text"],
    ],
  );
  await native("officialMarkAnnouncementRead", "7");
  assert.equal((await web.notices())[0].readAt, Date.parse(readAt));
  assert.deepEqual(
    (await web.pending()).map(({ id }) => id),
    [7, 6],
  );
  failPopupClose();
  await assert.rejects(web.close(7, "dismiss"), /Try again/);
  assert.deepEqual(
    (await web.pending()).map(({ id }) => id),
    [7, 6],
  );
  await web.close(7, "dismiss");
  assert.deepEqual(popupActions.get(1), { action: "dismiss" });
  assert.deepEqual(
    await native("officialPendingAnnouncements"),
    await web.pending(),
  );
  assert.deepEqual(
    (await web.pending()).map(({ id }) => id),
    [6],
  );

  await bridge.api.addAccount();
  await bridge.api.loginAccount(users[1].email, "fixture-password");
  selectNative(1);
  assert.equal((await web.notices())[0].readAt, null);
  assert.deepEqual(await native("officialAnnouncements"), await web.notices());
  assert.deepEqual(
    await native("officialPendingAnnouncements"),
    await web.pending(),
  );
  assert.deepEqual(
    (await web.pending()).map(({ id }) => id),
    [7, 6],
  );
  await bridge.api.switchAccount("1");
  assert.equal((await web.notices())[0].readAt, Date.parse(readAt));
  assert.deepEqual(
    (await web.pending()).map(({ id }) => id),
    [6],
  );
});

test("account changes discard stale announcement replies and stop queued writes", async (t) => {
  const { bridge, native, selectNative, holdOrdinaryList } = setup();
  t.after(() => bridge.dispose());
  await bridge.api.loginAccount(users[0].email, "fixture-password");

  const browserGate = holdOrdinaryList();
  const web = bridge.officialAnnouncements.notices();
  await browserGate.sent.promise;
  await bridge.api.addAccount();
  await bridge.api.loginAccount(users[1].email, "fixture-password");
  browserGate.resume.resolve();
  await assert.rejects(web, /active account changed/i);

  const nativeGate = holdOrdinaryList();
  const desktop = native("officialAnnouncements");
  await nativeGate.sent.promise;
  selectNative(0);
  nativeGate.resume.resolve();
  await assert.rejects(desktop, /account changed/i);

  const mark = native("officialMarkAnnouncementRead", "7");
  selectNative(1);
  await assert.rejects(mark, /account changed/i);
  assert.equal((await bridge.officialAnnouncements.notices())[0].readAt, null);
  await bridge.api.switchAccount("1");
  assert.equal((await bridge.officialAnnouncements.notices())[0].readAt, null);
});
