import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { openPolicy } from "../../shared/client-policy";
import { officialMelangeEditRequest } from "../../shared/official-melange";
import { officialUiCapabilitiesPath } from "../../shared/official-ui-web";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import type { CallFrame } from "../../runner/src/dispatcher";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { useElectronShim } from "./runner-core-support.test.ts";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");

const origin = "https://app.fixture.invalid";
const account = { id: "memory-owner" };
const organization = organizationUuid(account.id);
const base = `/api/organizations/${organization}/melange`;
const projectId = "d189871f-17d5-4d64-91d2-15193be34fb1";
const project = { id: projectId, kind: "chat", name: "Owned project", createdAt: 1 };
const projectPath = `/api/organizations/${organization}/projects/${projectId}`;
const user = {
  id: 7,
  accessToken: "token",
  tabId: "tab-00000001",
  webSession: { id: "owner-session", issuedAt: 1 },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const allowRead = deferred();
  const readStarted = deferred();
  const modelStarted = deferred();
  const modelClosed = deferred();
  const allowModel = deferred();
  let available = true;
  let firstRead = true;
  let revision = 1;
  let stored = { mode: "melange", files: [] as unknown[] };
  const content = "I prefer short meetings.";
  const note = "Updated. " + "你".repeat(30_000);
  const filePath = "preferences/meetings.md";
  const model = http.createServer(async (req, res) => {
    try {
      if (req.url === "/api/v1/claudex/memory/melange") {
        if (firstRead) {
          firstRead = false;
          readStarted.resolve();
          await allowRead.promise;
        }
        if (req.method === "PUT") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const value = JSON.parse(body);
          assert.equal(value.base_revision, revision);
          stored = value.state;
          revision++;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: 0, data: { revision, state: stored } }));
        return;
      }
      assert.equal(req.url, "/responses");
      modelStarted.resolve();
      res.once("close", modelClosed.resolve);
      await allowModel.promise;
      const answer = JSON.stringify({
        write: [{ path: filePath, content }],
        delete: [],
        rejected: null,
        text: note,
      });
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ content: [{ type: "output_text", text: answer }] }] } })}\n\n`,
      );
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  assert.ok(address && typeof address !== "string");
  const modelOrigin = `http://127.0.0.1:${address.port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "melange-web-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let activation = {};
  const ctx = {
    userId: user.id,
    activeAccount: account,
    closedFlag: false,
    signedOut: false,
    appVersion: "fixture",
    log() {},
    onEvent: () => () => {},
    onAccountDeactivating: () => () => {},
    officialSessionIdentity: () => activation,
    get accountActivationIdentity() {
      return activation;
    },
    setAccessToken() {},
    policy: () => openPolicy,
    services: {
      memory: {
        service: {
          status: () => ({ available, allowed: { generate: available } }),
          preferenceActions: () => ({ generate: available, searchChats: false }),
          synthesisModel: () => undefined,
          refresh: async () => {},
        },
      },
    },
    store: {
      root,
      projects: [project],
      isProjectDeleting: () => false,
      settings: {
        activeProviderId: "provider",
        providers: [{ id: "provider", model: "fixture" }],
      },
    },
    engine: {
      providerId: "provider",
      policy: () => ({}),
      gatewayEndpoint: () => ({ url: modelOrigin, token: "model-token" }),
    },
    remote: {
      claudex: true,
      accounts: { baseUrl: modelOrigin },
      backend: {},
      session: {
        authorized: (run: (token: string) => Promise<unknown>) =>
          run(user.accessToken),
      },
    },
    handlers: new Map<string, () => unknown>([
      ["snapshot", () => ({ projects: [project], conversations: [] })],
      ["listProjectKnowledge", () => ({ files: [] })],
      ["memoryStatus", () => ({
        available,
        allowed: { generate: available, searchChats: false },
        prefs: { generate: available, searchChats: false },
      })],
    ]),
  } as unknown as WebAppContext;
  const results = new Map<string, unknown>();
  const dispatcher = new Dispatcher({
    officialUiRoot: path.resolve("build/official-ui"),
    officialUiActions: true,
    runtime: {} as ConstructorParameters<typeof Dispatcher>[0]["runtime"],
    link: {
      send(frame) {
        if (frame.t === "result") results.set(frame.id, frame);
        return true;
      },
      request: async () => {
        throw Error("Unexpected relay request.");
      },
    },
    openUrl() {},
    publish() {},
    log() {},
  });
  dispatcher.contexts.set(user.id, ctx);
  t.after(() => {
    dispatcher.abortRelayedCalls();
    allowRead.resolve();
    allowModel.resolve();
    model.closeAllConnections();
    model.close();
  });
  let sequence = 0;
  const frame = (
    method: string,
    request: OfficialUiReadRequest,
    sender = user,
  ): CallFrame => ({
    t: "call",
    id: `fixture-${++sequence}`,
    user: sender,
    method,
    args: encodeWireValue([request]) as unknown[],
    deadlineMs: 30_000,
  });
  const run = (method: string, request: OfficialUiReadRequest, sender = user) =>
    dispatcher.run(
      frame(method, request, sender),
    ) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    run("officialUiRead", request);
  let pendingStart: Promise<void> | undefined;
  let stopSent = false;
  let startPath: string | undefined;
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: String(user.id),
    isCurrent: () => true,
    read,
    action: async (request, transfer) => {
      const call = frame("officialUiAction", request);
      if (
        officialMelangeEditRequest(request.method, request.path)?.kind !==
        "start"
      )
        return run("officialUiAction", request);
      const abort = () => dispatcher.cancel(call.id);
      transfer?.signal.addEventListener("abort", abort, { once: true });
      try {
        startPath = request.path;
        pendingStart = dispatcher.call(call);
        await pendingStart;
        transfer?.signal.throwIfAborted();
        const response = results.get(call.id);
        assert.ok(
          response &&
            typeof response === "object" &&
            "ok" in response &&
            response.ok &&
            "value" in response,
        );
        return decodeWireValue(response.value) as OfficialUiReadResponse;
      } finally {
        transfer?.signal.removeEventListener("abort", abort);
      }
    },
  });
  const fetchOfficial = createOfficialReadFetch(
    origin,
    read,
    async () => {
      throw Error("Unexpected external fetch.");
    },
    undefined,
    (request, transfer) => {
      if (
        officialMelangeEditRequest(request.method, request.path)?.kind !==
        "stop"
      )
        return action(request, transfer);
      stopSent = true;
      return run("officialUiAction", request);
    },
  );
  const request = (route: string, body: unknown, signal?: AbortSignal) =>
    fetchOfficial(base + "/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  return {
    dispatcher,
    allowRead,
    allowModel,
    readStarted,
    modelStarted,
    modelClosed,
    filePath,
    content,
    note,
    run,
    request,
    fetchOfficial,
    read,
    changeActivation: () => { activation = {}; },
    setMode: (mode: "classic" | "melange") => { stored = { ...stored, mode }; },
    disableMemory: () => { available = false; },
    saved: () => stored.files,
    responseCount: () => results.size,
    waitStart: () => pendingStart,
    stopSent: () => stopSent,
    streamPath: () => {
      assert.ok(startPath);
      return startPath;
    },
  };
}

