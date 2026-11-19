import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { directoryMcpSubmissionsRoute } from "../electron/official-ui/api/directory-submissions-mcp";
import { organizationUuid } from "../electron/official-ui/api/context";
import { connectorUuid } from "../electron/official-ui/api/connector-auth";
import { Sub2ApiError } from "../electron/sub2api/http";
import { directorySubmissionInput } from "../shared/directory-submissions-input";
import type { DirectorySubmission } from "../shared/directory-submissions";

const id = "cb93f8b3-a2b6-46e1-8f1d-8f3a6d6e8b7a";
const connectorUrl = "https://mcp.example.com/rpc";
const serverName = "private-notes";
const connectorId = connectorUuid(serverName);
const stamp = 1_789_000_000_000;
const policy = {
  readGuidelines: true,
  firstPartyApi: true,
  noFinancialTransactions: true,
  noAiMediaGeneration: true,
  noPromptInjection: true,
  noConversationDataCollection: true,
  publicDocsByPublishDate: true,
};
const listing = {
  type: "remote",
  name: "Private notes",
  one_liner: "Find and edit your notes",
  description: "Find and edit notes in your workspace.",
  remote: {
    url: connectorUrl,
    transport: "streamable-http",
    is_authless: false,
  },
  support: "mailto:notes@example.com",
  documentation: "https://mcp.example.com/docs",
  tool_names: ["renderer-invented-tool"],
  author: { name: "Notes team", url: "https://example.com" },
  image_urls: [
    { prompt: "Search for notes", image_url: "https://example.com/image" },
  ],
};
const questionnaire = {
  primary_contact_email: "author@example.com",
  company_name: "Notes team",
  use_cases: "Search your notes",
  policy_compliance: policy,
  additional_info:
    "Owner notes\n\n<<<wizard-context-v1>>>\n<<<json>>>\n" +
    JSON.stringify({
      connected_server_uuid: connectorId,
      api_ownership: "first_party",
    }),
  server_snapshot: {
    source: "client_mirrored",
    captured_at: new Date(stamp).toISOString(),
    connected_server_uuid: connectorId,
    tools: [
      {
        name: "renderer-invented-tool",
        inputSchema: {
          type: "object",
          properties: { password: { type: "string" } },
        },
      },
    ],
    prompts: [],
    resources: [],
    truncated: false,
    declared_tool_count: 1,
    declared_prompt_count: 0,
    declared_resource_count: 0,
  },
};
const original = { data: listing, submission_data: questionnaire };
const legacy = {
  id,
  kind: "mcp",
  name: listing.name,
  slug: "private-notes",
  url: connectorUrl,
  description: listing.description,
  examples: questionnaire.use_cases,
  email: questionnaire.primary_contact_email,
  license: "",
  termsAcknowledged: true,
  serverName,
  toolsVerified: true,
  tools: ["read_notes"],
  status: "rejected",
  reviewerNote: "Please clarify the permissions.",
  updatedAt: stamp,
} satisfies DirectorySubmission;

