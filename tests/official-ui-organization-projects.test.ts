import assert from "node:assert/strict";
import type http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { organizationProjectRoute, organizationProjectWorkspaces } from "../electron/official-ui/api/organization-projects";
import { organizationUuid, type AdapterContext } from "../electron/official-ui/api/context";
import { remoteAccountId } from "../electron/sub2api/identity-support";

const organization = "33442200-1111-4321-8222-000012345678";
const id = "99887766-1111-4321-8222-000012345678";
const baseUrl = "http://claudex.example.test";
const detail = `/api/organizations/${organization}/projects/${id}`;
const rpc = "/claudex/project-organizations";
const owner = { userId: 7, email: "owner@example.test", name: "Owner" };
const reader = { userId: 8, email: "reader@example.test", name: "Reader" };
const project = {
  id, organizationId: organization, ownerId: owner.userId, creator: owner,
  name: "Current projects", description: "", instructions: "Use shared knowledge",
  createdAt: 1, updatedAt: 2, starred: false, audienceRole: "none", directRole: "view", role: "view",
};

function fixture(call: NonNullable<AdapterContext["organizationProjects"]>["call"]) {
  const ctx = {
    account: () => ({ id: remoteAccountId(baseUrl, reader.userId) }),
    isCurrent: () => true,
    organizationProjects: { baseUrl, call },
  } as AdapterContext;
  const request = async (path: string, method = "GET", data?: unknown) => {
    const url = new URL(path, baseUrl);
    const req = Object.assign(Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]),
      { method, headers: { "content-type": "application/json" } }) as unknown as http.IncomingMessage;
    let status = 0;
    let body: unknown;
    const res = {
      writeHead(value: number) { status = value; },
      end(value?: string) { body = value ? JSON.parse(value) : undefined; },
    } as http.ServerResponse;
    return { handled: await organizationProjectRoute(req, res, url, ctx), status, body };
  };
  return { ctx, request };
}

test("organization access uses the service workspace and viewer's actual project role", async () => {
  const { ctx, request } = fixture(async path => {
    if (path === rpc) return [{ id: organization, name: "Actual workspace", role: "member",
      sharingEnabled: true, publicProjectsEnabled: false }];
    assert.equal(path, `${rpc}/${organization}/projects/${id}`);
    return project;
  });
  assert.deepEqual(await organizationProjectWorkspaces(ctx), [{
    uuid: organization, name: "Actual workspace", role: "member",
    project_sharing_enabled: true, public_projects_enabled: false,
  }]);
  const res = await request(detail);
  assert.equal(res.status, 200);
  assert.partialDeepStrictEqual(res.body, {
    uuid: id, is_private: true, organization_role: "none",
    creator: { uuid: remoteAccountId(baseUrl, owner.userId) },
    permissions: ["chat_project:chat:create", "chat_project:chat:view", "chat_project:knowledge:view"],
  });
  const personal = await request(`/api/organizations/${organizationUuid(ctx.account()!.id)}/projects`);
  assert.equal(personal.handled, false);
});

test("organization invitations identify the same member by stock UUID and service roster", async () => {
  const writes: unknown[] = [];
  const { request } = fixture(async (path, method, body) => {
    if (path.startsWith(`${rpc}/${organization}/members?`)) return { members: [reader] };
    assert.equal(path, `${rpc}/${organization}/projects/${id}/accounts_bulk`);
    assert.equal(method, "POST");
    writes.push(body);
  });
  const grant = { email_address: reader.email, account_uuid: remoteAccountId(baseUrl, reader.userId) };
  const forged = await request(`${detail}/accounts_bulk`, "POST",
    { accounts: [{ ...grant, account_uuid: remoteAccountId(baseUrl, owner.userId) }], role: "user" });
  assert.equal(forged.status, 404);
  assert.deepEqual(writes, []);
  const accepted = await request(`${detail}/accounts_bulk`, "POST", { accounts: [grant], role: "view" });
  assert.equal(accepted.status, 204);
  assert.deepEqual(writes, [{ targets: [reader.userId], role: "view" }]);
});
