import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cloudCodeSessionKey } from "../../electron/official-ui/api/cloud-code-history";
import { submitOfficialCoworkFollowup } from "../../runner/src/official-cowork-followup";
import { decodeWireValue } from "../../shared/web-wire";

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
    activeAccount: { id: owner },
    store,
    officialSessionIdentity: () => identity,
    push() {},
  };
  const key = cloudCodeSessionKey(session, owner);
  const uuid = "d4ff6720-719e-4444-a12b-012c55524ea6";
  let calls = 0;
  const dispatcher = {
    async run(frame: any, expected: any) {
      if (frame.method === "modelCatalog")
        return { items: [{ id: "fixture", efforts: ["high"] }, { id: "second", efforts: ["low"] }] };
      assert.equal(expected.coworkFollowup.current(), true);
      const [input] = decodeWireValue(frame.args) as any[];
      assert.equal(input.mode, "cowork");
      assert.equal(input.conversationId, session.id);
      assert.equal(input.text, calls === 2 ? "Use /fixture after /fixture" : "Hello Cowork");
      if (calls === 1) {
        assert.equal(input.model, "second");
        assert.equal(input.effort, "low");
        assert.equal(input.thinkingMode, "extended");
      }
      if (calls === 2) assert.deepEqual(input.skillReferences, [selected]);
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
});
