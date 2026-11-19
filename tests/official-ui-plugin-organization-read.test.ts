import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApiAdapter } from "../electron/official-ui/api/index";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { Sub2ApiError } from "../electron/sub2api/http";
import { pluginOrganizationNotFoundCode } from "../shared/official-plugin-organizations";
import type { OrganizationRuntimeStates } from "../shared/official-organization-catalog";
import { libraryRoute } from "../electron/official-ui/api/skills";
import { pluginReadRoute } from "../electron/official-ui/api/plugin-read";

test("the desktop organization marketplace URL returns only active-account registry responses", async (t) => {
  const organization = "11111111-1111-4111-8111-111111111111";
  const otherOrganization = "33333333-3333-4333-8333-333333333333";
  const market = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "research",
    display_name: "Research",
  };
  let activation = {};
  let fault: "malformed" | "missing-service" | "switch" | undefined;
  const context = {
    account: () => ({ id: "local-personal", email: "owner@example.invalid", name: "Owner" }),
    sessionIdentity: () => activation,
    async readPluginOrganization(target) {
      if (target.kind === "memberships")
        return [{ id: organization, name: "Research", role: "member" }];
      if (fault === "missing-service")
        throw new Sub2ApiError(404, "NOT_FOUND", "backend version lacks this route");
      if (target.organization !== organization)
        throw new Sub2ApiError(404, pluginOrganizationNotFoundCode, "private diagnostic");
      if (fault === "switch") activation = {};
      if (fault === "malformed") return [market, market];
      return [{ ...market, private_source: "not renderer metadata" }];
    },
    log() {},
  } satisfies Partial<AdapterContext>;
  const handler = createApiAdapter(context as AdapterContext, { scoped: false });
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const path = (id: string) => "/api/organizations/" + id + "/marketplaces/list-org-marketplaces";
  const read = async (route: string, status: number) => {
    const response = await fetch(base + route);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return await response.json();
  };
  assert.deepEqual(await read("/api/claudex/plugin-organizations", 200), {
    organizations: [{ id: organization, name: "Research", role: "member" }],
  });
  assert.deepEqual(await read(path(organization), 200), { marketplaces: [market] });
  assert.deepEqual(await read(path(organizationUuid("local-personal")), 200), { marketplaces: [] });
  await read(path(organization) + "?user=owner", 400);
  assert.deepEqual(await read(path(otherOrganization), 404), {
    error: { type: "not_found_error", message: "Organization not found." },
  });
  fault = "malformed";
  await read(path(organization), 503);
  fault = "missing-service";
  await read(path(organization), 503);
  fault = "switch";
  await read(path(organization), 409);
});

test("organization library only includes installed runtime entries and removal stays account-scoped", async (t) => {
  const owner = organizationUuid("local-personal");
  const optionalId = "plugin_000000000000000000000001";
  const requiredId = "plugin_000000000000000000000002";
  const rows = [optionalId, requiredId].map((id, index) => ({
    id, name: `managed-${index}`, display_name: `Managed ${index}`, description: "",
    marketplace_id: "22222222-2222-4222-8222-222222222222", marketplace_display_name: "Research",
    version: "1.0.0", package_available: true, installation_preference: index === 0 ? "available" : "required",
  }));
  let optionalInstalled = true;
  const identity = {};
  const ctx: AdapterContext = {
    root: "",
    appVersion: "test",
    account: () => ({ id: "local-personal", email: "owner@example.invalid", name: "Owner" }),
    sessionIdentity: () => identity,
    settings() { throw Error("Unexpected settings read"); },
    listConversations: async () => [],
    loadConversation: async () => undefined,
    onEvent: () => () => {},
    modelCatalog: async () => null,
    async snapshot() { throw Error("Unexpected snapshot read"); },
    call: async () => ({ plugins: [], marketplaces: [], loadErrors: [] }),
    localCall: async () => undefined,
    readPluginOrganization: async () => rows,
    async readOrganizationPluginStates(): Promise<OrganizationRuntimeStates> {
      return optionalInstalled ? { [optionalId]: { enabled: false } } : {};
    },
    async removeOrganizationPlugin(id) {
      assert.equal(id, optionalId);
      optionalInstalled = false;
      return { id, installed: false };
    },
    log() {},
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await libraryRoute(res, url.pathname, url, ctx) || await pluginReadRoute(req, res, url.pathname, url, ctx)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port + "/api/organizations/";
  const library = () => fetch(base + owner + "/library/mine?kind=plugin&source=organization").then((res) => res.json());
  const remove = (organization: string, query: string) => fetch(base + organization + "/plugins/" + optionalId + query, { method: "DELETE" });
  const before = await library();
  assert.deepEqual(before.items.map(({ id }: { id: string }) => id), [optionalId]);
  assert.deepEqual(before.items[0].viewer.installed, {
    enabled: false, installation_preference: "available", can_toggle: true, can_remove: true,
  });
  assert.equal((await remove(owner, "")).status, 404);
  assert.equal((await remove(organizationUuid("other"), "?source=organization")).status, 404);
  assert.equal(optionalInstalled, true);
  assert.equal((await remove(owner, "?source=organization")).status, 200);
  assert.deepEqual((await library()).items, []);
});
