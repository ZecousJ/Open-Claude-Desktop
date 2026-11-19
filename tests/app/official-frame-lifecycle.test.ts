import test from "node:test";
import assert from "node:assert/strict";
import {
  bindOfficialFrame,
  officialRoute,
} from "../../src-web/official/frame-lifecycle";
import { officialWebReadOnlyAction } from "../../src-web/official/readiness";
import type { AppEvent } from "../../shared/types";
const req = { method: "GET" as const, path: "/api/account" };
const answer = {
  status: 200,
  contentType: "application/json",
  body: new Uint8Array(),
};
test("frame callbacks reject late reads and cannot revive after same account signs in again", async () => {
  let live = true,
    release!: (v: typeof answer) => void,
    called = 0;
  const f = bindOfficialFrame(
    {
      read: () => new Promise((r) => (release = r)),
      action: async () => {
        called++;
        return answer;
      },
      events: () => () => {},
    },
    () => live,
    "/new",
    () => {},
  );
  const pending = f.bindings.read(req);
  live = false;
  f.dispose();
  live = true;
  release(answer);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(f.bindings.action(req), { name: "AbortError" });
  assert.equal(called, 0);
});
test("frame account revocation propagates signout once and cleans event subscriptions", () => {
  let listener: (e: AppEvent) => void = () => {},
    off = 0,
    seen = 0;
  const f = bindOfficialFrame(
    {
      read: async () => answer,
      action: async () => answer,
      events: (fn) => {
        listener = fn;
        return () => {
          off++;
        };
      },
    },
    () => true,
    "/new",
    () => {},
  );
  f.bindings.events((e) => {
    if (e.type === "signed-out") seen++;
  });
  listener({ type: "signed-out" } as AppEvent);
  listener({ type: "signed-out" } as AppEvent);
  assert.equal(seen, 1);
  assert.equal(off, 1);
  assert.equal(f.bindings.isCurrent(), false);
});
test("navigation is same-origin application only and host entry maps to new", () => {
  assert.equal(
    officialRoute("/chat/a?x=1#test", "https://local.test"),
    "/chat/a?x=1#test",
  );
  assert.equal(
    officialRoute("/official-web.html", "https://local.test"),
    "/new",
  );
  assert.throws(() =>
    officialRoute("https://other.test/new", "https://local.test"),
  );
  assert.throws(() => officialRoute("/api/account", "https://local.test"));
});
test("genuine entry actions fail with explicit readonly error, regardless of underlying runner capability", async () => {
  for (const method of ["POST", "PATCH", "DELETE"] as const) {
    const r = await officialWebReadOnlyAction({
      method,
      path: "/api/organizations/a/chat_conversations/b/completion",
    });
    assert.equal(r.status, 501);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), {
      type: "error",
      error: { type: "not_supported" },
    });
  }
});

test("throwing subscriber and cleanup cannot retain an expired binding", () => {
  const listeners: ((e: AppEvent) => void)[] = [];
  let cleanups = 0;
  const f = bindOfficialFrame(
    {
      read: async () => answer,
      action: async () => answer,
      events: (listener) => {
        listeners.push(listener);
        return () => {
          cleanups++;
          throw Error("cleanup failed");
        };
      },
    },
    () => true,
    "/new",
    () => {},
  );
  f.bindings.events(() => {
    throw Error("consumer failed");
  });
  f.bindings.events(() => {});
  assert.throws(
    () => listeners[0]({ type: "signed-out" } as AppEvent),
    /consumer failed/,
  );
  assert.equal(f.bindings.isCurrent(), false);
  assert.equal(cleanups, 2);
});

test("reload handshake reads current owned host route rather than initial navigation", () => {
  let location = "/new";
  const f = bindOfficialFrame({read: async () => answer, action: async () => answer, events: () => () => {}}, () => true,
    () => officialRoute(location, "https://local.test"),
    (route) => { location = officialRoute(route, "https://local.test"); });
  assert.equal(f.bindings.route, "/new");
  f.bindings.onNavigate("/chat/owned?artifactId=test#code", false);
  assert.equal(f.bindings.route, "/chat/owned?artifactId=test#code");
  assert.throws(() => f.bindings.onNavigate("https://other.test/chat/unowned", false));
  assert.throws(() => f.bindings.onNavigate("/api/account", false));
  assert.equal(f.bindings.route, "/chat/owned?artifactId=test#code");
  f.dispose();
  assert.throws(() => f.bindings.route, {name: "AbortError"});
});

test("synchronous signed-out registration disposes late unsubscribe and revokes route", () => {
  let off = 0;
  const f = bindOfficialFrame({read: async () => answer, action: async () => answer,
    events: (listener) => { listener({type: "signed-out"} as AppEvent); return () => { off++; }; }
  }, () => true, "/new", () => {});
  f.bindings.events(() => {});
  assert.equal(off, 1);
  assert.equal(f.bindings.isCurrent(), false);
  assert.throws(() => f.bindings.route, {name: "AbortError"});
});

test('synchronous ordinary event that exits document cleans late unsubscribe exactly once',()=>{
 let off=0;const f=bindOfficialFrame({read:async()=>answer,action:async()=>answer,events:listener=>{listener({type:'resync'} as AppEvent);return()=>{off++;};}},()=>true,'/new',()=>{});
 f.bindings.events(()=>f.bindings.onDocumentExit());assert.equal(f.bindings.isCurrent(),false);assert.equal(off,1);f.dispose();assert.equal(off,1);
});
test('synchronous ordinary consumer error still obtains and closes source unsubscribe',()=>{
 let off=0;const f=bindOfficialFrame({read:async()=>answer,action:async()=>answer,events:listener=>{listener({type:'resync'} as AppEvent);return()=>{off++;};}},()=>true,'/new',()=>{});
 assert.throws(()=>f.bindings.events(()=>{throw Error('Consumer failed');}),/Consumer failed/);assert.equal(f.bindings.isCurrent(),false);assert.equal(off,1);
});
