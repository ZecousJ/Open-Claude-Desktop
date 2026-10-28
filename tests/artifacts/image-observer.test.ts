import test from "node:test";
import assert from "node:assert/strict";
import { generatedImageFromResponse } from "../../server/image-observer";

test("a finished image_generation_call hands its picture over", () => {
  const event = {
    type: "response.output_item.done",
    item: {
      type: "image_generation_call",
      id: "ig_1",
      status: "completed",
      result: "iVBORw0KGgo=",
      output_format: "webp",
      revised_prompt: "a cat",
    },
  };
  assert.deepEqual(generatedImageFromResponse(event, "t1"), {
    threadId: "t1",
    callId: "ig_1",
    base64: "iVBORw0KGgo=",
    format: "webp",
    revisedPrompt: "a cat",
  });
  // Other events, an empty result, or no id: nothing.
  assert.equal(
    generatedImageFromResponse(
      { ...event, type: "response.output_item.added" },
      "t1",
    ),
    undefined,
  );
  assert.equal(
    generatedImageFromResponse(
      { ...event, item: { ...event.item, result: "" } },
      "t1",
    ),
    undefined,
  );
  assert.equal(
    generatedImageFromResponse(
      { ...event, item: { ...event.item, id: undefined } },
      "t1",
    ),
    undefined,
  );
  // An unknown format is saved as PNG.
  assert.equal(
    generatedImageFromResponse(
      { ...event, item: { ...event.item, output_format: "gif" } },
      "t1",
    )?.format,
    "png",
  );
});
