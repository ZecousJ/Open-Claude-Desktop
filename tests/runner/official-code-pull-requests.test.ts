import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CloudClient } from "../../electron/cloud/cloud-client";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type { StoreTransport } from "../../runner/src/cloud-store";
import { LinkRequestError } from "../../runner/src/control-link";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { Conversation } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

const repository = "fixture/repo";
const repositoryUrl = `https://github.com/${repository}`;
const branch = "claude/feature";
const originalBody =
  "Describe the change.\n\nhttps://claudex.test/code/session_fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function githubPull({
  base = "main",
  target = repository,
  draft = false,
  number = 21,
  title = "Fixture pull request",
} = {}) {
  return {
    number,
    html_url: `https://github.com/${target}/pull/${number}`,
    state: "open",
    draft,
    title,
    head_ref: branch,
    head_repository: repository,
    base_ref: base,
    created_at: "2026-10-01T12:00:00Z",
  };
}

async function fixture(t: TestContext) {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { cloudCodeSessionKey },
    { organizationUuid },
    { createDesktopCloudCode },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
    import("../../electron/official-ui/api/desktop-cloud-code"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-pulls-"));
  const webstore = memoryWebstore();
  const user = { id: 7, accessToken: "fixture-token" };
  const account = { id: "fixture-owner" };
  const organization = organizationUuid(account.id);
  const calls: { action: string; [key: string]: unknown }[] = [];
  let github = async (_request: Record<string, unknown>): Promise<unknown> =>
    assert.fail("unexpected GitHub request");
  const transport: StoreTransport = {
    async request(op, id, body) {
      assert.equal(id, user.id);
      if (op !== "github.api") return webstore.request(op, id, body);
      assert.ok(
        body &&
          typeof body === "object" &&
          "action" in body &&
          typeof body.action === "string",
      );
      calls.push({ ...body, action: body.action });
      return github(body);
    },
  };
  const open = (profile = "profile") =>
    CloudStore.open({
      root: path.join(root, profile),
      userId: user.id,
      log() {},
      transport,
    });
  const store = await open();
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const conversation: Conversation = {
    id: "code",
    mode: "code",
    title: "Cloud Code",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: false,
    environment: { kind: "space", spaceId: "r-fixture" },
    repository: { url: repositoryUrl, fullName: repository },
    sessionRepositories: [
      {
        url: repositoryUrl,
        ref: "refs/heads/main",
        outcome: { kind: "create", branch },
      },
    ],
    branch,
    turns: [],
  };
  const foreign = {
    ...structuredClone(conversation),
    id: "foreign",
    sessionAuthors: {
      viewerAccountUuid: account.id,
      ownerAccountUuid: "someone-else",
    },
  };
  store.conversations.push(conversation, foreign);
  await store.sync();
  let identity = {};
  const ctx = {
    userId: user.id,
    activeAccount: account,
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
  const send = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  const origin = "https://claudex.test";
  const fetch = createOfficialReadFetch(
    origin,
    read,
    async () => assert.fail("unexpected native network request"),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: String(user.id),
      isCurrent: () => true,
      read,
      action: send,
    }),
  );
  const codePullBody = (changes: Record<string, unknown>) =>
    JSON.stringify({
      repo: repository,
      head: branch,
      base: "main",
      title: "Fixture pull request",
      body: originalBody,
      draft: false,
      session_id: `session_${cloudCodeSessionKey(conversation, account.id)}`,
      ...changes,
    });
  const request = (
    changes: Record<string, unknown> = {},
    org = organization,
    header = org,
  ) =>
    fetch(`/api/github/organizations/${org}/github_create_pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-uuid": header,
      },
      body: codePullBody(changes),
    });
  const desktopOwner = "desktop-fixture";
  const desktopOrg = organizationUuid(desktopOwner);
  const cloudClient = new CloudClient({
    baseUrl: origin,
    session: () => undefined,
    randomId: () => "desktop-fixture",
    fetch: async () => assert.fail("unexpected service request"),
  });
  const desktop = createDesktopCloudCode(
    {
      available: () => true,
      capture: () => ({
        identity: cloudClient,
        userId: user.id,
        current: () => true,
        connected: () => true,
        read: async (request) =>
          request.path === "/api/account"
            ? {
                status: 200,
                contentType: "application/json",
                body: Buffer.from(JSON.stringify({ uuid: account.id })),
              }
            : read(request),
        action: send,
        environment: () => assert.fail("unexpected environment request"),
        json: async () => assert.fail("unexpected service request"),
        onEvent: () => () => {},
      }),
    },
    desktopOwner,
    () => true,
  );
  return {
    calls,
    conversation,
    store,
    open,
    request,
    desktopRequest: () =>
      desktop.request({
        method: "POST",
        path: `/api/github/organizations/${desktopOrg}/github_create_pr`,
        codeOrganizationId: desktopOrg,
        contentType: "application/json",
        body: Buffer.from(codePullBody({})),
      }),
    foreignSession: `session_${cloudCodeSessionKey(foreign, account.id)}`,
    foreignOrganization: organizationUuid("someone-else"),
    organization,
    replaceActivation() {
      identity = {};
    },
    setGitHub(handler: typeof github) {
      github = handler;
    },
  };
}

test("original hosted Create PR creates ready and draft pull requests and binds the exact existing pull on repeat", async (t) => {
  const f = await fixture(t);
  const pulls = new Map<unknown, ReturnType<typeof githubPull>>();
  f.setGitHub(async (request) => {
    const base = request.base;
    assert.equal(request.url, repositoryUrl);
    assert.equal(request.head, branch);
    assert.equal(request.headRepository, repository);
    if (request.action === "pr.byHead")
      return { pull_request: pulls.get(base) ?? null };
    assert.equal(request.action, "pr.create");
    assert.equal(request.body, originalBody);
    const draft = base === "release";
    assert.equal(request.draft, draft);
    assert.equal(request.title, draft ? "" : "Fixture pull request");
    const pr = githubPull({
      base: String(base),
      draft,
      number: draft ? 22 : 21,
      title: draft ? "Subject of the head commit" : "Fixture pull request",
    });
    pulls.set(base, pr);
    return pr;
  });

  const ready = await f.request();
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    number: 21,
    html_url: `${repositoryUrl}/pull/21`,
    state: "open",
    draft: false,
    title: "Fixture pull request",
  });
  const draft = await f.request({
    base: "release",
    draft: true,
    title: undefined,
  });
  assert.equal(draft.status, 200);
  assert.deepEqual(await draft.json(), {
    number: 22,
    html_url: `${repositoryUrl}/pull/22`,
    state: "open",
    draft: true,
    title: "Subject of the head commit",
  });
  const repeated = await f.request({ base: "release", draft: false });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).draft, true);
  assert.equal(f.calls.filter((call) => call.action === "pr.create").length, 2);

  const reopened = await f.open("reopened");
  try {
    const persisted = reopened.conversation(f.conversation.id)?.pullRequests;
    assert.deepEqual(
      persisted?.map(({ number, state, baseRef, own, openedBySession }) => ({
        number,
        state,
        baseRef,
        own,
        openedBySession,
      })),
      [
        {
          number: 21,
          state: "open",
          baseRef: "main",
          own: true,
          openedBySession: true,
        },
        {
          number: 22,
          state: "draft",
          baseRef: "release",
          own: true,
          openedBySession: true,
        },
      ],
    );
  } finally {
    await reopened.close();
  }
});

test("hosted Create PR rejects another organization, session, repository, or head before invoking GitHub", async (t) => {
  const f = await fixture(t);
  for (const response of [
    await f.request({}, f.foreignOrganization),
    await f.request({}, f.organization, f.foreignOrganization),
    await f.request({ session_id: f.foreignSession }),
    await f.request({ repo: "someone-else/repo" }),
    await f.request({ head: "main" }),
    await f.request({ head: "someone-else:claude/feature" }),
  ]) {
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.type, "not_found_error");
  }
  assert.equal(f.calls.length, 0);
});

test("hosted fork calls use GitHub's verified upstream and retain the source fork", async (t) => {
  const f = await fixture(t);
  const other = "https://github.com/fixture/other";
  f.conversation.sessionRepositories?.push({
    url: other,
    outcome: { branch, kind: "create" },
  });
  f.setGitHub(async (request) => {
    if (request.action === "repository.forkBases") {
      assert.ok(request.url === repositoryUrl || request.url === other);
      return request.url === repositoryUrl
        ? ["upstream/repo"]
        : ["upstream/other"];
    }
    assert.equal(request.url, "https://github.com/upstream/repo");
    assert.equal(request.headRepository, repository);
    assert.equal(request.head, branch);
    if (request.action === "pr.byHead") return { pull_request: null };
    assert.equal(request.action, "pr.create");
    return githubPull({ target: "upstream/repo", draft: false });
  });
  const head = `fixture:${branch}`;
  assert.equal((await f.request({ repo: "foreign/repo", head })).status, 404);
  const created = await f.request({ repo: "upstream/repo", head });
  assert.equal(created.status, 200);
  assert.equal(f.calls.filter((call) => call.action === "pr.create").length, 1);
  assert.equal(f.conversation.pullRequests?.[0].repository, "upstream/repo");
  assert.equal(f.conversation.pullRequests?.[0].headRepository, repository);
});

test("the Desktop hosted Code view forwards the original action to its linked Runner organization", async (t) => {
  const f = await fixture(t);
  f.setGitHub(async ({ action }) =>
    action === "pr.byHead" ? { pull_request: null } : githubPull(),
  );
  const response = await f.desktopRequest();
  assert.equal(response?.status, 200);
  assert.equal(f.conversation.pullRequests?.[0].number, 21);
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["pr.byHead", "pr.create"],
  );
});

test("an unresolved GitHub write does not fabricate a binding or retry creation", async (t) => {
  const f = await fixture(t);
  let linked = false;
  let createAttempted = false;
  f.setGitHub(async ({ action }) => {
    if (action === "pr.create") {
      createAttempted = true;
      throw Error("relay disconnected");
    }
    if (linked) return { pull_request: githubPull() };
    if (createAttempted) throw Error("relay disconnected");
    return { pull_request: null };
  });
  const lost = await f.request();
  assert.equal(lost.status, 409);
  assert.match((await lost.json()).error.message, /could not confirm whether/);
  assert.equal(f.conversation.pullRequests, undefined);
  linked = true;
  assert.equal((await f.request()).status, 200);
  assert.equal(
    f.store.conversation(f.conversation.id)?.pullRequests?.[0].number,
    21,
  );
  assert.equal(
    f.store.conversation(f.conversation.id)?.pullRequests?.[0].openedBySession,
    undefined,
  );
  assert.equal(f.calls.filter((call) => call.action === "pr.create").length, 1);
});

test("concurrent requests from the same hosted session make one GitHub write", async (t) => {
  const f = await fixture(t);
  const started = deferred();
  const proceed = deferred();
  f.setGitHub(async ({ action }) => {
    if (action === "pr.byHead") {
      started.resolve();
      await proceed.promise;
      return { pull_request: null };
    }
    return githubPull();
  });
  const first = f.request();
  try {
    await started.promise;
    assert.equal((await f.request()).status, 409);
  } finally {
    proceed.resolve();
  }
  assert.equal((await first).status, 200);
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["pr.byHead", "pr.create"],
  );
});

test("GitHub's cross-fork permission refusal keeps the original 403 error envelope", async (t) => {
  const f = await fixture(t);
  f.setGitHub(async ({ action }) => {
    if (action === "repository.forkBases") return ["upstream/repo"];
    if (action === "pr.byHead") return { pull_request: null };
    throw new LinkRequestError({
      code: "CLAUDEX_GITHUB_REFUSED",
      message: "GitHub refused it: Resource not accessible",
      details: { status: "403" },
    });
  });
  const response = await f.request({
    repo: "upstream/repo",
    head: `fixture:${branch}`,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    type: "error",
    error: {
      type: "permission_error",
      message: "GitHub refused it: Resource not accessible",
      details: { error_code: "CLAUDEX_GITHUB_REFUSED" },
    },
  });
});

test("account activation changing during GitHub lookup prevents a write", async (t) => {
  const f = await fixture(t);
  f.setGitHub(async ({ action }) => {
    assert.equal(action, "pr.byHead");
    f.replaceActivation();
    return { pull_request: null };
  });
  assert.equal((await f.request()).status, 409);
  assert.equal(f.calls.length, 1);
});
