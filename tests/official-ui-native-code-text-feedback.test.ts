/** Explicit local text only: original preload → native → IPC → inert mail service. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { Store } from "../electron/store/store";
import { registerProductFeedback } from "../electron/official-ui/native/product-feedback";
import { registerProductFeedbackHandlers } from "../electron/ipc/product-feedback";
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-text-feedback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.conversations.push({
    id: "own-code",
    mode: "code",
    cwd: root,
    title: "PRIVATE_TITLE",
    providerId: "private-provider",
    model: "private-model",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "private-turn",
        prompt: "PRIVATE_TRANSCRIPT",
        status: "completed",
        items: [],
        createdAt: 1,
      },
    ],
  } as any);
  store.flush();
  const main: any = {
    store,
    activeAccount: { id: "owner-a" },
    accountRetiring: false,
    accountActivationIdentity: {},
    appVersion: "1.2.3",
    onAccountDeactivating() {},
    onAccountActivated() {},
  };
  const ipc = new Map<string, any>(),
    native = new Map<string, any>(),
    bodies: any[] = [],
    calls: string[] = [];
  let mode = "sent",
    listHook: undefined | (() => void);
  main.remote = {
    ready: true,
    backend: {
      accounts: { baseUrl: "https://synthetic.invalid" },
      session: {
        authorized: async (fn: any, current: any) => {
          assert.equal(current(), true);
          return fn("inert-token");
        },
      },
    },
  };
  registerProductFeedbackHandlers(
    (n, fn) => ipc.set(n, fn),
    main,
    async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (mode === "drop") throw Error("inert response loss");
      if (mode === "unavailable")
        return new Response(
          JSON.stringify({ code: 503, reason: "PRODUCT_FEEDBACK_UNAVAILABLE" }),
          { status: 503 },
        );
      return new Response(
        JSON.stringify({
          code: 0,
          data: { status: "sent", feedback_id: randomUUID() },
        }),
        { status: 200 },
      );
    },
  );
  const ctx: any = {
    appVersion: main.appVersion,
    account: () => main.activeAccount,
    sessionIdentity: () => main.accountActivationIdentity,
    isCurrent: () => !main.accountRetiring,
    localListConversations: async () => {
      calls.push("local-index");
      const rows = structuredClone(main.store.conversations);
      listHook?.();
      return rows;
    },
    localLoadConversation: () => {
      throw Error("Must not hydrate transcript");
    },
    sshCodeEnvironment: (session: {
      environment?: { kind: string; hostId?: string };
    }) =>
      session.environment?.kind === "ssh" &&
      session.environment.hostId === "owned-host"
        ? { remoteTarget: { kind: "ssh" } }
        : undefined,
    localCall: async (n: string, ...args: any[]) => {
      calls.push(n);
      assert.equal(n, "submitProductFeedback");
      return ipc.get(n)(...args);
    },
  };
  registerProductFeedback({
    ctx,
    on: (n: string, fn: any) => native.set(n, fn),
  } as any);
  const source = fs.readFileSync(
    ".restore/archive-extracted/claude-frontend-4.4212.0/electron/official-preload.cjs",
    "utf8",
  );
  const match = source.match(
    /submitFeedback\(e, n\) \{\s*return t\.ipcRenderer\.invoke\(Y \+ "LocalSessions_\$_submitFeedback", e, n\);\s*\}/,
  );
  assert.ok(match);
  const preload = vm.runInNewContext("({" + match[0] + "})", {
    Y: "inert-prefix_",
    t: {
      ipcRenderer: {
        invoke: (channel: string, ...args: any[]) => {
          assert.equal(channel, "inert-prefix_LocalSessions_$_submitFeedback");
          return native.get("LocalSessions.submitFeedback")(...args);
        },
      },
    },
  });
  return {
    root,
    store,
    main,
    ctx,
    native,
    bodies,
    calls,
    preload,
    setMode(v: string) {
      mode = v;
    },
    onList(fn: () => void) {
      listHook = fn;
    },
  };
}
const payload = {
  claudexTextOnlyFeedback: true,
  description: "Self-authored local Code feedback",
};
test("original preload preserves tagged second object; own temporary Store lookup sends only explicit text and confirmed response", async (t) => {
  const x = setup(t);
  const answer = await x.preload.submitFeedback("local_own-code", payload);
  assert.ok(answer.feedbackId);
  assert.equal(answer.includedTranscript, false);
  assert.equal(answer.ccshareUrl, undefined);
  assert.deepEqual(Object.keys(x.bodies[0]).sort(), [
    "app_version",
    "request_id",
    "text",
  ]);
  assert.equal(x.bodies[0].text, payload.description);
  for (const secret of [
    "own-code",
    "owner-a",
    x.root,
    "PRIVATE_TRANSCRIPT",
    "PRIVATE_TITLE",
    "private-model",
  ])
    assert.equal(JSON.stringify(x.bodies).includes(secret), false);
  assert.deepEqual(x.calls, ["local-index", "submitProductFeedback"]);
  assert.equal(
    new Store(x.root).conversation("own-code").title,
    "PRIVATE_TITLE",
  );
  assert.deepEqual(
    await x.preload.submitFeedback("local_own-code", payload),
    answer,
  );
  assert.equal(x.bodies.length, 1);
});
test("original string, unknown fields, unknown or foreign sessions and readonly reject without any send", async (t) => {
  for (const tweak of [
    "string",
    "missing",
    "foreign",
    "chat",
    "cloud",
    "runner",
    "space",
    "unconfigured-ssh",
    "cwd",
    "shared",
    "readonly",
    "noidentity",
    "notcurrent",
    "badpayload",
    "extra",
  ]) {
    const x = setup(t);
    let id = "local_own-code",
      data: any = payload;
    if (tweak === "string") data = "Original legacy feedback";
    if (tweak === "missing") id = "local_missing";
    if (tweak === "foreign") {
      x.main.store = new Store(path.join(x.root, "other-account"));
      x.main.activeAccount = { id: "owner-b" };
      x.main.accountActivationIdentity = {};
    }
    if (tweak === "chat") x.store.conversations[0].mode = "chat";
    if (tweak === "cloud") x.store.conversations[0].cloudHosted = true;
    if (tweak === "runner")
      x.store.conversations[0].cloudEnvironmentId = "default";
    if (tweak === "space")
      x.store.conversations[0].environment = {
        kind: "space",
        spaceId: "private-space",
      };
    if (tweak === "unconfigured-ssh")
      x.store.conversations[0].environment = {
        kind: "ssh",
        hostId: "missing-host",
      };
    if (tweak === "cwd") delete x.store.conversations[0].cwd;
    if (tweak === "shared")
      x.store.conversations[0].sessionAuthors = {
        viewerAccountUuid: "owner-a",
        ownerAccountUuid: "other-owner",
      };
    if (tweak === "readonly") x.ctx.readOnly = true;
    if (tweak === "noidentity") x.main.accountActivationIdentity = undefined;
    if (tweak === "notcurrent") x.main.accountRetiring = true;
    if (tweak === "badpayload") data = { ...payload, includeTranscript: true };
    const answer =
      tweak === "extra"
        ? await x.native.get("LocalSessions.submitFeedback")(id, data, "extra")
        : await x.preload.submitFeedback(id, data);
    assert.equal(answer.feedbackId, undefined, tweak);
    assert.equal(x.bodies.length, 0, tweak);
    assert.equal(x.calls.includes("submitProductFeedback"), false, tweak);
  }
});

test("the native local index authorizes owned WSL and SSH Code feedback", async (t) => {
  for (const environment of [
    { kind: "wsl", distro: "private-distro" },
    { kind: "ssh", hostId: "owned-host" },
  ] as const) {
    const x = setup(t);
    x.store.conversations[0].environment = environment;
    const answer = await x.preload.submitFeedback("local_own-code", payload);
    assert.ok(answer.feedbackId);
    assert.equal(x.bodies[0].text, payload.description);
    assert.deepEqual(x.calls, ["local-index", "submitProductFeedback"]);
  }
});
test("retirement and same-account ABA during index lookup refuse; unknown delivery remains deduplicated", async (t) => {
  for (const mode of ["retire", "aba"]) {
    const x = setup(t);
    x.onList(() => {
      if (mode === "retire") x.main.accountRetiring = true;
      else x.main.accountActivationIdentity = {};
    });
    const result = await x.preload.submitFeedback("local_own-code", payload);
    assert.equal(result.failureReason, "auth_error");
    assert.equal(x.bodies.length, 0);
  }
  const x = setup(t);
  x.setMode("drop");
  const first = await x.preload.submitFeedback("local_own-code", payload);
  assert.equal(first.deliveryState, "unknown");
  assert.equal(first.feedbackId, undefined);
  assert.deepEqual(
    await x.preload.submitFeedback("local_own-code", payload),
    first,
  );
  assert.equal(x.bodies.length, 1);
});

test("owned Code feedback retries a known refusal with the same request ID", async (t) => {
  const x = setup(t);
  x.setMode("unavailable");
  assert.deepEqual(await x.preload.submitFeedback("local_own-code", payload), {
    failureReason: "unavailable",
    statusCode: 503,
  });
  x.setMode("sent");
  const [sent, concurrent] = await Promise.all([
    x.preload.submitFeedback("local_own-code", payload),
    x.preload.submitFeedback("local_own-code", payload),
  ]);
  assert.ok(sent.feedbackId);
  assert.deepEqual(concurrent, sent);
  assert.equal(x.bodies.length, 2);
  assert.deepEqual(x.bodies[0], x.bodies[1]);
});

test("identical feedback from both native forms shares one receipt", async (t) => {
  const x = setup(t);
  const text = "Feedback about my session";
  const [product, code] = await Promise.all([
    x.native.get("CoworkFeedback.submitFeedback")({
      details: text,
      reportType: "bug",
      urgency: "normal",
    }),
    x.preload.submitFeedback("local_own-code", {
      claudexTextOnlyFeedback: true,
      description: text + "\n\nCategory: bug\n\nUrgency: normal",
    }),
  ]);
  assert.ok(product.feedbackId);
  assert.deepEqual(code, product);
  assert.equal(x.bodies.length, 1);
});

test("actual host Pe → local transport → original preload → owned native → real IPC reaches inert backend once, with no warm/share", async (t) => {
  const x = setup(t);
  const { brandedModule } = await import("../scripts/official-web-assets.mjs");
  const {
    deriveOfficialUiHostCodeFeedbackModule: derive,
    hostCodeFeedbackInputHashes: hashes,
    hostCodeFeedbackHelper: helper,
  } = await import("../scripts/official-ui-host-code-feedback.mjs");
  const [modalFile, transportFile] = Object.keys(hashes);
  const input = (name: string) =>
    brandedModule(
      fs.readFileSync(
        ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/" +
          name,
        "utf8",
      ),
    );
  const modal = derive(modalFile, input(modalFile)),
    transport = derive(transportFile, input(transportFile));
  const at = transport.indexOf("    async submitFeedback(e, t, n, options) {"),
    end = transport.indexOf("    async submitSurveyFeedback", at);
  assert.ok(at > 0 && end > at);
  const scope: any = {
    a: x.preload,
    Wr: () => {
      throw Error("No warmSession allowed");
    },
  };
  vm.runInNewContext(
    "this.transport=({" + transport.slice(at, end) + "});",
    scope,
  );
  const pe: any = {
    AbortController,
    setTimeout,
    clearTimeout,
    w: 120000,
    T: 20000,
    e: (e: any) => e,
    S() {},
    x: () => "",
    ge: () => false,
    ne: () => {
      throw Error("No share URL");
    },
    C: {},
  };
  vm.runInNewContext(
    helper +
      modal.slice(
        modal.indexOf("async function Pe({"),
        modal.indexOf("function D(e) {"),
      ) +
      ";this.submit=Pe;",
    pe,
  );
  const states: string[] = [],
    errors: any[] = [];
  await pe.submit({
    hostTextFeedback: "native",
    sessionId: "local_own-code",
    submitFn: scope.transport.submitFeedback.bind(scope.transport),
    description: payload.description,
    grantSupportShare: true,
    createSupportShare() {
      throw Error("No support share");
    },
    shouldWake: true,
    wakeSession() {
      throw Error("No SDK wake");
    },
    intl: { locale: "en-US", formatMessage: (m: any) => m.defaultMessage },
    generationRef: { current: 1 },
    abortRef: { current: null },
    setStep: (s: string) => states.push(s),
    setError: (e: any) => errors.push(e),
    setFeedbackId: (id: string) => assert.ok(id),
    setCcshareUrl: (url: any) => assert.equal(url, null),
    setLinkCopy() {
      throw Error("No clipboard");
    },
  });
  assert.deepEqual(states, ["submitting", "done"]);
  assert.deepEqual(errors, [null]);
  assert.equal(x.bodies.length, 1);
  assert.equal(x.bodies[0].text, payload.description);
  assert.deepEqual(x.calls, ["local-index", "submitProductFeedback"]);
});
