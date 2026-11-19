import test from "node:test";
import assert from "node:assert/strict";
import { openOfficialCompletion } from "../../src-web/official/completion-fetch";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import type { AppEvent } from "../../shared/types";
import { webErrorCodes } from "../../shared/web-protocol";
const org = "11111111-1111-4111-8111-111111111111",
  chat = "22222222-2222-4222-8222-222222222222",
  op = "33333333-3333-4333-8333-333333333333";
const path = `/api/organizations/${org}/chat_conversations/${chat}/completion`;
const request = {
  method: "POST" as const,
  path,
  contentType: "application/json",
  body: new TextEncoder().encode("{}"),
};
const event = (event: string, data: object = { type: event }) => ({
  event,
  data,
});
const response = (
  cursor: number,
  events: ReturnType<typeof event>[],
  done = false,
  operation_id = op,
) => ({
  status: 200,
  contentType: "application/json",
  body: new TextEncoder().encode(
    JSON.stringify({ operation_id, cursor, events, done }),
  ),
});
function harness() {
  let listener: (e: AppEvent) => void = () => {},
    unsub = 0,
    posts = 0,
    reads = 0;
  return {
    subscribe: (fn: typeof listener) => {
      listener = fn;
      return () => {
        unsub++;
      };
    },
    emit: (e: AppEvent) => listener(e),
    action: async () => {
      posts++;
      return response(1, [event("message_start")]);
    },
    read: async () => {
      reads++;
      return response(2, [event("message_stop")], true);
    },
    get counts() {
      return { unsub, posts, reads };
    },
  };
}
test("completion posts once and exposes exact UTF8 SSE incrementally, then closes", async () => {
  const h = harness();
  let release!: (value: any) => void;
  const next = new Promise<any>((r) => (release = r));
  const result = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async (req) => {
      assert.match(req.path, /cursor=1$/);
      return next;
    },
    h.action,
    h.subscribe,
  );
  const reader = result.body!.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /event: message_start/,
  );
  release(
    response(
      3,
      [
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "中文\nline" },
        }),
        event("message_stop"),
      ],
      true,
    ),
  );
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /中文\\nline/);
  assert.equal((await reader.read()).done, true);
  assert.equal(h.counts.posts, 1);
  assert.equal(h.counts.unsub, 1);
});
test("transient batch transport failures resume at the same cursor without resending", async () => {
  const h = harness();
  const paths: string[] = [];
  const result = await openOfficialCompletion(
    request, new AbortController().signal,
    async ({ path }) => {
      paths.push(path);
      if (paths.length === 1) throw Object.assign(new Error("offline"), { code: webErrorCodes.runnerUnavailable });
      if (paths.length === 2) throw Object.assign(new Error("timeout"), { code: webErrorCodes.timeout });
      return response(2, [event("message_stop")], true);
    }, h.action, h.subscribe, { pollMs: 2, deadlineMs: 1000 },
  );
  const text = await result.text();
  assert.match(text, /event: message_stop/);
  assert.doesNotMatch(text, /event: error/);
  assert.equal(h.counts.posts, 1);
  assert.equal(paths.length, 3);
  assert.ok(paths.every((path) => path.endsWith("cursor=1")));
});
test("permanent batch failures remain terminal and transient failures respect the deadline", async () => {
  const permanent = harness();
  const denied = await openOfficialCompletion(request, new AbortController().signal,
    async () => { throw Object.assign(new Error("signed out"), { code: "UNAUTHORIZED" }); },
    permanent.action, permanent.subscribe, { pollMs: 2, deadlineMs: 1000 });
  assert.match(await denied.text(), /signed out/);
  assert.equal(permanent.counts.posts, 1);
  const transient = harness();
  const timed = await openOfficialCompletion(request, new AbortController().signal,
    async () => { throw Object.assign(new Error("offline"), { code: webErrorCodes.runnerUnavailable }); },
    transient.action, transient.subscribe, { pollMs: 2, deadlineMs: 20 });
  assert.match(await timed.text(), /timed out/);
  assert.equal(transient.counts.posts, 1);
  assert.equal(transient.counts.unsub, 1);
});
test("non200 initial reply stays an actionable HTTP error, no stream/read", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    h.read,
    async () => ({
      status: 501,
      contentType: "application/json",
      body: new TextEncoder().encode('{"error":"Unsupported tools"}'),
    }),
    h.subscribe,
  );
  assert.equal(r.status, 501);
  assert.match(await r.text(), /Unsupported tools/);
  assert.equal(h.counts.reads, 0);
  assert.equal(h.counts.unsub, 1);
});
test("abort while submitting detaches, never resubmits or interrupts", async () => {
  const h = harness(),
    abort = new AbortController();
  const result = openOfficialCompletion(
    request,
    abort.signal,
    h.read,
    async () => new Promise(() => {}),
    h.subscribe,
  );
  abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(h.counts.unsub, 1);
  assert.equal(h.counts.reads, 0);
});
test("signout after initial frame suppresses late batches", async () => {
  const h = harness();
  let release!: (v: any) => void;
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    () => new Promise((resolve) => (release = resolve)),
    h.action,
    h.subscribe,
  );
  const reader = r.body!.getReader();
  await reader.read();
  h.emit({ type: "signed-out" } as AppEvent);
  release(response(2, [event("message_stop")], true));
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(h.counts.unsub, 1);
  assert.equal(h.counts.posts, 1);
});
test("changed operation identity becomes SSE error, not successful stop", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => response(2, [event("message_stop")], true, org),
    h.action,
    h.subscribe,
  );
  const text = await r.text();
  assert.match(text, /event: error/);
  assert.doesNotMatch(text, /event: message_stop/);
});
test("empty nonterminal polls are bounded, never replay POST", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => response(1, []),
    h.action,
    h.subscribe,
    { pollMs: 2, deadlineMs: 20 },
  );
  assert.match(await r.text(), /timed out/);
  assert.equal(h.counts.posts, 1);
  assert.equal(h.counts.unsub, 1);
});
test("canceling browser reader unsubscribes without stopping engine", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => response(1, []),
    h.action,
    h.subscribe,
  );
  await r.body!.cancel();
  assert.equal(h.counts.unsub, 1);
  assert.equal(h.counts.posts, 1);
});
test("malformed event termination rejects instead of yielding empty success", async () => {
  const h = harness();
  await assert.rejects(
    openOfficialCompletion(
      request,
      new AbortController().signal,
      h.read,
      async () => response(1, [event("message_start")], true),
      h.subscribe,
    ),
    /termination/,
  );
  assert.equal(h.counts.unsub, 1);
});
test("fetch exact completion route only, no action on query or remote origin", async () => {
  let calls = 0;
  const h = harness();
  const f = createOfficialReadFetch(
    "http://local",
    h.read,
    async () => {
      calls++;
      return new Response("native");
    },
    h.subscribe,
    h.action,
  );
  const r = await f(path, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.match(await r.text(), /message_stop/);
  assert.equal(h.counts.posts, 1);
  assert.equal(
    (await f(path + "?bad=1", { method: "POST", body: "{}" })).status,
    501,
  );
  await f("https://example.invalid" + path, { method: "POST" });
  assert.equal(calls, 1);
  assert.equal(h.counts.posts, 1);
});

test("poll failure stays actionable and never reports message_stop", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => ({
      status: 409,
      contentType: "application/json",
      body: new TextEncoder().encode(
        '{"error":{"message":"Account changed."}}',
      ),
    }),
    h.action,
    h.subscribe,
  );
  const text = await r.text();
  assert.match(text, /event: error/);
  assert.match(text, /Account changed/);
  assert.doesNotMatch(text, /event: message_stop/);
});
test("cursor jumps and oversized batches fail closed", async () => {
  const h = harness();
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => response(5, [event("message_stop")], true),
    h.action,
    h.subscribe,
  );
  assert.match(await r.text(), /cursor changed/);
  await assert.rejects(
    openOfficialCompletion(
      request,
      new AbortController().signal,
      h.read,
      async () =>
        response(1, [event("message_start", { text: "x".repeat(256 * 1024) })]),
      h.subscribe,
    ),
    /Invalid completion batch/,
  );
});
test("reader backpressure prevents fetching unbounded batches", async () => {
  const h = harness();
  let calls = 0;
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => {
      calls++;
      return response(2, [event("message_stop")], true);
    },
    h.action,
    h.subscribe,
    { pollMs: 2 },
  );
  h.emit({ type: "resync" });
  h.emit({ type: "resync" });
  assert.equal(calls, 0);
  const reader = r.body!.getReader();
  await reader.read();
  await reader.read();
  assert.equal((await reader.read()).done, true);
  assert.equal(calls, 1);
});

