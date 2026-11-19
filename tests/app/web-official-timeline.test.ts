import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { officialUiTimelinePath } from "../../shared/official-ui-web";

test("official Web timeline follows account events, coalesces updates and stops on cancellation", async () => {
  let listener!: (event: any) => void;
  let subscriptions = 0, calls = 0;
  let release!: (answer: any) => void;
  const first = new Promise<any>((resolve) => { release = resolve; });
  const fetch = createOfficialReadFetch("https://example.test", async (request) => {
    assert.equal(request.path, officialUiTimelinePath);
    calls++;
    return calls === 1 ? first : { status: 200, contentType: "application/connect+proto", body: new Uint8Array([calls]) };
  }, async () => new Response(), (fn) => { listener = fn; subscriptions++; return () => { subscriptions--; }; });
  const pending = fetch(officialUiTimelinePath, { method: "POST", headers: { "content-type": "application/connect+proto" }, body: new Uint8Array([0, 0, 0, 0, 0]) });
  while (!listener) await new Promise((resolve) => setImmediate(resolve));
  listener({ type: "conversation-turn", conversationId: "a" });
  listener({ type: "conversation-turn", conversationId: "a" });
  release({ status: 200, contentType: "application/connect+proto", body: new Uint8Array([1]) });
  const response = await pending;
  const reader = response.body!.getReader();
  assert.deepEqual([...(await reader.read()).value!], [1]);
  assert.deepEqual([...(await reader.read()).value!], [2]);
  assert.equal(calls, 2);
  listener({ type: "resync" });
  assert.deepEqual([...(await reader.read()).value!], [3]);
  assert.equal(calls, 3);
  await reader.cancel();
  assert.equal(subscriptions, 0);
  listener({ type: "conversation-turn", conversationId: "a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
});

test("sign-out and abort close official timeline subscriptions", async () => {
  let listener!: (event: any) => void;
  let subscriptions = 0;
  const fetch = createOfficialReadFetch("https://example.test", async () => ({ status: 200, contentType: "application/connect+proto", body: new Uint8Array([1]) }),
    async () => new Response(), (fn) => { listener = fn; subscriptions++; return () => { subscriptions--; }; });
  const controller = new AbortController();
  const response = await fetch(officialUiTimelinePath, { method: "POST", signal: controller.signal, headers: { "content-type": "application/connect+proto" }, body: new Uint8Array(5) });
  const reader = response.body!.getReader(); await reader.read();
  listener({ type: "signed-out" });
  await assert.rejects(reader.read(), (error: Error) => error.name === "AbortError");
  assert.equal(subscriptions, 0);
  controller.abort();
  assert.equal(subscriptions, 0);
});

test("aborting a pending initial timeline query cannot start a stream", async () => {
  let subscriptions = 0, calls = 0;
  const fetch = createOfficialReadFetch("https://example.test", () => { calls++; return new Promise(() => {}); }, async () => new Response(),
    () => { subscriptions++; return () => { subscriptions--; }; });
  const controller = new AbortController();
  const pending = fetch(officialUiTimelinePath, { method: "POST", signal: controller.signal, headers: { "content-type": "application/connect+proto" }, body: new Uint8Array(5) });
  while (!calls) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  assert.equal(subscriptions, 0);
});
