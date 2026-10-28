import assert from "node:assert/strict";
import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import { readFileSync } from "node:fs";
import {
  ConversationBridge,
  ConversationUserDeclinedError,
} from "../../src/mobile-conversation/bridge";
import { ConversationActionErrors } from "../../src/mobile-conversation/useActionError";
import {
  applyUpdate,
  validateState,
} from "../../src/mobile-conversation/state";
import {
  fileIdentity,
  rasterDataUrl,
} from "../../src/mobile-conversation/identity";
import type {
  ConversationEvent,
  ConversationActionResult,
  ConversationRenderState,
} from "../../shared/mobile/conversation-contract";

function actionHarness() {
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((event) => events.push(event));
  bridge.setSession("a");
  const actions = new ConversationActionErrors(bridge);
  const respond = (
    reply: Partial<ConversationActionResult>,
    event = events.at(-1)! as { requestId: string },
  ) =>
    bridge.result({
      version: 1,
      sessionId: "a",
      requestId: event.requestId,
      ok: true,
      ...reply,
    });
  return { events, bridge, actions, respond };
}

const retryPayload = { conversationId: "c", turnId: "t" };

test("explicit confirmation decline is a typed rejected no-op, never mutation success", async () => {
  const { actions, events, respond } = actionHarness();
  let success = 0;
  const pending = actions
    .request("retryResponse", retryPayload)
    .then(() => success++);
  const rejected = assert.rejects(pending, ConversationUserDeclinedError);
  respond({ ok: false, cancelled: true, cancellationReason: "userDeclined" });
  await rejected;
  assert.equal(success, 0);
  assert.equal(events.length, 1);
  actions.report(new ConversationUserDeclinedError());
  assert.equal(actions.snapshot(), undefined);
});

test("only a valid decline on a confirmation action is silent; lifecycle and export are errors", async () => {
  const { bridge, respond } = actionHarness();
  for (const reply of [
    { ok: false, error: "Action cancelled" },
    { ok: false, cancelled: true },
    {
      ok: false,
      cancelled: true,
      error: "Submitted operation may still complete",
    },
    { ok: false, cancelled: true, cancellationReason: "unknown" },
    { ok: false, cancelled: false, cancellationReason: "userDeclined" },
    { ok: true, cancelled: true, cancellationReason: "userDeclined" },
    { ok: undefined, cancelled: true, cancellationReason: "userDeclined" },
  ]) {
    const pending = bridge.request("retryResponse", retryPayload);
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ConversationUserDeclinedError, false);
      if (reply.error) assert.equal(error.message, reply.error);
      return true;
    });
    respond(reply as Partial<ConversationActionResult>);
    await rejected;
  }
  for (const type of ["copyText", "downloadArtifact"] as const) {
    const pending =
      type === "copyText"
        ? bridge.request(type, { text: "x" })
        : bridge.request(type, { conversationId: "c", artifactId: "file" });
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ConversationUserDeclinedError, false);
      return true;
    });
    respond({ ok: false, cancelled: true, cancellationReason: "userDeclined" });
    await rejected;
  }
  const link = bridge.request("openLink", { url: "https://example.com/" });
  const rejected = assert.rejects(link, ConversationUserDeclinedError);
  respond({ ok: false, cancelled: true, cancellationReason: "userDeclined" });
  await rejected;
});

test("only a later successful exact action clears its existing failure; decline does not", async () => {
  const { actions, respond } = actionHarness();
  const failed = actions
    .request("retryResponse", retryPayload)
    .catch(actions.report);
  respond({ ok: false, error: "Retry failed" });
  await failed;
  const original = actions.snapshot();
  assert.equal(original?.message, "Retry failed");
  const otherTurn = actions.request("retryResponse", {
    ...retryPayload,
    turnId: "other",
  });
  respond({});
  await otherTurn;
  assert.equal(actions.snapshot(), original);
  const cancelled = actions
    .request("retryResponse", retryPayload)
    .catch(actions.report);
  respond({ ok: false, cancelled: true, cancellationReason: "userDeclined" });
  await cancelled;
  assert.equal(actions.snapshot(), original);
  const refused = actions.request("retryResponse", retryPayload);
  respond({ result: false });
  await refused;
  assert.equal(actions.snapshot(), original);
  const success = actions.request("retryResponse", retryPayload);
  respond({ result: true });
  await success;
  assert.equal(actions.snapshot(), undefined);
});

