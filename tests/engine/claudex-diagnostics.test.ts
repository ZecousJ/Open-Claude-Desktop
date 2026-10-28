import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DiagnosticsReporter,
  FetchedBootstrap,
  type ReporterOptions,
} from "../../electron/support/diagnostics";
import {
  conversationExcerpt,
  describeTurnError,
  feedbackCategories,
  ratingGraceMs,
  redactMessage,
} from "../../electron/support/diagnostics-support";
import {
  codexVersionOf,
  crashReport,
  mcpStartFailure,
  nameHash,
  processGoneReport,
  recordDiagnostic,
  registerDiagnosticsHandlers,
} from "../../electron/ipc/diagnostics";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import { Store } from "../../electron/store/store";
import type { AppContext, ReplyRated } from "../../electron/app/app-context";
import { Listeners } from "../../electron/app/app-context";
import { requestJson, Sub2ApiError } from "../../electron/sub2api/http";
import type { ClaudexBootstrap } from "../../shared/claudex-contract";
import type { AppEvent, Conversation, Settings } from "../../shared/types";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import {
  MemoryBootstrapSource,
  MockSub2Api,
  mockBootstrapSource,
  type MockOptions,
} from "../support/sub2api-mock";

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const pro = {
  id: 4,
  name: "Claudex Pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};

function bootstrap(
  diagnostics: boolean,
  feedback: boolean,
  allowConversationExcerpt = false,
): ClaudexBootstrap {
  return {
    schemaVersion: 1,
    generatedAt: null,
    server: { siteName: "Claudex", version: "0.2.8", timezone: "UTC" },
    feedback: {
      diagnostics: { enabled: diagnostics },
      feedback: { enabled: feedback, allowConversationExcerpt },
    },
    features: {
      deviceKeys: true,
      usageStatus: true,
      structuredRefusals: true,
      modelCatalog: true,
      voiceTranscription: false,
      payment: false,
      desktopCheckout: false,
      redeem: true,
      diagnostics,
      feedback,
      selfDelete: false,
      announcements: true,
    },
    errors: [],
  };
}

function conversation(
  prompt = "Summarise /Users/bob/secret-plan.md",
): Conversation {
  return {
    id: "conversation-a",
    title: "Plan",
    mode: "chat",
    providerId: "sub2api",
    model: "gpt-5.5",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn-1",
        prompt,
        attachments: [],
        items: [
          { id: "i1", type: "agentMessage", text: "Here is the summary." },
        ],
        status: "completed",
        createdAt: 1,
      },
    ],
  };
}

interface Harness {
  reporter: DiagnosticsReporter;
  posts: { route: string; body: any }[];
  file: string;
  source: MemoryBootstrapSource;
  consent: { value: boolean };
  clock: { now: number };
  fail: { error?: unknown };
}

function harness(
  t: TestContext,
  options: {
    consent?: boolean;
    flags?: ClaudexBootstrap | undefined;
    seed?: unknown;
  } = {},
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "diagnostics-queue.json");
  if (options.seed) fs.writeFileSync(file, JSON.stringify(options.seed));
  const posts: Harness["posts"] = [];
  const consent = { value: options.consent ?? true };
  const clock = { now: 1_000_000 };
  const fail: Harness["fail"] = {};
  const source = new MemoryBootstrapSource(
    "flags" in options ? options.flags : bootstrap(true, true),
  );
  const reporterOptions: ReporterOptions = {
    file,
    bootstrap: source,
    consented: () => consent.value,
    client: { appVersion: "1.3.2", platform: "darwin", arch: "arm64" },
    now: () => clock.now,
    post: async (route, body) => {
      if (fail.error) throw fail.error;
      posts.push({ route, body });
      return route === "diagnostics"
        ? {
            accepted: (body as { reports: unknown[] }).reports.length,
            duplicates: 0,
          }
        : { accepted: true, duplicate: false, excerpt_dropped: false };
    },
  };
  const reporter = new DiagnosticsReporter(reporterOptions);
  t.after(() => reporter.stop());
  return { reporter, posts, file, source, consent, clock, fail };
}

const refusal: GatewayRefusal = {
  status: 429,
  code: "WEEKLY_LIMIT_EXCEEDED",
  reason: "weekly",
  exceeded: true,
  invalidKey: false,
  message:
    "You’ve reached your plan’s weekly usage limit. Requests resume when the weekly window resets.",
};

