/** Browser wire → official runner read gate → adapter → real profile snapshots. No network/model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  createGeneratedOutputFixture,
  outputConversationId,
} from "../support/generated-output-fixture";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { verifyOfficialDocumentPreviewToken } from "../../runner/src/official-document-preview";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { officialUiTimelinePath } from "../../shared/official-ui-web";
import {
  loadRegistry,
  deepCreate,
} from "../../electron/official-ui/api/timeline";
import { organizationUuid } from "../../electron/official-ui/api/context";
test("official Web REST and timeline share owned XLSX snapshots and reject foreign files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f019-runner-"));
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = await createGeneratedOutputFixture(root);
  let identity = {},
    nativeCalls = 0;
  const calls: string[] = [];
  const ctx: any = {
    userId: 19,
    activeAccount: f.ctx.account(),
    officialSessionIdentity: () => identity,
    store: f.store,
    setAccessToken() {},
    appVersion: "test",
    log() {},
    onEvent: () => () => {},
    signedOut: false,
    closedFlag: false,
    selectedAttachments: new Map(),
  };
  const dispatcher: any = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: false,
    },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: (userId: number) => (userId === ctx.userId ? ctx : undefined),
    now: () => 0,
    run: async (frame: any, expected: any) => {
      assert.equal(expected.context, ctx);
      assert.equal(expected.identity, identity);
      calls.push(frame.method);
      const args = decodeWireValue(frame.args) as any[];
      if (frame.method === "snapshot")
        return { conversations: f.store.conversations, projects: [] };
      if (frame.method === "conversationTurns") {
        assert.equal(args[0], outputConversationId);
        return { turns: f.store.conversations[0].turns, savedBranches: [] };
      }
      if (frame.method === "readGeneratedFile") {
        assert.equal(args.length, 1);
        return f.blobs.read(args[0]).toString("base64");
      }
      throw Error("Unexpected runner call " + frame.method);
    },
  };
  const read = (request: any) =>
    officialUiRead(dispatcher, {
      method: "officialUiRead",
      args: encodeWireValue([request]),
      user: {
        id: 19,
        accessToken: "synthetic-local-token",
        webSession: { id: "test-session", issuedAt: 100 },
      },
    } as any) as Promise<any>;
  const registry = loadRegistry(
      "build/official-ui/data/conversation-protocol.json",
    ),
    schema = registry.getMessage(
      "anthropic.bard.api.v1alpha.StreamTimelineRequest",
    )!;
  const payload = toBinary(
      schema,
      deepCreate(schema, { conversationId: outputConversationId }),
    ),
    head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  const answer = await read({
    method: "POST",
    path: officialUiTimelinePath,
    contentType: "application/connect+proto",
    body: Buffer.concat([head, payload]),
  });
  assert.equal(answer.status, 200);
  const response: any = fromBinary(
    registry.getMessage("anthropic.bard.api.v1alpha.StreamTimelineResponse")!,
    answer.body.subarray(5),
  );
  const update = response.event.event.value;
  const file = update.messages
    .find((m: any) => m.role === 2)
    .attachments.find((f: any) => f.fileName.endsWith(".xlsx"));
  assert.ok(file);
  // The Store restores a later running turn as interrupted with restart.
  f.store.conversations[0].turns.push({
    id: "interrupted-follow-up",
    prompt: "Follow-up",
    attachments: [],
    items: [],
    createdAt: Date.now(),
    status: "interrupted",
    stopReason: "restart",
  });
  const rest = await read({
    method: "GET",
    path: `/api/organizations/${organizationUuid("f019-owner")}/chat_conversations/${outputConversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
  });
  assert.equal(rest.status, 200);
  const { chat_messages } = JSON.parse(Buffer.from(rest.body).toString());
  assert.equal(chat_messages[3].stop_reason, "user_canceled");
  const delivered = chat_messages[1].content.find(
    (block: { type: string; name?: string }) =>
      block.type === "tool_result" && block.name === "SendUserFile",
  );
  assert.ok(
    delivered.attachments.some(
      (output: { path: string; file_uuid: string }) =>
        path.basename(output.path) === file.fileName &&
        output.file_uuid === file.id,
    ),
  );
  const fetch = createOfficialReadFetch(
    "http://synthetic.invalid",
    read,
    async () => {
      nativeCalls++;
      throw Error("Network fallback forbidden");
    },
  );
  const data = await fetch(file.url);
  assert.equal(data.status, 200);
  assert.match(data.headers.get("Content-Disposition")!, /^attachment;/);
  assert.equal(data.headers.get("Content-Length"), String(f.bytes.length));
  assert.deepEqual(Buffer.from(await data.arrayBuffer()), f.bytes);
  assert.equal(nativeCalls, 0);
  assert.equal(calls.filter((x) => x === "readGeneratedFile").length, 1);
  const foreign = await fetch(
    file.url.replace(organizationUuid("f019-owner"), organizationUuid("other")),
  );
  assert.equal(foreign.status, 404);
  assert.equal(calls.filter((x) => x === "readGeneratedFile").length, 1);
  const tokenPath = `/api/organizations/${organizationUuid("f019-owner")}/convert_pdf_token`;
  assert.equal((await fetch(tokenPath)).status, 501);
  assert.equal(
    (await fetch(tokenPath + "?extra=1", { method: "POST" })).status,
    501,
  );
  assert.equal(
    (await fetch(tokenPath, { method: "POST", body: "{}" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        tokenPath.replace(
          organizationUuid("f019-owner"),
          organizationUuid("other"),
        ),
        { method: "POST" },
      )
    ).status,
    403,
  );
  const tokenResponse = await fetch(tokenPath, { method: "POST" });
  assert.equal(tokenResponse.status, 200);
  const { token } = await tokenResponse.json();
  assert.match(token, /^19\.[0-9a-f]{64}$/);
  const opaqueToken = token.split(".")[1];
  assert.deepEqual(
    verifyOfficialDocumentPreviewToken(dispatcher, 19, opaqueToken),
    { id: "test-session", issuedAt: 100 },
  );
  assert.equal(
    verifyOfficialDocumentPreviewToken(dispatcher, 20, opaqueToken),
    undefined,
  );
  const old = dispatcher.run;
  dispatcher.run = async (frame: any, expected: any) => {
    const result = await old(frame, expected);
    if (frame.method === "readGeneratedFile") identity = {};
    return result;
  };
  const retired = await fetch(file.url);
  assert.notEqual(retired.status, 200);
  assert.ok(!(await retired.text()).includes("PK"));
  assert.equal(
    verifyOfficialDocumentPreviewToken(dispatcher, 19, opaqueToken),
    undefined,
  );
});
