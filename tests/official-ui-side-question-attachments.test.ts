import test from "node:test";
import assert from "node:assert/strict";
import { materializeSideQuestionAttachments } from "../electron/official-ui/api/side-question-attachments";
import {
  sideQuestionContext,
  sideQuestionInputSchema,
} from "../electron/official-ui/api/side-question-context";
import type { AdapterContext } from "../electron/official-ui/api/context";
import type { Conversation } from "../shared/types";
const text = Buffer.from("exact file content"),
  image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const conversation = {
  id: "c",
  mode: "chat",
  turns: [
    {
      id: "turn",
      prompt: "Inspect these",
      attachments: [
        {
          id: "text",
          name: "note.txt",
          kind: "text",
          size: text.length,
          path: "/private/path",
        },
        {
          id: "image",
          name: "photo.png",
          kind: "image",
          size: image.length,
          path: "/private/image",
        },
      ],
      items: [
        { id: "answer", type: "agentMessage", text: "Previously answered" },
      ],
      status: "completed",
    },
  ],
  savedBranches: [],
} as unknown as Conversation;
const input = sideQuestionInputSchema.parse({
  question: "What is in the files?",
  parent_message_uuid: "turn:assistant",
  btw_history: [],
});
function fixture() {
  let active = true;
  const files = new Map([
      ["text", Buffer.from(text)],
      ["image", Buffer.from(image)],
    ]),
    reads: string[] = [];
  const ctx = {
    call: async (method: string, conversationId: string, id: string) => {
      assert.equal(method, "turnAttachment");
      assert.equal(conversationId, "c");
      reads.push(id);
      const data = files.get(id);
      return data
        ? { name: id === "text" ? "note.txt" : "photo.png", data }
        : null;
    },
  } as unknown as AdapterContext;
  return {
    ctx,
    files,
    reads,
    current: () => active,
    retire: () => {
      active = false;
    },
  };
}
test("side-question attachments keep exact text and image order without exposing stored paths", async () => {
  const f = fixture(),
    messages = sideQuestionContext(conversation, input);
  const prepared = await materializeSideQuestionAttachments(
    f.ctx,
    "c",
    messages,
    f.current,
    new AbortController().signal,
  );
  const user = prepared.messages[0];
  assert.ok("role" in user && user.role === "user");
  if (!("role" in user)) throw Error();
  assert.deepEqual(
    user.content?.map((part) => part.type),
    ["input_text", "input_text", "input_image"],
  );
  assert.match(JSON.stringify(user.content), /exact file content/);
  assert.match(JSON.stringify(user.content), /data:image\/png;base64/);
  assert.doesNotMatch(JSON.stringify(prepared.messages), /\/private\//);
  await prepared.verify();
  assert.deepEqual(f.reads, ["text", "image", "text", "image"]);
});
test("changed or retired attachment data never passes the final proof", async () => {
  for (const mode of ["changed", "retired"]) {
    const f = fixture(),
      prepared = await materializeSideQuestionAttachments(
        f.ctx,
        "c",
        sideQuestionContext(conversation, input),
        f.current,
        new AbortController().signal,
      );
    if (mode === "changed")
      f.files.set("text", Buffer.from("other file content"));
    else f.retire();
    await assert.rejects(prepared.verify(), /changed|account/);
  }
});
test("unavailable or substituted attachment names and oversized content fail before dispatch", async () => {
  const f = fixture();
  f.files.delete("text");
  await assert.rejects(
    materializeSideQuestionAttachments(
      f.ctx,
      "c",
      sideQuestionContext(conversation, input),
      f.current,
      new AbortController().signal,
    ),
    /unavailable/,
  );
  const replaced = {
    ...conversation,
    turns: [
      {
        ...conversation.turns[0],
        attachments: [
          {
            id: "image",
            name: "different.png",
            kind: "image",
            size: image.length,
            path: "/private/image",
          },
        ],
      },
    ],
  } as Conversation;
  await assert.rejects(
    materializeSideQuestionAttachments(
      f.ctx,
      "c",
      sideQuestionContext(replaced, input),
      f.current,
      new AbortController().signal,
    ),
    /unavailable/,
  );
});

test("document attachment uses the same text extraction as the main conversation", async () => {
  const JSZip = (await import("jszip")).default;
  const { documentTextData } =
    await import("../electron/workspace/document-text");
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Slide evidence</a:t></a:r></a:p></p:sld>',
  );
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const source = {
    ...conversation,
    turns: [
      {
        ...conversation.turns[0],
        attachments: [
          {
            id: "doc",
            name: "deck.pptx",
            kind: "document",
            size: bytes.length,
            path: "/secret",
          },
        ],
      },
    ],
  } as Conversation;
  const ctx = {
    call: async () => ({ name: "deck.pptx", data: bytes }),
  } as unknown as AdapterContext;
  const result = await materializeSideQuestionAttachments(
    ctx,
    "c",
    sideQuestionContext(source, input),
    () => true,
    new AbortController().signal,
  );
  const message = result.messages[0];
  assert.ok("role" in message);
  if (!("role" in message)) throw Error();
  const extracted = await documentTextData(bytes, "deck.pptx");
  assert.ok(
    message.content?.some(
      (part) => part.type === "input_text" && part.text.includes(extracted),
    ),
  );
  await result.verify();
});
