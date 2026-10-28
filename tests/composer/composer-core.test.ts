import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Attachment, Conversation, Item } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import {
  contextUsage,
  contextUsageLabel,
} from "../../src/composer/context-usage";
import {
  nextQueued,
  queuedMessages,
  addQueued,
  reconcileQueue,
  type QueuedMessage,
} from "../../src/composer/queue";
import { conversationChanged } from "../../src/composer/queue";
import {
  insertMention,
  mentionAt,
  mentionToken,
} from "../../src/composer/mention";
import {
  incomingFileName,
  pastedTextThreshold,
  pastesAsCard,
  dragHasFiles,
} from "../../src/composer/attachment-input";
import { dictationShown } from "../../src/composer/useComposerServices";
import {
  attachmentFileName,
  imagePreview,
  listFolder,
  mentionFiles,
  mentionQueryAllowed,
  rankMentions,
  storeAttachment,
} from "../../electron/engine/composer-files";
import { registerComposerHandlers } from "../../electron/ipc/composer";
import "../../shared/agent-api";

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "c",
    title: "Task",
    mode: "code",
    cwd: "/tmp",
    providerId: "p",
    model: "gpt-test",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    ...patch,
  } as Conversation;
}
const usage = (totalTokens: number) => ({
  totalTokens,
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});
const catalog = {
  defaultModel: "gpt-test",
  items: [
    {
      id: "gpt-test",
      displayName: "GPT Test",
      description: "",
      badges: [],
      sort: 0,
      hidden: false,
      isDefault: true,
      contextWindow: 200_000,
      fast: false,
      usageHint: "",
    },
  ],
};

test("the context ring uses the latest request against Codex's window, then the catalog's", () => {
  const withWindow = conversation({
    tokenUsage: {
      total: usage(900_000),
      last: usage(64_600),
      modelContextWindow: 258_400,
    },
  });
  assert.deepEqual(contextUsage(withWindow, catalog), {
    used: 64_600,
    window: 258_400,
    fraction: 0.25,
    total: usage(900_000),
    draft: false,
  });
  assert.equal(
    contextUsageLabel(contextUsage(withWindow, catalog)),
    "25% of context used (65k of 258k tokens)",
  );
  const noWindow = conversation({
    tokenUsage: {
      total: usage(50_000),
      last: usage(50_000),
      modelContextWindow: null,
    },
  });
  assert.equal(contextUsage(noWindow, catalog).window, 200_000);
  assert.equal(contextUsage(noWindow, catalog).fraction, 0.25);
  // Neither Codex nor a catalog names a window: only the token count.
  const plain = contextUsage(noWindow, null);
  assert.deepEqual(plain, {
    used: 50_000,
    window: null,
    fraction: null,
    total: usage(50_000),
    draft: false,
  });
  assert.equal(contextUsageLabel(plain), "50,000 tokens in context");
  // A new session uses nothing; the draft's model finds its catalog window.
  assert.deepEqual(contextUsage(undefined, catalog, "gpt-test"), {
    used: 0,
    window: 200_000,
    fraction: 0,
    total: undefined,
    draft: true,
  });
  // More than the window (before a compaction) fills the ring, no further.
  const over = conversation({
    tokenUsage: {
      total: usage(1),
      last: usage(300_000),
      modelContextWindow: 258_400,
    },
  });
  assert.equal(contextUsage(over, null).fraction, 1);
});

const entry = (patch: Partial<QueuedMessage>): QueuedMessage => ({
  id: "q1",
  text: "also run the linter",
  attachments: [],
  state: "queued",
  mode: "code",
  providerId: "p",
  model: "gpt-test",
  webSearch: false,
  ...patch,
});
const running = (items: Item[] = []) =>
  conversation({
    turns: [
      {
        id: "t",
        prompt: "go",
        attachments: [],
        items,
        status: "inProgress",
        createdAt: 0,
      },
    ],
  });
const finished = (items: Item[] = []) =>
  conversation({
    turns: [
      {
        id: "t",
        prompt: "go",
        attachments: [],
        items,
        status: "completed",
        createdAt: 0,
      },
    ],
  });
const steeredItem = (clientId: string) =>
  ({
    id: "i",
    type: "userMessage",
    steered: true,
    clientId,
    text: "also run the linter",
    attachments: [],
  }) as unknown as Item;