test("without consent nothing is queued, written or sent", async (t) => {
  const h = harness(t, { consent: false });
  assert.equal(h.reporter.recordRefusal(refusal), false);
  h.reporter.rated(conversation(), "turn-1", "down");
  assert.deepEqual(
    await h.reporter.submitFeedback(conversation(), {
      conversationId: "conversation-a",
      turnId: "turn-1",
      rating: "down",
    }),
    { sent: false },
  );
  await h.reporter.flush();
  assert.equal(h.posts.length, 0);
  assert.equal(fs.existsSync(h.file), false);
});

test("while the service does not collect nothing is queued or sent", async (t) => {
  const h = harness(t, { flags: bootstrap(false, false) });
  assert.equal(h.reporter.recordRefusal(refusal), false);
  h.reporter.rated(conversation(), "turn-1", "up");
  assert.deepEqual(
    await h.reporter.submitFeedback(conversation(), {
      conversationId: "conversation-a",
      turnId: "turn-1",
      rating: "up",
      comment: "Great",
    }),
    { sent: false },
  );
  await h.reporter.flush();
  assert.equal(h.posts.length, 0);
  assert.equal(fs.existsSync(h.file), false);
  assert.deepEqual(await h.reporter.reportingStatus(), {
    diagnostics: false,
    feedback: false,
    allowConversationExcerpt: false,
    consented: true,
  });
});

test("withdrawing consent deletes the queue file at once and at the next start", async (t) => {
  const h = harness(t);
  h.fail.error = new Sub2ApiError(0, "UNREACHABLE", "offline");
  assert.equal(h.reporter.recordRefusal(refusal), true);
  h.reporter.rated(conversation(), "turn-1", "down");
  assert.equal(fs.existsSync(h.file), true);
  h.consent.value = false;
  h.reporter.consentChanged();
  assert.equal(fs.existsSync(h.file), false);
  assert.deepEqual(h.reporter.pending, { diagnostics: 0, feedback: 0 });

  // A queue left from a session whose consent was withdrawn later is removed unread.
  const seed = {
    version: 1,
    diagnostics: [
      {
        id: "0f7d7b8e-0000-4000-8000-000000000001",
        occurredAt: 1,
        kind: "crash",
        code: "X",
        message: "",
        appVersion: "1",
        platform: "darwin",
        arch: "arm64",
      },
    ],
    feedback: [],
  };
  const later = harness(t, { consent: false, seed });
  assert.equal(fs.existsSync(later.file), false);
  // With consent the same file is read and sent.
  const kept = harness(t, { seed });
  assert.equal(kept.reporter.pending.diagnostics, 1);
  await kept.reporter.flush();
  assert.equal(kept.posts[0].body.reports[0].id, seed.diagnostics[0].id);
  assert.equal(fs.existsSync(kept.file), false);
});

test("diagnostics carry codes and redacted, short texts only", async (t) => {
  const long = `Failed at /Users/bob/work/app.ts with sk-abcdefghijk and Bearer eyJ.abc for bob@example.com via https://api.example.com/v1?key=1 in C:\\Users\\bob\\x.txt ${"x".repeat(400)}`;
  const redacted = redactMessage(long);
  assert.ok(redacted.length <= 300);
  for (const secret of [
    "/Users/bob",
    "sk-abc",
    "eyJ",
    "bob@example.com",
    "api.example.com",
    "C:\\Users",
  ])
    assert.equal(redacted.includes(secret), false, secret);
  const more = redactMessage(
    "open '/Users/bob/My Docs/plan.txt' failed: C:\\Program Files\\Claudex\\app.exe, src/secret/notes.md, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, password=hunter2",
  );
  for (const secret of [
    "My Docs",
    "Program",
    "Claudex",
    "notes.md",
    "eyJ",
    "hunter2",
  ])
    assert.equal(more.includes(secret), false, secret);

  const h = harness(t);
  h.reporter.recordRefusal(refusal, "code", "gpt-5.5");
  const failed = conversation("Please read /Users/bob/diary.txt");
  failed.turns.push({
    id: "turn-2",
    prompt: "Next",
    attachments: [],
    items: [],
    status: "failed",
    error:
      "upstream said: stream disconnected while reading /Users/bob/diary.txt",
    createdAt: h.clock.now,
  });
  // A failed turn whose text is the refusal's is not reported twice.
  failed.turns.push({
    id: "turn-3",
    prompt: "Again",
    attachments: [],
    items: [],
    status: "failed",
    error: refusal.message,
    createdAt: h.clock.now,
  });
  h.reporter.observeConversation(failed);
  h.reporter.observeConversation(failed);
  await h.reporter.flush();
  assert.equal(h.posts.length, 1);
  const [refused, turnError] = h.posts[0].body.reports;
  assert.equal(h.posts[0].body.consent, true);
  assert.equal(h.posts[0].body.reports.length, 2);
  assert.equal(refused.kind, "gateway_refusal");
  assert.equal(refused.code, "WEEKLY_LIMIT_EXCEEDED");
  assert.equal(refused.message, "");
  assert.deepEqual(refused.context, {
    surface: "code",
    reason: "weekly",
    http_status: 429,
  });
  assert.equal(turnError.kind, "turn_error");
  assert.equal(turnError.code, "TURN_NETWORK");
  assert.equal(turnError.message, "network");
  assert.deepEqual(turnError.context, { surface: "chat" });
  const wire = JSON.stringify(h.posts[0].body);
  for (const secret of ["diary", "/Users/bob", "Please read", "upstream said"])
    assert.equal(wire.includes(secret), false, secret);

  assert.equal(describeTurnError(refusal.message), undefined);
  assert.deepEqual(describeTurnError("The Claudex service is unreachable."), {
    code: "TURN_CLIENT",
    message: "The Claudex service is unreachable.",
  });
  assert.equal(describeTurnError("Something odd")?.message, "unknown");
  assert.deepEqual(
    feedbackCategories(["Inaccurate", "not helpful", "", "x".repeat(40)]),
    ["inaccurate", "not_helpful", "x".repeat(32)],
  );
});

