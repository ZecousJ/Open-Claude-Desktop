import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionToolView } from "../../src/transcript/tools/SessionToolView";
import type { Item } from "../../shared/types";
const render = (item: Item) =>
  renderToStaticMarkup(createElement(SessionToolView, { item }));
test("remaining session events use readable tool states rather than protocol objects", () => {
  assert.match(
    render({
      id: "compaction",
      type: "contextCompaction",
      lifecycleStatus: "completed",
    }),
    /Compacted session/,
  );
  // A compaction that failed does not claim it compacted.
  const failed = render({
    id: "compaction-failed",
    type: "contextCompaction",
    lifecycleStatus: "failed",
  });
  assert.match(failed, /Compaction failed/);
  assert.doesNotMatch(failed, /Compacted session/);
  assert.match(
    render({
      id: "sleep",
      type: "sleep",
      durationMs: 1250,
      lifecycleStatus: "completed",
    }),
    /Slept for 1 second/,
  );
  assert.match(
    render({
      id: "review",
      type: "enteredReviewMode",
      review: "synthetic <review>",
    }),
    /Started review/,
  );
  assert.match(
    render({
      id: "review",
      type: "enteredReviewMode",
      review: "synthetic <review>",
    }),
    /&lt;review&gt;/,
  );
  assert.match(
    render({ id: "view", type: "imageView", path: "/synthetic/chart.png" }),
    /chart.png/,
  );
  const image = render({
    id: "gen",
    type: "imageGeneration",
    status: "completed",
    result: "data:image/png;base64,aGVsbG8=",
    revisedPrompt: "A synthetic image",
  });
  assert.match(image, /Generated an image/);
  assert.match(image, /A synthetic image/);
  assert.match(image, /data:image\/png;base64,aGVsbG8=/);
  const unsafe = render({
    id: "gen",
    type: "imageGeneration",
    status: "completed",
    result: "data:image/svg+xml;base64,PHN2Zz4=",
  });
  assert.doesNotMatch(unsafe, /<img|PHN2Zz4=/);
});
