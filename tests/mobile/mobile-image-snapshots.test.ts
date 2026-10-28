import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import { transcriptImageSnapshot } from "../../src/mobile-conversation/image-snapshots";
import { fileIdentity } from "../../src/mobile-conversation/identity";
const digest = "a".repeat(64);
const file = {
  id: "image-tool:i:" + digest,
  name: "picture.png",
  path: "synthetic/picture.png",
  state: "ready",
  blob: true,
  digest,
  bytes: 123,
  mime: "image/png",
  language: "text",
  operation: "create",
};
const conversation = {
  id: "synthetic",
  mode: "chat",
  turns: [
    {
      id: "t",
      prompt: "test",
      status: "completed",
      items: [
        {
          id: "i",
          type: "imageGeneration",
          savedPath: file.path,
          generatedFiles: [file],
        },
      ],
    },
  ],
} as unknown as Conversation;
test("snapshot and opening resolve through the same canonical file", () => {
  assert.deepEqual(transcriptImageSnapshot(conversation, file.path), {
    digest,
    mime: "image/png",
    bytes: 123,
  });
  const identity = fileIdentity(conversation, {
    id: "generated-image:" + digest,
    sourcePath: file.path,
    sourceDigest: digest,
  } as never);
  assert.equal(identity?.conversationId, conversation.id);
  assert.equal(identity?.sourcePath, file.path);
  assert.equal(identity?.sourceDigest, digest);
  assert.match(identity!.artifactId, /^generated:image-tool:i:/);
});
test("a generated picture larger than an inline thumbnail still gets its card", () => {
  const large = structuredClone(conversation) as any;
  large.turns[0].items[0].generatedFiles[0].bytes = 2_573_330;
  assert.deepEqual(transcriptImageSnapshot(large, file.path), {
    digest,
    mime: "image/png",
    bytes: 2_573_330,
  });
});
test("unobserved paths and unsupported snapshots remain unavailable", () => {
  assert.equal(transcriptImageSnapshot(conversation, "other.png"), null);
  assert.equal(transcriptImageSnapshot(conversation, file.path, true), null);
  const other = structuredClone(conversation) as any;
  other.turns[0].items[0].generatedFiles[0].bytes = 64 * 1024 * 1024 + 1;
  assert.equal(transcriptImageSnapshot(other, file.path), null);
  other.turns[0].items[0].generatedFiles[0].bytes = 10;
  other.turns[0].items[0].generatedFiles[0].mime = "image/svg+xml";
  assert.equal(transcriptImageSnapshot(other, file.path), null);
});
