import test from "node:test";
import assert from "node:assert/strict";
import type { Provider } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import {
  retiredModel,
  retiredModelNotice,
} from "../../src/composer/retired-model";

const provider: Provider = {
  id: "p",
  name: "Service",
  baseUrl: "https://example.test",
  protocol: "openai-responses" as Provider["protocol"],
  model: "gpt-b",
  models: ["gpt-a", "gpt-b"],
};
const item = (id: string, sort: number) => ({
  id,
  displayName: id.toUpperCase(),
  description: "",
  badges: [],
  sort,
  hidden: false,
  isDefault: false,
  usageHint: "",
});

test("an offered model is not retired; nothing before the models load", () => {
  const chat = { mode: "chat" as const, providerId: "p", model: "gpt-a" };
  assert.equal(retiredModel(chat, [provider], "p", null), undefined);
  assert.equal(
    retiredModel({ ...chat, model: "old" }, [], "p", null),
    undefined,
  );
  assert.equal(
    retiredModel(
      { ...chat, mode: "code", model: "old" },
      [provider],
      "p",
      null,
    ),
    undefined,
  );
});

test("a retired model replies with the active service's model", () => {
  const found = retiredModel(
    { mode: "cowork", providerId: "p", model: "old-model" },
    [provider],
    "p",
    null,
  );
  assert.deepEqual(found, {
    legacy: "old-model",
    providerId: "p",
    model: "gpt-b",
  });
});

test("the catalog's default wins when it is offered", () => {
  const catalog: ModelCatalog = {
    defaultModel: "gpt-a",
    items: [item("gpt-a", 1), item("gpt-b", 2)],
  };
  const found = retiredModel(
    { mode: "chat", providerId: "p", model: "old-model" },
    [provider],
    "p",
    catalog,
  );
  assert.equal(found?.model, "gpt-a");
});

test("the menu's notice names both models", () => {
  assert.equal(
    retiredModelNotice("Old", "New"),
    "Old is no longer available. New replies will use New.",
  );
});