test("turns that failed before the reporter started are not reported", async (t) => {
  const h = harness(t);
  const old = conversation();
  old.turns[0] = {
    ...old.turns[0],
    status: "failed",
    error: "network",
    createdAt: h.clock.now - 1,
  };
  h.reporter.observeConversation(old);
  assert.equal(h.reporter.pending.diagnostics, 0);
});

test("URL and contextual feedback reach the service through the shared desktop/runner handler", async (t) => {
  const h = harness(t);
  const input = {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down" as const,
    categories: ["web_url", "thoughts", "memory"],
    reportUrl: "https://example.com/page",
    comment: "Unsafe result",
  };
  assert.deepEqual(await h.reporter.submitFeedback(conversation(), input), {
    sent: true,
  });
  assert.deepEqual(h.posts[0].body.categories, input.categories);
  assert.equal(
    h.posts[0].body.comment,
    "https://example.com/page\n\nUnsafe result",
  );
  assert.equal(h.posts[0].body.conversation_excerpt, null);
  await assert.rejects(
    h.reporter.submitFeedback(conversation(), {
      ...input,
      reportUrl: "javascript:alert(1)",
    }),
    /Enter a valid URL/,
  );
  assert.equal(h.posts.length, 1);
});

test("unticked feedback carries no conversation content; ticked only when the service allows it", async (t) => {
  const input = {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down" as const,
    categories: ["Inaccurate"],
    comment: "The table was wrong. My key is sk-abcdefghijkl",
  };
  const h = harness(t, { flags: bootstrap(true, true, true) });
  assert.deepEqual(await h.reporter.submitFeedback(conversation(), input), {
    sent: true,
  });
  const unticked = h.posts[0].body;
  assert.equal(unticked.conversation_excerpt, null);
  assert.equal(unticked.comment, "The table was wrong. My key is [key]");
  assert.deepEqual(unticked.categories, ["inaccurate"]);
  assert.equal(unticked.model, "gpt-5.5");
  const wire = JSON.stringify(unticked);
  for (const text of ["secret-plan", "Summarise", "Here is the summary"])
    assert.equal(wire.includes(text), false, text);

  await h.reporter.submitFeedback(conversation(), {
    ...input,
    includeConversation: true,
  });
  assert.equal(
    h.posts[1].body.conversation_excerpt,
    "User: Summarise /Users/bob/secret-plan.md\n\nAssistant: Here is the summary.",
  );
  assert.notEqual(h.posts[1].body.id, h.posts[0].body.id);
  // Incognito chats never go along.
  await h.reporter.submitFeedback(
    { ...conversation(), incognito: true },
    { ...input, includeConversation: true },
  );
  assert.equal(h.posts[2].body.conversation_excerpt, null);

  const closed = harness(t, { flags: bootstrap(true, true, false) });
  await closed.reporter.submitFeedback(conversation(), {
    ...input,
    includeConversation: true,
  });
  assert.equal(closed.posts[0].body.conversation_excerpt, null);

  const long = conversation("a".repeat(30_000));
  assert.equal(conversationExcerpt(long, "turn-1")!.length, 20_000);
  assert.equal(conversationExcerpt(long, "missing"), null);
});

