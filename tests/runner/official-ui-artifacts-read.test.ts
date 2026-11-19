import { artifactNoteKey } from "../../shared/artifact-notes";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
import { writeStateIfMissing } from "../../electron/official-ui/api/state";
import type { Conversation } from "../../shared/types";

const id = "33333333-3333-4333-8333-333333333333";
const org = organizationUuid("owner");
const listing = `/api/frame/artifacts?org=${org}`;
const versions = `/api/organizations/${org}/artifacts/${id}/versions`;
function setup(t: { after(fn: () => void): void }, pageId?: string) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifacts-runner-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "owner",
    session = 1;
  let hook: ((method: string) => void) | undefined;
  const calls: string[] = [];
  const metadata = { notes: {} as any, pinned: [] as string[] };
  const chat: Conversation = {
    id,
    mode: "chat",
    title: "Saved source",
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: "turn",
        prompt: "create",
        attachments: [],
        status: "completed",
        createdAt: 2,
        items: [
          {
            id: "assistant",
            type: "agentMessage",
            text: "```js\nconst genuine = 42;\n```",
          },
        ],
      },
    ],
  };
  if (pageId)
    inAdapterScope(newAdapterScope(owner, root), () =>
      writeStateIfMissing("aliases", [[pageId, id]]),
    );
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({
        id: owner,
        email: "owner@example.invalid",
        name: "Owner",
      }),
      settings: () => ({}),
      sessionIdentity: () => session,
      stateDirectory: () => root,
      onEvent: () => () => {},
      appVersion: "test",
      log() {},
    } as never,
    async (method, args) => {
      calls.push(method);
      hook?.(method);
      if (method === "snapshot")
        return {
          projects: [],
          conversations: [{ ...chat, turns: [] }],
          artifactLibrary: { version: 1, copies: [], pinned: metadata.pinned },
        };
      if (method === "artifactNotes") return metadata.notes;
      if (method === "conversationTurns") {
        assert.equal(args[0], id);
        return { turns: chat.turns, savedBranches: [] };
      }
      throw Error(`Unexpected dispatch ${method}`);
    },
    root,
    { modes: ["chat"] },
  );
  return {
    chat,
    calls,
    metadata,
    run,
    hook(fn: typeof hook) {
      hook = fn;
    },
    switchAccount() {
      owner = "other";
    },
    reactivate() {
      session++;
    },
  };
}
const json = (r: { body: Uint8Array }) =>
  JSON.parse(Buffer.from(r.body).toString());

test("runner snapshot metadata plus conversationTurns produce exact selectable snippet content", async (t) => {
  const f = setup(t);
  const list = await f.run({ method: "GET", path: listing });
  assert.equal(list.status, 200);
  assert.deepEqual(f.calls, ["snapshot", "snapshot", "conversationTurns"]);
  const row = json(list).artifacts[0];
  assert.equal(row.conversation_uuid, id);
  const detail = await f.run({
    method: "GET",
    path: versions + "?latest_only=true",
  });
  assert.equal(detail.status, 200);
  const content = json(detail).artifact_versions.find(
    (v: any) => v.uuid === row.latest_artifact_version_uuid,
  );
  assert.equal(content.artifact_uuid, row.artifact_identifier);
  assert.equal(content.result_state, "const genuine = 42;\n");
  assert.equal(content.source, "w");
});

test("the Chat drawer can read artifact versions through a saved page alias", async (t) => {
  const pageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const f = setup(t, pageId);
  const drawerPath = `/api/organizations/${org}/artifacts/${pageId}/versions`;
  const fromConversation = await f.run({ method: "GET", path: versions });
  const fromDrawer = await f.run({ method: "GET", path: drawerPath });

  assert.equal(fromConversation.status, 200);
  assert.equal(fromDrawer.status, 200);
  assert.deepEqual(json(fromDrawer), json(fromConversation));
  assert.equal(
    json(fromDrawer).artifact_versions[0].result_state,
    "const genuine = 42;\n",
  );

  f.switchAccount();
  assert.equal(
    (
      await f.run({
        method: "GET",
        path: drawerPath.replace(org, organizationUuid("other")),
      })
    ).status,
    404,
  );
});

test("runner rejects wrong organization and all artifact mutation methods before dispatch", async (t) => {
  const f = setup(t);
  const publications = `/api/organizations/${org}/published_artifacts`;
  for (const path of [
    listing.replace(org, organizationUuid("other")),
    versions.replace(org, organizationUuid("other")),
    "/api/frame/artifacts",
  ])
    assert.equal((await f.run({ method: "GET", path })).status, 404);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const)
    for (const path of [listing, versions, publications, `${publications}/one`, `${publications}/one/open`, `/api/organizations/${org}/publish_artifact`])
      assert.equal((await f.run({ method, path })).status, 501);
  const hosted = await f.run({ method: "GET", path: `${publications}?include_deleted_artifacts=true` });
  assert.equal(hosted.status, 200);
  assert.deepEqual(json(hosted), []);
  assert.equal(
    (await f.run({ method: "GET", path: listing, body: new Uint8Array() }))
      .status,
    400,
  );
  assert.equal(f.calls.length, 0);
});

test("runner composite snapshot/history loads cannot continue after account or activation changes", async (t) => {
  for (const method of ["snapshot", "conversationTurns"])
    for (const change of ["switchAccount", "reactivate"] as const) {
      const f = setup(t);
      f.hook((name) => {
        if (name === method) f[change]();
      });
      const result = await f.run({ method: "GET", path: listing });
      assert.notEqual(result.status, 200);
      assert.ok(!Buffer.from(result.body).toString().includes("genuine"));
      if (method === "snapshot") assert.deepEqual(f.calls, ["snapshot"]);
    }
});

test("runner failed history is not reported as an empty successful artifact catalog", async (t) => {
  const f = setup(t);
  f.hook((method) => {
    if (method === "conversationTurns") throw Error("secret upstream token");
  });
  const result = await f.run({ method: "GET", path: listing });
  assert.equal(result.status, 503);
  assert.ok(
    !Buffer.from(result.body).toString().includes("secret upstream token"),
  );
});

test("runner artifact response limit includes escaped JSON and does not emit partial content", async (t) => {
  const f = setup(t);
  const content = "\\".repeat(900_000);
  f.chat.turns[0].items[0].text = Array.from(
    { length: 3 },
    () => `\`\`\`text\n${content}\n\`\`\``,
  ).join("\n");
  const result = await f.run({ method: "GET", path: versions });
  assert.equal(result.status, 413);
  assert.ok(result.body.byteLength < 1024);
  assert.equal(json(result).artifact_versions, undefined);
});

test("runner reads actual account notes and pinned identities for bounded favorite queries", async (t) => {
  const f = setup(t);
  const identity = JSON.stringify([id, "const genuine = 42;\n"]);
  f.metadata.notes[artifactNoteKey(identity)] = { viewedAt: 3000 };
  f.metadata.pinned.push(identity);
  const r = await f.run({
    method: "GET",
    path: `${listing}&rel=favorited&limit=500&sort=last_viewed`,
  });
  assert.equal(r.status, 200);
  const body = json(r);
  assert.equal(body.artifacts.length, 1);
  assert.equal(body.artifacts[0].starred, true);
  assert.equal(body.artifacts[0].last_viewed_at, new Date(3000).toISOString());
  assert.ok(f.calls.includes("artifactNotes"));
  f.hook((method) => {
    if (method === "artifactNotes") f.switchAccount();
  });
  assert.equal(
    (await f.run({ method: "GET", path: `${listing}&sort=last_viewed` }))
      .status,
    409,
  );
});
