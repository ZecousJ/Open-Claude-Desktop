import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import { ArtifactShares } from "../../electron/artifacts/artifact-shares";
import {
  registerSharingHandlers,
  sharingError,
} from "../../electron/ipc/sharing";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
import { ClaudexSharing } from "../../electron/sub2api/claudex-sharing";
import { requestJson, Sub2ApiError } from "../../electron/sub2api/http";
import { sourceKeyOf } from "../../electron/artifacts/hosted-shares-support";
import {
  parseHostedShare,
  parseSharePage,
  parseSharingStatus,
  shareUrl,
} from "../../shared/sharing";
import type { AppEvent, Conversation } from "../../shared/types";
import {
  fail,
  MockSub2Api,
  ok,
  type MockRequest,
} from "../support/sub2api-mock";

type Json = Record<string, unknown>;
const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const token43 = (n: number) => `${String(n).padStart(4, "0")}${"A".repeat(39)}`;

/** The service's sharing routes as design R1 3.4 describes them, in memory. */
function sharingService(
  mock: MockSub2Api,
  options: {
    settings?: Json;
    publicBase?: string;
  } = {},
) {
  const settings: Json = {
    enabled: true,
    conversations: true,
    artifacts: true,
    usage_policy_url: "https://service.example.test/usage",
    max_snapshot_bytes: 8 * 1024 * 1024,
    max_artifact_bytes: 2 * 1024 * 1024,
    blocked: false,
    ...options.settings,
  };
  const shares: (Json & { id: number; body?: Json })[] = [];
  let next = 1;
  const dto = (share: Json) => {
    const { body: _body, token, ...rest } = share;
    return {
      ...rest,
      path: `/s/${token}`,
      url: options.publicBase ? `${options.publicBase}/s/${token}` : "",
    };
  };
  const mine = (request: MockRequest) =>
    shares.find(
      (share) =>
        String(share.id) === request.params.id &&
        share.user_id === request.userId &&
        share.status !== "revoked",
    );
  mock.route("GET", "/api/v1/claudex/sharing/status", () => ok(settings));
  mock.route("POST", "/api/v1/claudex/shares", (request) => {
    if (!settings.enabled)
      return fail(403, "Sharing is off", "CLAUDEX_SHARING_DISABLED");
    if (settings.blocked)
      return fail(403, "Blocked", "CLAUDEX_SHARING_USER_BLOCKED");
    if (request.raw.length > Number(settings.max_snapshot_bytes))
      return fail(413, "Too large", "CLAUDEX_SHARE_TOO_LARGE");
    const { kind, source_key, title, snapshot } = request.body;
    const live = shares.find(
      (share) =>
        share.user_id === request.userId &&
        share.kind === kind &&
        share.source_key === source_key &&
        share.status !== "revoked",
    );
    const now = new Date().toISOString();
    if (live) {
      Object.assign(live, { title, snapshot_at: now, body: snapshot });
      return ok(dto(live));
    }
    const share = {
      id: next,
      token: token43(next++),
      user_id: request.userId,
      kind,
      source_key,
      title,
      status: "active",
      disabled_reason: "",
      created_at: now,
      snapshot_at: now,
      expires_at: null,
      view_count: 0,
      body: snapshot as Json,
    };
    shares.push(share);
    return ok(dto(share));
  });
  mock.route("GET", "/api/v1/claudex/shares", (request) => {
    const kind = request.url.searchParams.get("kind");
    const page = Number(request.url.searchParams.get("page") ?? 1);
    const size = Number(request.url.searchParams.get("page_size") ?? 20);
    const all = shares.filter(
      (share) =>
        share.user_id === request.userId &&
        share.status !== "revoked" &&
        (!kind || share.kind === kind),
    );
    return ok({
      items: all.slice((page - 1) * size, page * size).map(dto),
      total: all.length,
      page,
      page_size: size,
      pages: Math.max(1, Math.ceil(all.length / size)),
    });
  });
  mock.route("GET", "/api/v1/claudex/shares/:id", (request) => {
    const share = mine(request);
    return share
      ? ok(dto(share))
      : fail(404, "Not found", "CLAUDEX_SHARE_NOT_FOUND");
  });
  mock.route("DELETE", "/api/v1/claudex/shares/:id", (request) => {
    const share = mine(request);
    if (!share) return fail(404, "Not found", "CLAUDEX_SHARE_NOT_FOUND");
    share.status = "revoked";
    delete share.body;
    return ok(null);
  });
  return { settings, shares };
}