test("Code reports keep independent durable queue entries without replacing a reply rating", async (t) => {
  const h = harness(t);
  const c = { ...conversation(), mode: "code" as const };
  h.fail.error = new Error("Synthetic offline collector");
  h.reporter.rated(c, "turn-1", "up");
  for (const comment of ["First UI issue", "Second UI issue"])
    assert.deepEqual(
      await h.reporter.submitCodeFeedback(c, { conversationId: c.id, comment }),
      { sent: false, queued: true },
    );
  const queue = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(queue.feedback.length, 3);
  assert.equal(queue.feedback[0].turnId, "turn-1");
  assert.equal(queue.feedback[0].report.rating, "up");
  assert.equal(
    new Set(queue.feedback.map((entry: { turnId: string }) => entry.turnId))
      .size,
    3,
  );
  assert.ok(
    queue.feedback
      .slice(1)
      .every((entry: { turnId: string }) =>
        entry.turnId.startsWith("code-session:"),
      ),
  );
  h.reporter.stop();
  const posts: any[] = [];
  const resumed = new DiagnosticsReporter({
    file: h.file,
    bootstrap: h.source,
    consented: () => true,
    client: { appVersion: "1.3.2", platform: "darwin", arch: "arm64" },
    now: () => h.clock.now + ratingGraceMs + 1,
    post: async (_route, body) => {
      posts.push(body);
      return { accepted: true, duplicate: false, excerpt_dropped: false };
    },
  });
  t.after(() => resumed.stop());
  await resumed.flush();
  assert.equal(posts.length, 3);
  assert.deepEqual(
    new Set(posts.map((body) => body.id)),
    new Set(queue.feedback.map((entry: any) => entry.report.id)),
  );
  assert.deepEqual(
    posts.slice(1).map((body) => body.categories),
    [["code_session_issue"], ["code_session_issue"]],
  );
});

test("Code report excerpts require both opt-in and service permission and never include incognito", async (t) => {
  const c = { ...conversation(), mode: "code" as const };
  const h = harness(t, { flags: bootstrap(true, true, true) });
  const report = { conversationId: c.id, comment: "Synthetic UI issue" };
  await h.reporter.submitCodeFeedback(c, report);
  assert.equal(h.posts[0].body.conversation_excerpt, null);
  await h.reporter.submitCodeFeedback(c, {
    ...report,
    includeConversation: true,
  });
  assert.match(h.posts[1].body.conversation_excerpt, /Here is the summary/);
  await h.reporter.submitCodeFeedback(
    { ...c, incognito: true },
    { ...report, includeConversation: true },
  );
  assert.equal(h.posts[2].body.conversation_excerpt, null);
  await h.reporter.submitCodeFeedback(
    { ...c, turns: [] },
    { ...report, includeConversation: true },
  );
  assert.equal(h.posts[3].body.conversation_excerpt, null);
  const noConsent = harness(t, { consent: false });
  assert.deepEqual(await noConsent.reporter.submitCodeFeedback(c, report), {
    sent: false,
  });
  assert.equal(noConsent.posts.length, 0);
  const disallowed = harness(t, { flags: bootstrap(true, true, false) });
  await disallowed.reporter.submitCodeFeedback(c, {
    ...report,
    includeConversation: true,
  });
  assert.equal(disallowed.posts[0].body.conversation_excerpt, null);
});

test("Code retries keep the client report ID for the collector's existing per-user deduplication", async (t) => {
  const h = harness(t);
  const c = { ...conversation(), mode: "code" as const };
  const reportId = "4bac7c67-e946-42b3-9e7d-cb89b93ec53d";
  const report = {
    conversationId: c.id,
    comment: "Synthetic retry issue",
    reportId,
  };
  h.fail.error = new Error("Synthetic offline collector");
  await h.reporter.submitCodeFeedback(c, report);
  await h.reporter.submitCodeFeedback(c, report);
  const queue = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(queue.feedback.length, 1);
  assert.equal(queue.feedback[0].report.id, reportId);
  h.fail.error = undefined;
  h.clock.now += 60_001;
  await h.reporter.submitCodeFeedback(c, report);
  await h.reporter.submitCodeFeedback(c, report);
  assert.deepEqual(
    h.posts.map((entry) => entry.body.id),
    [reportId, reportId],
  );
});

