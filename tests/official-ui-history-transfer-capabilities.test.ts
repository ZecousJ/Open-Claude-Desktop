import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import {
  registerHistoryTransferCapabilities,
  unavailableHistoryTransferCapabilities,
} from "../electron/official-ui/native/history-transfer-capabilities";

test("transfer capabilities match the original disabled contract including promptBanner", () => {
  const result = unavailableHistoryTransferCapabilities();
  assert.deepEqual(result, {
    remotePull: false,
    remotePullConfigured: false,
    localZip: false,
    localSessions: false,
    sessionExport: false,
    hostLoopRequired: false,
    cliUpdateRequired: false,
    hasImportableSessions: false,
    local1PSessionCount: 0,
    promptBanner: "off",
  });
});

test("native capability read is inert, rejects extra arguments and returns fresh answers", () => {
  const handlers = new Map<string, (...args: unknown[]) => any>();
  registerHistoryTransferCapabilities({
    on: (name: string, fn: (...args: unknown[]) => any) =>
      handlers.set(name, fn),
    get ctx() {
      throw Error(
        "Capability read must not inspect user data or invoke a provider.",
      );
    },
  } as any);
  assert.equal(handlers.size, 1);
  const read = handlers.get("HistoryImport.getImportCapabilities")!;
  assert.throws(() => read({ localZip: true }), /no arguments/);
  const result = read();
  result.sessionExport = true;
  assert.equal(read().sessionExport, false);
  assert.equal(read().promptBanner, "off");
});

const originalSchema = process.env.CLAUDEX_ORIGINAL_NATIVE_SCHEMA;
test(
  "original 4.4212.0 validator accepts disabled transfer answer and rejects former missing banner",
  {
    skip: !originalSchema,
  },
  () => {
    // Exact recovered validator execution only, not rendered UI acceptance.
    const text = fs.readFileSync(originalSchema!, "utf8");
    assert.equal(
      createHash("sha256").update(text).digest("hex"),
      "25ddc78e2b39049ba249f282987595043d10cd2c9ada03d92b361fd1ed62a15f",
    );
    const schema = JSON.parse(text);
    assert.equal(
      schema.domains.HistoryImport.methods.getImportCapabilities.returns,
      "hxt",
    );
    const validate = vm.runInNewContext(
      `(${schema.validators.hxt})`,
      {},
      { timeout: 1000 },
    );
    const answer: Record<string, unknown> =
      unavailableHistoryTransferCapabilities();
    assert.equal(validate(answer), true);
    delete answer.promptBanner;
    assert.equal(validate(answer), false);
  },
);
