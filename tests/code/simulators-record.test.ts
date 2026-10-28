import test from "node:test";
import assert from "node:assert/strict";
import { EngineExtensions } from "../../electron/engine/engine-extensions";
import {
  keptScreenshots,
  simulatorExtension,
} from "../../electron/simulators/tools";
import { simulatorNamespaces } from "../../electron/simulators/tool-schemas";
import type { Conversation, Item } from "../../shared/types";

const picture = { type: "inputImage", imageUrl: "data:image/jpeg;base64,AAAA" };

function call(id: string, namespace: string, withPicture = true): Item {
  return {
    id,
    type: "dynamicToolCall",
    namespace,
    tool: "control",
    contentItems: [
      ...(withPicture ? [picture] : []),
      { type: "inputText", text: "Screenshot: 1x1" },
    ],
  };
}

function conversation(items: Item[]): Conversation {
  return {
    id: "c1",
    title: "t",
    mode: "code",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: "t1", items } as never],
  };
}

const extensions = new EngineExtensions();
extensions.add(
  simulatorExtension({ service: () => undefined, unattended: () => false }),
);

test("the first screenshots of a conversation are kept, later ones are not stored", () => {
  const stored = Array.from({ length: keptScreenshots }, (_, index) =>
    call(`s${index}`, simulatorNamespaces.ios),
  );
  const talk = conversation(stored);
  const fresh = call("new", simulatorNamespaces.android);
  const kept = extensions.recordItem(conversation(stored.slice(1)), fresh);
  assert.deepEqual(kept.contentItems[0], picture);
  const trimmed = extensions.recordItem(talk, fresh);
  assert.deepEqual(trimmed.contentItems, [
    { type: "inputText", text: "Screenshot not kept in this transcript." },
    { type: "inputText", text: "Screenshot: 1x1" },
  ]);
  // The same call updating (running → completed) is not counted against itself.
  const again = extensions.recordItem(
    conversation([...stored.slice(1), fresh]),
    fresh,
  );
  assert.deepEqual(again.contentItems[0], picture);
});

test("other tools' items and calls without a picture are left as they are", () => {
  const talk = conversation(
    Array.from({ length: keptScreenshots + 3 }, (_, index) =>
      call(`s${index}`, simulatorNamespaces.ios),
    ),
  );
  const other = call("o", "claudex_memory");
  assert.equal(extensions.recordItem(talk, other), other);
  const text = call("t", simulatorNamespaces.ios, false);
  assert.equal(extensions.recordItem(talk, text), text);
});
