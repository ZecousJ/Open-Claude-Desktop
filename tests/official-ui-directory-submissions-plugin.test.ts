import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { organizationUuid } from "../electron/official-ui/api/context";
import { pluginDirectorySubmissionsRoute } from "../electron/official-ui/api/directory-submissions-plugin";
import { directorySubmissionInput } from "../shared/directory-submissions-input";
import type { DirectorySubmission } from "../shared/directory-submissions";

const id = "9a7eac31-0317-40ec-b8b1-3772cffc8840";
const mcpId = "12aca00e-4477-4631-bc00-029efa8a3a11";
const createdAt = Date.parse("2026-10-30T13:28:00Z");
const when = createdAt + 60_000;
const form = {
  plugin_name: "Scratch Pad",
  plugin_url: "https://github.com/example/scratch-pad",
  plugin_homepage: "https://example.org/scratch-pad",
  plugin_description: "Capture notes as you work.",
  plugin_examples: "Save this observation to the project notes.",
  submitter_email: "notes@example.org",
  supported_platforms: ["claude_code", "claude_cowork"],
  terms_acknowledged: true,
  license_type: "MIT",
  privacy_policy_url: "https://example.org/privacy",
};

async function fixture(t: TestContext) {
  const rows = new Map<string, DirectorySubmission>();
  let enabled = true;
  let activation = {};
  let retireOnRead = false;
  let writes = 0;
  const server = http.createServer(async (req, res) => {
    const handled = await pluginDirectorySubmissionsRoute(
      req,
      res,
      new URL(req.url ?? "/", "http://localhost"),
      {
        account: () => ({
          id: "owner",
          name: "Owner",
          email: "owner@example.org",
        }),
        get allowDirectorySubmissions() {
          return enabled;
        },
        sessionIdentity: () => activation,
        call: async (method, raw, submit) => {
          if (method === "listDirectorySubmissions") {
            if (retireOnRead) activation = {};
            return [...rows.values()];
          }
          if (method === "deleteDirectorySubmission") {
            writes++;
            rows.delete(String(raw));
            return;
          }
          assert.equal(method, "saveDirectorySubmission");
          writes++;
          const input = directorySubmissionInput.parse(raw);
          const rowId = input.id ?? id;
          const prior = rows.get(rowId);
          const row: DirectorySubmission = {
            ...input,
            id: rowId,
            status: submit ? "submitted" : (prior?.status ?? "draft"),
            reviewerNote: submit ? "" : (prior?.reviewerNote ?? ""),
            createdAt,
            updatedAt: when,
          };
          rows.set(rowId, row);
          return row;
        },
      },
    );
    if (!handled) res.writeHead(501).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = (
    method: string,
    body?: unknown,
    item?: string,
    owner = "owner",
  ) =>
    fetch(
      `http://127.0.0.1:${address.port}/api/console/organizations/${organizationUuid(owner)}/directory/plugin-submissions${item ? "/" + item : ""}`,
      {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    );
  return {
    rows,
    request,
    writes: () => writes,
    disable: () => {
      enabled = false;
    },
    retireOnRead: () => {
      retireOnRead = true;
    },
  };
}

test("the original plugin form saves, restores, submits and withdraws one owned row", async (t) => {
  const f = await fixture(t);
  const draft = await f.request("POST", {
    status: "draft",
    plugin_name: form.plugin_name,
    plugin_homepage: "https://",
    current_step: "pluginInfo",
    touched_steps: ["introduction"],
    client_context: { unrelated: "discard" },
  });
  assert.equal(draft.status, 200);
  assert.equal((await draft.json()).uuid, id);
  assert.equal(f.rows.get(id)?.slug, "");
  const loaded = await f.request("GET", undefined, id);
  assert.equal(loaded.status, 200);
  const loadedForm = await loaded.json();
  assert.equal(loadedForm.plugin_homepage, "https://");
  assert.equal(loadedForm.current_step, "pluginInfo");
  assert.deepEqual(loadedForm.touched_steps, ["introduction"]);
  assert.equal(loadedForm.status, "draft");
  assert.equal(loadedForm.created_at, "2026-10-30T13:28:00.000Z");
  assert.equal(loadedForm.client_context, undefined);

  const final = { ...form, status: "pending" };
  const submitted = await f.request("PATCH", final, id);
  assert.equal(submitted.status, 200);
  const saved = await submitted.json();
  assert.equal(saved.id, id);
  assert.equal(saved.status, "pending");
  assert.deepEqual(saved.supported_platforms, form.supported_platforms);
  assert.equal(saved.privacy_policy_url, form.privacy_policy_url);
  const retry = await f.request("PATCH", final, id);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), saved);
  assert.equal(f.writes(), 2);

  const row = f.rows.get(id);
  assert.ok(row);
  f.rows.set(id, {
    ...row,
    status: "rejected",
    reviewerNote: "Please provide another example.",
  });
  f.rows.set(mcpId, { ...row, kind: "mcp", id: mcpId });
  const list = await (await f.request("GET")).json();
  assert.equal(list.submissions.length, 1);
  assert.equal(list.submissions[0].status, "rejected");
  assert.equal(
    list.submissions[0].external_notes,
    "Please provide another example.",
  );
  assert.equal((await f.request("GET", undefined, mcpId)).status, 404);
  assert.equal((await f.request("DELETE", undefined, mcpId)).status, 404);
  assert.equal(
    (await f.request("DELETE", undefined, id, "another-owner")).status,
    404,
  );

  const revised = await f.request(
    "PATCH",
    { status: "draft", plugin_examples: "Create a dated lab note." },
    id,
  );
  const revisedForm = await revised.json();
  assert.equal(revisedForm.status, "rejected");
  assert.equal(revisedForm.external_notes, list.submissions[0].external_notes);
  assert.equal(revisedForm.plugin_examples, "Create a dated lab note.");
  const resubmitted = await f.request("PATCH", { status: "pending" }, id);
  const resubmittedForm = await resubmitted.json();
  assert.equal(resubmittedForm.uuid, id);
  assert.equal(resubmittedForm.status, "pending");
  assert.equal(resubmittedForm.external_notes, undefined);

  f.rows.set(id, { ...row, status: "approved", publishedAt: when });
  const published = await (await f.request("GET", undefined, id)).json();
  assert.equal(published.status, "published");
  assert.equal(published.published_at, "2026-10-30T13:29:00.000Z");
  assert.equal((await f.request("DELETE", undefined, id)).status, 204);
  assert.equal((await f.request("GET", undefined, id)).status, 404);
  assert.equal(f.rows.get(mcpId)?.kind, "mcp");
});

test("invalid plugin forms, unsupported hosts and retired accounts never submit", async (t) => {
  const f = await fixture(t);
  const original = {
    ...form,
    status: "pending",
    submitted_via: "claude_ai",
    workspace_id: "default",
  };
  for (const invalid of [
    { terms_acknowledged: false },
    { plugin_examples: " " },
    { submitter_email: "invalid" },
    { supported_platforms: [] },
    { supported_platforms: ["unsupported"] },
    { plugin_url: "https://user:secret@example.com/plugin" },
    { privacy_policy_url: "javascript:alert(1)" },
  ]) {
    assert.equal(
      (await f.request("POST", { ...original, ...invalid })).status,
      400,
    );
  }
  assert.equal(f.writes(), 0);
  const created = await f.request("POST", original);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).uuid, id);
  f.retireOnRead();
  assert.equal((await f.request("PATCH", { status: "draft" }, id)).status, 409);
  f.disable();
  assert.equal((await f.request("GET")).status, 403);
  assert.equal(f.writes(), 1);
});