async function fixture(t: TestContext) {
  let owner = "owner-a";
  let activation = 1;
  let current = true;
  let capability = true;
  let inventory = ["read_notes", "search_notes"];
  let mcpServers: Record<string, unknown> = {
    [serverName]: { url: connectorUrl },
  };
  let retireOnList = false;
  let row: DirectorySubmission | undefined;
  let plugin: DirectorySubmission | undefined;
  const persisted: DirectorySubmission[] = [];
  const verifyRequests: string[] = [];
  const calls: string[] = [];
  const org = organizationUuid(owner);
  const path = `/api/organizations/${org}/directory/mcp-servers`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void directoryMcpSubmissionsRoute(req, res, url, {
      get allowDirectorySubmissions() {
        return capability;
      },
      isCurrent: () => current,
      sessionIdentity: () => activation,
      account: () => (owner ? { id: owner } : undefined),
      settings: () => ({ mcpServers }),
      async call(name, ...args) {
        calls.push(name);
        if (name === "listDirectorySubmissions") {
          if (retireOnList) activation++;
          return [row, plugin].filter(Boolean);
        }
        if (name === "saveDirectorySubmission") {
          const input = directorySubmissionInput.parse(args[0]);
          const submit = args[1] === true;
          if (submit || input.serverName) {
            assert.equal(input.toolsVerified, false);
            assert.deepEqual(input.tools, []);
            assert.equal(input.url, connectorUrl);
            assert.equal(input.serverName, serverName);
            verifyRequests.push(serverName);
            if (!inventory.length)
              throw new Sub2ApiError(
                400,
                "DIRECTORY_TOOLS_UNAVAILABLE",
                "No tools were verified.",
              );
            input.toolsVerified = true;
            input.tools = inventory;
          }
          const status = submit
            ? "submitted"
            : row?.status === "approved"
              ? "draft"
              : (row?.status ?? "draft");
          row = {
            ...input,
            id,
            status,
            reviewerNote: submit ? "" : (row?.reviewerNote ?? ""),
            createdAt: stamp,
            updatedAt: stamp + persisted.length,
          };
          persisted.push(row);
          return row;
        }
        if (
          name === "publishDirectorySubmission" &&
          row &&
          row.id === args[0]
        ) {
          assert.equal(row.status, "approved");
          row = { ...row, publishedAt: row.publishedAt ?? stamp + 100 };
          return row;
        }
        if (name === "deleteDirectorySubmission" && row?.id === args[0]) {
          row = undefined;
          return;
        }
        assert.fail(`Unexpected ${name}`);
      },
    }).then(
      (handled) => {
        if (!handled) res.writeHead(404).end();
      },
      (error: unknown) => res.writeHead(500).end(String(error)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  async function request(
    method: string,
    tail = "",
    body?: unknown,
    base = path,
  ) {
    const response = await fetch(`http://127.0.0.1:${port}${base}${tail}`, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    });
    return {
      response,
      json: response.status === 204 ? undefined : await response.json(),
    };
  }

  return {
    request,
    calls,
    persisted,
    verifyRequests,
    setInventory: (value: string[]) => {
      inventory = value;
    },
    setConnectors: (value: Record<string, unknown>) => {
      mcpServers = value;
    },
    setRow: (value: DirectorySubmission) => {
      row = value;
    },
    setStatus: (status: DirectorySubmission["status"], reviewerNote = "") => {
      assert.ok(row);
      row = { ...row, status, reviewerNote };
    },
    setPlugin: () => {
      plugin = { ...legacy, kind: "plugin" };
    },
    retireDuringList: () => {
      retireOnList = true;
    },
    signOut: () => {
      owner = "";
    },
    setCurrent: () => {
      current = false;
    },
    disable: () => {
      capability = false;
    },
  };
}

test("the original wizard can save an incomplete draft, resume it, choose a slug and withdraw it", async (t) => {
  const f = await fixture(t);
  const draft = {
    form_data: { name: listing.name, connectedServerUuid: connectorId },
    touched_steps: ["connection", "listing"],
    current_step: "listing",
  };
  const saved = await f.request("POST", "", {
    data: { name: listing.name },
    submission_data: { claudex_draft: draft },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.json.status, "draft");
  assert.equal(saved.json.id, id);
  assert.equal(saved.json.slug, id);
  assert.equal(saved.json.organization_uuid, organizationUuid("owner-a"));
  assert.deepEqual(saved.json.submission_data.claudex_draft, draft);
  const detail = await f.request("GET", `/by-slug/${id}`);
  assert.deepEqual(detail.json, saved.json);
  f.setPlugin();
  const list = await f.request("GET");
  assert.deepEqual(list.json, { servers: [saved.json] });
  const edited = await f.request("PATCH", `/${id}`, {
    slug: "private-notes",
    ...original,
  });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.json.slug, "private-notes");
  assert.deepEqual(edited.json.submission_data, questionnaire);
  assert.deepEqual(edited.json.data, listing);
  assert.deepEqual(
    (await f.request("GET", "/by-slug/private-notes")).json,
    edited.json,
  );
  assert.equal((await f.request("GET", `/by-slug/${id}`)).response.status, 404);
  assert.equal((await f.request("DELETE", `/${id}`)).response.status, 204);
  assert.deepEqual((await f.request("GET")).json, { servers: [] });
  assert.deepEqual(f.verifyRequests, []);
});

test("submission uses endpoint-bound runtime inventory, remains retryable, and publishes only after review", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request("POST", "", { slug: "private-notes", ...original }))
      .response.status,
    200,
  );
  assert.deepEqual(f.persisted[0].tools, []);
  assert.equal(
    (await f.request("POST", `/${id}/publish`)).response.status,
    409,
  );
  f.setConnectors({
    [serverName]: { url: "https://different.example.com/mcp" },
  });
  assert.equal((await f.request("POST", `/${id}/submit`)).response.status, 400);
  assert.deepEqual(f.verifyRequests, []);
  f.setConnectors({ [serverName]: { url: connectorUrl } });
  const normalizedUrl = await f.request("PATCH", `/${id}`, {
    data: {
      ...listing,
      remote: { ...listing.remote, url: "https://MCP.example.com:443/rpc" },
    },
  });
  assert.equal(normalizedUrl.response.status, 200);
  f.setInventory([]);
  const noTools = await f.request("POST", `/${id}/submit`, {
    client_context: { surface: "directory", entry: "new" },
  });
  assert.equal(noTools.response.status, 400);
  assert.equal(noTools.json.error.message, "No tools were verified.");
  assert.equal(f.persisted.length, 2);
  f.setInventory(["read_notes", "search_notes"]);
  const submitted = await f.request("POST", `/${id}/submit`);
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.json.status, "submitted");
  assert.deepEqual(f.persisted[2].tools, ["read_notes", "search_notes"]);
  assert.deepEqual(f.persisted[2].original, {
    data: normalizedUrl.json.data,
    submission_data: questionnaire,
  });
  assert.deepEqual(
    (await f.request("POST", `/${id}/submit`)).json,
    submitted.json,
  );
  assert.equal(f.persisted.length, 3);
  f.setStatus("in_review");
  assert.equal(
    (await f.request("GET", "/by-slug/private-notes")).json.status,
    "submitted",
  );
  const changedListing = { ...listing, name: "Notes" };
  const updatedReview = await f.request("PATCH", `/${id}`, {
    data: changedListing,
  });
  assert.equal(updatedReview.response.status, 200);
  assert.equal(updatedReview.json.status, "submitted");
  assert.equal(updatedReview.json.data.name, "Notes");
  assert.equal(f.persisted[3].toolsVerified, true);
  f.setStatus("rejected", "Clarify the write permission.");
  const returned = await f.request("GET", "/by-slug/private-notes");
  assert.equal(returned.json.status, "changes_requested");
  assert.equal(returned.json.review_notes, "Clarify the write permission.");
  assert.equal(
    (await f.request("POST", `/${id}/submit`)).json.review_notes,
    null,
  );
  f.setStatus("approved");
  assert.equal(
    (await f.request("GET", "/by-slug/private-notes")).json.status,
    "approved",
  );
  const published = await f.request("POST", `/${id}/publish`);
  assert.equal(published.json.status, "published");
  assert.equal(published.json.editable_as_owner, false);
  assert.deepEqual(
    (await f.request("GET", "/by-slug/private-notes")).json,
    published.json,
  );
  assert.deepEqual(
    (await f.request("POST", `/${id}/publish`)).json,
    published.json,
  );
  assert.equal(
    (await f.request("PATCH", `/${id}`, { data: listing })).response.status,
    409,
  );
  assert.equal((await f.request("DELETE", `/${id}`)).response.status, 409);
});

