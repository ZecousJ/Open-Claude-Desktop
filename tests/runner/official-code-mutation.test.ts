import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppEvent, Conversation } from "../../shared/types";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import type { StoreTransport } from "../../runner/src/cloud-store";
import { webHost } from "../../shared/host";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

async function fixture(t: TestContext) {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { cloudCodeSessionKey },
    { organizationUuid },
    { readCodeQueue, writeCodeQueue },
    { CodeAutoArchive },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
    import("../../runner/src/official-code-queue"),
    import("../../runner/src/code-auto-archive"),
  ]);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-code-mutation-"),
  );
  const web = memoryWebstore();
  const user = { id: 1, accessToken: "fixture-token" };
  let intercept:
    | ((op: string, commit: () => Promise<unknown>) => Promise<unknown>)
    | undefined;
  let github: ((input: unknown) => Promise<unknown>) | undefined;
  const transport: StoreTransport = {
    request(op, id, body) {
      if (op === "github.api" && github) {
        assert.equal(id, user.id);
        return github(body);
      }
      const commit = () => web.request(op, id, body);
      return intercept ? intercept(op, commit) : commit();
    },
  };
  const open = (profile: string) =>
    CloudStore.open({
      root: path.join(root, profile),
      userId: user.id,
      log() {},
      transport,
    });
  const store = await open("profile");
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const account = { id: "fixture-owner" };
  const org = organizationUuid(account.id);
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
    keepAwake: true,
    environment: { kind: "space", spaceId: "s-fixture" },
    turns: [
      {
        id: "completed",
        prompt: "Fixture",
        status: "completed",
        createdAt: 2,
        attachments: [],
        items: [],
      },
    ],
  };
  const foreign: Conversation = {
    ...structuredClone(conversation),
    id: "foreign",
    sessionAuthors: {
      ownerAccountUuid: "other",
      viewerAccountUuid: account.id,
    },
  };
  const cowork: Conversation = {
    ...structuredClone(conversation),
    id: "cowork",
    mode: "cowork",
  };
  store.conversations.push(conversation, foreign, cowork);
  await store.sync();
  const key = cloudCodeSessionKey(conversation, account.id);
  const route = `/v1/code/sessions/session_${key}`;
  let identity = {};
  let due: number | undefined;
  const events: AppEvent[] = [];
  const ctx = {
    userId: user.id,
    activeAccount: account,
    store,
    runtime: {
      host: {
        ...webHost,
        capabilities: { ...webHost.capabilities, cloudCode: true },
      },
      transport,
      wakeCodeArchive(id: number, at?: number) {
        assert.equal(id, user.id);
        due = at;
      },
    },
    onSettingsChanged() {},
    onEvent() {},
    selectedAttachments: new Map(),
    replyFeedback: { deleteConversation() {} },
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    push(event: AppEvent) {
      events.push(event);
    },
    log() {},
  };
  const dispatcher = {
    options: { officialUiRoot: "/fixture", officialUiActions: true },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
  } as unknown as Dispatcher;
  const autoArchive = new CodeAutoArchive(dispatcher.context(user.id)!);
  const call = (method: string, request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method,
      user,
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const action = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  const origin = "https://claudex.test";
  const fetch = createOfficialReadFetch(
    origin,
    read,
    async () => {
      throw Error("Unexpected upstream fetch");
    },
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: String(user.id),
      isCurrent: () => true,
      read,
      action,
    }),
  );
  const request = (
    method: string,
    url: string,
    body: unknown = {},
    organization = org,
  ) =>
    fetch(url, {
      method,
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "x-organization-uuid": organization,
      },
    });
  const reopen = async () => {
    const saved = await open("reopened");
    try {
      return saved.conversations;
    } finally {
      await saved.close();
    }
  };
  return {
    conversation,
    store,
    web,
    route,
    key,
    org,
    events,
    request,
    read,
    action,
    reopen,
    autoArchive,
    due: () => due,
    github(service: NonNullable<typeof github>) {
      github = service;
    },
    foreignRoute: `/v1/code/sessions/session_${cloudCodeSessionKey(foreign, account.id)}`,
    coworkRoute: `/v1/code/sessions/session_${cloudCodeSessionKey(cowork, account.id)}`,
    queued() {
      return readCodeQueue(store.root, account.id, conversation);
    },
    addQueuedInput(state: "queued" | "held" = "queued") {
      writeCodeQueue(store.root, account.id, conversation, [
        {
          eventId: "8371c65c-0cb5-4333-8a18-c012743b27b6",
          hash: "a".repeat(64),
          text: "A pending follow-up",
          priority: "later",
          state,
          createdAt: 3,
          attachments: [],
          after: { id: "completed", createdAt: 2 },
        },
      ]);
    },
    clearQueuedInput() {
      writeCodeQueue(store.root, account.id, conversation, []);
    },
    intercept(value: typeof intercept) {
      intercept = value;
    },
    retire() {
      identity = {};
    },
  };
}