test("a rating waits for the dialog, can be withdrawn and leaves with its conversation", async (t) => {
  const h = harness(t);
  h.reporter.rated(conversation(), "turn-1", "up");
  await h.reporter.flush();
  assert.equal(h.posts.length, 0);
  h.clock.now += ratingGraceMs;
  await h.reporter.flush();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.rating, "up");
  assert.deepEqual(h.posts[0].body.categories, []);
  assert.equal(h.posts[0].body.comment, "");
  assert.equal(h.posts[0].body.conversation_excerpt, null);

  h.reporter.rated(conversation(), "turn-1", "down");
  h.reporter.rated(conversation(), "turn-1", null);
  assert.equal(h.reporter.pending.feedback, 0);

  h.reporter.rated(conversation(), "turn-1", "down");
  await h.reporter.submitFeedback(conversation(), {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down",
    comment: "Wrong",
  });
  // The dialog's answer replaced the waiting rating.
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].body.comment, "Wrong");
  assert.equal(h.reporter.pending.feedback, 0);

  h.reporter.rated(conversation(), "turn-1", "down");
  h.reporter.forgetConversation("conversation-a");
  assert.equal(h.reporter.pending.feedback, 0);
  assert.equal(fs.existsSync(h.file), false);
});

test("offline reports are retried later with the same ids; a closed service drops them", async (t) => {
  const h = harness(t);
  h.fail.error = new Sub2ApiError(0, "UNREACHABLE", "offline");
  for (let index = 0; index < 60; index++) h.reporter.recordRefusal(refusal);
  const queued = JSON.parse(fs.readFileSync(h.file, "utf8"));
  assert.equal(queued.diagnostics.length, 60);
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  await h.reporter.flush();
  assert.equal(h.reporter.pending.diagnostics, 60);
  const outcome = await h.reporter.submitFeedback(conversation(), {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "up",
  });
  assert.deepEqual(outcome, { sent: false, queued: true });

  h.fail.error = undefined;
  h.clock.now += 30_000;
  await h.reporter.flush();
  assert.equal(h.posts.length, 0, "waits for the back-off");
  h.clock.now += 60_000;
  await h.reporter.flush();
  const sent = h.posts.filter((post) => post.route === "diagnostics");
  assert.deepEqual(
    sent.map((post) => post.body.reports.length),
    [50, 10],
  );
  assert.deepEqual(
    sent.flatMap((post) => post.body.reports.map((item: any) => item.id)),
    queued.diagnostics.map((item: any) => item.id),
  );
  assert.equal(h.posts.filter((post) => post.route === "feedback").length, 1);
  assert.equal(fs.existsSync(h.file), false);

  // The service turned collection off: the queue goes.
  h.reporter.recordRefusal(refusal);
  h.fail.error = new Sub2ApiError(404, "CLAUDEX_FEEDBACK_DISABLED", "off");
  await h.reporter.flush();
  assert.equal(h.reporter.pending.diagnostics, 0);
  assert.equal(fs.existsSync(h.file), false);

  // A bootstrap that turns collection off drops what waits too.
  h.fail.error = new Sub2ApiError(503, "HTTP_503", "busy");
  h.reporter.recordRefusal(refusal);
  h.source.set(bootstrap(false, true));
  assert.equal(h.reporter.pending.diagnostics, 0);
});

