import assert from "node:assert/strict";
import type http from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  organizationUuid,
  type AdapterContext,
} from "../electron/official-ui/api/context";
import { projectsRoute } from "../electron/official-ui/api/projects";
import type { Project } from "../shared/types";

const account = { id: "owner", name: "Owner", email: "owner@example.test" };
const base = `/api/organizations/${organizationUuid(account.id)}`;
const id = "11111111-1111-4111-8111-111111111111";
const project: Project = {
  id,
  kind: "chat",
  name: "Personal",
  description: "",
  instructions: "",
  createdAt: 1,
};

function personalWorkspace(
  overrides: Partial<AdapterContext> = {},
  owned = project,
) {
  const activation = {};
  const ctx = {
    account: () => account,
    sessionIdentity: () => activation,
    snapshot: async () => ({
      projects: [owned, { ...owned, id: "archived", archivedAt: 2 }],
    }),
    call: async (name: string) => {
      assert.equal(name, "listProjectKnowledge");
      return { files: [] };
    },
    ...overrides,
  } as AdapterContext;
  return async (target: string, method = "GET", requestBody?: unknown) => {
    const url = new URL(target, "http://fixture.invalid");
    const req = Object.assign(
      Readable.from(
        requestBody === undefined
          ? []
          : [Buffer.from(JSON.stringify(requestBody))],
      ),
      {
        method,
        headers: { "content-type": "application/json" },
      },
    ) as unknown as http.IncomingMessage;
    let status = 0;
    let body: unknown;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        body = JSON.parse(value);
      },
    } as http.ServerResponse;
    await projectsRoute(req, res, url.pathname, url, ctx);
    return { status, body };
  };
}

test("stock project audiences keep personal projects under Mine", async () => {
  const request = personalWorkspace();
  for (const query of [
    "filter=is_shared_with_org",
    "filter=is_shared_with_me",
    "filter=is_not_creator",
    "creator_filter=is_not_creator",
  ]) {
    assert.deepEqual(
      await request(`${base}/projects_v2?${query}&include_has_archived=true`),
      {
        status: 200,
        body: {
          data: [],
          pagination: { total: 0, limit: 30, offset: 0, has_more: false },
          has_archived: false,
        },
      },
    );
  }
  for (const query of ["filter=is_creator", "creator_filter=is_creator"]) {
    const response = await request(
      `${base}/projects_v2?${query}&include_has_archived=true`,
    );
    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(response.body, {
      data: [{ uuid: id }],
      pagination: { total: 1, limit: 30, offset: 0, has_more: false },
      has_archived: true,
    });
  }
});

test("personal project owner identity and access readbacks agree with host rights", async () => {
  const target = `${base}/projects/${id}`;
  const request = personalWorkspace(
    {},
    {
      ...project,
      capabilities: { canEditInstructions: false, canEditKnowledgeBase: false },
    },
  );
  const detail = await request(target);
  assert.equal(detail.status, 200);
  const permissions = [
    "chat_project:chat:create",
    "chat_project:chat:view",
    "chat_project:knowledge:view",
  ];
  assert.partialDeepStrictEqual(detail.body, {
    creator: { uuid: account.id, full_name: account.name },
    claudex_can_edit_instructions: false,
  });
  assert.ok(
    detail.body &&
      typeof detail.body === "object" &&
      "permissions" in detail.body,
  );
  assert.deepEqual(detail.body.permissions, permissions);
  assert.deepEqual(await request(`${target}/accounts`), {
    status: 200,
    body: [
      {
        account: {
          uuid: account.id,
          full_name: account.name,
          email_address: account.email,
        },
        role: "view",
      },
    ],
  });
  assert.deepEqual(await request(`${target}/permissions`), {
    status: 200,
    body: { permissions },
  });
  assert.deepEqual(await request(`${target}/roles`), {
    status: 200,
    body: { group_assignments: [] },
  });
  assert.deepEqual(await request(`${target}/pending_shares`), {
    status: 200,
    body: [],
  });
  const browser = personalWorkspace({ readOnly: true });
  assert.deepEqual(await browser(`${target}/permissions`), {
    status: 200,
    body: {
      permissions: ["chat_project:chat:view", "chat_project:knowledge:view"],
    },
  });
  assert.equal(
    (await request(`${base}/projects/missing/accounts`)).status,
    404,
  );
  assert.equal(
    (
      await request(
        `${target.replace(organizationUuid(account.id), organizationUuid("other"))}/accounts`,
      )
    ).status,
    404,
  );
});

test("personal project sharing writes fail instead of reporting saved access", async () => {
  const target = `${base}/projects/${id}`;
  for (const request of [
    personalWorkspace(),
    personalWorkspace({
      readOnly: true,
      updateProjectMetadata: async () =>
        assert.fail("Unexpected project update"),
    }),
  ]) {
    assert.equal(
      (
        await request(target, "PUT", {
          is_private: false,
          organization_role: "view",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(target, "PUT", { organization_role: "user" })).status,
      403,
    );
  }
  const request = personalWorkspace();
  for (const [path, method] of [
    ["accounts", "POST"],
    ["accounts/member", "PUT"],
    ["accounts_bulk", "POST"],
    ["groups/group", "PATCH"],
    ["groups_bulk", "POST"],
    ["roles", "PUT"],
  ]) {
    assert.equal(
      (await request(`${target}/${path}`, method, { role: "user" })).status,
      403,
    );
  }
});