test("an owned Cloud Code session archives after merge, preserves input, and stays restored", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: 8_000 });
  const url = "https://github.com/team/repo";
  const head = "claude/manual-pr";
  f.conversation.sessionRepositories = [
    {
      url: url + ".git",
      ref: "main",
      outcome: { kind: "create", branch: head },
    },
  ];
  f.store.settings.prAutoArchive = true;
  const turn = f.conversation.turns[0];
  turn.status = "inProgress";
  let merged = false;
  const expectedRequests = [
    { url: url + ".git", action: "pr.byHead", head },
    { url: url + ".git", action: "pr.get", number: 12 },
  ];
  const requests: unknown[] = [];
  f.github(async (input) => {
    requests.push(input);
    if (
      input &&
      typeof input === "object" &&
      "action" in input &&
      input.action === "pr.byHead"
    )
      return { number: 12 };
    return {
      number: 12,
      html_url: url + "/pull/12",
      head_ref: head,
      state: "closed",
      merged,
    };
  });

  f.autoArchive.start();
  assert.equal(f.due(), Date.now());
  await f.autoArchive.check();
  assert.deepEqual(requests, expectedRequests);
  assert.equal(f.conversation.pullRequests?.[0]?.state, "closed");
  assert.equal(f.conversation.archived, false);

  const checkNext = async () => {
    const due = f.due();
    assert.notEqual(due, undefined);
    t.mock.timers.setTime(due!);
    await f.autoArchive.check();
  };
  merged = true;
  await checkNext();
  assert.equal(f.conversation.pullRequests?.[0]?.state, "merged");
  assert.equal(f.conversation.archived, false);
  turn.status = "completed";
  f.addQueuedInput("held");
  await checkNext();
  assert.equal(f.conversation.archived, false);
  assert.equal(f.queued()[0]?.text, "A pending follow-up");
  await f.store.sync();
  assert.equal(
    (await f.reopen()).find((c) => c.id === f.conversation.id)
      ?.pullRequests?.[0]?.state,
    "merged",
  );

  f.clearQueuedInput();
  await checkNext();
  assert.equal(f.due(), undefined);
  assert.equal(f.conversation.archived, true);
  assert.equal(f.conversation.keepAwake, undefined);
  assert.equal(f.conversation.turns[0]?.prompt, "Fixture");
  assert.equal(
    f.events.some(
      (event) => event.type === "conversation" && event.conversation.archived,
    ),
    true,
  );
  assert.equal(
    (await f.reopen()).find((c) => c.id === f.conversation.id)?.archived,
    true,
  );

  assert.equal((await f.request("POST", f.route + "/unarchive")).status, 200);
  const restored = (await f.reopen()).find((c) => c.id === f.conversation.id);
  assert.equal(restored?.archived, false);
  assert.equal(restored?.codeAutoArchiveExempt, true);
  const reads = requests.length;
  await f.autoArchive.check();
  assert.equal(requests.length, reads);
  assert.equal(f.conversation.archived, false);
});

test("a GitHub answer cannot archive after Cloud Code account retirement", async (t) => {
  const f = await fixture(t);
  const url = "https://github.com/team/repo/pull/8";
  f.conversation.pullRequests = [
    { number: 8, repository: "team/repo", url, state: "open", checkedAt: 1 },
  ];
  f.store.settings.prAutoArchive = true;
  let start!: () => void;
  let reply!: (data: unknown) => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const answer = new Promise<unknown>((resolve) => {
    reply = resolve;
  });
  f.github(async () => {
    start();
    return answer;
  });
  f.autoArchive.start();
  const check = f.autoArchive.check();
  await started;
  f.retire();
  reply({ number: 8, html_url: url, state: "closed", merged: true });
  await check;
  assert.equal(f.conversation.archived, false);
  assert.equal(f.conversation.pullRequests[0].state, "open");
});