test("the reporter talks to a Claudex service only with consent and while it collects", async (t) => {
  const start = async (options: MockOptions) => {
    const mock = new MockSub2Api({ users: [user], groups: [pro], ...options });
    await mock.start();
    t.after(() => mock.close());
    const login = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
      method: "POST",
      body: { email: user.email, password: user.password },
    })) as { access_token: string };
    return { mock, token: login.access_token };
  };
  const reporterFor = (mock: MockSub2Api, token: string, consent: boolean) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-diag-mock-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const reporter = new DiagnosticsReporter({
      file: path.join(root, "diagnostics-queue.json"),
      bootstrap: mockBootstrapSource(mock, token),
      consented: () => consent,
      client: { appVersion: "1.3.2", platform: "darwin", arch: "arm64" },
      post: (route, body) =>
        requestJson(fetch, `${mock.url}/api/v1/claudex/${route}`, {
          method: "POST",
          token,
          body,
        }),
    });
    t.after(() => reporter.stop());
    return reporter;
  };
  const reports = (mock: MockSub2Api) =>
    mock.calls.filter((call) => /claudex\/(diagnostics|feedback)$/.test(call));

  // Default install: collection off. Nothing is posted even with consent.
  const off = await start({});
  const idle = reporterFor(off.mock, off.token, true);
  assert.equal((await idle.reportingStatus())?.diagnostics, false);
  idle.recordRefusal(refusal);
  await idle.flush();
  assert.deepEqual(reports(off.mock), []);

  // Collection on, no consent: the status is read, nothing is posted.
  const on = await start({
    feedback: { diagnostics: true, feedback: true },
  });
  const declined = reporterFor(on.mock, on.token, false);
  assert.deepEqual(await declined.reportingStatus(), {
    diagnostics: true,
    feedback: true,
    allowConversationExcerpt: false,
    consented: false,
  });
  declined.recordRefusal(refusal);
  await declined.submitFeedback(conversation(), {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down",
  });
  await declined.flush();
  assert.deepEqual(reports(on.mock), []);

  // With consent both reach the service; the excerpt is dropped there too.
  const agreed = reporterFor(on.mock, on.token, true);
  await agreed.reportingStatus();
  agreed.recordRefusal(refusal);
  await agreed.flush();
  assert.equal(on.mock.diagnostics.length, 1);
  assert.equal(on.mock.diagnostics[0].code, "WEEKLY_LIMIT_EXCEEDED");
  const result = await agreed.submitFeedback(conversation(), {
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down",
    includeConversation: true,
  });
  assert.deepEqual(result, { sent: true });
  assert.equal(on.mock.feedback.length, 1);
  assert.equal(on.mock.feedback[0].conversation_excerpt, null);
});

test("the diagnostics IPC follows the signed-in account and deletes the queue when consent is withdrawn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-diag-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "profile"));
  store.conversations = [conversation()];
  (store.settings as Settings).helpImproveClaudex = true;
  const replyFeedback = new ReplyFeedback(store.root);
  const settings = new Listeners<Settings>();
  const refusals = new Listeners<GatewayRefusal>();
  const events = new Listeners<AppEvent>();
  const ratings = new Listeners<ReplyRated>();
  const posted: string[] = [];
  const source = new MemoryBootstrapSource(bootstrap(true, true));
  const remote = {
    ready: true,
    bootstrap: source,
    accounts: { baseUrl: "http://127.0.0.1:9" },
    session: {
      authorized: async () => {
        posted.push("post");
        throw new Sub2ApiError(0, "UNREACHABLE", "offline");
      },
    },
  };
  const ctx = {
    store,
    remote,
    activeAccount: { id: "a" },
    dataRoot: root,
    appVersion: "1.3.2",
    replyFeedback,
    push: () => {},
    onSettingsChanged: (cb: any) => settings.add(cb),
    onRefusal: (cb: any) => refusals.add(cb),
    onEvent: (cb: any) => events.add(cb),
    onReplyRated: (cb: any) => ratings.add(cb),
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerDiagnosticsHandlers((name, fn) => handlers.set(name, fn), ctx);
  const file = path.join(store.root, "diagnostics-queue.json");

  assert.deepEqual(await handlers.get("reportingStatus")!(), {
    diagnostics: true,
    feedback: true,
    allowConversationExcerpt: false,
    consented: true,
    codeSessionFeedback: true,
  });
  refusals.emit(refusal);
  ratings.emit({
    conversationId: "conversation-a",
    turnId: "turn-1",
    rating: "down",
  });
  const queued = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(queued.diagnostics.length, 1);
  assert.equal(queued.feedback.length, 1);
  assert.deepEqual(
    await handlers.get("submitReplyFeedback")!({
      conversationId: "conversation-a",
      turnId: "turn-1",
      rating: "down",
    }),
    { sent: false, queued: true },
  );
  await assert.rejects(
    handlers.get("submitReplyFeedback")!({
      conversationId: "conversation-a",
      turnId: "missing",
      rating: "down",
    }),
    /Only completed replies/,
  );

  // Deleting the conversation takes its unsent feedback along.
  await assert.rejects(
    handlers.get("submitCodeFeedback")!({
      conversationId: "conversation-a",
      comment: "Synthetic UI issue",
    }),
    /Open a Code session/,
  );
  store.conversations[0].mode = "code";
  for (const comment of ["", " ", "x".repeat(4001)])
    await assert.rejects(
      handlers.get("submitCodeFeedback")!({
        conversationId: "conversation-a",
        comment,
      }),
    );
  assert.deepEqual(
    await handlers.get("submitCodeFeedback")!({
      conversationId: "conversation-a",
      comment: "Synthetic UI issue",
    }),
    { sent: false, queued: true },
  );
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).feedback.length, 2);
  replyFeedback.deleteConversation("conversation-a");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).feedback.length, 0);

  (store.settings as Settings).helpImproveClaudex = false;
  settings.emit(store.settings);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await handlers.get("reportingStatus")!()).consented, false);

  // Signed out (or a local account): nothing to report to.
  (ctx as { remote: unknown }).remote = undefined;
  assert.equal(await handlers.get("reportingStatus")!(), null);
  assert.deepEqual(
    await handlers.get("submitReplyFeedback")!({
      conversationId: "conversation-a",
      turnId: "turn-1",
      rating: "up",
    }),
    { sent: false },
  );
});

