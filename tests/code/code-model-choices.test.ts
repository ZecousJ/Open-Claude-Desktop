import test from "node:test";
import assert from "node:assert/strict";
import { codeModelChoices } from "../../src/composer/model/code-model-choices";
import type { Provider } from "../../shared/types";

test("Code model menu prioritizes selected model and retains provider identity across More models", () => {
  const providers: Provider[] = [
    {
      id: "first",
      name: "First",
      baseUrl: "http://127.0.0.1:1/v1",
      protocol: "responses",
      model: "alpha",
      models: ["alpha", "beta", "gamma"],
    },
    {
      id: "second",
      name: "Second",
      baseUrl: "http://127.0.0.1:2/v1",
      protocol: "chat",
      model: "beta",
      models: ["beta", "delta", "epsilon"],
    },
  ];
  const { quick, more } = codeModelChoices(providers, "second", "beta");
  assert.deepEqual(
    quick.map((choice) => [choice.providerId, choice.name]),
    [
      ["second", "beta"],
      ["first", "alpha"],
      ["first", "beta"],
      ["first", "gamma"],
    ],
  );
  assert.deepEqual(
    more.map((choice) => [choice.providerId, choice.name]),
    [
      ["second", "delta"],
      ["second", "epsilon"],
    ],
  );
});

test("the model menu's provider switch names each model's maker", async () => {
  const { modelVendor, choiceVendors } =
    await import("../../src/composer/model/code-model-choices");
  assert.equal(modelVendor("gpt-6.1-sol").id, "openai");
  assert.equal(modelVendor("claude-opus-5-5").id, "anthropic");
  assert.equal(modelVendor("grok-4.7").id, "xai");
  assert.equal(modelVendor("composer-2.5").id, "xai");
  assert.equal(modelVendor("some-model").id, "other");
  assert.deepEqual(
    choiceVendors([
      { providerId: "p", name: "gpt-6-sol" },
      { providerId: "p", name: "grok-4.7" },
      { providerId: "p", name: "gpt-6-astra" },
      { providerId: "p", name: "claude-fable-5-1" },
    ]).map((v) => v.name),
    ["OpenAI", "xAI", "Messages API"],
  );
});