async function start(
  t: TestContext,
  options?: Parameters<typeof sharingService>[1],
) {
  const mock = new MockSub2Api({ users: [user] });
  await mock.start();
  t.after(() => mock.close());
  const service = sharingService(mock, options);
  const login = (await requestJson(fetch, `${mock.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  return { mock, service, token: String(login.access_token) };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c-1",
    title: "Plan a trip",
    mode: "chat",
    providerId: "sub2api",
    model: "gpt-test",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t-1",
        prompt: "Where should I go in /Users/bob/Trips?",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          { id: "i-1", type: "agentMessage", text: "Try Lisbon." },
          {
            id: "i-2",
            type: "commandExecution",
            command: "cat secrets.txt",
            aggregatedOutput: "hunter2",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("the status, a share and a page are read field by field", () => {
  assert.equal(
    parseSharingStatus({ enabled: false, conversations: true }),
    null,
  );
  assert.equal(parseSharingStatus(null), null);
  assert.deepEqual(
    parseSharingStatus({
      enabled: true,
      conversations: true,
      artifacts: false,
      usage_policy_url: "http://insecure.example.test/policy",
      max_snapshot_bytes: -1,
    }),
    {
      conversations: true,
      artifacts: false,
      maxSnapshotBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 2 * 1024 * 1024,
    },
  );
  assert.deepEqual(
    parseSharingStatus({
      enabled: true,
      conversations: true,
      artifacts: true,
      blocked: true,
      usage_policy_url: "https://service.example.test/usage",
    }),
    {
      conversations: false,
      artifacts: false,
      usagePolicyUrl: "https://service.example.test/usage",
      maxSnapshotBytes: 8 * 1024 * 1024,
      maxArtifactBytes: 2 * 1024 * 1024,
      blocked: true,
    },
  );
  const base = "https://claudex.example.test";
  // No public base URL: the path on the service this app signed in to.
  assert.equal(
    shareUrl({ url: "", path: `/s/${token43(1)}` }, base),
    `${base}/s/${token43(1)}`,
  );
  assert.equal(
    shareUrl({ path: `/s/${token43(1)}` }, "https://host.example.test/prefix/"),
    `https://host.example.test/prefix/s/${token43(1)}`,
  );
  // The administrator's public base URL wins; nothing but http(s) is a link.
  assert.equal(
    shareUrl(
      { url: `https://share.example.test/s/${token43(2)}`, path: "/s/x" },
      base,
    ),
    `https://share.example.test/s/${token43(2)}`,
  );
  assert.equal(
    shareUrl(
      { url: "javascript:alert(1)", path: "//evil.example.test/x" },
      base,
    ),
    undefined,
  );
  assert.equal(shareUrl({ path: "/s/../../x y" }, base), undefined);
  const share = parseHostedShare(
    {
      id: 7,
      kind: "conversation",
      source_key: "a".repeat(64),
      title: "Trip",
      status: "disabled",
      disabled_reason: "Reported",
      path: `/s/${token43(7)}`,
      created_at: "2026-09-26T10:00:00Z",
      snapshot_at: "2026-09-26T11:00:00Z",
      view_count: 3,
    },
    base,
  );
  assert.deepEqual(share, {
    id: "7",
    kind: "conversation",
    sourceKey: "a".repeat(64),
    title: "Trip",
    url: `${base}/s/${token43(7)}`,
    inviteUrl: `${base}/shared/${token43(7)}`,
    createdAt: Date.parse("2026-09-26T10:00:00Z"),
    snapshotAt: Date.parse("2026-09-26T11:00:00Z"),
    status: "disabled",
    views: 3,
    disabledReason: "Reported",
  });
  assert.equal(
    parseHostedShare(
      { id: 1, kind: "conversation", status: "revoked", path: "/s/a" },
      base,
    ),
    undefined,
  );
  assert.equal(
    parseHostedShare(
      { id: 1, kind: "other", status: "active", path: "/s/a" },
      base,
    ),
    undefined,
  );
  assert.deepEqual(parseSharePage("nonsense", base), {
    items: [],
    page: 1,
    pages: 1,
  });
});