test("a steered message leaves the queue once delivered and is queued again if the turn ends first", () => {
  const steered = entry({ state: "steered", messageId: "m1" });
  // Still waiting in a running turn.
  assert.deepEqual(reconcileQueue([steered], running()), [steered]);
  // The turn recorded it: delivered.
  assert.deepEqual(reconcileQueue([steered], running([steeredItem("m1")])), []);
  // The turn ended before the model read it: it goes as the next message.
  const requeued = reconcileQueue([steered], finished());
  assert.equal(requeued[0].state, "queued");
  assert.equal(nextQueued(requeued, finished())?.id, "q1");
  // Nothing is sent while the turn runs, or behind a failed message.
  assert.equal(nextQueued([entry({})], running()), undefined);
  assert.equal(
    nextQueued(
      [entry({ error: "Model service unavailable." }), entry({ id: "q2" })],
      finished(),
    ),
    undefined,
  );
});

test("the queue sends one message when the conversation is idle and keeps a failed one", async () => {
  const id = "queue-test";
  const { id: _first, ...first } = entry({});
  const { id: _second, ...second } = entry({ text: "second" });
  addQueued(id, first);
  addQueued(id, second);
  const sent: string[] = [];
  const idle = { ...finished(), id };
  await conversationChanged({ ...running(), id }, async (message) => {
    sent.push(message.text);
  });
  assert.equal(sent.length, 0);
  await conversationChanged(idle, async (message) => {
    sent.push(message.text);
  });
  assert.deepEqual(sent, ["also run the linter"]);
  assert.deepEqual(
    queuedMessages(id).map((value) => value.text),
    ["second"],
  );
  await conversationChanged(idle, async () => {
    throw new Error("Model service unavailable.");
  });
  assert.equal(queuedMessages(id)[0].error, "Model service unavailable.");
});

test("@ finds the query at the caret and inserts a quoted path when needed", () => {
  assert.deepEqual(mentionAt("look at @src/Ap", 15), {
    start: 8,
    query: "src/Ap",
  });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail me@example.com", 19), null);
  assert.equal(mentionAt("look at @src now", 16), null);
  assert.deepEqual(
    insertMention("see @Ap please", mentionAt("see @Ap", 7)!, 7, "src/App.tsx"),
    {
      text: "see @src/App.tsx please",
      caret: 17,
    },
  );
  assert.equal(mentionToken("My Notes/a b.md"), '@"My Notes/a b.md"');
});

