import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { HIWONDER_KNOWLEDGE_SERVER, HUANER_TECH } from "../../shared/knowledge-api";
import type { Conversation } from "../../shared/types";
import { reconcileOfficialCoworkMcp } from "../../runner/src/official-cowork-mcp";
import {
  isOfficialUiAction,
  officialCoworkMcpReconciliation,
} from "../../shared/official-ui-web";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

test("owned Cowork refuses unrelated bridge reconciliation", async () => {
  const owner = "fixture-owner";
  const session = {
    id: "cowork",
    mode: "cowork",
    environment: { kind: "space" },
    turns: [],
  };
  const store = {
    conversations: [session],
    conversation: (id: string) => (id === session.id ? session : undefined),
  };
  const ctx = { activeAccount: { id: owner }, store };
  const route = {
    organizationId: organizationUuid(owner),
    key: cloudCodeSessionKey(session, owner),
  };
  const path = `/api/organizations/${route.organizationId}/cowork/sessions/session_${route.key}/mcp-servers`;
  assert.deepEqual(officialCoworkMcpReconciliation("PUT", path), route);
  assert.equal(isOfficialUiAction("PUT", path), true);
  const call = (body: unknown, target = route, current = () => true) =>
    reconcileOfficialCoworkMcp(
      ctx as never,
      target,
      {
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(body)),
      },
      current,
    );
  const empty = await call({ local_mcps: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(empty.body).toString()), {
    server_names: [],
  });
  assert.equal((await call({ local_mcps: [{ server: "untrusted" }] })).status, 501);
  assert.equal((await call({ builtin_servers: { test: false } })).status, 501);
  assert.equal((await call({ browser_tools: {} })).status, 501);
  assert.equal((await call({ extra: true })).status, 400);
  assert.equal(
    (await call({}, { ...route, organizationId: organizationUuid("other") })).status,
    404,
  );
  assert.equal((await call({}, { ...route, key: "0".repeat(32) })).status, 404);
  assert.equal((await call({}, route, () => false)).status, 409);
});

test("Cowork saves the connector choice through its cloud store and restores it after reopening", async (t) => {
  useElectronShim();
  const { CloudStore } = await import("../../runner/src/cloud-store");
  const owner = "fixture-owner";
  const session: Conversation = {
    id: "cowork", mode: "cowork", title: "Cowork", model: "fixture-model",
    providerId: "fixture", createdAt: 1, updatedAt: 1, pinned: false, archived: false,
    environment: { kind: "space", spaceId: "cowork" }, turns: [], knowledgeBases: [HUANER_TECH],
  };
  const root = mkdtempSync(join(tmpdir(), "official-cowork-mcp-"));
  const transport = memoryWebstore();
  const open = () => CloudStore.open({ root, userId: 1, transport });
  const remote = {
    ready: false,
    backend: {
      accounts: { baseUrl: "https://knowledge.example.test" },
      session: { authorized: async () => ({ bases: [{ id: HUANER_TECH, name: "Hiwonder Knowledge", available: true }] }) },
    },
  };
  const ctx = { activeAccount: { id: owner }, store: await open(), accountActivationIdentity: {}, remote };
  t.after(async () => {
    await ctx.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  ctx.store.conversations.push(session);
  await ctx.store.sync();
  const route = { organizationId: organizationUuid(owner), key: cloudCodeSessionKey(session, owner) };
  const call = (body: unknown) => reconcileOfficialCoworkMcp(ctx as never, route, {
    contentType: "application/json", body: Buffer.from(JSON.stringify(body)),
  }, () => true);
  assert.deepEqual(JSON.parse(Buffer.from((await call({})).body).toString()).server_names, [HIWONDER_KNOWLEDGE_SERVER]);
  const disabled = await call({ builtin_servers: { [HIWONDER_KNOWLEDGE_SERVER]: false } });
  assert.equal(disabled.status, 200);
  assert.deepEqual(session.connectorOverrides, { [HIWONDER_KNOWLEDGE_SERVER]: false });
  await ctx.store.close();
  ctx.store = await open();
  assert.deepEqual(JSON.parse(Buffer.from((await call({})).body).toString()).server_names, []);
  const enable = { builtin_servers: { [HIWONDER_KNOWLEDGE_SERVER]: true } };
  assert.equal((await call(enable)).status, 409);
  remote.ready = true;
  assert.equal((await call(enable)).status, 200);
  await ctx.store.close();
  ctx.store = await open();
  assert.deepEqual(JSON.parse(Buffer.from((await call({})).body).toString()).server_names, [HIWONDER_KNOWLEDGE_SERVER]);
});