test(
  "the official edit streams model activity and saves a file the original list and read can find",
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t);
    f.allowRead.resolve();
    const response = await f.request("edit", {
      instruction: "Remember my preference for short meetings.",
    });
    assert.equal(
      response.status,
      200,
      response.ok ? undefined : await response.text(),
    );
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    const decoder = new TextDecoder();
    let events = decoder.decode(first.value, { stream: true });
    assert.match(events, /event: content_block_start/);
    const poll = { method: "GET", path: f.streamPath() + "?cursor=0" } as const;
    assert.equal(
      (await f.run("officialUiRead", poll, { ...user, tabId: "tab-00000002" }))
        .status,
      404,
    );
    assert.equal(
      (
        await f.run("officialUiRead", poll, {
          ...user,
          webSession: { ...user.webSession, id: "other" },
        })
      ).status,
      404,
    );
    f.allowModel.resolve();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      events += decoder.decode(part.value, { stream: true });
    }
    events += decoder.decode();
    assert.ok(events.includes(f.note), events.slice(-1400));
    assert.match(events, /event: content_block_delta/);
    assert.match(events, /event: content_block_stop/);
    const resultEvent = /^event: melange_edit_result\ndata: (.+)$/m.exec(
      events,
    );
    assert.ok(resultEvent);
    assert.deepEqual(JSON.parse(resultEvent[1]).written, ["/" + f.filePath]);
    const listed = await (await f.request("list", {})).json();
    assert.deepEqual(
      listed.data.map((item: { path: string }) => item.path),
      ["/" + f.filePath],
    );
    const file = await (
      await f.request("read", { path: "/" + f.filePath })
    ).json();
    assert.equal(file.content, f.content);
  },
);