test("crashes keep the error's name and frame file names, never messages or folders", () => {
  const error = new TypeError("Cannot read /Users/bob/secret-plan.md");
  error.stack = [
    "TypeError: Cannot read /Users/bob/secret-plan.md",
    "    at readPlan (/Users/bob/Applications/Claudex.app/Contents/Resources/app.asar/dist-electron/main.js:120:15)",
    "    at C:\\Users\\bob\\AppData\\Local\\Claudex\\resources\\app.asar\\dist-electron\\host.js:44:3",
    "    at async Promise.all (index 0)",
    "    at run (node:internal/process/task_queues.js:95:5)",
    "    at more (/Users/bob/four.js:1:1)",
  ].join("\n");
  const report = crashReport(error, "main");
  assert.equal(report.kind, "crash");
  assert.equal(report.code, "TypeError");
  assert.equal(
    report.message,
    "TypeError at main.js:120, host.js:44, task_queues.js:95",
  );
  assert.doesNotMatch(JSON.stringify(report), /bob|secret|Users|AppData/);
  assert.equal(crashReport("a string", "main-promise").code, "Error");
  assert.equal(
    processGoneReport("renderer", { reason: "clean-exit" }),
    undefined,
  );
  assert.deepEqual(
    processGoneReport("child", { type: "GPU", reason: "crashed", exitCode: 9 }),
    {
      kind: "crash",
      code: "GPU_CRASHED",
      message: "GPU process crashed",
      context: { surface: "child", reason: "crashed" },
    },
  );
});

