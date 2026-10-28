import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogForModels,
  isConversationModel,
} from "../../shared/model-catalog-api";

test("image, video and speech models stay out of the model menus", () => {
  for (const id of [
    "grok-imagine-image-2.0",
    "grok-imagine-video-1.5",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "text-embedding-3-large",
    "gpt-4o-mini-tts",
  ])
    assert.equal(isConversationModel(id), false, id);
  for (const id of ["gpt-6-sol", "grok-4.7", "composer-2.5", "gpt-5.6-luna"])
    assert.equal(isConversationModel(id), true, id);
  const { models } = catalogForModels(null, [
    "gpt-6-sol",
    "gpt-image-2",
    "grok-imagine-video-1.5",
  ]);
  // GPT's image models are offered (under Image generation); others are not.
  assert.deepEqual(models, ["gpt-6-sol", "gpt-image-2"]);
});

test("a new conversation never starts with a picture model", () => {
  const item = (id: string, sort: number) => ({
    id,
    displayName: id,
    description: "",
    badges: [],
    sort,
    hidden: false,
    isDefault: false,
    usageHint: "",
  });
  const met = catalogForModels(
    {
      defaultModel: "gpt-image-2.5",
      items: [item("gpt-image-2.5", 0), item("gpt-6-sol", 1)],
    },
    ["gpt-image-2.5", "gpt-6-sol"],
  );
  assert.equal(met.defaultModel, "gpt-6-sol");
  assert.deepEqual(met.models, ["gpt-image-2.5", "gpt-6-sol"]);
  assert.equal(
    catalogForModels(null, ["gpt-image-2", "grok-4.7"]).defaultModel,
    "grok-4.7",
  );
});