test("a merged PR cannot archive Cloud Code while another output branch has a draft PR", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: 8_000 });
  f.store.settings.prAutoArchive = true;
  const primary = "https://github.com/team/main-repo";
  const secondary = "https://github.com/team/extra-repo";
  const branch = "claude/multi";
  f.conversation.sessionRepositories = [primary, secondary].map((url) => ({
    url,
    ref: "main",
    outcome: { kind: "create", branch },
  }));
  let draft = true;
  f.github(async (input) => {
    assert.ok(
      input && typeof input === "object" && "url" in input && "action" in input,
    );
    const source = input.url;
    assert.ok(source === primary || source === secondary);
    if (input.action === "pr.byHead") {
      assert.ok("head" in input && input.head === branch);
      return { number: 5 };
    }
    assert.equal(input.action, "pr.get");
    return {
      number: 5,
      html_url: source + "/pull/5",
      head_ref: branch,
      state: source === secondary && draft ? "open" : "closed",
      merged: source === primary,
      draft: source === secondary && draft,
    };
  });
  f.autoArchive.start();
  await f.autoArchive.check();
  assert.deepEqual(
    f.conversation.pullRequests?.map((pr) => pr.state),
    ["merged", "draft"],
  );
  assert.equal(f.conversation.archived, false);
  draft = false;
  t.mock.timers.setTime(f.due()!);
  await f.autoArchive.check();
  assert.equal(f.conversation.archived, true);
});

