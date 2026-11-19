import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { StoreTransport } from "../../runner/src/cloud-store";
import { LinkRequestError } from "../../runner/src/control-link";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { Conversation } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

const repo = "fixture/fork";
const upstream = "project/upstream";
const branch = "claude/feature";
const statusPath = "/v1/code/github/get-batch-branch-status";
const subscribePath = "/v1/code/github/subscribe-pull-request";
const unsubscribePath = "/v1/code/github/unsubscribe-pull-request";
const mutePath = "/v1/code/github/set-pull-request-address-comments-muted";

async function fixture(t: TestContext) {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { cloudCodeSessionKey },
    { organizationUuid },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
  ]);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-code-pr-monitor-"),
  );
  const user = { id: 7, accessToken: "fixture-token" };
  const owner = "fixture-owner";
  const organization = organizationUuid(owner);
  const webstore = memoryWebstore();
  const url = `https://github.com/${repo}`;
  const conversation: Conversation = {
    id: "code",
    mode: "code",
    title: "Fixture",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    turns: [],
    branch,
    environment: { kind: "space", spaceId: "r-fixture" },
    sessionAuthors: { ownerAccountUuid: owner, viewerAccountUuid: owner },
    repository: { fullName: repo, url },
    sessionRepositories: [
      { url, ref: "main", outcome: { kind: "create", branch } },
    ],
  };
  const foreign: Conversation = {
    ...structuredClone(conversation),
    id: "foreign",
    sessionAuthors: { ownerAccountUuid: "foreign", viewerAccountUuid: owner },
  };
  const id = (row: Conversation) =>
    `session_${cloudCodeSessionKey(row, owner)}`;
  const provider = {
    unavailable: false,
    disconnected: false,
    branchExists: true,
    state: "open",
    head: branch,
    beforeRead: async () => {},
  };
  const providerCalls: unknown[] = [];
  const transport: StoreTransport = {
    async request(op, userId, body) {
      assert.equal(userId, user.id);
      if (op !== "github.api") return webstore.request(op, userId, body);
      assert.ok(
        body && typeof body === "object" && "action" in body && "url" in body,
      );
      providerCalls.push(body);
      if (provider.unavailable) throw Error("Offline");
      if (provider.disconnected)
        throw new LinkRequestError({
          code: "CLAUDEX_GITHUB_NOT_CONNECTED",
          message: "Disconnected",
        });
      if (body.action === "repository.branchExists") {
        assert.equal(body.url, url);
        return { exists: provider.branchExists };
      }
      if (body.action === "repository.forkBases") return [upstream, upstream];
      if (body.action === "pr.byHead") {
        if (body.url === url) return {};
        assert.equal(body.url, `https://github.com/${upstream}`);
        assert.ok("headRepository" in body);
        assert.equal(body.headRepository, repo);
        return { number: 21 };
      }
      if (body.action === "pr.hostedStatus")
        return {
          headRefOid: "head-sha", reviewDecision: "REVIEW_REQUIRED",
          autoMergeRequest: { enabledAt: "2026-10-01T12:00:00Z" },
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
            { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "FAILURE" },
            { __typename: "StatusContext", context: "Legacy tests", state: "PENDING" },
          ] } } } }] },
        };
      if (body.action === "pr.get") {
        await provider.beforeRead();
        assert.equal(body.url, `https://github.com/${upstream}`);
        return {
          number: 21,
          html_url: `https://github.com/${upstream}/pull/21`,
          state: provider.state,
          title: "Fixture PR",
          head_ref: provider.head,
          head_repository: repo,
          base_ref: "main",
          head_sha: "head-sha",
        };
      }
      return assert.fail("unexpected GitHub action");
    },
  };
  const open = (name: string) =>
    CloudStore.open({
      root: path.join(root, name),
      userId: user.id,
      transport,
      log() {},
    });
  const store = await open("active");
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.conversations.push(conversation, foreign);
  await store.sync();
  let identity = {};
  const ctx = {
    activeAccount: { id: owner },
    userId: user.id,
    store,
    runtime: { transport },
    selectedAttachments: new Map(),
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    push() {},
  };
  const dispatcher = {
    options: { officialUiRoot: "/fixture", officialUiActions: true },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: Date.now,
  } as unknown as Dispatcher;
  const call = (method: string, request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method,
      user,
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const fetch = createOfficialReadFetch(
    "https://claudex.test",
    read,
    async () => assert.fail("Unexpected network request."),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: String(user.id),
      isCurrent: () => true,
      read,
      action: (request) => call("officialUiAction", request),
    }),
  );
  const post = (target: string, body: object, org = organization) =>
    fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-organization-uuid": org,
      },
      body: JSON.stringify(body),
    });
  const session = id(conversation);
  const action = { repo, session_id: session, pr_number: 21 };
  const status = {
    repo_branches: [{ repo, branch, session_id: session }],
    include_ci_status: true,
  };
  return {
    session,
    foreign: id(foreign),
    conversation,
    post,
    provider,
    providerCalls,
    action,
    status,
    open,
    retire: () => {
      identity = {};
    },
  };
}

