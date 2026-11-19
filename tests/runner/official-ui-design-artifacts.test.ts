import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { Store } from "../../electron/store/store";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { blankArtifactInitialContent } from "../../shared/blank-artifacts";
import {
  officialDesignArtifactRoute,
  officialDesignWorkspaceDestination,
} from "../../shared/official-design-artifacts";
import {
  isOfficialUiAction,
  isOfficialUiQuery,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { encodeWireValue } from "../../shared/web-wire";
import {
  negotiatedOfficialAction,
  readOfficialCapabilities,
} from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { useElectronShim } from "./runner-core-support.test";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");

const userId = 123;
const owner = String(userId);
const organization = organizationUuid(owner);
const design = "bcd2878f-a88d-4094-a616-8e39d8a5fd8a";
const otherType = "8d95edfc-0ec2-4d54-8950-75ed2380c648";
const requestId = "11111111-1111-4111-8111-111111111111";
const types = `/api/frame/types?org=${organization}`;
const create = `/api/frame/types/${design}/create?org=${organization}`;
const gallery = `/api/frame/frames?thumb=1&limit=60&org=${organization}`;
const payload = {
  title: "画板",
  target_type_version: null,
  entrypoint: "gallery",
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "official-design-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.settings.providers[0].model = "model";
  store.settings.providers[0].models = ["model"];
  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  const defaultWorkspace = path.join(root, "workspace");
  const app = { store, engine: { defaultWorkspace }, push() {} };
  let identity = {};
  let retireOnRead = false;
  let writes = 0;
  registerBlankArtifactHandlers(
    (name, handler) =>
      handlers.set(name, (...args: unknown[]) => {
        if (name === "createBlankArtifact") writes++;
        return handler(...args);
      }),
    app as unknown as AppContext,
  );
  handlers.set("snapshot", () => {
    if (retireOnRead) identity = {};
    return { conversations: store.conversations, projects: [] };
  });
  const ctx = {
    userId,
    activeAccount: {
      id: owner,
      name: "Fixture",
      email: "test@example.invalid",
    },
    officialSessionIdentity: () => identity,
    handlers,
    store,
    signedOut: false,
    accountRetiring: false,
    closedFlag: false,
    setAccessToken() {},
    appVersion: "test",
    log() {},
    onEvent: () => () => {},
  };
  const dispatcher = new Dispatcher({
    officialUiRoot: path.resolve("build/official-ui"),
    officialUiActions: true,
    guard: { modes: ["chat"] },
    runtime: {
      serviceUrl: "http://unused",
      stateDir: root,
      providerServiceScript: "unused",
      version: "test",
      codexBinary: () => "unused",
    },
    link: {
      send: () => assert.fail("Unexpected link send"),
      request: async () => assert.fail("Unexpected link request"),
    },
    publish() {},
    openUrl() {},
    log() {},
  });
  dispatcher.contexts.set(userId, ctx as unknown as WebAppContext);
  const call = (method: string, request: OfficialUiReadRequest) =>
    dispatcher.run({
      t: "call",
      id: "fixture-call",
      deadlineMs: 1000,
      method,
      args: [encodeWireValue(request)],
      user: { id: userId, accessToken: "fixture-inert" },
    }) as Promise<OfficialUiReadResponse>;
  const read = (request: OfficialUiReadRequest) =>
    call("officialUiRead", request);
  const write = (request: OfficialUiReadRequest) =>
    call("officialUiAction", request);
  const action = negotiatedOfficialAction({
    mode: "engine-chat",
    accountId: owner,
    isCurrent: () => true,
    read,
    action: write,
  });
  const fetch = createOfficialReadFetch(
    "https://fixture.invalid",
    read,
    async () => assert.fail("Unexpected remote request"),
    undefined,
    action,
  );
  const post = (target: string, body: unknown = payload) =>
    fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    call,
    fetch,
    post,
    read,
    write,
    root,
    store,
    options: dispatcher.options,
    retire: () => (identity = {}),
    retireOnRead: () => (retireOnRead = true),
    get writes() {
      return writes;
    },
  };
}

