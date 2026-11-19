import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdapterContext } from "../../electron/official-ui/api/context";
import { CloudClient } from "../../electron/cloud/cloud-client";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import { openPolicy } from "../../shared/client-policy";
import {
  officialCodeSessionPresetKey,
  officialCodeUserSettingsMaxBytes,
  officialCodeUserSettingsPath,
} from "../../shared/official-code-user-settings";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { parseRpcRequest, webPaths } from "../../shared/web-protocol";
import { encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

const groupKey = "ccd/dframe-store";
const starredKey = "ccd/dframe-starred-code";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const row = (state: unknown) =>
  JSON.stringify({ state, version: 3, updatedAt: 1 });
const preset = (kind: string, name = "Deploy") => ({
  id: "preset-1",
  name,
  createdAt: 1,
  lastUsedAt: 2,
  target: {
    kind,
    worker: { type: "environment", id: "env_1" },
    repos: [{ key: "org/app", branch: "main" }],
  },
  settings: { modelId: "claude", effort: "high" },
});
const catalog = (kind: string, name?: string) =>
  row({
    presets: [preset(kind, name)],
    builtIns: {},
    placeDefaults: { "cloud:environment:env_1": { effort: "high" } },
  });

test("hosted Code presets and groups share an account revision across Web and Desktop", async (t) => {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { createDesktopCloudCode },
    { createApiAdapter },
    { organizationUuid },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/desktop-cloud-code"),
    import("../../electron/official-ui/api/index"),
    import("../../electron/official-ui/api/context"),
  ]);
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-code-user-settings-"),
  );
  const webstore = memoryWebstore();
  const started = deferred();
  const release = deferred();
  let pause = false;
  const transport = {
    async request(op: string, userId: number, body?: unknown) {
      if (pause && op === "store.settings.put") {
        pause = false;
        started.resolve();
        await release.promise;
      }
      return webstore.request(op, userId, body);
    },
  };
  const open = (name: string, userId: number) =>
    CloudStore.open({ root: path.join(root, name), userId, transport });
  const owner = "7aa2ef0e-c698-44b4-a9f9-4544443fdc8a";
  let identity = {};
  const ctx = {
    userId: 1,
    activeAccount: { id: owner },
    store: await open("first", 1),
    officialSessionIdentity: () => identity,
    accountRetiring: false,
    policy: () => openPolicy,
    setAccessToken() {},
    log() {},
  };
  t.after(async () => {
    release.resolve();
    await ctx.store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  ctx.store.settings.instructions = "Existing instructions";
  const dispatcher = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
    },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
  } as unknown as Dispatcher;
  const call = (method: string) => (request: OfficialUiReadRequest) =>
    officialUiRead(dispatcher, {
      method,
      user: { id: ctx.userId, accessToken: "fixture" },
      args: encodeWireValue([request]),
    } as CallFrame);
  const read = call("officialUiRead");
  const action = call("officialUiAction");
  const web = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => assert.fail("Code user settings escaped the local bridge"),
    undefined,
    negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: "1",
      isCurrent: () => true,
      read,
      action,
    }),
  );
  const route = officialCodeUserSettingsPath(organizationUuid(owner));
  const put = (entries: unknown, ifMatch?: string): RequestInit => ({
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
    },
    body: JSON.stringify({ entries }),
  });
  const writes = () =>
    webstore.log.filter((event) => event.op === "store.settings.put").length;
  const initial = await (await web(route)).json();
  assert.equal(initial.userId, owner);
  assert.equal(typeof initial.checksum, "string");
  assert.deepEqual(initial.content, { entries: {} });
  assert.equal(
    (await web(route, put({}, `sha256:${"0".repeat(64)}`))).status,
    412,
  );
  assert.equal((await web(route, put({}, initial.checksum))).status, 200);
  const unchanged = await web(route, {
    headers: { "If-None-Match": initial.checksum },
  });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.equal(
    (
      await web(
        officialCodeUserSettingsPath(organizationUuid("different")),
        put({}),
      )
    ).status,
    404,
  );
  assert.equal((await web(route + "?extra=1", put({}))).status, 501);
  assert.equal((await web(route, { method: "POST" })).status, 501);
  const acceptedPreset = catalog("cloud");
  for (const entries of [
    {
      [officialCodeSessionPresetKey]: acceptedPreset,
      "ccd/unrelated": row({}),
    },
    { [officialCodeSessionPresetKey]: catalog("local") },
    {
      [officialCodeSessionPresetKey]: row({
        presets: Array(201).fill(preset("cloud")),
        builtIns: {},
        placeDefaults: {},
      }),
    },
    { [groupKey]: "not JSON" },
  ])
    assert.equal((await web(route, put(entries))).status, 400);
  assert.equal(
    (
      await web(
        route,
        put({ [groupKey]: "x".repeat(officialCodeUserSettingsMaxBytes) }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await action({
        method: "PUT",
        path: route,
        contentType: "application/json",
        body: Buffer.from('{"entries":{}}'),
      })
    ).status,
    409,
  );
  assert.equal(writes(), 0);

  pause = true;
  const saving = web(
    route,
    put({ [officialCodeSessionPresetKey]: acceptedPreset }, initial.checksum),
  );
  await started.promise;
  const competing = web(
    route,
    put(
      { [officialCodeSessionPresetKey]: catalog("cloud", "Backup") },
      initial.checksum,
    ),
  );
  assert.deepEqual(await (await web(route)).json(), initial);
  release.resolve();
  const saved = await saving;
  assert.equal(saved.status, 200);
  const savedRow = await saved.json();
  assert.notEqual(savedRow.checksum, initial.checksum);
  assert.deepEqual(savedRow.content.entries, {
    [officialCodeSessionPresetKey]: acceptedPreset,
  });
  const stale = await competing;
  assert.equal(stale.status, 412);
  assert.deepEqual(await stale.json(), savedRow);
  assert.equal(writes(), 1);

  const desktopOwner = "8eb0a04a-9f1d-4da9-a01d-93748832f69a";
  let desktopConnected = true;
  const desktopSession = {
    currentToken: async () => "desktop-token",
    renewed: async () => assert.fail("Unexpected session expiration"),
  };
  const cloudClient = new CloudClient({
    baseUrl: "https://fixture.invalid",
    randomId: () => "fixture-desktop",
    session: () => (desktopConnected ? desktopSession : undefined),
    async fetch(input, init) {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer desktop-token",
      );
      const url = new URL(String(input));
      assert.ok(
        url.pathname.startsWith(webPaths.rpc),
        `Unexpected service request ${url.pathname}`,
      );
      const method = url.pathname.slice(webPaths.rpc.length);
      const { args } = parseRpcRequest(JSON.parse(String(init?.body)));
      const request = args[0] as OfficialUiReadRequest;
      const answer =
        request.path === "/api/account"
          ? {
              status: 200,
              contentType: "application/json",
              body: Buffer.from(JSON.stringify({ uuid: owner })),
            }
          : await call(method)(request);
      return Response.json({ ok: true, value: encodeWireValue(answer) });
    },
  });
  const cloudCall = (method: string) => (request: OfficialUiReadRequest) =>
    cloudClient.call(method, [request]) as Promise<OfficialUiReadResponse>;
  const desktopCloud = createDesktopCloudCode(
    {
      available: () => desktopConnected,
      capture: () => ({
        identity: cloudClient,
        userId: 1,
        current: () => desktopConnected,
        connected: () => true,
        read: cloudCall("officialUiRead"),
        action: cloudCall("officialUiAction"),
        environment: () => assert.fail("Unexpected environment request"),
        json: async () => assert.fail("Unexpected service request"),
        onEvent: () => () => {},
      }),
    },
    desktopOwner,
    () => true,
  );
  const adapter = createApiAdapter(
    {
      account: () => ({
        id: desktopOwner,
        name: "Fixture",
        email: "fixture@example.invalid",
        createdAt: 0,
      }),
      root,
      officialDesktopCloudCode: desktopCloud,
      settings: () => ctx.store.settings,
      listConversations: async () => [],
      loadConversation: async () => undefined,
      onEvent: () => () => {},
      modelCatalog: async () => assert.fail("Unexpected model catalog request"),
      snapshot: async () => assert.fail("Unexpected snapshot request"),
      call: async () => assert.fail("Unexpected adapter call"),
      appVersion: "fixture",
      log() {},
    } satisfies AdapterContext,
    { scoped: false },
  );
  const server = http.createServer((request, response) => {
    void adapter(request, response)
      .then((handled) => {
        if (!handled) response.writeHead(404).end();
      })
      .catch(() => response.writeHead(500).end());
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const desktopRoute = `http://127.0.0.1:${address.port}${officialCodeUserSettingsPath(organizationUuid(desktopOwner))}`;
  assert.equal(
    (
      await fetch(desktopRoute, {
        headers: { "If-None-Match": savedRow.checksum },
      })
    ).status,
    304,
  );
  assert.equal(
    (await fetch(desktopRoute, put({}, initial.checksum))).status,
    412,
  );
  const assignments = Object.fromEntries(
    Array.from({ length: 6_000 }, (_, index) => [
      `code:session_${index.toString(16).padStart(32, "0")}`,
      "g1",
    ]),
  );
  const groups = row({
    customGroups: [{ id: "g1", name: "Release" }],
    customGroupAssignments: assignments,
    sidebarSections: [],
  });
  const stars = row({ starredIds: ["session_1"] });
  assert.ok(Buffer.byteLength(groups) > 256 * 1024);
  const grouped = await fetch(
    desktopRoute,
    put({ [groupKey]: groups, [starredKey]: stars }, savedRow.checksum),
  );
  assert.equal(grouped.status, 200, await grouped.clone().text());
  const updated = await grouped.json();
  assert.equal(updated.userId, desktopOwner);
  assert.deepEqual(updated.content.entries, {
    [officialCodeSessionPresetKey]: acceptedPreset,
    [groupKey]: groups,
    [starredKey]: stars,
  });
  assert.equal(writes(), 2);

  await ctx.store.close();
  ctx.store = await open("reopened", 1);
  identity = {};
  assert.deepEqual(await (await web(route)).json(), {
    ...updated,
    userId: owner,
  });
  assert.equal(ctx.store.settings.instructions, "Existing instructions");
  desktopConnected = false;
  assert.equal((await fetch(desktopRoute)).status, 404);

  await ctx.store.close();
  ctx.activeAccount.id = "fa02b5cb-1f59-4fd9-8bdb-c7029ab61e50";
  ctx.userId = 2;
  ctx.store = await open("other", 2);
  identity = {};
  assert.equal((await web(route)).status, 404);
  const other = await (
    await web(
      officialCodeUserSettingsPath(organizationUuid(ctx.activeAccount.id)),
    )
  ).json();
  assert.deepEqual(other.content, { entries: {} });
});