test("official Web discovers an upstream PR, binds Auto-fix, and reloads its mute and subscription state", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post(subscribePath, f.action)).status,
    404,
    "a raw PR number cannot create a watch",
  );
  assert.equal(f.providerCalls.length, 0);

  const discovery = await f.post(
    statusPath + "?caller=epitaxy-discover-repos",
    {
      repo_branches: [],
      discover_session_prs: true,
      session_ids: [f.session],
    },
  );
  assert.equal(discovery.status, 200);
  assert.deepEqual((await discovery.json()).branch_statuses, [
    {
      repo,
      branch,
      session_id: f.session,
      branch_exists: true,
      has_session_binding: false,
      address_comments_muted: false,
      upstream_repo: upstream,
      pull_request: {
        number: 21,
        url: `https://github.com/${upstream}/pull/21`,
        state: "open",
        title: "Fixture PR",
        base_ref: "main",
        head_sha: "head-sha",
      },
    },
  ]);
  assert.equal((await f.post(subscribePath, f.action)).status, 200);
  assert.equal(
    (await f.post(mutePath, { ...f.action, muted: true })).status,
    200,
  );

  const status = await f.post(
    statusPath + "?caller=epitaxy-cichecks",
    f.status,
  );
  assert.equal(status.status, 200);
  const [tracked] = (await status.json()).branch_statuses;
  assert.equal(tracked.request_session_id, f.session);
  assert.equal(tracked.has_session_binding, true);
  assert.equal(tracked.address_comments_muted, true);
  assert.equal(tracked.pull_request.review_decision, "REVIEW_REQUIRED");
  assert.equal(tracked.pull_request.auto_merge_enabled, true);
  assert.deepEqual(tracked.pull_request.checks, [
    {
      typename: "CheckRun",
      name: "Build",
      status: "COMPLETED",
      conclusion: "FAILURE",
    },
    { typename: "StatusContext", name: "Legacy tests", state: "PENDING" },
  ]);

  assert.equal((await f.post(unsubscribePath, f.action)).status, 200);
  const reopened = await f.open("reloaded");
  t.after(() => reopened.close());
  const [saved] =
    reopened.conversations.find((row) => row.id === f.conversation.id)
      ?.pullRequests ?? [];
  assert.equal(saved.number, 21);
  assert.equal(saved.repository, upstream);
  assert.equal(saved.headRepository, repo);
  assert.deepEqual(saved.autoFix, { ci: false, comments: false });
});

test("official Web distinguishes absent branches, provider errors, foreign sessions and stale PR heads", async (t) => {
  const f = await fixture(t);
  const wrongOrg = await f.post(
    statusPath,
    f.status,
    "96d2e789-8d31-4aed-839f-2e35ec914579",
  );
  assert.equal(wrongOrg.status, 403);
  assert.equal(
    (await wrongOrg.json()).error.message,
    "Organization not found.",
  );
  const foreign = await f.post(statusPath, {
    repo_branches: [],
    discover_session_prs: true,
    session_ids: [f.foreign],
  });
  assert.equal(foreign.status, 404);
  assert.equal(f.providerCalls.length, 0);
  assert.equal(
    (await f.post(statusPath + "?caller=epitaxy-repopr&extra=1", f.status))
      .status,
    501,
  );
  assert.equal(
    (await f.post(subscribePath, { ...f.action, branch })).status,
    400,
  );

  f.provider.disconnected = true;
  const disconnected = await f.post(statusPath, f.status);
  assert.equal(disconnected.status, 403);
  assert.equal(
    (await disconnected.json()).error.message,
    "Connect your GitHub account first.",
  );
  f.provider.disconnected = false;
  f.provider.unavailable = true;
  assert.equal((await f.post(statusPath, f.status)).status, 503);
  f.provider.unavailable = false;
  f.provider.branchExists = false;
  const gone = await f.post(statusPath, f.status);
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).branch_statuses[0].branch_exists, false);

  f.provider.head = "unrelated-head";
  assert.equal((await f.post(subscribePath, f.action)).status, 404);
  assert.equal(f.conversation.pullRequests?.[0].autoFix, undefined);
  f.provider.head = branch;
  f.provider.beforeRead = async () => {
    f.retire();
  };
  assert.equal((await f.post(subscribePath, f.action)).status, 409);
  assert.equal(f.conversation.pullRequests?.[0].autoFix, undefined);
});