test("@ file lists never leave the folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-mention-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-outside-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "App.tsx"), "");
    fs.writeFileSync(path.join(root, "README.md"), "");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "");
    fs.writeFileSync(path.join(outside, "secret.txt"), "");
    fs.symlinkSync(outside, path.join(root, "escape"));
    fs.symlinkSync(
      path.join(root, "src", "App.tsx"),
      path.join(root, "app-link.tsx"),
    );
    const listed = listFolder(root).map((file) => file.path);
    assert.ok(listed.includes("src/App.tsx"));
    assert.ok(listed.includes("app-link.tsx"));
    assert.ok(!listed.some((file) => file.startsWith("escape")));
    assert.ok(!listed.some((file) => file.startsWith("node_modules")));
    assert.deepEqual(
      mentionFiles(root, "app")
        .map((file) => file.path)
        .sort(),
      ["app-link.tsx", "src/App.tsx"],
    );
    for (const query of ["../", "..", "src/../..", "/etc", "~/x", "C:\\x"])
      assert.equal(mentionQueryAllowed(query), false, query);
    assert.deepEqual(mentionFiles(root, "../secret"), []);
    assert.deepEqual(
      rankMentions(
        [
          { path: "docs/app-notes.md", kind: "file" },
          { path: "src/App.tsx", kind: "file" },
          { path: "lib/xapp.ts", kind: "file" },
        ],
        "app",
      ).map((file) => file.path),
      ["src/App.tsx", "docs/app-notes.md", "lib/xapp.ts"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("pasted and dropped files follow the attachment rules", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-attach-"));
  try {
    const png = storeAttachment(
      folder,
      "Pasted image.png",
      new Uint8Array([137, 80, 78, 71]),
      openPolicy,
    );
    assert.equal(png.kind, "image");
    assert.ok(png.path.startsWith(folder + path.sep));
    assert.ok(imagePreview(png)?.startsWith("data:image/png;base64,"));
    const text = storeAttachment(
      folder,
      "Pasted text.txt",
      new TextEncoder().encode("x".repeat(5000)),
      openPolicy,
      true,
    );
    assert.equal(text.pasted, true);
    assert.equal(text.kind, "text");
    assert.equal(imagePreview(text), null);
    assert.throws(
      () => storeAttachment(folder, "run.exe", new Uint8Array(4), openPolicy),
      /can’t be attached in this chat yet — this file type isn’t supported here/,
    );
    const off: ClientPolicy = {
      ...openPolicy,
      attachments: { maxBytes: null, types: [] },
    };
    assert.throws(
      () => storeAttachment(folder, "a.txt", new Uint8Array(4), off),
      /turned off attachments/,
    );
    const small: ClientPolicy = {
      ...openPolicy,
      attachments: { ...openPolicy.attachments, maxBytes: 3 },
    };
    assert.throws(
      () => storeAttachment(folder, "a.txt", new Uint8Array(4), small),
      /“a.txt” is 4 B, over the 0 MB limit\. Choose a smaller file\./,
    );
    assert.equal(attachmentFileName("../../etc/passwd.txt"), "passwd.txt");
    assert.equal(attachmentFileName(".."), "Attachment");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(pastesAsCard("x".repeat(pastedTextThreshold - 1)), false);
  assert.equal(pastesAsCard("x".repeat(pastedTextThreshold)), true);
  // Bytes, not characters: 3-byte characters reach 4096 bytes sooner.
  assert.equal(pastedTextThreshold, 4096);
  assert.equal(pastesAsCard("字".repeat(1365)), false);
  assert.equal(pastesAsCard("字".repeat(1366)), true);
  assert.equal(
    incomingFileName({ name: "image.png", type: "image/png" }),
    "image.png",
  );
  assert.equal(
    incomingFileName({ name: "", type: "image/jpeg" }),
    "Pasted image.jpg",
  );
  assert.equal(dragHasFiles(["text/plain"]), false);
  assert.equal(dragHasFiles(["Files"]), true);
});

test("composer IPC keeps pasted files and lists only chosen folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ipc-"));
  try {
    fs.writeFileSync(path.join(root, "notes.md"), "");
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const selectedAttachments = new Map<string, Attachment>();
    const ctx = {
      selectedAttachments,
      store: {
        root,
        conversation: (id: string) =>
          id === "code"
            ? conversation({ id, cwd: root })
            : conversation({ id, mode: "chat", cwd: undefined }),
      },
      policy: () => openPolicy,
      allowedFolder: (folder?: string) => {
        if (folder !== root)
          throw new Error("Choose the working folder with the folder picker.");
      },
      engine: {},
    } as unknown as AppContext;
    registerComposerHandlers((name, fn) => handlers.set(name, fn), ctx);
    const added = handlers.get("addAttachmentData")!(
      "diagram.png",
      new Uint8Array([1, 2, 3]),
    ) as Attachment;
    assert.equal(selectedAttachments.get(added.id), added);
    assert.ok(added.path.startsWith(path.join(root, "attachments")));
    assert.throws(() =>
      handlers.get("addAttachmentData")!("a.txt", "not bytes"),
    );
    assert.throws(
      () => handlers.get("attachmentPreview")!("unknown"),
      /no longer available/,
    );
    const list = handlers.get("mentionFiles")!;
    assert.deepEqual(
      (list({ conversationId: "code" }, "notes") as { path: string }[]).map(
        (file) => file.path,
      ),
      ["notes.md"],
    );
    assert.deepEqual(list({ conversationId: "chat" }, ""), []);
    assert.equal((list({ folder: root }, "notes") as unknown[]).length, 1);
    assert.throws(() => list({ folder: "/" }, ""), /folder picker/);
    assert.deepEqual(list({}, ""), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the microphone shows only when the administrator allows voice and the service transcribes", () => {
  const voice = {
    transcription: true,
    speech: false,
    maxTranscriptionBytes: 1_000_000,
    maxSeconds: 120,
    maxInputChars: null,
    voices: [],
    defaultVoice: null,
  };
  assert.equal(dictationShown(true, voice), true);
  assert.equal(dictationShown(false, voice), false);
  assert.equal(dictationShown(true, { ...voice, transcription: false }), false);
  assert.equal(dictationShown(true, null), false);
});