test("the Design gallery creates a real blank file and replays the same slug", async (t) => {
  const f = fixture(t);
  assert.equal(
    isOfficialUiQuery("GET", "/api/frame/types", `?org=${organization}`),
    true,
  );
  assert.equal(isOfficialUiAction("POST", create), true);
  assert.equal(
    isOfficialUiAction("POST", create.replace(design, otherType)),
    false,
  );
  assert.deepEqual(await (await f.fetch(types)).json(), {
    types: [{ slug: design, title: "Design" }],
  });
  const target = `${create}&idempotency_key=${requestId}`;
  const response = await f.post(target);
  assert.equal(response.status, 200, await response.clone().text());
  const { slug } = await response.json();
  assert.deepEqual(await (await f.post(target)).json(), { slug });
  const [created] = new Store(f.root).conversations;
  assert.equal(created.id, requestId);
  assert.equal(created.blankArtifact?.id, slug);
  assert.equal(created.title, "画板");
  assert.deepEqual(created.turns, []);
  assert.equal(new Store(f.root).conversations.length, 1);
  assert.equal(
    readFileSync(path.join(created.cwd!, "design.svg"), "utf8"),
    blankArtifactInitialContent("design"),
  );
  const listing = await f.fetch(
    `${gallery}&type=${encodeURIComponent(`${otherType},${design}`)}`,
  );
  assert.equal(listing.status, 200);
  assert.deepEqual(await listing.json(), {
    frames: [
      {
        slug,
        rel: "mine",
        title: "画板",
        type_slug: design,
        type_title: "Design",
        created_at: new Date(created.blankArtifact!.createdAt).toISOString(),
        updatedAt: new Date(created.updatedAt).toISOString(),
      },
    ],
  });

  const withoutKey = await f.post(create, { target_type_version: null });
  assert.equal(withoutKey.status, 200);
  assert.notEqual((await withoutKey.json()).slug, slug);
  assert.ok(f.store.conversations.some((row) => row.title === "Untitled"));
});

test("invalid, foreign, retired and unavailable requests cannot create Design files", async (t) => {
  const f = fixture(t);
  for (const [target, status] of [
    [`${create}&idempotency_key=invalid`, 400],
    [`${create}&org=${organization}`, 400],
    [create.replace(organization, organizationUuid("other")), 404],
    [create.replace(design, otherType), 501],
  ] as const)
    assert.equal((await f.post(target)).status, status);
  for (const body of [
    { title: "Missing target" },
    { target_type_version: 1 },
    { ...payload, title: 3 },
    { ...payload, template_id: design },
  ])
    assert.equal((await f.post(create, body)).status, 400);
  const request = {
    method: "POST",
    path: create,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload)),
  } as const;
  assert.equal((await f.write(request)).status, 409);
  const { activationLease } = await readOfficialCapabilities(f.read, owner);
  f.retire();
  assert.equal(
    (await f.write({ ...request, capabilityLease: activationLease })).status,
    409,
  );
  assert.equal(f.writes, 0);
  f.options.officialUiActions = false;
  assert.deepEqual(await (await f.fetch(types)).json(), { types: [] });
  assert.equal((await f.post(create)).status, 501);
});

test("the gallery shows only visible owned designs, honors filters and keeps reads independent of writes", async (t) => {
  const f = fixture(t);
  assert.equal((await f.post(create)).status, 200);
  const [created] = f.store.conversations;
  assert.ok(created.blankArtifact);
  const later = {
    ...created,
    id: requestId,
    updatedAt: created.updatedAt + 1000,
    blankArtifact: { ...created.blankArtifact, id: otherType },
  };
  f.store.conversations.push(
    later,
    { ...created, archived: true },
    { ...created, incognito: true },
    { ...created, mode: "code" },
    { ...created, blankArtifact: undefined },
    { ...created, projectOrganizationId: organizationUuid("other") },
    {
      ...created,
      sessionAuthors: { viewerAccountUuid: owner, ownerAccountUuid: "other" },
    },
  );
  f.options.officialUiActions = false;
  const all = await (await f.fetch(gallery)).json();
  assert.deepEqual(
    all.frames.map((row: { slug: string }) => row.slug),
    [otherType, created.blankArtifact.id],
  );
  const limited = await (
    await f.fetch(gallery.replace("limit=60", "limit=1"))
  ).json();
  assert.deepEqual(
    limited.frames.map((row: { slug: string }) => row.slug),
    [otherType],
  );
  for (const query of ["rel=shared", "type=none", `type=${otherType}`])
    assert.deepEqual(await (await f.fetch(`${gallery}&${query}`)).json(), {
      frames: [],
    });
  f.retireOnRead();
  const retired = await f.fetch(gallery);
  assert.equal(retired.status, 409);
  assert.doesNotMatch(await retired.text(), /画板/);
});

