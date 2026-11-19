import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebAppContext } from "../../runner/src/web-app-context";
import type { Conversation, Mode } from "../../shared/types";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { webErrorCodes } from "../../shared/web-protocol";
import { encodeWireValue } from "../../shared/web-wire";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

test("Runner viewer presence accepts owned cloud Code and Cowork sessions without changing history", async (t) => {
  useElectronShim();
  const [
    { CloudStore },
    { Dispatcher },
    { cloudCodeSession, cloudCodeSessionKey },
    { organizationUuid },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/dispatcher"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
  ]);
  const root = mkdtempSync(join(tmpdir(), "official-viewers-"));
  const user = { id: 1, accessToken: "fixture" };
  const owner = "owner";
  const web = memoryWebstore();
  const store = await CloudStore.open({
    root,
    userId: user.id,
    transport: web,
  });
  t.after(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const code: Conversation = {
    id: "code",
    mode: "code",
    title: "Code",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    archived: true,
    unread: true,
    readStateRevision: 3,
    turns: [],
  };
  const cowork: Conversation = {
    ...code,
    id: "cowork",
    mode: "cowork",
    title: "Cowork",
    archived: false,
    environment: { kind: "space", spaceId: "cowork" },
  };
  const foreign: Conversation = {
    ...cowork,
    id: "foreign",
    sessionAuthors: {
      ownerAccountUuid: "other",
      viewerAccountUuid: owner,
    },
  };
  store.conversations.push(code, cowork, foreign);
  await store.sync();
  const history = structuredClone(store.conversations);
  const callsBefore = web.log.length;
  const activation = {};
  const context = {
    userId: user.id,
    activeAccount: { id: owner },
    store,
    accountRetiring: false,
    officialSessionIdentity: () => activation,
    setAccessToken() {},
    push: () => assert.fail("Viewer presence published an app event"),
  };
  const modes: Mode[] = ["code", "cowork"];
  let now = 1_000;
  const dispatcher = new Dispatcher({
    officialUiRoot: "/fixture",
    officialUiActions: true,
    guard: { modes },
    now: () => now,
    runtime: {
      serviceUrl: "https://fixture.invalid",
      stateDir: root,
      providerServiceScript: "unused",
      version: "test",
      codexBinary: () => "unused",
    },
    link: {
      send: () => assert.fail("Unexpected link send"),
      request: async () =>
        assert.fail("Viewer presence called an external service"),
    },
    publish: () => assert.fail("Viewer presence published a runner event"),
    openUrl() {},
    log() {},
  });
  dispatcher.contexts.set(user.id, context as unknown as WebAppContext);
  assert.ok(dispatcher.methods.includes("officialUiAction"));
  const presencePath = (sessionId: string) =>
    `/v1/code/sessions/${sessionId.replace(/^session_/, "cse_")}/client/presence`;
  const codePath = presencePath(cloudCodeSession(code, owner).id);
  const coworkPath = presencePath(cloudCodeSession(cowork, owner).id);
  const validBody = { client_id: "c3456ae6-2417-4f26-98e0-12af6d4c4e95" };
  const jsonBody = (body: unknown) => Buffer.from(JSON.stringify(body));
  const call = (
    patch: Partial<OfficialUiReadRequest> = {},
    method = "officialUiAction",
  ) =>
    dispatcher.run({
      t: "call",
      id: "fixture",
      deadlineMs: 1000,
      method,
      user,
      args: [
        encodeWireValue({
          method: "POST",
          path: codePath,
          contentType: "application/json",
          body: jsonBody(validBody),
          codeOrganizationId: organizationUuid(owner),
          ...patch,
        } satisfies OfficialUiReadRequest),
      ],
    }) as Promise<OfficialUiReadResponse>;

  const expectPresence = async (
    request: Partial<OfficialUiReadRequest> = {},
  ) => {
    const result = await call(request);
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "application/json");
    assert.deepEqual(JSON.parse(Buffer.from(result.body).toString()), {
      refresh_after_seconds: 20,
    });
  };
  await expectPresence();
  now += 20_000;
  await expectPresence();
  await expectPresence({ path: coworkPath });
  await expectPresence({
    path: coworkPath,
    body: jsonBody({ ...validBody, clear: true }),
  });
  await expectPresence({
    path: coworkPath,
    body: jsonBody({ ...validBody, clear: true }),
  });

  assert.equal(
    (await call({ codeOrganizationId: organizationUuid("other") })).status,
    404,
  );
  assert.equal((await call({ codeOrganizationId: undefined })).status, 404);
  assert.equal(
    (await call({ path: presencePath("cse_" + "0".repeat(32)) })).status,
    404,
  );
  assert.equal(
    (
      await call({
        path: presencePath("cse_" + cloudCodeSessionKey(foreign, owner)),
      })
    ).status,
    404,
  );
  for (const body of [
    {},
    { client_id: "not-a-uuid" },
    { ...validBody, clear: false },
    { ...validBody, unread: false },
  ]) {
    assert.equal((await call({ body: jsonBody(body) })).status, 400);
  }
  assert.equal((await call({ body: Buffer.from("{") })).status, 400);
  assert.equal(
    (
      await call({
        body: Buffer.concat([jsonBody(validBody), Buffer.alloc(4096, " ")]),
      })
    ).status,
    400,
  );
  assert.equal((await call({ contentType: "text/plain" })).status, 400);

  for (const patch of [
    { method: "GET" } as const,
    { path: codePath + "?clear=true" },
  ]) {
    await assert.rejects(call(patch), { code: webErrorCodes.badRequest });
  }
  await assert.rejects(call({}, "officialUiRead"), {
    code: webErrorCodes.badRequest,
  });

  modes.splice(0, 1);
  await expectPresence({ path: coworkPath });
  assert.equal((await call()).status, 404);
  context.accountRetiring = true;
  assert.equal((await call({ path: coworkPath })).status, 409);

  await store.settled();
  assert.equal(web.log.length, callsBefore);
  assert.deepEqual(store.conversations, history);
});
