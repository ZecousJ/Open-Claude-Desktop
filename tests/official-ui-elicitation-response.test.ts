/** Real pinned protobuf descriptor; all host calls are inert spies and must remain unused. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { fromJson, toBinary, fromBinary, toJson } from "@bufbuild/protobuf";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import { elicitationRefusal } from "../electron/official-ui/api/elicitation-response";
const registry = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  ),
  pkg = "anthropic.bard.api.v1alpha";
const input = registry.getMessage(pkg + ".PerformActionRequest")!,
  output = registry.getMessage(pkg + ".PerformActionResponse")!;
async function request(value: Record<string, unknown>, binary: boolean) {
  let calls = 0,
    status = 0,
    result: unknown;
  const route = createActionRpc(
    {
      call: async () => {
        calls++;
        throw Error("Approval must not be called");
      },
      loadConversation: async () => {
        calls++;
        throw Error("No guessing pending request");
      },
      log() {},
    } as never,
    registry,
  );
  const message = deepCreate(input, {
    header: { conversationId: "owned" },
    action: { case: "respondToElicitation", value },
  });
  const body = toJson(input, message, { useProtoFieldName: true });
  const req: any = Readable.from([
    binary
      ? Buffer.from(toBinary(input, message))
      : Buffer.from(JSON.stringify(body)),
  ]);
  req.method = "POST";
  req.headers = {
    "content-type": binary ? "application/proto" : "application/json",
  };
  const res: any = {
    writeHead: (n: number) => (status = n),
    end: (value: Uint8Array | string) => {
      result = binary
        ? toJson(output, fromBinary(output, value as Uint8Array), {
            useProtoFieldName: true,
          })
        : JSON.parse(String(value));
    },
  };
  assert.equal(await route(req, res, PERFORM_ACTION_PATH), true);
  return { status, result, calls };
}
test("missing/unknown response cannot imply accepted; real descriptor verdict is numeric", () => {
  for (const value of [
    {},
    { elicitationId: "a" },
    { elicitationId: "a", response: {} },
    { elicitationId: "a", response: { verdict: 0 } },
    { elicitationId: "a", response: { verdict: 99 } },
    { elicitationId: "a", response: { response: { case: "accept" } } },
  ])
    assert.equal(elicitationRefusal(value).code, "invalid_argument");
  assert.equal(
    elicitationRefusal({ elicitationId: "a", response: { verdict: 2 } }).code,
    "unimplemented",
  );
});
test("actual protobuf and JSON declined/approved/empty responses never dispatch tool approval", async () => {
  for (const binary of [false, true])
    for (const response of [
      undefined,
      {},
      { verdict: 0 },
      { verdict: 1, approvalOption: 1 },
      { verdict: 2 },
      { verdict: 2, approvalOption: 1 },
    ]) {
      const result = await request(
        { elicitationId: "pending-id", ...(response ? { response } : {}) },
        binary,
      );
      assert.equal(result.status, 200);
      assert.equal(result.calls, 0);
      assert.match(JSON.stringify(result.result), /error/);
      assert.doesNotMatch(JSON.stringify(result.result), /"applied"/);
      if (response?.verdict === 2)
        assert.match(
          JSON.stringify(result.result),
          /No approval or cancellation was sent/,
        );
    }
});
test("form, nonce, always/per-chat/site and step-up inputs cannot become generic boolean approvals", async () => {
  for (const response of [
    { verdict: 1, approvalOption: 2 },
    { verdict: 1, approvalOption: 3 },
    { verdict: 1, approvalOption: 4 },
    { verdict: 1, stepUpDecision: 1 },
    { verdict: 1, alwaysAllowTools: { tools: [] } },
    { verdict: 1, askNonce: "unmapped-nonce" },
    { verdict: 2, values: [{ fieldId: "form-field" }] },
  ]) {
    const result = await request(
      { elicitationId: "a", askNonce: "unmapped-nonce", response },
      true,
    );
    assert.equal(result.calls, 0);
    assert.match(JSON.stringify(result.result), /error/);
  }
});

test("every pinned verdict/approval-option/step-up enum combination fails closed in both transports", async () => {
  const values = (name: string) =>
    registry
      .getEnum(`${pkg}.ElicitationResponse.${name}`)!
      .values.map((v) => v.number);
  const verdicts = values("Verdict"),
    options = values("ApprovalOption"),
    steps = values("StepUpDecision");
  assert.deepEqual(verdicts, [0, 1, 2]);
  assert.deepEqual(options, [0, 1, 2, 3, 4]);
  assert.deepEqual(steps, [0, 1, 2]);
  for (const binary of [false, true])
    for (const verdict of [...verdicts, 99])
      for (const approvalOption of options)
        for (const stepUpDecision of steps) {
          const result = await request(
            {
              elicitationId: "pending",
              response: { verdict, approvalOption, stepUpDecision },
            },
            binary,
          );
          assert.equal(result.calls, 0);
          assert.match(JSON.stringify(result.result), /error/);
          assert.doesNotMatch(JSON.stringify(result.result), /"applied"/);
        }
});