test("original Design navigation accepts full and compact artifact IDs", () => {
  const id = "76001fc5-95ed-4fae-b2ad-b566b38dddbe";
  const search = `?org=${organization}`;
  assert.deepEqual(officialDesignArtifactRoute(`/code/artifact/${id}`, search), { id, organization });
  assert.deepEqual(officialDesignArtifactRoute(`/epitaxy/artifact/${id}`, search), { id, organization });
  assert.deepEqual(officialDesignArtifactRoute("/artifact/Fa8XYdTLV2rsWZr9hs2eff", search), { id, organization });
  assert.deepEqual(officialDesignArtifactRoute("/epitaxy/artifact/Fa8XYdTLV2rsWZr9hs2eff", search), { id, organization });
  assert.equal(officialDesignArtifactRoute("/artifact/Fa8XYdTLV2rsWZr9hs2eff", "?org=invalid"), undefined);
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("an overlapping keyed Design create reports the original client's retry headers", async (t) => {
  const f = fixture(t);
  const entered = signal();
  const released = signal();
  t.after(() => released.resolve());
  const confirm = f.store.confirmConversationMetadata.bind(f.store);
  f.store.confirmConversationMetadata = async (...args) => {
    entered.resolve();
    await released.promise;
    await confirm(...args);
  };
  const target = `${create}&idempotency_key=${requestId}`;
  const first = f.post(target);
  await entered.promise;
  try {
    const overlap = await f.post(target);
    assert.equal(overlap.status, 409, await overlap.clone().text());
    assert.equal(overlap.headers.get("retry-after"), "1");
    assert.equal(overlap.headers.get("x-frame-refusal"), "create_in_flight");
    assert.equal(f.store.conversations.length, 1);
  } finally {
    released.resolve();
  }
  const initial = await first;
  assert.equal(initial.status, 200);
  const created = await initial.json();
  const retried = await f.post(target);
  assert.equal(retried.status, 200);
  assert.equal(retried.headers.has("retry-after"), false);
  assert.deepEqual(await retried.json(), created);
  assert.equal(new Store(f.root).conversations.length, 1);
});

test("an unconfirmed Design save asks for the same key and returns the first real artifact after retry", async (t) => {
  const f = fixture(t);
  const confirm = f.store.confirmConversationMetadata.bind(f.store);
  let first = true;
  f.store.confirmConversationMetadata = async (...args) => {
    await confirm(...args);
    if (first) {
      first = false;
      throw Error("Controlled loss of the save confirmation.");
    }
  };
  const target = `${create}&idempotency_key=${requestId}`;
  const failed = await f.post(target);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "1");
  assert.equal(failed.headers.has("x-frame-refusal"), false);
  assert.match(await failed.text(), /retry with the same idempotency_key/);
  const [written] = new Store(f.root).conversations;
  assert.equal(written.id, requestId);
  assert.ok(written.blankArtifact?.id);
  assert.equal(
    readFileSync(path.join(written.cwd!, "design.svg"), "utf8"),
    blankArtifactInitialContent("design"),
  );

  const confirmed = await f.post(target);
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.deepEqual(await confirmed.json(), { slug: written.blankArtifact.id });
  assert.equal(new Store(f.root).conversations.length, 1);
});

test("legacy Design navigation stays in the Claudex workspace", () => {
  const origin = "https://claudex.example.test";
  const destination = (route: string) =>
    officialDesignWorkspaceDestination(new URL(route, origin), origin);
  for (const route of [
    "/design", "/design/", "/desktop-design", "/claude-design",
    "/design?via=design_artifacts_banner&noredir=1",
    "https://claude.ai/design",
    "https://claude.com/design/p/00000000-0000-0000-0000-000000000157",
  ]) {
    assert.equal(destination(route), "/artifacts/design");
  }
  assert.equal(destination("https://claude.ai/design/settings"), "/settings/design-systems");
  assert.equal(destination("/artifacts/design"), undefined);
  assert.equal(destination("https://other.example.test/design"), undefined);
  assert.equal(destination(`/code/artifact/${design}?org=${organization}`), undefined);
});
