import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexModelCatalog } from "../../electron/engine/codex-model-catalog";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { sandboxArgs } from "../../runner/src/sandbox/sandbox-setup";
import type { Conversation } from "../../shared/types";
import { fileChangeLabel } from "../../src/code-tools/CodeFileChange";

test("the catalog gives GPT-6 models a directly called freeform apply_patch", () => {
  const { models } = codexModelCatalog();
  const gpt6 = models.find((model) => model.slug === "gpt-6")!;
  assert.equal(gpt6.apply_patch_tool_type, "freeform");
  // Otherwise Codex's fallback: direct tools (code mode gets no patch
  // events), its own prompt, the unified exec shell, no parallel calls.
  assert.equal(gpt6.tool_mode, null);
  assert.equal(gpt6.shell_type, "default");
  assert.equal(gpt6.supports_parallel_tool_calls, false);
  assert.match(
    String(gpt6.base_instructions),
    /^You are Claudex, a coding agent/,
  );
  // Codex's own models stay as it ships them.
  for (const slug of ["gpt-5.5", "gpt-5.6-sol", "codex-auto-review"])
    assert.ok(
      models.some((model) => model.slug === slug),
      slug,
    );
});

test("a file the model is still writing shows from its first patch update", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-patch-"));
  try {
    const store = new Store(root);
    const c: Conversation = {
      id: "c",
      title: "c",
      mode: "code",
      providerId: "p",
      model: "gpt-6.1-sol",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      threadId: "thread",
      turns: [
        {
          id: "turn",
          prompt: "",
          attachments: [],
          items: [],
          status: "inProgress",
          createdAt: 1,
        },
      ],
    };
    store.conversations = [c];
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    ) as any;
    engine.routes.set("thread", "c");
    const send = (method: string, params: object) =>
      engine.notification({
        method,
        params: { threadId: "thread", turnId: "turn", ...params },
      });
    const change = (diff: string) => ({
      path: "/w/thesis.md",
      kind: { type: "add" },
      diff,
    });
    send("item/fileChange/patchUpdated", {
      itemId: "call_1",
      changes: [change("# 第1章\n")],
    });
    const item = c.turns[0].items[0];
    assert.equal(item.type, "fileChange");
    assert.equal(fileChangeLabel(item), "Creating thesis.md");
    const started = item.startedAt;
    send("item/fileChange/patchUpdated", {
      itemId: "call_1",
      changes: [change("# 第1章\n## 1.1\n")],
    });
    assert.equal(c.turns[0].items.length, 1);
    assert.equal(item.changes![0].diff, "# 第1章\n## 1.1\n");
    // Codex's own item takes over, keeping when the row first appeared.
    const done = {
      id: "call_1",
      type: "fileChange",
      status: "completed",
      changes: [change("# 第1章\n## 1.1\n正文\n")],
    };
    send("item/started", { item: { ...done, status: "inProgress" } });
    send("item/completed", { item: done });
    assert.equal(c.turns[0].items.length, 1);
    const final = c.turns[0].items[0];
    assert.equal(final.startedAt, started);
    assert.equal(fileChangeLabel(final), "Created thesis.md");
    // A late update never reopens a written file.
    send("item/fileChange/patchUpdated", {
      itemId: "call_1",
      changes: [change("stale")],
    });
    assert.equal(
      c.turns[0].items[0].changes![0].diff,
      "# 第1章\n## 1.1\n正文\n",
    );
    // The store's pending save, before its folder goes.
    store.flush();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the catalog's host path is mapped into the sandbox", () => {
  const mounts = [
    { host: "/data/s1/codex-home", sandbox: "/codex-home", writable: true },
    { host: "/data/s1/workspace", sandbox: "/workspace", writable: true },
  ] as never;
  assert.deepEqual(
    sandboxArgs(mounts, [
      "app-server",
      "-c",
      'model_catalog_json="/data/s1/codex-home/claudex-models.json"',
      "-c",
      'model="gpt-6.1-sol"',
    ]),
    [
      "app-server",
      "-c",
      'model_catalog_json="/codex-home/claudex-models.json"',
      "-c",
      'model="gpt-6.1-sol"',
    ],
  );
  // A path outside every mount is left alone.
  assert.deepEqual(sandboxArgs(mounts, ['model_catalog_json="/etc/x.json"']), [
    'model_catalog_json="/etc/x.json"',
  ]);
});
