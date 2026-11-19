import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { modelMenuOrderSource } from "../../scripts/official-ui-model-catalog-state.mjs";

const sortRows = runInNewContext(modelMenuOrderSource + "\nclaudexSortModelRows");

test("model menu groups vendors and shows newer, larger models first", () => {
  const ids = [
    "gpt-6-sol", "grok-4.6", "claude-haiku-4-5", "gpt-6-astra",
    "gpt-6.1-terra", "gpt-5.6-sol", "composer-2.5", "gpt-6.2-sol",
    "gpt-6.2-astra", "claude-opus-4-8", "grok-4.7", "claude-sonnet-5-5",
    "gpt-6.1-sol", "grok-latest", "grok-4.6-latest-build",
    "manual-fast", "manual-pro", "gpt-6.10-terra", "grok-build-fast",
    "claude-opus-5", "claude-fable-5",
  ];
  const sorted = sortRows(ids.map((id, i) => ({
    ...(i % 2 ? { id } : { model: id }),
    ...(id === "grok-build-fast" ? { name: "Composer 2.5 Fast" } : {}),
  })));
  assert.deepEqual(Array.from(sorted, row => row.model ?? row.id), [
    "gpt-6.10-terra", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol",
    "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol",
    "grok-4.7", "grok-4.6-latest-build", "grok-4.6", "grok-latest", "composer-2.5", "grok-build-fast",
    "claude-sonnet-5-5", "claude-fable-5", "claude-opus-5", "claude-opus-4-8", "claude-haiku-4-5",
    "manual-fast", "manual-pro",
  ]);
});
