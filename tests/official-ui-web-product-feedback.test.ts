import assert from "node:assert/strict";
import test from "node:test";
import { createWebProductFeedback } from "../src-web/bridge/product-feedback";
import { productFeedbackPath } from "../shared/product-feedback";

const feedbackId = "fadadbd4-2109-4ac2-b232-2113418bbab5";
const sent = () => Response.json({ code: 0, data: { status: "sent", feedback_id: feedbackId } });

test("Web feedback retries a confirmed refusal with the same ID and deduplicates an unknown delivery", async () => {
  let send = () => Response.json({ code: 503, reason: "PRODUCT_FEEDBACK_UNAVAILABLE" }, { status: 503 });
  const calls: { id: string; token: string }[] = [];
  let activation = {};
  let token = "alpha";
  const auth = {
    get activationIdentity() { return activation; },
    accessToken: async () => token,
    refresh: async () => null,
    expire: () => undefined,
  };
  const submit = createWebProductFeedback({ timers: globalThis, fetch: async (path, init) => {
    assert.equal(path, productFeedbackPath);
    const { request_id: id, ...fields } = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(fields).sort(), ["app_version", "text"]);
    calls.push({ id, token: new Headers(init?.headers).get("Authorization") ?? "" });
    return send();
  } }, auth, "fixture");

  assert.deepEqual(await submit("retry"), { failureReason: "unavailable", statusCode: 503 });
  send = sent;
  assert.deepEqual(await submit("retry"), { feedbackId, includedTranscript: false });
  assert.equal(calls[1].id, calls[0].id);
  send = () => Response.json({ code: 409, reason: "PRODUCT_FEEDBACK_DELIVERY_UNKNOWN" }, { status: 409 });
  const unknown = await submit("unknown");
  assert.ok("deliveryState" in unknown && unknown.deliveryState === "unknown");
  assert.deepEqual(await submit("unknown"), unknown);
  assert.equal(calls.length, 3);

  activation = {};
  token = "beta";
  send = sent;
  assert.deepEqual(await submit("unknown"), { feedbackId, includedTranscript: false });
  assert.notEqual(calls[3].id, calls[2].id);
  assert.equal(calls[3].token, "Bearer beta");
});

test("Web feedback classifies token acquisition failure before dispatch as retryable", async () => {
  let ready = false;
  let dispatches = 0;
  const submit = createWebProductFeedback({ timers: globalThis, fetch: async () => { dispatches++; return sent(); } }, {
    activationIdentity: {},
    accessToken: async () => { if (!ready) throw Error("Token unavailable"); return "fixture"; },
    refresh: async () => null,
    expire: () => undefined,
  }, "fixture");
  assert.deepEqual(await submit("token retry"), { failureReason: "auth_error", statusCode: 401 });
  assert.equal(dispatches, 0);
  ready = true;
  assert.deepEqual(await submit("token retry"), { feedbackId, includedTranscript: false });
  assert.equal(dispatches, 1);
});