test("initial prefix cannot be skipped and terminal reason cannot disappear", async () => {
  const h = harness();
  await assert.rejects(
    openOfficialCompletion(
      request,
      new AbortController().signal,
      h.read,
      async () => response(3, [event("message_start")]),
      h.subscribe,
    ),
    /prefix/,
  );
  const r = await openOfficialCompletion(
    request,
    new AbortController().signal,
    async () => response(1, [], true),
    h.action,
    h.subscribe,
  );
  assert.match(await r.text(), /termination is inconsistent/);
});
test("synchronous signout and subscription failure never submit", async () => {
  const h = harness();
  let unsubscribed = 0;
  await assert.rejects(
    openOfficialCompletion(
      request,
      new AbortController().signal,
      h.read,
      h.action,
      (listener) => {
        listener({ type: "signed-out" } as AppEvent);
        return () => {
          unsubscribed++;
        };
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(unsubscribed, 1);
  assert.equal(h.counts.posts, 0);
  await assert.rejects(
    openOfficialCompletion(
      request,
      new AbortController().signal,
      h.read,
      h.action,
      () => {
        throw Error("Event channel unavailable");
      },
    ),
    /Event channel unavailable/,
  );
  assert.equal(h.counts.posts, 0);
});

test("malformed terminal ordering never publishes a success before its error", async () => {
  for (const events of [
    [event("message_stop"), event("content_block_delta")],
    [event("message_stop"), event("error")],
    [event("error"), event("message_stop")],
    [event("message_stop"), event("message_stop")],
    [event("error"), event("ping")],
  ]) {
    const initial = harness();
    await assert.rejects(
      openOfficialCompletion(
        request,
        new AbortController().signal,
        initial.read,
        async () => response(events.length, events, true),
        initial.subscribe,
      ),
      /unique and last/,
    );
    assert.equal(initial.counts.reads, 0);
    assert.equal(initial.counts.unsub, 1);
    const h = harness();
    const result = await openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => response(1 + events.length, events, true),
      h.action,
      h.subscribe,
    );
    const text = await result.text();
    assert.match(text, /event: error/);
    assert.match(text, /unique and last/);
    assert.doesNotMatch(text, /event: message_stop/);
    assert.equal(h.counts.posts, 1);
    assert.equal(h.counts.unsub, 1);
  }
});
test("a single final error or success remains valid with preceding content", async () => {
  for (const last of ["error", "message_stop"]) {
    const h = harness(),
      events = [event("content_block_delta"), event(last)];
    const result = await openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => response(3, events, true),
      h.action,
      h.subscribe,
    );
    const text = await result.text();
    assert.ok(text.includes("event: " + last));
    assert.doesNotMatch(text, /unique and last/);
    assert.equal(h.counts.posts, 1);
    assert.equal(h.counts.unsub, 1);
  }
});

test("SSE event name and payload type must agree before any terminal is published", async () => {
  for (const malformed of [
    event("message_stop", { type: "content_block_delta" }),
    event("message_stop", {}),
    event("error", { type: "message_stop" }),
    event("content_block_delta", { type: "message_stop" }),
    event("message_start", { type: null }),
  ]) {
    const done = ["error", "message_stop"].includes(malformed.event);
    const initial = harness();
    await assert.rejects(
      openOfficialCompletion(
        request,
        new AbortController().signal,
        initial.read,
        async () => response(1, [malformed], done),
        initial.subscribe,
      ),
      /Invalid completion event/,
    );
    assert.equal(initial.counts.reads, 0);
    assert.equal(initial.counts.unsub, 1);
    const h = harness();
    const result = await openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => response(2, [malformed], done),
      h.action,
      h.subscribe,
    );
    const text = await result.text();
    assert.match(text, /event: error/);
    assert.match(text, /Invalid completion event/);
    assert.doesNotMatch(text, /event: message_stop/);
    assert.equal(h.counts.posts, 1);
    assert.equal(h.counts.unsub, 1);
  }
});

test("operation identifier must be a string, never a regex-coerced UUID array", async () => {
  for (const malformed of [[op], { value: op }, null, 42]) {
    const h = harness();
    await assert.rejects(
      openOfficialCompletion(
        request,
        new AbortController().signal,
        h.read,
        async () =>
          response(1, [event("message_start")], false, malformed as any),
        h.subscribe,
      ),
      /Invalid completion batch/,
    );
    assert.equal(h.counts.reads, 0);
    assert.equal(h.counts.unsub, 1);
    const continuation = harness();
    const result = await openOfficialCompletion(
      request,
      new AbortController().signal,
      async () => response(2, [event("message_stop")], true, malformed as any),
      continuation.action,
      continuation.subscribe,
    );
    const text = await result.text();
    assert.match(text, /Invalid completion batch/);
    assert.doesNotMatch(text, /event: message_stop/);
    assert.equal(continuation.counts.posts, 1);
    assert.equal(continuation.counts.unsub, 1);
  }
});
