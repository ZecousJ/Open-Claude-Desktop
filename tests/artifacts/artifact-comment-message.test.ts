import assert from "node:assert/strict";
import test from "node:test";
import { artifactComment } from "../../src/artifacts/artifact-comment-message";

test("a comment sent from an artifact shows only its text (R-1022)", () => {
  assert.deepEqual(
    artifactComment(
      'Comment on artifact "Counter":\nMake it blue.\n\nFile: /w/c.html\nSnapshot: x',
    ),
    { name: "Counter", text: "Make it blue." },
  );
  assert.equal(artifactComment("Make it blue."), undefined);
});
