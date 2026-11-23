import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { submitOfficialCoworkFollowup } from "../../runner/src/official-cowork-followup";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { officialUiCapabilitiesPath } from "../../shared/official-ui-web";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { openPolicy } from "../../shared/client-policy";
import type { Attachment } from "../../shared/types";

test("Cowork follow-up dispatches once and rejects unrelated or unsupported requests", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cowork-followup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const owner = "owner",
    identity = {};
  const session = {
    id: "cowork",
    createdAt: 1,
    mode: "cowork",
    environment: { kind: "space" },
    turns: [],
    providerId: "fixture",
    model: "fixture",
  };
  const store = {
    root,
    conversations: [session],
    settings: { codeEffort: "high", providers: [{ id: "fixture", model: "fixture", models: ["second"] }] },
    async commitCoworkModelPreference(row: typeof session, patch: Partial<typeof session>, current: () => boolean) {
      assert.equal(row, session);
      assert.equal(current(), true);
      Object.assign(row, patch);
      return true;
    },
  };
  const ctx = {
    userId: 1,
    activeAccount: { id: owner },
    store,
    policy: () => openPolicy,
    selectedAttachments: new Map<string, Attachment>(),
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    push() {},
  };
  const key = cloudCodeSessionKey(session, owner);
  const uuid = "d4ff6720-719e-4444-a12b-012c55524ea6";
  let calls = 0;
  let upload = Buffer.alloc(0);
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHksAAAAASUVORK5CYII=";
  const dispatcher = {
    options: { officialUiRoot: root, officialUiActions: true, link: {
      async request(op: string, user: number, params: { id: string; offset: number; length: number }) {
        assert.equal(op, "store.files.get");
        assert.equal(user, ctx.userId);
        assert.equal(params.id, "fixture-upload");
        return encodeWireValue({
          size: upload.length, bytes: upload.subarray(params.offset, params.offset + params.length),
        });
      },
    } },
    guard: { modes: ["chat", "cowork"] },
    context: () => ctx,
    contextFor: async () => ctx,
    now: () => 1,
    async run(frame: any, expected: any) {
      if (frame.method === "modelCatalog")
        return { items: [{ id: "fixture", efforts: ["high"] }, { id: "second", efforts: ["low"] }] };
      assert.equal(expected.coworkFollowup.current(), true);
      const [input] = decodeWireValue(frame.args) as any[];
      assert.equal(input.mode, "cowork");
      assert.equal(input.conversationId, session.id);
      assert.equal(input.text, ["Hello Cowork", "Hello Cowork", "Use /fixture after /fixture", "Compare these images"][calls]);
      if (calls === 1) {
        assert.equal(input.model, "second");
        assert.equal(input.effort, "low");
        assert.equal(input.thinkingMode, "extended");
      }
      if (calls === 2) assert.deepEqual(input.skillReferences, [selected]);
      if (calls === 3) {
        assert.deepEqual(input.attachments, imageIds.map(id => ({ id })));
        for (const [index, { id }] of input.attachments.entries()) {
          const attachment = ctx.selectedAttachments.get(id);
          assert.equal(attachment?.name, `image-${index + 1}.png`);
          assert.equal(readFileSync(attachment!.path).toString("base64"), imageData);
        }
      }
      calls++;
    },
  };
  const body = (message: unknown = "Hello Cowork") =>
    Buffer.from(
      JSON.stringify({
        events: [
          {
            payload: {
              type: "user",
              uuid,
              session_id: `session_${key}`,
              parent_tool_use_id: null,
              message: { role: "user", content: message },
            },
          },
        ],
      }),
    );
  const selected = { kind: "local", name: "fixture", start: 19, end: 27 };
  const call = (data = body(), target = key, current = () => true) =>
    submitOfficialCoworkFollowup(
      dispatcher as never,
      {} as never,
      ctx as never,
      target,
      { contentType: "application/json", body: data },
      current,
    );
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal(calls, 1);
  assert.equal((await call(body("Changed"))).status, 409);
  assert.equal((await call(body([{ type: "image", source: {} }]))).status, 400);
  assert.equal((await call(body(), "0".repeat(32))).status, 404);
  assert.equal((await call(body(), key, () => false)).status, 409);
  const batch = JSON.parse(body().toString());
  batch.events[0].payload.uuid = "e4ff6720-719e-4444-a12b-012c55524ea6";
  batch.events.unshift(
    ...[
      { subtype: "set_model", model: "second" },
      { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
      { subtype: "set_max_thinking_tokens", max_thinking_tokens: 31999 },
      { subtype: "initialize", rendersChromeSetupOffer: true },
    ].map((request, index) => ({
      payload: {
        type: "control_request",
        request_id: `request-${index}`,
        request,
      },
    })),
  );
  assert.equal((await call(Buffer.from(JSON.stringify(batch)))).status, 200);
  assert.equal(calls, 2);
  const skill = JSON.parse(body("Use /fixture after /fixture").toString());
  skill.events[0].payload.uuid = "f4ff6720-719e-4444-a12b-012c55524ea6";
  const postSkill = (...skill_references: unknown[]) => {
    skill.events[0].payload.skill_references = skill_references;
    return call(Buffer.from(JSON.stringify(skill)));
  };
  assert.equal((await postSkill({ ...selected, start: 18 })).status, 400);
  assert.equal((await postSkill(selected)).status, 200);
  assert.equal((await postSkill(selected)).status, 200);
  assert.equal((await postSkill({ ...selected, start: 4, end: 12 })).status, 409);
  assert.equal(calls, 3);
  const modelChange = (model: string, session_id = `cse_${key}`) => call(Buffer.from(JSON.stringify({
    session_id,
    events: [{ payload: { type: "control_request", request_id: "set-model-123", request: { subtype: "set_model", model } } }],
  })));
  assert.equal((await modelChange("second", "other")).status, 400);
  assert.equal((await modelChange("missing")).status, 409);
  const saved = await modelChange("second");
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(Buffer.from(saved.body).toString()).persisted, true);
  assert.equal(session.model, "second");
  assert.equal(calls, 3);
  const withImages = JSON.parse(body([
    { type: "text", text: "Compare these images" },
    ...Array.from({ length: 2 }, () => ({
      type: "image", source: { type: "base64", media_type: "image/png", data: imageData },
    })),
  ]).toString());
  const imageIds = ["81704203-1a65-4851-a569-e3bced5104d0", "8149c824-f64c-4da1-a7d7-7fe25612cf2a"];
  withImages.events[0].payload.file_attachments = imageIds.map((id, index) => {
    const dir = path.join(root, "attachments", id);
    const name = `image-${index + 1}.png`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), Buffer.from(imageData, "base64"));
    return { file_uuid: id, file_name: name, is_image: true };
  });
  withImages.events[0].payload.uuid = "b4ff6720-719e-4444-a12b-012c55524ea6";
  upload = Buffer.from(JSON.stringify(withImages));
  const rpc = (method: string, request: object) => officialUiRead(
    dispatcher as never, { method, args: encodeWireValue([request]), user: { id: ctx.userId } } as never,
  );
  const capabilities = await rpc("officialUiRead", { method: "GET", path: officialUiCapabilitiesPath });
  assert.equal(capabilities.status, 200);
  const { activationLease } = JSON.parse(Buffer.from(capabilities.body).toString());
  const postImages = () => rpc("officialUiAction", {
    method: "POST", path: `/v1/code/sessions/session_${key}/events`, contentType: "application/json",
    capabilityLease: activationLease, body: { $upload: "fixture-upload" },
  });
  assert.equal((await postImages()).status, 200);
  assert.equal((await postImages()).status, 200);
  assert.equal(calls, 4);
  assert.equal(ctx.selectedAttachments.size, 2);
});
