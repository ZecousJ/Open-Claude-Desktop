import test from "node:test";
import assert from "node:assert/strict";
import { SettingsWriteQueue } from "../../src/app/SettingsWriteQueue";

test("rapid slider changes save in order and stale responses do not replace the final choice", async () => {
  let visible = { codeEffort: "max", effort: "medium" };
  const pending: Array<{
    value: typeof visible;
    resolve: (value: typeof visible) => void;
  }> = [];
  const queue = new SettingsWriteQueue(
    () => visible,
    (value) => {
      visible = value;
    },
    (value) => new Promise((resolve) => pending.push({ value, resolve })),
    async () => visible,
  );
  const first = queue.update({ codeEffort: "ultra" });
  const second = queue.update({ codeEffort: "max" });
  assert.equal(visible.codeEffort, "max");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    pending.map((row) => row.value.codeEffort),
    ["ultra"],
  );
  pending[0].resolve(pending[0].value);
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visible.codeEffort, "max");
  assert.deepEqual(
    pending.map((row) => row.value.codeEffort),
    ["ultra", "max"],
  );
  pending[1].resolve(pending[1].value);
  await second;
  assert.equal(visible.codeEffort, "max");
});

test("failed last save restores persisted settings instead of a false preview", async () => {
  let visible = { codeEffort: "max" };
  const queue = new SettingsWriteQueue(
    () => visible,
    (value) => {
      visible = value;
    },
    async () => {
      throw Error("save failed");
    },
    async () => ({ codeEffort: "max" }),
  );
  await assert.rejects(queue.update({ codeEffort: "ultra" }), /save failed/);
  assert.equal(visible.codeEffort, "max");
});