test("success never clears an unrelated or newer overlapping failure", async () => {
  const { actions, events, respond } = actionHarness();
  const first = actions
    .request("retryResponse", retryPayload)
    .catch(actions.report);
  const firstEvent = events.at(-1)! as { requestId: string };
  const overlapping = actions.request("retryResponse", retryPayload);
  const overlappingEvent = events.at(-1)! as { requestId: string };
  respond(
    { ok: false, error: "First failed while another was pending" },
    firstEvent,
  );
  await first;
  const original = actions.snapshot();
  respond({}, overlappingEvent);
  await overlapping;
  assert.equal(actions.snapshot(), original);
  for (const sameScope of [false, true]) {
    const retry = actions.request("retryResponse", retryPayload);
    const retryEvent = events.at(-1)! as { requestId: string };
    const failed = (
      sameScope
        ? actions.request("retryResponse", retryPayload)
        : actions.request("openLink", { url: "https://example.com/" })
    ).catch(actions.report);
    respond({ ok: false, error: "New failure" });
    await failed;
    const newer = actions.snapshot();
    respond({}, retryEvent);
    await retry;
    assert.equal(actions.snapshot(), newer);
  }
});

test("single and partial batch export cancellation retain same-action errors until fully saved", async () => {
  const { actions, respond } = actionHarness();
  const file = { conversationId: "c", artifactId: "one" };
  const singleFailed = actions
    .request("downloadArtifact", file)
    .catch(actions.report);
  respond({ ok: false, error: "Single save failed" });
  await singleFailed;
  const original = actions.snapshot();
  for (const result of [null, "", false]) {
    const cancelled = actions.request("downloadArtifact", file);
    respond({ result });
    assert.equal(await cancelled, result);
    assert.equal(actions.snapshot(), original);
  }
  const singleSuccess = actions.request("downloadArtifact", file);
  respond({ result: "saved.txt" });
  assert.equal(await singleSuccess, "saved.txt");
  assert.equal(actions.snapshot(), undefined);

  const batch = {
    conversationId: "c",
    files: [file, { ...file, artifactId: "two" }],
  };
  const batchFailed = actions
    .request("downloadArtifacts", batch)
    .catch(actions.report);
  respond({ ok: false, error: "Batch save failed" });
  await batchFailed;
  const batchError = actions.snapshot();
  for (const result of [
    { saved: 0, cancelled: true },
    { saved: 1, cancelled: true },
    { saved: 2, cancelled: true },
    { saved: 1, cancelled: false },
    { saved: 3, cancelled: false },
    null,
  ]) {
    const partial = actions.request("downloadArtifacts", batch);
    respond({ result });
    assert.deepEqual(await partial, result);
    assert.equal(actions.snapshot(), batchError);
  }
  const completed = actions.request("downloadArtifacts", batch);
  respond({ result: { saved: 2, cancelled: false } });
  assert.deepEqual(await completed, { saved: 2, cancelled: false });
  assert.equal(actions.snapshot(), undefined);
});

test("rotation and disposal reject, retain lifecycle warnings, and cannot pollute a new surface", async () => {
  const { actions, bridge, events, respond } = actionHarness();
  const cancelled = actions
    .request("retryResponse", retryPayload)
    .catch(actions.report);
  respond({
    ok: false,
    cancelled: true,
    error: "Submitted operation may still complete",
  });
  await cancelled;
  assert.equal(
    actions.snapshot()?.message,
    "Submitted operation may still complete",
  );
  const pending = actions.request("retryResponse", retryPayload);
  const oldEvent = events.at(-1)! as { requestId: string };
  let oldError: unknown;
  const failed = pending.catch((error) => {
    oldError = error;
    actions.report(error);
  });
  bridge.setSession("b");
  await failed;
  assert.equal(actions.snapshot()?.message, "Conversation closed");
  const fresh = new ConversationActionErrors(bridge);
  fresh.report(oldError);
  assert.equal(fresh.snapshot(), undefined);
  assert.equal(
    respond(
      { ok: false, cancelled: true, cancellationReason: "userDeclined" },
      oldEvent,
    ),
    false,
  );
  const next = fresh.request("retryResponse", retryPayload).catch(fresh.report);
  bridge.dispose();
  await next;
  assert.equal(fresh.snapshot()?.message, "Conversation closed");
});

