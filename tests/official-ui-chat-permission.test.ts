import { codexModelCatalog } from "../electron/engine/codex-model-catalog";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { approvalsReviewerFor, taskSandboxFor, approvalPolicyFor } from "../shared/sandbox-policy";
import { chatPermissionFromWire, chatPermissionToWire } from "../shared/chat-permission-mode";
import { createActionRpc, PERFORM_ACTION_PATH } from "../electron/official-ui/api/actions";
import { deepCreate, loadRegistry } from "../electron/official-ui/api/timeline";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import { accountOf } from "../electron/official-ui/api/bootstrap";
import type { AdapterContext } from "../electron/official-ui/api/context";

const registry = loadRegistry("build/official-ui/data/conversation-protocol.json");
const requestSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
const responseSchema = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;

test("the account advertises the pinned composer layout only for an available Auto host", () => {
  const ctx = {
    root: "build/official-ui",
    account: () => ({ id: "owner" }),
    settings: () => ({}),
    isCurrent: () => true,
    chatPermissionModes: ["default", "auto"],
    readOnly: true,
  } as unknown as AdapterContext;
  assert.equal(accountOf(ctx)?.claudex_composer_layout_seed, "marlin");
  assert.equal(accountOf({ ...ctx, chatPermissionModes: ["default"] })?.claudex_composer_layout_seed, undefined);
  assert.equal(accountOf({ ...ctx, isCurrent: () => false })?.claudex_composer_layout_seed, undefined);
  assert.equal(accountOf({ ...ctx, root: "/nonexistent-claudex-defaults" })?.claudex_composer_layout_seed, undefined);
});

async function update(mode: number, allowed: string[] = ["manual", "auto"], capability = true) {
  return inAdapterScope(newAdapterScope("permission-fixture"), async () => {
    const identity = {};
    const conversation: any = { id: "c", mode: "chat", turns: [] };
    const writes: unknown[] = [];
    const ctx: any = {
      account: () => ({ id: "permission-fixture" }), sessionIdentity: () => identity,
      isCurrent: () => true, strictActionSemantics: true,
      chatPermissionModes: capability ? ["default", "auto"] : undefined,
      loadConversation: async () => conversation,
      call: async (name: string, ...args: any[]) => {
        if (name === "clientPolicy") return { permissionModes: allowed };
        if (name === "updateConversation") {
          writes.push(args[1]); Object.assign(conversation, args[1]); return conversation;
        }
        throw Error(`Unexpected ${name}`);
      },
      log() {},
    };
    const message = deepCreate(requestSchema, { header: { conversationId: "c" }, action: {
      case: "updateConversationSettings", value: { settings: { permissionMode: mode } },
    } });
    const req: any = Readable.from([Buffer.from(toBinary(requestSchema, message))]);
    req.method = "POST"; req.headers = { "content-type": "application/proto" };
    let response: any;
    const res: any = { writeHead() {}, end(bytes: Uint8Array) { response = fromBinary(responseSchema, bytes); } };
    await createActionRpc(ctx, registry)(req, res, PERFORM_ACTION_PATH);
    return { response, writes, conversation };
  });
}

test("pinned permission update stores exactly the chosen mode and respects policy", async () => {
  for (const [wire, stored] of [[1, "default"], [2, "auto"]] as const) {
    const result = await update(wire);
    assert.equal(result.response.ack.outcome.case, "applied");
    assert.deepEqual(result.writes, [{ chatPermissionMode: stored }]);
    assert.equal(chatPermissionToWire(stored), wire);
    assert.equal(chatPermissionFromWire(wire), stored);
  }
  for (const result of [await update(2, ["manual"]), await update(2, ["manual", "auto"], false), await update(9)]) {
    assert.equal(result.response.ack.outcome.case, "error");
    assert.deepEqual(result.writes, []);
  }
});

test("Auto uses the reviewer inside the same workspace sandbox as Manual", () => {
  for (const [permission, reviewer] of [["default", "user"], ["auto", "auto_review"]] as const) {
    const settings = { taskPermission: permission };
    assert.equal(approvalsReviewerFor("chat", settings), reviewer);
    const sandbox = taskSandboxFor(settings);
    assert.equal(sandbox, "workspace-write");
    assert.equal(approvalPolicyFor(sandbox), "on-request");
  }
});

test("automatic review uses an assigned model for both connector loading modes", () => {
  const { models } = codexModelCatalog({ reviewModels: ["gpt-5.5", "custom-provider-model"] });
  for (const name of ["gpt-5.5", "custom-provider-model"]) {
    for (const slug of [name, name + "~tools-loaded"]) {
      assert.equal(models.find(model => model.slug === slug)?.auto_review_model_override, name);
    }
  }
});