test("original Cloud Code writes update account-scoped history through the official Web fetch and Runner", async (t) => {
  const f = await fixture(t);
  const start = f.web.log.length;
  for (const route of [f.foreignRoute, f.coworkRoute])
    assert.equal(
      (await f.request("PUT", route, { title: "Other" })).status,
      404,
    );
  assert.equal(
    (await f.request("POST", f.route + "/archive", {}, "other")).status,
    404,
  );
  assert.equal(
    (await f.request("POST", f.route + "/archive?ignored=true")).status,
    501,
  );
  assert.equal(
    (await f.request("PUT", f.route, { add_tags: ["other"] })).status,
    400,
  );
  assert.equal(
    (await f.request("POST", f.route + "/archive", { force: true })).status,
    400,
  );
  assert.equal((await f.request("PUT", f.route, "x".repeat(4096))).status, 413);
  assert.deepEqual(f.web.log.slice(start), []);
  assert.equal(f.events.length, 0);

  const capability = await f.read({
    method: "GET",
    path: "/api/claudex/official-capabilities/version1",
  });
  f.retire();
  assert.equal(
    (
      await f.action({
        method: "DELETE",
        path: f.route,
        codeOrganizationId: f.org,
        contentType: "application/json",
        body: Buffer.from("{}"),
        capabilityLease: JSON.parse(Buffer.from(capability.body).toString())
          .activationLease,
      })
    ).status,
    409,
  );

  const session = async (response: Response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).session;
  };
  const renamed = await session(
    await f.request("PUT", f.route, { title: "A durable title" }),
  );
  assert.equal(renamed.title, "A durable title");
  assert.equal(renamed.id, `session_${f.key}`);
  const control = {
    type: "control_request",
    request_id: "rename-session-1-fixture",
    request: { subtype: "rename_session", title: "A durable title" },
  };
  const beforeControl = f.web.log.length;
  assert.equal(
    (
      await f.request("POST", f.route + "/events", {
        events: [{ payload: control }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("POST", f.route.replace("/code", "") + "/events", {
        events: [control],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("POST", f.route + "/events", {
        events: [
          {
            payload: {
              ...control,
              request: { ...control.request, title: "Stale" },
            },
          },
        ],
      })
    ).status,
    409,
  );
  assert.equal(f.web.log.length, beforeControl);
  const pinned = await session(
    await f.request("PUT", f.route.replace("session_", "cse_"), {
      add_tags: ["ui:pinned"],
    }),
  );
  assert.deepEqual(pinned.tags, ["ui:pinned"]);
  assert.equal(
    (await session(await f.request("POST", f.route + "/archive"))).status,
    "archived",
  );
  assert.equal(
    (await session(await f.request("POST", f.route + "/archive"))).status,
    "archived",
  );
  const saved = (await f.reopen()).find((row) => row.id === f.conversation.id);
  assert.equal(saved?.title, "A durable title");
  assert.equal(saved?.titleSetByUser, true);
  assert.equal(saved?.pinned, true);
  assert.equal(saved?.archived, true);
  assert.equal(saved?.keepAwake, undefined);
  assert.deepEqual(saved?.turns, f.conversation.turns);
  f.addQueuedInput();
  assert.equal(
    (await session(await f.request("POST", f.route + "/unarchive"))).status,
    "active",
  );
  assert.equal(f.queued()[0]?.state, "held");
  assert.deepEqual(
    (
      await session(
        await f.request("PUT", f.route, { remove_tags: ["ui:pinned"] }),
      )
    ).tags,
    [],
  );
  assert.equal((await f.request("DELETE", f.route)).status, 200);
  assert.deepEqual(f.queued(), []);
  assert.equal((await f.request("DELETE", f.route)).status, 404);
  assert.equal(f.web.users.get(1)?.turns.has(f.conversation.id), false);
  assert.deepEqual(
    (await f.reopen()).map((row) => row.id),
    ["foreign", "cowork"],
  );
  assert.equal(f.events.at(-1)?.type, "resync");
});

test("Cloud Code lifecycle waits for acknowledgement, blocks sends, and leaves a failed save unconfirmed", async (t) => {
  const f = await fixture(t);
  const turn = f.conversation.turns[0];
  turn.status = "inProgress";
  assert.equal((await f.request("POST", f.route + "/archive")).status, 409);
  assert.equal((await f.request("DELETE", f.route)).status, 409);
  turn.status = "completed";

  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.intercept(async (op, commit) => {
    if (op === "store.conversations.put") {
      enter();
      await released;
    }
    return commit();
  });
  const archiving = f.request("POST", f.route + "/archive");
  try {
    await Promise.race([
      entered,
      archiving.then(() => assert.fail("Archive did not reach webstore")),
    ]);
    assert.equal(
      (
        await f.request("POST", f.route + "/events", {
          events: [
            {
              payload: {
                type: "user",
                uuid: "ac794cb1-2c34-4bf5-aa6f-eb38970cd0c0",
                message: { role: "user", content: "Wait for archive" },
              },
            },
          ],
        })
      ).status,
      409,
    );
    assert.deepEqual(f.queued(), []);
    assert.equal(f.conversation.archived, false);
    assert.equal(f.events.length, 0);
    assert.equal((await f.request("DELETE", f.route)).status, 409);
  } finally {
    release();
  }
  assert.equal((await archiving).status, 200);
  assert.equal(f.conversation.archived, true);

  f.intercept(undefined);
  f.web.failNext("store.conversations.put");
  const eventCount = f.events.length;
  assert.equal((await f.request("POST", f.route + "/unarchive")).status, 409);
  assert.equal(f.conversation.archived, true);
  assert.equal(f.events.length, eventCount);
  await f.store.sync();
  assert.equal(
    (await f.reopen()).find((row) => row.id === f.conversation.id)?.archived,
    true,
  );
});

test("a lost Cloud Code deletion acknowledgement confirms the service row is gone", async (t) => {
  const f = await fixture(t);
  f.intercept(async (op, commit) => {
    const answer = await commit();
    if (op === "store.conversations.delete")
      throw Error("Connection lost after commit");
    return answer;
  });
  assert.equal((await f.request("DELETE", f.route)).status, 200);
  assert.ok(f.events.some((event) => event.type === "resync"));
  assert.equal(f.store.conversations.includes(f.conversation), false);
  await f.store.sync();
  assert.equal(
    (await f.reopen()).some((row) => row.id === f.conversation.id),
    false,
  );
});

test("a lost Cloud Code metadata acknowledgement confirms the renamed and pinned row together", async (t) => {
  const f = await fixture(t);
  f.intercept(async (op, commit) => {
    const answer = await commit();
    if (op === "store.conversations.put")
      throw Error("Connection lost after commit");
    return answer;
  });
  const response = await f.request("PUT", f.route, {
    title: "Renamed",
    add_tags: ["ui:pinned"],
  });
  assert.equal(response.status, 200);
  const saved = (await f.reopen()).find((row) => row.id === f.conversation.id);
  assert.equal(saved?.title, "Renamed");
  assert.equal(saved?.pinned, true);
});
