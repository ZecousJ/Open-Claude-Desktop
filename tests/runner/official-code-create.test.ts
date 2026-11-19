import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOfficialCodeSession } from "../../runner/src/official-code-creation";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { connectorInventory } from "../../electron/official-ui/api/connector-inventory";
import { openPolicy } from "../../shared/client-policy";
import { officialCodeSessionCreation } from "../../shared/official-code-history";
import type { Conversation } from "../../shared/types";
import { isOfficialUiAction } from "../../shared/official-ui-web";

test("original Code creation persists an empty staged session with the original Code settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-create-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = {}, owner = "owner";
  const store = {
    root, conversations: [] as Conversation[],
    settings: { activeProviderId: "p", providers: [{ id: "p", model: "m", models: ["m", "gpt-image-2.5"] }], codeEffort: "medium",
      mcpServers: { wiki: { url: "https://wiki.example.test/mcp", disabled_tools: ["lookup"] } } },
    flush() {}, async confirmConversationMetadata(row: Conversation) { assert.ok(this.conversations.includes(row)); },
  };
  let stages = 0;
  const ctx = {
    activeAccount: { id: owner }, store, officialSessionIdentity: () => identity, policy: () => openPolicy,
    spaceRoot: (id: string) => path.join(root, id),
    async stageCodeSession(_id: string, _repo: unknown, space: string) { stages++; return { cwd: path.join(root, space, "workspace") }; },
    discardCodeSession() {}, push() {},
  };
  connectorInventory({ settings: () => store.settings, account: () => ctx.activeAccount, sessionIdentity: () => identity }, [
    { name: "wiki", url: "https://wiki.example.test/mcp", state: "ready", tools: 1, toolList: [
      { name: "lookup", description: "Look up an entry", enabled: true, definition: { name: "lookup", inputSchema: { type: "object" } } },
    ] },
  ]);
  const stockPrompt = "\n\nFor pull requests or issues, use a markdown link with the full URL, taking owner/repo from the repository the pull request or issue belongs to — the `--repo` you passed to `gh`, or the git remote of the checkout you ran the command in — which may not be your working directory. Never write a bare `#123` or `PR #123`; if you must write a short reference, qualify it as `owner/repo#123`.\n\n\nWhen you give the user a shell command they might run, put it in its own fenced code block tagged `bash`. Several commands meant to run one after another each get their own block, so each can be copied on its own; a single command that spans lines (heredoc, `\\` continuation, pipeline) stays one block. No leading `$` prompt and no interleaved output inside the fence.\n";
  const body = { title: "Example", environment_id: "default", config: { sources: [], outcomes: [], model: "m", permission_mode: "auto", append_system_prompt: stockPrompt }, events: [] };
  const request = (payload: unknown, org = organizationUuid(owner)) => ({ body: Buffer.from(JSON.stringify(payload)), contentType: "application/json", codeOrganizationId: org });
  const create = (payload: unknown, org?: string) => createOfficialCodeSession(ctx as never, request(payload, org), () => true);
  assert.equal(officialCodeSessionCreation("POST", "/v1/code/sessions"), true);
  assert.equal(isOfficialUiAction("POST", "/v1/code/sessions"), true);
  assert.equal(officialCodeSessionCreation("POST", "/v1/code/sessions?x=1"), false);
  assert.equal((await create(body, organizationUuid("other"))).status, 404);
  assert.equal((await create({ ...body, config: { ...body.config, sources: [{ path: "/tmp" }] } })).status, 400);
  assert.equal((await create({ ...body, events: [{}] })).status, 400);
  const drawing = await create({ ...body, config: { ...body.config, model: "gpt-image-2.5" } });
  assert.equal(drawing.status, 400);
  assert.match(Buffer.from(drawing.body).toString(), /Code model is unavailable/);
  assert.equal(stages, 0);
  assert.equal(store.conversations.length, 0);
  const result = await create(body);
  assert.equal(result.status, 200);
  assert.match(JSON.parse(Buffer.from(result.body).toString()).session.id, /^session_[a-f0-9]{32}$/);
  assert.equal(stages, 1);
  assert.equal(store.conversations.length, 1);
  assert.equal(store.conversations[0].title, "Example");
  assert.deepEqual(store.conversations[0].turns, []);
  assert.equal(store.conversations[0].environment?.kind, "space");
  assert.equal(store.conversations[0].codePermissionMode, "auto");
  assert.deepEqual(store.conversations[0].connectorOverrides, { wiki: false });
});