test("the client makes, lists, reads and revokes shares on the service", async (t) => {
  const { mock, service, token } = await start(t);
  const api = new ClaudexSharing(mock.url);
  assert.equal((await api.status(token))?.conversations, true);
  const snapshot = {
    kind: "conversation" as const,
    title: "Trip",
    messages: [{ role: "user" as const, text: "Hello" }],
  };
  const made = await api.create(token, {
    kind: "conversation",
    source_key: "b".repeat(64),
    title: "Trip",
    snapshot,
  });
  assert.equal(made.url, `${mock.url}/s/${token43(1)}`);
  // The same source again refreshes the same link.
  const again = await api.create(token, {
    kind: "conversation",
    source_key: "b".repeat(64),
    title: "Trip, updated",
    snapshot,
  });
  assert.equal(again.id, made.id);
  assert.equal(again.url, made.url);
  assert.equal(service.shares.length, 1);
  for (let index = 0; index < 130; index++)
    await api.create(token, {
      kind: "artifact",
      source_key: index.toString(16).padStart(64, "0"),
      title: `Artifact ${index}`,
      snapshot: { kind: "artifact", title: "A", artifacts: [] },
    });
  // Two pages of 100.
  assert.equal((await api.list(token)).length, 131);
  assert.equal((await api.list(token, "conversation")).length, 1);
  assert.equal((await api.get(token, made.id))?.title, "Trip, updated");
  await api.revoke(token, made.id);
  assert.equal(await api.get(token, made.id), undefined);
  // Revoking again is not an error.
  await api.revoke(token, made.id);
  assert.equal((await api.list(token, "conversation")).length, 0);
});

test("a service without sharing, or with it off, reads as no sharing", async (t) => {
  const { mock, service, token } = await start(t);
  const api = new ClaudexSharing(mock.url);
  service.settings.enabled = false;
  assert.equal(await api.status(token), null);
  const plain = new MockSub2Api({ users: [user], claudex: false });
  await plain.start();
  t.after(() => plain.close());
  const login = (await requestJson(fetch, `${plain.url}/api/v1/auth/login`, {
    method: "POST",
    body: { email: user.email, password: user.password },
  })) as Json;
  assert.equal(
    await new ClaudexSharing(plain.url).status(String(login.access_token)),
    null,
  );
});

test("refusals read as what they mean to the person", () => {
  const refusal = (status: number, code: string) =>
    sharingError(new Sub2ApiError(status, code, "raw"));
  assert.match(
    refusal(413, "CLAUDEX_SHARE_TOO_LARGE").message,
    /This chat is too large to share/,
  );
  assert.match(
    sharingError(new Sub2ApiError(413, "HTTP_413", "raw"), "artifact").message,
    /This artifact is too large/,
  );
  assert.match(
    refusal(403, "CLAUDEX_SHARING_USER_BLOCKED").message,
    /turned off sharing for your account/,
  );
  assert.match(
    refusal(403, "CLAUDEX_SHARING_DISABLED").message,
    /turned off sharing/,
  );
  assert.match(
    refusal(429, "CLAUDEX_SHARE_QUOTA").message,
    /limit of shared links/,
  );
  assert.match(
    refusal(0, "UNREACHABLE").message,
    /Couldn't reach the Claudex service/,
  );
  assert.match(
    refusal(404, "CLAUDEX_SHARE_NOT_FOUND").message,
    /no longer exists/,
  );
});