export const fixture: ConversationRenderState = {
  version: 1,
  sessionId: "test-lease",
  revision: 1,
  theme: "light",
  conversation: {
    id: "conversation-1",
    title: "Shared conversation",
    mode: "chat",
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn-1",
        prompt: "Please explain the result",
        status: "completed",
        createdAt: 1,
        attachments: [],
        items: [
          {
            id: "item-1",
            type: "agentMessage",
            text: "Hello\n\n```js\nconst n = 2;\n```",
          },
        ],
      },
    ],
  },
};
test("canonical state accepts shared types and rejects malformed or duplicate identity", () => {
  validateState(fixture);
  for (const change of [
    { version: 2 },
    { sessionId: "" },
    { revision: NaN },
    { theme: "fake" },
  ])
    assert.throws(() => validateState({ ...fixture, ...change }));
  assert.throws(() =>
    validateState({
      ...fixture,
      conversation: {
        ...fixture.conversation,
        turns: [...fixture.conversation.turns, ...fixture.conversation.turns],
      },
    }),
  );
});
test("stream append is immutable, preserves rich fields and refuses stale/cross-session deltas", () => {
  const next = applyUpdate(fixture, {
    version: 1,
    sessionId: fixture.sessionId,
    baseRevision: 1,
    revision: 2,
    changes: [
      {
        type: "appendItemText",
        turnId: "turn-1",
        itemId: "item-1",
        text: " more",
      },
    ],
  });
  assert.equal(
    next.conversation.turns[0].items[0].text,
    fixture.conversation.turns[0].items[0].text + " more",
  );
  assert.equal(fixture.revision, 1);
  for (const change of [
    { baseRevision: 0 },
    { sessionId: "other" },
    { revision: 1 },
  ])
    assert.throws(() =>
      applyUpdate(fixture, {
        version: 1,
        sessionId: fixture.sessionId,
        baseRevision: 1,
        revision: 2,
        changes: [],
        ...change,
      }),
    );
  assert.throws(() =>
    applyUpdate(fixture, {
      version: 1,
      sessionId: fixture.sessionId,
      baseRevision: 1,
      revision: 2,
      changes: [
        {
          type: "appendItemText",
          turnId: "turn-1",
          itemId: "unknown",
          text: "x",
        },
      ],
    }),
  );
});
test("request results match exact session and id, never resolve twice", async () => {
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((e) => events.push(e));
  bridge.setSession("a");
  const pending = bridge.request("copyText", { text: "safe" });
  const event = events.at(-1)! as { requestId: string };
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "b",
      requestId: event.requestId,
      ok: true,
    }),
    false,
  );
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "a",
      requestId: event.requestId,
      ok: true,
      result: "ok",
    }),
    true,
  );
  assert.equal(await pending, "ok");
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "a",
      requestId: event.requestId,
      ok: true,
    }),
    false,
  );
});
test("lease change cancels pending actions, timeouts notify native, failures do not succeed", async () => {
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((e) => events.push(e), 10);
  bridge.setSession("a");
  const one = bridge.request("copyText", { text: "x" });
  const rejected = assert.rejects(one, /closed/);
  bridge.setSession("b");
  await rejected;
  assert.equal(
    events.some((e) => e.type === "cancelRequest" && e.sessionId === "a"),
    true,
  );
  await assert.rejects(bridge.request("copyText", { text: "x" }), /timed out/);
  const three = bridge.request("copyText", { text: "x" });
  const threeError = assert.rejects(three, /cancelled/);
  const event = events.at(-1)! as { requestId: string };
  bridge.result({
    version: 1,
    sessionId: "b",
    requestId: event.requestId,
    ok: false,
    cancelled: true,
  });
  await threeError;
});
test("inline artifacts resolve canonical fence identity, arbitrary files and SVG images fail closed", () => {
  assert.deepEqual(
    fileIdentity(fixture.conversation, {
      id: "random",
      name: "Code",
      language: "js",
      content: "const n = 2;",
    }),
    { conversationId: "conversation-1", artifactId: "fence:item-1:0" },
  );
  assert.equal(
    fileIdentity(fixture.conversation, {
      id: "evil",
      name: "file",
      language: "text",
      content: "secret",
      sourcePath: "/etc/passwd",
    }),
    undefined,
  );
  assert.equal(rasterDataUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(rasterDataUrl("https://tracking.invalid/image.png"), false);
  assert.equal(rasterDataUrl("data:image/png;base64,AAAA"), true);
});
test("mobile imports actual shared components and CSS rather than alternate renderers", () => {
  const surface = readFileSync(
    new URL(
      "../../src/mobile-conversation/ConversationSurface.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    surface,
    /import \{ ConversationTranscript \} from "\.\.\/transcript\/ConversationTranscript"/,
  );
  assert.match(surface, /useTranscriptScroll/);
  const css = readFileSync(
    new URL("../../src/mobile-conversation/styles.css", import.meta.url),
    "utf8",
  );
  for (const source of [
    "../styles.css",
    "../transcript/chat-transcript.css",
    "../transcript/code-transcript.css",
    "../transcript/markdown-media.css",
    "../citations/citations.css",
  ])
    assert.ok(css.includes(source));
  assert.doesNotMatch(
    css +
      readFileSync(
        new URL("../../src/mobile-conversation/layout.css", import.meta.url),
        "utf8",
      ),
    /#[a-f\d]{3,8}\b|font-family\s*:/i,
  );
  const entry = readFileSync(
    new URL("../../src/mobile-conversation/main.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    entry,
    /window\.desktop\s*=|addEventListener\(["']message|\bfetch\(/,
  );
  const html = readFileSync(
    new URL("../../src/mobile-conversation/index.html", import.meta.url),
    "utf8",
  );
  for (const rule of [
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ])
    assert.ok(html.includes(rule));
});

test("raw selection removes only the shared quote wrapper, not selected Markdown", async () => {
  const { rawQuoteSelection } =
    await import("../../src/mobile-conversation/identity");
  const { quoteSelection } =
    await import("../../src/transcript/SelectionReply");
  for (const text of [
    "Hello",
    "Hello world",
    "line one\n\nline two",
    "> literal quote",
    "code\n  indent",
  ]) {
    assert.equal(rawQuoteSelection(quoteSelection(text)), text);
  }
});
test("late native media replaces the initial missing preview without changing attachment ID", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ConversationServicesContext, desktopConversationServices } =
    await import("../../src/conversation/ConversationServices");
  const { MessageAttachments } = await import("../../src/composer/Attachments");
  const attachment = {
    id: "image",
    name: "image.png",
    path: "/image.png",
    kind: "image" as const,
    size: 100,
  };
  const render = (url: string | null) =>
    renderToStaticMarkup(
      createElement(
        ConversationServicesContext.Provider,
        {
          value: {
            ...desktopConversationServices,
            attachmentPreview: async () => null,
            attachmentPreviewSync: () => url,
          },
        },
        createElement(MessageAttachments, { attachments: [attachment] }),
      ),
    );
  assert.doesNotMatch(render(null), /<img/);
  assert.match(render("data:image/png;base64,AAAA"), /<img/);
});

test("plan and reasoning fences keep source-scoped identities", () => {
  const conversation = structuredClone(fixture.conversation);
  conversation.turns[0].items.push(
    { id: "plan", type: "plan", text: "```js\nconst plan = 1;\n```" },
    {
      id: "thought",
      type: "reasoning",
      summary: ["```js\nconst thought = 1;\n```"],
    },
  );
  assert.equal(
    fileIdentity(conversation, {
      id: "random",
      name: "Code",
      language: "js",
      content: "const plan = 1;",
    })?.artifactId,
    "fence:plan:0",
  );
  assert.equal(
    fileIdentity(conversation, {
      id: "random",
      name: "Code",
      language: "js",
      content: "const thought = 1;",
    })?.artifactId,
    "fence-summary:thought:0",
  );
});
test("completed image tools use narrow services rather than a missing desktop global", () => {
  const source = readFileSync(
    new URL("../../src/artifacts/GeneratedImageCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /services\.imageGenerationSnapshot/);
  assert.doesNotMatch(source, /window\.desktop/);
  assert.match(source, /imagePreviewUnavailable/);
});

test("presentation-only IDs work without secure-context crypto.randomUUID", async () => {
  const { presentationId } = await import("../../src/ui/presentation-id");
  const one = presentationId(null),
    two = presentationId(null);
  assert.match(one, /^presentation-/);
  assert.notEqual(one, two);
  assert.equal(
    presentationId({
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
    }),
    "00000000-0000-0000-0000-000000000001",
  );
});

test("same transcript renders chat, cowork and code rich variants without desktop globals", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { ConversationSurface } =
    await import("../../src/mobile-conversation/ConversationSurface");
  const state = structuredClone(fixture);
  state.conversation.turns[0].items.unshift(
    {
      id: "reasoning",
      type: "reasoning",
      summary: ["Shared reasoning"],
      status: "completed",
    },
    {
      id: "command",
      type: "commandExecution",
      command: "echo shared",
      status: "completed",
      aggregatedOutput: "shared",
      exitCode: 0,
    },
    {
      id: "image",
      type: "imageGeneration",
      status: "completed",
      savedPath: "/generated/safe.png",
    },
  );
  const bridge = new ConversationBridge(() => {});
  bridge.setSession(state.sessionId);
  for (const mode of ["chat", "cowork", "code"] as const) {
    state.conversation.mode = mode;
    const html = renderToStaticMarkup(
      createElement(ConversationSurface, { state, bridge, onApplied() {} }),
    );
    assert.match(html, /messages-scroll/);
    assert.match(html, /Please explain the result/);
    assert.match(html.replace(/<[^>]+>/g, ""), /const n/);
    assert.doesNotMatch(html, /<iframe|<script/);
  }
});

test("a replacement media snapshot evicts old data; omission keeps it and empty clears", () => {
  const state = {
    ...fixture,
    media: {
      attachmentPreviews: { old: "data:image/png;base64,AAAA" },
      generatedFileBytes: { digest: "AAAA" },
    },
  };
  const update = {
    version: 1 as const,
    sessionId: state.sessionId,
    baseRevision: 1,
    revision: 2,
    changes: [],
  };
  assert.deepEqual(applyUpdate(state, update).media, state.media);
  const replacement = {
    attachmentPreviews: { new: "data:image/png;base64,BBBB" },
  };
  assert.deepEqual(
    applyUpdate(state, { ...update, media: replacement }).media,
    replacement,
  );
  assert.deepEqual(applyUpdate(state, { ...update, media: {} }).media, {});
});

test("one bounded export survives a slow human chooser without extending gesture admission", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ConversationGesture } =
    await import("../../src/mobile-conversation/gesture");
  const { downloadResult } =
    await import("../../src/mobile-conversation/bridge");
  let now = 0;
  const gesture = new ConversationGesture(() => now);
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge(
    (event) => events.push(event),
    30_000,
    () => gesture.active(),
  );
  bridge.setSession("account-a");
  const files = ["one", "two"].map((artifactId) => ({
    conversationId: "c",
    artifactId,
  }));
  await assert.rejects(
    bridge.request("downloadArtifacts", { conversationId: "c", files }),
    /Tap/,
  );
  gesture.observe(false);
  await assert.rejects(bridge.request("copyText", { text: "x" }), /Tap/);
  gesture.observe(true);
  const batch = bridge.request("downloadArtifacts", {
    conversationId: "c",
    files,
  });
  const request = events.at(-1)! as { requestId: string };
  await assert.rejects(
    bridge.request("downloadArtifact", files[0]),
    /current file export/,
  );
  now = 1_501;
  await assert.rejects(bridge.request("copyText", { text: "x" }), /Tap/);
  t.mock.timers.tick(31_000);
  now = 31_000;
  assert.equal(
    events.some((event) => event.type === "cancelRequest"),
    false,
  );
  assert.equal(
    events.filter((event) => event.type === "downloadArtifacts").length,
    1,
  );
  const reply = {
    version: 1 as const,
    sessionId: "account-a",
    requestId: request.requestId,
    ok: true,
    result: { saved: 1, cancelled: true },
  };
  assert.equal(bridge.result(reply), true);
  assert.deepEqual(downloadResult(await batch, files.length), {
    saved: 1,
    cancelled: true,
  });
  assert.equal(bridge.result(reply), false);
  await assert.rejects(bridge.request("downloadArtifact", files[0]), /Tap/);
  gesture.observe(true);
  const single = bridge.request("downloadArtifact", files[0]);
  const singleRequest = events.at(-1)! as { requestId: string };
  t.mock.timers.tick(31_000);
  assert.equal(
    bridge.result({
      ...reply,
      requestId: singleRequest.requestId,
      result: null,
    }),
    true,
  );
  assert.equal(await single, null);
  gesture.reset();
  await assert.rejects(bridge.request("copyText", { text: "x" }), /Tap/);
});

test("export batches are bounded, unique and scoped; partial results cannot overcount", async () => {
  const { downloadResult } =
    await import("../../src/mobile-conversation/bridge");
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((event) => events.push(event));
  bridge.setSession("a");
  const file = { conversationId: "c", artifactId: "one" };
  for (const files of [
    [],
    [file, file],
    [{ ...file, conversationId: "other" }],
    Array.from({ length: 33 }, (_, index) => ({
      ...file,
      artifactId: `${index}`,
    })),
  ])
    await assert.rejects(
      bridge.request("downloadArtifacts", { conversationId: "c", files }),
      /distinct files/,
    );
  assert.deepEqual(events, []);
  for (const result of [
    { saved: -1, cancelled: false },
    { saved: 3, cancelled: false },
    { saved: 0.5, cancelled: false },
    { saved: 1 },
    null,
  ])
    assert.throws(() => downloadResult(result, 2), /Invalid download result/);
  assert.deepEqual(downloadResult({ saved: 0, cancelled: true }, 2), {
    saved: 0,
    cancelled: true,
  });
});

test("slow exports cancel on account switch or dispose and ignore late and duplicate results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((event) => events.push(event));
  bridge.setSession("account-a");
  const file = { conversationId: "c", artifactId: "one" };
  const first = bridge.request("downloadArtifacts", {
    conversationId: "c",
    files: [file],
  });
  const firstRequest = events.at(-1)! as { requestId: string };
  const firstRejected = assert.rejects(first, /closed/);
  t.mock.timers.tick(31_000);
  bridge.setSession("account-b");
  await firstRejected;
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "account-a",
      requestId: firstRequest.requestId,
      ok: true,
      result: { saved: 1, cancelled: false },
    }),
    false,
  );
  const second = bridge.request("downloadArtifact", file);
  const secondRequest = events.at(-1)! as { requestId: string };
  const secondRejected = assert.rejects(second, /closed/);
  t.mock.timers.tick(31_000);
  bridge.dispose();
  await secondRejected;
  assert.equal(
    events.filter((event) => event.type === "cancelRequest").length,
    2,
  );
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "account-b",
      requestId: secondRequest.requestId,
      ok: true,
      result: "saved.txt",
    }),
    false,
  );
});

test("ordinary RPCs still time out and cancellation rejects even while export is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events: ConversationEvent[] = [];
  const bridge = new ConversationBridge((event) => events.push(event));
  bridge.setSession("a");
  const pending = bridge.request("downloadArtifact", {
    conversationId: "c",
    artifactId: "one",
  });
  const request = events.at(-1)! as { requestId: string };
  const rejected = assert.rejects(pending, /cancelled/);
  const rpc = assert.rejects(
    bridge.request("copyText", { text: "safe" }),
    /timed out/,
  );
  t.mock.timers.tick(31_000);
  await rpc;
  assert.equal(
    events.filter((event) => event.type === "cancelRequest").length,
    1,
  );
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "a",
      requestId: request.requestId,
      ok: false,
      cancelled: true,
    }),
    true,
  );
  await rejected;
  assert.equal(
    bridge.result({
      version: 1,
      sessionId: "a",
      requestId: request.requestId,
      ok: true,
      result: "too late",
    }),
    false,
  );
});
