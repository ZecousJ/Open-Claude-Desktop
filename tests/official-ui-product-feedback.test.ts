import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { RemoteSession } from "../electron/sub2api/session";
import { randomUUID } from "node:crypto";
import { registerProductFeedback } from "../electron/official-ui/native/product-feedback";
import { registerProductFeedbackHandlers } from "../electron/ipc/product-feedback";
const assets =
  ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/";
function originalForm() {
  const file = assets + "c4b740774-EVvUEVti.js",
    source = fs.readFileSync(file, "utf8"),
    ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
  let found: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some((p) => p.name?.getText(ast) === "reportType") &&
      node.properties.some((p) => p.name?.getText(ast) === "details") &&
      node.getText(ast).includes("t.slice(0, xe)")
    ) {
      assert.equal(found, undefined);
      found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found);
  return vm.runInNewContext("(" + found.getText(ast) + ")", {
    j: "bug",
    A: "other_not_sure",
    Ge: { current: "self chosen area" },
    i: {},
    t: "Self-authored test feedback",
    xe: 4096,
    r: undefined,
    q: { model: "synthetic-private-model" },
    e: false,
    w: "feedback-menu",
  });
}
function setup() {
  const main: any = {
    store: { root: "unused" },
    activeAccount: { id: "synthetic-owner" },
    accountRetiring: false,
    accountActivationIdentity: {},
    appVersion: "1.2.3",
    onAccountDeactivating() {},
    onAccountActivated() {},
  };
  let bodies: any[] = [],
    requests = 0,
    mode = "sent",
    before: (() => void) | undefined;
  const transport: any = async (_url: string, init: any) => {
    requests++;
    bodies.push(JSON.parse(init.body));
    if (mode === "refresh-then-drop" && requests === 1)
      return new Response(
        JSON.stringify({ code: 401, reason: "TOKEN_EXPIRED" }),
        { status: 401 },
      );
    if (mode === "throw" || mode === "refresh-then-drop")
      throw Error("Private backend details must not escape");
    if (mode === "gateway503")
      return new Response("Unavailable", { status: 503 });
    if (mode === "unknown409" || mode === "unavailable503")
      return new Response(
        JSON.stringify({
          code: mode === "unknown409" ? 409 : 503,
          reason:
            mode === "unknown409"
              ? "PRODUCT_FEEDBACK_DELIVERY_UNKNOWN"
              : "PRODUCT_FEEDBACK_UNAVAILABLE",
        }),
        { status: mode === "unknown409" ? 409 : 503 },
      );
    return new Response(
      JSON.stringify({
        code: 0,
        data:
          mode === "sent"
            ? { status: "sent", feedback_id: randomUUID() }
            : { status: "queued", feedback_id: randomUUID() },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  main.remote = {
    ready: true,
    backend: {
      accounts: { baseUrl: "https://synthetic.invalid" },
      session: {
        authorized: async (fn: any, current: any) => {
          before?.();
          if (current && !current()) throw Error("Retired");
          return fn("inert-test-token");
        },
      },
    },
  };
  const ipc = new Map<string, any>();
  registerProductFeedbackHandlers(
    (name, fn) => ipc.set(name, fn),
    main,
    transport,
  );
  const native = new Map<string, any>();
  const adapter: any = {
    account: () => main.activeAccount,
    sessionIdentity: () => main.accountActivationIdentity,
    isCurrent: () => !main.accountRetiring,
    appVersion: main.appVersion,
    localCall: async (name: string, body: any) => ipc.get(name)(body),
  };
  registerProductFeedback({
    ctx: adapter,
    on: (name: string, fn: any) => native.set(name, fn),
  } as any);
  return {
    main,
    adapter,
    ipc,
    native,
    bodies,
    count: () => requests,
    setMode(v: string) {
      mode = v;
    },
    before(fn: () => void) {
      before = fn;
    },
    submit: (body: any) => native.get("CoworkFeedback.submitFeedback")(body),
  };
}
test("original ordinary form → registered native bridge → real authenticated IPC only sends text/version/request id", async () => {
  const x = setup(),
    form = originalForm();
  const result = await x.submit(form);
  assert.ok(result.feedbackId);
  assert.equal(result.includedTranscript, false);
  assert.equal(x.count(), 1);
  assert.deepEqual(Object.keys(x.bodies[0]).sort(), [
    "app_version",
    "request_id",
    "text",
  ]);
  assert.ok(x.bodies[0].text.startsWith(form.details));
  assert.ok(x.bodies[0].text.includes("Other area: self chosen area"));
  assert.ok(x.bodies[0].text.includes("Category: bug"));
  assert.equal(x.bodies[0].app_version, "1.2.3");
  assert.equal(
    JSON.stringify(x.bodies).includes("synthetic-private-model"),
    false,
  );
  assert.equal(JSON.stringify(x.bodies).includes("synthetic-owner"), false);
  assert.deepEqual(await x.submit(form), result);
  assert.equal(x.count(), 1);
  const info = x.native.get("CoworkFeedback.getSystemInfo")();
  assert.equal(info.appVersion, "1.2.3");
  assert.equal(x.count(), 1);
});
test("explicit logs/transcript, arbitrary recipient, malformed body and readonly requests never send", async () => {
  const x = setup();
  for (const extra of [
    { includeLogs: true },
    { includeTranscript: true },
    { to: "nobody@example.invalid" },
    { details: "" },
  ]) {
    const result = await x.submit({ ...originalForm(), ...extra });
    assert.equal(result.statusCode, 400);
    assert.equal(result.feedbackId, undefined);
  }
  x.adapter.readOnly = true;
  assert.equal((await x.submit(originalForm())).statusCode, 403);
  assert.equal(x.count(), 0);
  await assert.rejects(
    x.ipc.get("submitProductFeedback")({
      text: "x",
      app_version: "1.2.3",
      request_id: randomUUID(),
      to: "nobody@example.invalid",
    }),
  );
  assert.equal(x.count(), 0);
});
test("uncertain responses never claim success or dispatch on repeat", async () => {
  for (const mode of ["throw", "queued", "unknown409", "gateway503"]) {
    const x = setup();
    x.setMode(mode);
    const first = await x.submit(originalForm());
    assert.equal(first.claudexProductFeedback, true, mode);
    assert.equal(first.deliveryState, "unknown", mode);
    assert.equal(first.feedbackId, undefined);
    assert.equal(first.failureReason, "unconfirmed");
    assert.deepEqual(await x.submit(originalForm()), first);
    assert.equal(x.count(), 1);
    assert.equal(JSON.stringify(first).includes("Private"), false);
  }
});
test("retirement during authorization prevents transmission and post-response retirement prevents successful acknowledgement", async () => {
  const x = setup();
  x.before(() => {
    x.main.accountRetiring = true;
  });
  assert.equal((await x.submit(originalForm())).feedbackId, undefined);
  assert.equal(x.count(), 0);
  const y = setup(),
    call = y.adapter.localCall;
  y.adapter.localCall = async (...args: any[]) => {
    const response = await call(...args);
    y.main.accountRetiring = true;
    return response;
  };
  assert.equal((await y.submit(originalForm())).failureReason, "auth_error");
  assert.equal(y.count(), 1);
});

test("explicit choices and supplements survive without automatic metadata; combined oversize refuses without truncation", async () => {
  const x = setup();
  const form = {
    ...originalForm(),
    reportTypeOther: "My own category",
    areaOther: "My other area",
    impact: "blocked",
    frequency: "sometimes",
    regression: "yes",
    satisfaction: 3,
    source: "automatic-private-source",
    sessionId: "automatic-private-session",
    model: "automatic-private-model",
  };
  assert.ok((await x.submit(form)).feedbackId);
  for (const value of [
    "My own category",
    "My other area",
    "blocked",
    "sometimes",
    "yes",
    "Satisfaction: 3",
  ])
    assert.ok(x.bodies[0].text.includes(value));
  assert.equal(x.bodies[0].text.includes("automatic-private"), false);
  const y = setup();
  assert.equal(
    (await y.submit({ ...originalForm(), details: "a".repeat(4096) }))
      .statusCode,
    413,
  );
  assert.equal(y.count(), 0);
});

test("concurrent submissions share one receipt, and a known 503 retries the same request ID", async () => {
  const x = setup(),
    form = originalForm();
  x.setMode("unavailable503");
  const denied = await Promise.all([x.submit(form), x.submit(form)]);
  assert.deepEqual(denied, [
    { failureReason: "unavailable", statusCode: 503 },
    { failureReason: "unavailable", statusCode: 503 },
  ]);
  assert.equal(x.count(), 1);
  x.setMode("sent");
  const [first, concurrent] = await Promise.all([
    x.submit(form),
    x.submit(form),
  ]);
  assert.ok(first.feedbackId);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(await x.submit(form), first);
  assert.equal(x.count(), 2);
  assert.deepEqual(x.bodies[0], x.bodies[1]);
});

test("a service unavailable before dispatch can recover; a new activation gets a new receipt", async () => {
  const x = setup(),
    form = originalForm();
  x.main.remote.ready = false;
  assert.deepEqual(await x.submit(form), {
    failureReason: "unavailable",
    statusCode: 503,
  });
  assert.equal(x.count(), 0);
  x.main.remote.ready = true;
  const first = await x.submit(form);
  assert.ok(first.feedbackId);
  x.main.accountActivationIdentity = {};
  const next = await x.submit(form);
  assert.ok(next.feedbackId);
  assert.notEqual(next.feedbackId, first.feedbackId);
  assert.notEqual(x.bodies[0].request_id, x.bodies[1].request_id);
});

test("original authorized 401 refresh reuses exact request id and subsequent response loss is unknown", async () => {
  const x = setup();
  x.setMode("refresh-then-drop");
  const session: any = {
    accessToken: "old-inert",
    token: async () => "old-inert",
    refresh: async () => {
      session.accessToken = "new-inert";
    },
  };
  x.main.remote.backend.session.authorized = (fn: any, current: any) =>
    RemoteSession.prototype.authorized.call(session, fn, current);
  const answer = await x.submit(originalForm());
  assert.equal(x.count(), 2);
  assert.deepEqual(x.bodies[0], x.bodies[1]);
  assert.equal(answer.deliveryState, "unknown");
  await x.submit(originalForm());
  assert.equal(x.count(), 2);
});