test("a failed MCP server is reported by a hash of its name and the error's category", () => {
  const report = mcpStartFailure(
    "acme-private-crm",
    "connection timed out after 30s at https://crm.acme.test",
  );
  assert.equal(report.code, "MCP_TIMEOUT");
  assert.equal(report.message, "");
  assert.equal(report.context?.feature, `mcp:${nameHash("acme-private-crm")}`);
  assert.match(String(report.context?.feature), /^mcp:[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(report), /acme|crm/);
  assert.equal(mcpStartFailure("x", "spawn npx ENOENT").code, "MCP_NOT_FOUND");
  assert.equal(mcpStartFailure("x", undefined).code, "MCP_FAILED");
  assert.equal(
    codexVersionOf("codex_cli_rs/0.144.1 (Mac OS 15.4; arm64)"),
    "0.144.1",
  );
  assert.equal(codexVersionOf("Codex 0.145.0-alpha.2"), "0.145.0-alpha.2");
  assert.equal(codexVersionOf(undefined), undefined);
});

test("the diagnostics IPC reports refusals with their request id, failed MCP starts, device key issues and the Codex version", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-diag-kinds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "profile"));
  (store.settings as Settings).helpImproveClaudex = true;
  const refusals = new Listeners<GatewayRefusal>();
  const events = new Listeners<AppEvent>();
  const listen = () => () => {};
  const mcpStartup = new Map<string, { status: string; error?: string }>();
  const ctx = {
    store,
    remote: {
      ready: true,
      bootstrap: new MemoryBootstrapSource(bootstrap(true, false)),
      accounts: { baseUrl: "http://127.0.0.1:9" },
      session: {
        authorized: async () => {
          throw new Sub2ApiError(0, "UNREACHABLE", "offline");
        },
      },
    },
    activeAccount: { id: "a" },
    engine: { mcpStartup },
    dataRoot: root,
    appVersion: "1.3.2",
    replyFeedback: new ReplyFeedback(store.root),
    push: () => {},
    onSettingsChanged: listen,
    onRefusal: (cb: any) => refusals.add(cb),
    onEvent: (cb: any) => events.add(cb),
    onReplyRated: listen,
  } as unknown as AppContext;
  registerDiagnosticsHandlers(() => {}, ctx);
  const file = path.join(store.root, "diagnostics-queue.json");
  const queued = () =>
    JSON.parse(fs.readFileSync(file, "utf8")).diagnostics as {
      kind: string;
      code: string;
      requestId?: string;
      codexVersion?: string;
      context?: Record<string, unknown>;
    }[];

  events.emit({
    type: "engine",
    engine: {
      state: "ready",
      version: "codex_cli_rs/0.144.1 (Mac OS 15.4; arm64)",
    },
  });
  refusals.emit({ ...refusal, requestId: "req-42" });
  mcpStartup.set("acme-private-crm", { status: "failed", error: "timed out" });
  mcpStartup.set("files", { status: "ready" });
  events.emit({ type: "conversation", conversation: conversation() });
  // The same failure is reported once per engine start.
  events.emit({ type: "conversation", conversation: conversation() });
  recordDiagnostic(ctx, {
    kind: "provision_failed",
    code: "CLAUDEX_DEVICE_LIMIT",
    context: { http_status: 409 },
  });
  const reports = queued();
  assert.deepEqual(
    reports.map((report) => report.kind),
    ["gateway_refusal", "mcp_start_failed", "provision_failed"],
  );
  assert.equal(reports[0].requestId, "req-42");
  for (const report of reports) assert.equal(report.codexVersion, "0.144.1");
  assert.equal(reports[1].code, "MCP_TIMEOUT");
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /acme/);
  assert.equal(reports[2].context?.http_status, 409);

  // A new engine start reports a server that still fails.
  events.emit({ type: "engine", engine: { state: "starting" } });
  events.emit({ type: "conversation", conversation: conversation() });
  assert.equal(queued().length, 4);
  // Another context has no reporter: nothing happens, nothing throws.
  recordDiagnostic({}, { kind: "provision_failed", code: "X" });
});

test("a fetched bootstrap is read on demand and announces changes", async () => {
  let reads = 0;
  const source = new FetchedBootstrap(async (etag) => {
    reads++;
    return etag
      ? { notModified: true }
      : { notModified: false, data: bootstrap(true, false), etag: '"a"' };
  });
  const seen: unknown[] = [];
  source.onChange((value) => seen.push(value?.features.diagnostics));
  assert.equal(source.current(), undefined);
  await Promise.all([source.refresh(), source.refresh()]);
  assert.equal(reads, 1);
  await source.refresh();
  assert.equal(reads, 2);
  assert.deepEqual(seen, [true]);
  assert.equal(source.current()?.features.feedback, false);
});

test("a turn that fails right after sign-in is reported once, even across a new sign-in", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-diag-first-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, "profile"));
  (store.settings as Settings).helpImproveClaudex = true;
  const events = new Listeners<AppEvent>();
  const listen = () => () => {};
  const remoteHost = () => ({
    ready: true,
    bootstrap: new MemoryBootstrapSource(bootstrap(true, true)),
    accounts: { baseUrl: "http://127.0.0.1:9" },
    session: {
      authorized: async () => {
        throw new Sub2ApiError(0, "UNREACHABLE", "offline");
      },
    },
  });
  const ctx = {
    store,
    remote: remoteHost(),
    activeAccount: { id: "a" },
    dataRoot: root,
    appVersion: "1.3.2",
    replyFeedback: new ReplyFeedback(store.root),
    push: () => {},
    onSettingsChanged: listen,
    onRefusal: listen,
    onEvent: (cb: any) => events.add(cb),
    onReplyRated: listen,
  } as unknown as AppContext;
  registerDiagnosticsHandlers(() => {}, ctx);
  const file = path.join(store.root, "diagnostics-queue.json");
  // The reporter is made on first use: here, the turn's own events.
  const failed = conversation();
  failed.turns[0] = {
    ...failed.turns[0],
    status: "failed",
    error: "fetch failed",
    createdAt: Date.now(),
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  events.emit({ type: "conversation", conversation: failed });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).diagnostics.length, 1);
  // Signing in again makes a new reporter; the same turn is not reported twice.
  (ctx as { remote: unknown }).remote = remoteHost();
  events.emit({ type: "conversation", conversation: failed });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).diagnostics.length, 1);
});