test(
  "abort during edit start reaches the pending relayed call and no model work starts",
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const pending = f.request(
      "edit",
      { instruction: "Do not save this." },
      controller.signal,
    );
    await f.readStarted.promise;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await f.waitStart();
    assert.ok(f.stopSent());
    assert.equal(f.responseCount(), 0);
    assert.deepEqual(f.saved(), []);
    assert.equal(
      (
        await f.run("officialUiRead", {
          method: "GET",
          path: f.streamPath() + "?cursor=0",
        })
      ).status,
      404,
    );
  },
);

test(
  "relay disconnect aborts a streaming edit before its plan can save",
  { timeout: 8_000 },
  async (t) => {
    const f = await fixture(t);
    f.allowRead.resolve();
    const response = await f.request("edit", {
      instruction: "Do not save after disconnect.",
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    await f.modelStarted.promise;
    assert.equal((await reader.read()).done, false);
    f.dispatcher.abortRelayedCalls();
    await f.modelClosed.promise;
    await assert.rejects(reader.read(), /Invalid memory edit response/);
    assert.deepEqual(f.saved(), []);
  },
);

test("project memory uses owned project settings and requires the current Web Chat lease", async (t) => {
  const f = await fixture(t);
  f.allowRead.resolve();
  const settings = projectPath + "/settings";
  const update = (payload: unknown, target = settings) => f.fetchOfficial(target, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const projectBefore = await f.fetchOfficial(projectPath);
  assert.equal(projectBefore.status, 200, projectBefore.ok ? undefined : await projectBefore.text());
  assert.equal((await projectBefore.json()).memory_general_enabled, false);
  assert.deepEqual(await (await f.fetchOfficial(settings)).json(), { memory_general_enabled: false });

  const wireUpdate = {
    method: "PUT",
    path: settings,
    contentType: "application/json",
    body: Buffer.from('{"memory_general_enabled":true}'),
  } as const;
  assert.equal((await f.run("officialUiAction", wireUpdate)).status, 409);
  const capabilities = await f.read({ method: "GET", path: officialUiCapabilitiesPath });
  const { activationLease } = JSON.parse(Buffer.from(capabilities.body).toString());
  f.changeActivation();
  assert.equal((await f.run("officialUiAction", { ...wireUpdate, capabilityLease: activationLease })).status, 409);
  assert.equal((await update({ memory_general_enabled: "true" })).status, 400);
  assert.equal((await update({ memory_general_enabled: true, name: "New name" })).status, 400);
  assert.equal((await update({ memory_general_enabled: true }, settings + "?mode=melange")).status, 501);
  assert.equal((await update({ memory_general_enabled: true }, settings.replace(projectId, organization))).status, 404);
  assert.equal((await f.fetchOfficial(settings.replace(organization, organizationUuid("other")))).status, 404);
  assert.deepEqual(await (await f.fetchOfficial(settings)).json(), { memory_general_enabled: false });

  assert.deepEqual(await (await update({ memory_general_enabled: true })).json(), { memory_general_enabled: true });
  assert.equal((await (await f.fetchOfficial(projectPath.replace("/projects/", "/projects_v2/"))).json()).memory_general_enabled, true);
  assert.deepEqual(await (await f.fetchOfficial(settings)).json(), { memory_general_enabled: true });
  assert.deepEqual(await (await update({ memory_general_enabled: false })).json(), { memory_general_enabled: false });
  assert.equal((await (await f.fetchOfficial(projectPath)).json()).memory_general_enabled, false);

  f.setMode("classic");
  assert.equal((await (await f.fetchOfficial(projectPath)).json()).memory_general_enabled, undefined);
  assert.deepEqual(await (await f.fetchOfficial(settings)).json(), {});
  assert.equal((await update({ memory_general_enabled: true })).status, 501);
});

test("sensitive memory browser requests preserve organization and negotiate writes", async (t) => {
  const f = await fixture(t);
  f.allowRead.resolve();
  const consentType = { consent_type: "memory.sensitive_info" };
  const optIn = "CONSENT_DECISION_OPT_IN";
  const optOut = "CONSENT_DECISION_OPT_OUT";
  const consentPath = "/v1/privacy-consents";
  const checkPath = consentPath + "/check";
  const orgPath = consentPath + "/org";
  const orgQuery = "?organization_uuid=" + organization + "&consent_type=memory.sensitive_info";
  const cleanupPath = base + "/sensitive_cleanup";
  const headers = { "x-organization-uuid": organization, "Content-Type": "application/json" };
  const check = (organizationHeader = organization) => f.fetchOfficial(checkPath, {
    method: "POST",
    headers: { ...headers, "x-organization-uuid": organizationHeader },
    body: JSON.stringify(consentType),
  });
  const write = (route: string, consent_decision: string, source: string, organization_uuid?: string) =>
    f.fetchOfficial(route, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...consentType, consent_decision, source, consent_lang_localization_code: "en-US", organization_uuid }),
    });

  const bootstrap = () => f.fetchOfficial(`/edge-api/bootstrap/${organization}/app_start`);
  const config = await bootstrap();
  assert.equal(config.status, 200, config.ok ? undefined : await config.text());
  assert.equal((await config.json()).org_growthbook.features["3868090370"].defaultValue, true);
  assert.deepEqual(await (await check()).json(), { consent_decision: null, disabled_by_org_admin: false });
  const foreign = organizationUuid("other");
  assert.equal((await check(foreign)).status, 404);
  assert.equal((await f.fetchOfficial(orgPath + orgQuery.replace(organization, foreign), { headers: { "x-organization-uuid": organization } })).status, 404);
  assert.equal((await write(orgPath, optOut, "sensitive_memory_org_admin_toggle", foreign)).status, 404);
  const withoutLease = await f.run("officialUiAction", {
    method: "PUT",
    path: consentPath,
    privacyOrganizationId: organization,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ ...consentType, consent_decision: optIn, source: "sensitive_memory_toggle", consent_lang_localization_code: "en-US" })),
  });
  assert.equal(withoutLease.status, 409);
  assert.deepEqual(await (await write(consentPath, optIn, "sensitive_memory_toggle")).json(), { consent_decision: optIn });
  assert.deepEqual(await (await check()).json(), { consent_decision: optIn, disabled_by_org_admin: false });

  const writeOrg = (decision: string) => write(orgPath, decision, "sensitive_memory_org_admin_toggle", organization);
  const readOrg = () => f.fetchOfficial(orgPath + orgQuery, { headers: { "x-organization-uuid": organization } });
  assert.deepEqual(await (await writeOrg(optOut)).json(), { consent: { consent_decision: optOut } });
  assert.deepEqual(await (await readOrg()).json(), { consent: { consent_decision: optOut } });
  assert.deepEqual(await (await check()).json(), { consent_decision: optIn, disabled_by_org_admin: true });
  assert.deepEqual(await (await writeOrg(optIn)).json(), { consent: { consent_decision: optIn } });

  assert.deepEqual(await (await f.fetchOfficial(cleanupPath)).json(), { state: "none", cleanup_id: null });
  const cleanup = await f.fetchOfficial(cleanupPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent_source: "sensitive_memory_couldnt_save_notice" }),
  });
  assert.equal(cleanup.status, 200, cleanup.ok ? undefined : await cleanup.text());
  const { state, cleanup_id, consent_recorded } = await cleanup.json();
  assert.equal(state, "done");
  assert.equal(typeof cleanup_id, "string");
  assert.equal(consent_recorded, true);
  assert.deepEqual(await (await f.fetchOfficial(cleanupPath)).json(), { state: "done", cleanup_id });
  assert.deepEqual(await (await check()).json(), { consent_decision: optOut, disabled_by_org_admin: false });

  f.disableMemory();
  assert.equal((await (await bootstrap()).json()).org_growthbook.features["3868090370"].defaultValue, false);
  assert.equal((await check()).status, 501);
});