test("classic connector rows are shown and can be resubmitted after fresh verification", async (t) => {
  const f = await fixture(t);
  f.setRow(legacy);
  const detail = await f.request("GET", "/by-slug/private-notes");
  assert.equal(detail.json.status, "changes_requested");
  assert.equal(detail.json.review_notes, legacy.reviewerNote);
  assert.equal(detail.json.data.remote.url, legacy.url);
  assert.deepEqual(detail.json.data.tool_names, ["read_notes"]);
  assert.equal(detail.json.submission_data.primary_contact_email, legacy.email);
  const submitted = await f.request("POST", `/${id}/submit`);
  assert.equal(submitted.json.status, "submitted");
  assert.deepEqual(f.persisted[0].tools, ["read_notes", "search_notes"]);
});

test("outside organization, retired account, unsupported credential writes and invalid tool evidence cannot save", async (t) => {
  const f = await fixture(t);
  const unrelated = `/api/organizations/${organizationUuid("owner-b")}/directory/mcp-servers`;
  assert.equal(
    (
      await f.request(
        "POST",
        "",
        { slug: "private-notes", ...original },
        unrelated,
      )
    ).response.status,
    404,
  );
  assert.equal(
    (await f.request("GET", `/${id}/static-credential`)).response.status,
    501,
  );
  assert.equal(
    (
      await f.request("POST", "", {
        ...original,
        static_credential: { client_secret: "sensitive" },
      })
    ).response.status,
    501,
  );
  assert.equal(
    (
      await f.request("POST", "", {
        data: { remote: { url: "https://name:password@example.com/" } },
      })
    ).response.status,
    400,
  );
  assert.equal(
    (
      await f.request("POST", "", {
        data: {
          remote: { url: connectorUrl },
          scratch: "x".repeat(130 * 1024),
        },
      })
    ).response.status,
    413,
  );
  assert.equal(
    (
      await f.request("POST", "", {
        submission_data: {
          claudex_draft: { form_data: { clientSecret: "sensitive" } },
        },
      })
    ).response.status,
    400,
  );
  assert.deepEqual(f.calls, []);
  const badSnapshot = {
    ...questionnaire,
    server_snapshot: {
      ...questionnaire.server_snapshot,
      connected_server_uuid: connectorUuid("other"),
    },
  };
  assert.equal(
    (
      await f.request("POST", "", {
        slug: "private-notes",
        data: listing,
        submission_data: badSnapshot,
      })
    ).response.status,
    200,
  );
  assert.equal((await f.request("POST", `/${id}/submit`)).response.status, 400);
  assert.deepEqual(f.verifyRequests, []);
  f.retireDuringList();
  assert.equal(
    (await f.request("PATCH", `/${id}`, original)).response.status,
    409,
  );
  assert.equal(f.persisted.length, 1);
  f.setCurrent();
  assert.equal((await f.request("GET")).response.status, 409);
  f.disable();
  assert.equal((await f.request("GET")).response.status, 501);
  f.signOut();
  assert.equal((await f.request("GET")).response.status, 401);
});