/** The sharing and Privacy handlers over a context with a signed-in Claudex account. */
async function desktop(
  t: TestContext,
  remote: boolean,
  options?: Parameters<typeof sharingService>[1],
) {
  const { mock, service, token } = await start(t, options);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sharing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactShares = new ArtifactShares(root);
  const events: AppEvent[] = [];
  let activated: (() => void) | undefined;
  const conversations = [
    conversation(),
    conversation({ id: "c-incognito", incognito: true }),
  ];
  const ctx = {
    store: { root, conversations },
    remote: remote
      ? {
          accounts: { baseUrl: mock.url },
          session: {
            authorized: <T>(call: (token: string) => Promise<T>) => call(token),
          },
        }
      : undefined,
    artifactShares,
    services: {},
    push: (event: AppEvent) => events.push(event),
    onAccountActivated: (cb: () => void) => {
      activated = cb;
      return () => {};
    },
    onAccountDeactivating: () => () => {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSharingHandlers((name, fn) => handlers.set(name, fn), ctx);
  registerSettingsAccountHandlers((name, fn) => handlers.set(name, fn), ctx);
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  activated?.();
  return { mock, service, call, events, artifactShares, ctx, conversations };
}

test("a local account has no hosted sharing and every change is refused", async (t) => {
  const { call, mock } = await desktop(t, false);
  assert.equal(await call("sharingStatus"), null);
  assert.equal(await call("conversationShare", "c-1"), null);
  assert.deepEqual(await call("hostedShares"), []);
  await assert.rejects(
    call("shareConversation", "c-1"),
    /Sharing isn't available/,
  );
  await assert.rejects(
    call("publishArtifact", {
      identity: "a",
      title: "A",
      language: "html",
      content: "<p>",
    }),
    /Sharing isn't available/,
  );
  assert.equal(mock.calls.filter((c) => c.includes("/claudex/shar")).length, 0);
});

test("a Claudex account shares a chat, sees it, and stops it", async (t) => {
  const { call, service, events, mock } = await desktop(t, true);
  const status = await call("sharingStatus");
  assert.equal(status.conversations, true);
  assert.equal(status.usagePolicyUrl, "https://service.example.test/usage");
  assert.equal(await call("conversationShare", "c-1"), null);
  const share = await call("shareConversation", "c-1");
  assert.equal(share.sourceKey, "c-1");
  assert.equal(share.status, "active");
  assert.match(share.url, new RegExp(`^${mock.url}/s/`));
  // The service keeps a hash of the conversation id and only the prompt and reply text.
  const stored = service.shares[0];
  assert.equal(stored.source_key, sourceKeyOf("conversation", "c-1"));
  assert.doesNotMatch(
    JSON.stringify(stored),
    /c-1"|hunter2|cat secrets|\/Users\/bob/,
  );
  assert.deepEqual((stored.body as Json).messages, [
    { role: "user", text: "Where should I go in ~/Trips?" },
    { role: "assistant", text: "Try Lisbon.", activity: ["Ran a command"] },
  ]);
  assert.ok(events.some((e) => e.type === "sharing" && e.sourceKey === "c-1"));
  assert.equal((await call("conversationShare", "c-1")).id, share.id);
  assert.equal((await call("hostedShares", "conversation")).length, 1);
  await assert.rejects(
    call("shareConversation", "c-incognito"),
    /Incognito chats can't be shared/,
  );
  await assert.rejects(
    call("shareConversation", "missing"),
    /Conversation not found/,
  );
  await call("unshareConversation", "c-1");
  assert.equal(stored.status, "revoked");
  assert.equal(await call("conversationShare", "c-1"), null);
  // Stopping again is fine.
  await call("unshareConversation", "c-1");
});

test("a chat that grew after sharing shows as behind until it is shared again", async (t) => {
  const { call, conversations } = await desktop(t, true);
  await call("shareConversation", "c-1");
  assert.equal((await call("conversationShare", "c-1")).stale, undefined);
  conversations[0].turns.push({
    id: "t-2",
    prompt: "And in winter?",
    attachments: [],
    status: "completed",
    createdAt: 2,
    items: [{ id: "i-3", type: "agentMessage", text: "Madeira." }],
  });
  assert.equal((await call("conversationShare", "c-1")).stale, true);
  await call("shareConversation", "c-1");
  assert.equal((await call("conversationShare", "c-1")).stale, undefined);
});

test("an artifact's public link shows in the popover, the Privacy list and follows Only you", async (t) => {
  const { call, service, artifactShares, events } = await desktop(t, true, {
    publicBase: "https://share.example.test",
  });
  const input = {
    identity: JSON.stringify(["c-1", "/workspace/card.html"]),
    title: "Card",
    language: "html",
    content: "<p>Card</p>",
  };
  const share = await call("publishArtifact", input);
  assert.match(share.url, /^https:\/\/share\.example\.test\/s\//);
  assert.equal(share.sourceKey, input.identity);
  const info = artifactShares.sync(input);
  assert.equal(info.scope, "public");
  assert.equal(info.visibility, "link");
  assert.equal(info.publicUrl, share.url);
  assert.ok(
    artifactShares.list().some((item) => item.identity === input.identity),
  );
  assert.ok(events.some((e) => e.type === "artifact-shares"));
  const privacy = await call("sharedArtifacts");
  assert.deepEqual(privacy, [
    {
      identity: `hosted:${share.id}`,
      title: "Card",
      url: share.url,
      scope: "public",
      createdAt: share.createdAt,
    },
  ]);
  // Only you in the popover stops the public link.
  const privateInfo = artifactShares.update(input, { visibility: "private" });
  assert.equal(privateInfo.visibility, "private");
  assert.equal(privateInfo.scope, undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.shares[0].status, "revoked");
  // Privacy → Stop sharing works on a public row too.
  const again = await call("publishArtifact", input);
  assert.notEqual(again.id, share.id);
  assert.deepEqual(await call("stopSharingArtifact", `hosted:${again.id}`), []);
  assert.equal(service.shares[1].status, "revoked");
});

test("Publish: each version gets its link, and Unpublish stops them all", async (t) => {
  const { call, service } = await desktop(t, true);
  const input = {
    identity: JSON.stringify(["c-1", "/workspace/page.html"]),
    title: "Page",
    language: "html",
    content: "<p>1</p>",
  };
  assert.deepEqual(await call("artifactPublication", input), {
    share: null,
    liveLinks: 0,
    unpublished: false,
  });
  const first = await call("publishArtifact", input);
  const second = await call("publishArtifact", {
    ...input,
    content: "<p>2</p>",
  });
  assert.notEqual(first.id, second.id);
  const shown = await call("artifactPublication", input);
  assert.equal(shown.share.id, first.id);
  assert.equal(shown.liveLinks, 2);
  await call("unpublishArtifact", input.identity);
  assert.deepEqual(
    service.shares.map((share) => share.status),
    ["revoked", "revoked"],
  );
  assert.deepEqual(await call("artifactPublication", input), {
    share: null,
    liveLinks: 0,
    unpublished: true,
  });
  await assert.rejects(
    call("publishArtifact", input),
    /previously unpublished/,
  );
  await assert.rejects(call("unpublishArtifact", ""));
});

test("sharing off for the account or too large reads plainly", async (t) => {
  const { call, service } = await desktop(t, true, {
    settings: { max_artifact_bytes: 10 },
  });
  await assert.rejects(
    call("publishArtifact", {
      identity: "x",
      title: "Big",
      language: "html",
      content: "<p>more than ten bytes</p>",
    }),
    /This artifact is too large to share/,
  );
  service.settings.blocked = true;
  const status = await call("sharingStatus");
  // Cached for a minute: the dialog's refusal still explains it.
  assert.equal(status.conversations, true);
  await assert.rejects(
    call("shareConversation", "c-1"),
    /turned off sharing for your account/,
  );
});
