import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { Store } from "../../electron/store/store";
import { SessionTransfer } from "../../electron/conversations/session-transfer";
import { assertCodeSessionSendAvailable } from "../../electron/conversations/code-lifecycle-guard";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";
import type { Conversation } from "../../shared/types";
import { storeAttachment } from "../../electron/engine/composer-files";
import { openPolicy } from "../../shared/client-policy";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-transfer-"));
  const downloads = path.join(root, "downloads");
  fs.mkdirSync(downloads);
  const source = new Store(path.join(root, "source"));
  const target = new Store(path.join(root, "target"));
  const conversation: Conversation = {
    id: randomUUID(),
    title: "Export fixture",
    mode: "code",
    cwd: root,
    model: "test",
    providerId: "default",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    sessionAuthors: { viewerAccountUuid: "source", ownerAccountUuid: "source" },
    turns: [
      {
        id: randomUUID(),
        prompt: "  Keep spacing\n",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          {
            id: "tool",
            type: "commandExecution",
            command: "printf fixture",
            aggregatedOutput: "fixture",
            status: "completed",
            exitCode: 0,
          },
          {
            id: "output",
            type: "outputFiles",
            generatedFiles: [
              {
                id: "report",
                name: "report.txt",
                path: "/outputs/report.txt",
                language: "text",
                operation: "create",
                state: "ready",
                content: "saved report",
                bytes: 12,
              },
            ],
          },
          { id: "reply", type: "agentMessage", text: "Saved the report." },
        ],
      },
    ],
  };
  source.conversations.push(conversation);
  source.flush();
  let current = true;
  const create = (store: Store, accountId: string) =>
    new SessionTransfer({
      root: store.root,
      accountId,
      appVersion: "test",
      conversations: () => store.conversations,
      projects: () => store.projects,
      assertCurrent: () => {
        if (!current) throw Error("Account changed");
      },
      provider: () => ({ id: "default", model: "test" }),
      storeImage: (name, data) =>
        storeAttachment(
          path.join(store.root, "attachments"),
          name,
          data,
          openPolicy,
        ),
      importConversations: (rows, projects) =>
        store.commitImportedConversations(rows, () => current, projects),
      saveConversation: (next) =>
        store.commitLocalCodeHistory(
          store.conversation(next.id),
          next,
          undefined,
          () => current,
        ),
      removeConversations: async (ids) => {
        for (const id of ids)
          store.commitLocalCodeLifecycle(
            store.conversation(id),
            null,
            () => current,
          );
      },
    });
  return {
    root,
    source,
    target,
    downloads,
    conversation,
    create,
    revoke: () => {
      current = false;
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("official account ZIP roundtrips through isolated stores with tools, outputs, confirmation and dedupe", async () => {
  const f = fixture();
  try {
    const exporter = f.create(f.source, "source"),
      importer = f.create(f.target, "target");
    const preview = await exporter.preview(0);
    assert.deepEqual(preview.byKind, { cowork: 0, code: 1, chat: 0 });
    const events: number[][] = [];
    const result = await exporter.export(
      0,
      f.downloads,
      (_kind, _phase, done, total) => events.push([done, total]),
    );
    assert.equal(result.ok, true);
    assert.ok(result.writtenPath);
    const zip = await JSZip.loadAsync(fs.readFileSync(result.writtenPath));
    const manifest = JSON.parse(
      await zip.file("claude-3p-export.json")!.async("string"),
    );
    assert.equal(manifest.kind, "claude-desktop-export");
    assert.equal(manifest.counts.code, 1);
    assert.equal(manifest.counts.totalBytes, preview.sizeBytes);
    assert.deepEqual(manifest.skippedOutputs, []);
    assert.ok(
      !Object.keys(zip.files).some((name) => name.includes("attachments/")),
    );
    assert.deepEqual(events.at(-1), [4, 4]);
    const picked = await importer.add(result.writtenPath);
    assert.ok(picked.source);
    const scan = importer.scan(picked.source.id);
    assert.equal(scan.sessions[0].alreadyImported, false);
    assert.deepEqual(await importer.run(0, [picked.source.id]), {
      imported: 1,
      skipped: 0,
    });
    const imported = f.target.conversations[0];
    assert.equal(imported.turns[0].prompt, f.conversation.turns[0].prompt);
    assert.equal(
      imported.turns[0].items.find((i) => i.type === "agentMessage")?.text,
      "Saved the report.",
    );
    const tool = imported.turns[0].items.find((i) => i.tool === "Bash");
    assert.equal(tool?.status, "completed");
    assert.ok(JSON.stringify(tool?.contentItems).includes("fixture"));
    const output = imported.turns[0].items.find(
      (i) => i.tool === "SendUserFile",
    )?.generatedFiles?.[0];
    assert.ok(output?.digest);
    assert.equal(
      new GeneratedBlobs(f.target.root).read(output.digest).toString(),
      "saved report",
    );
    assert.ok(
      imported.turns[0].importedCodeTranscript?.some(
        (row) => row.codeOutput?.fileId === output.id,
      ),
    );
    assert.equal(imported.sessionAuthors?.ownerAccountUuid, "target");
    assert.throws(
      () => assertCodeSessionSendAvailable(imported),
      /trust this imported session/,
    );
    assert.equal(await importer.confirm(imported.id), true);
    assert.doesNotThrow(() => assertCodeSessionSendAvailable(imported));
    const reopened = new Store(f.target.root);
    assert.equal(
      reopened.conversations[0].importedSessionResumePending,
      undefined,
    );
    const restarted = f.create(reopened, "target");
    const again = await restarted.add(result.writtenPath);
    assert.ok(again.source);
    assert.deepEqual(await restarted.run(0, [again.source.id]), {
      imported: 0,
      skipped: 1,
    });
    assert.equal(reopened.conversations.length, 1);
    assert.equal((await restarted.history())[0].counts.sessions, 1);
    const repeatedExport = await restarted.export(0, f.downloads);
    assert.equal(repeatedExport.ok, true);
  } finally {
    f.close();
  }
});

test("cutoff and incognito are excluded, and cancellation leaves no export or partial file", async () => {
  const f = fixture();
  try {
    f.source.conversations.push({
      ...structuredClone(f.conversation),
      id: randomUUID(),
      incognito: true,
    });
    const exporter = f.create(f.source, "source");
    assert.equal((await exporter.preview(3)).count, 0);
    const cancelled = await exporter.export(0, f.downloads, () =>
      exporter.cancelExport(),
    );
    assert.deepEqual(cancelled, { ok: false, errorCode: "CANCELLED" });
    assert.deepEqual(fs.readdirSync(f.downloads), []);
  } finally {
    f.close();
  }
});

test("account retirement during registration commits no imported sessions", async () => {
  const f = fixture();
  try {
    const exported = await f.create(f.source, "source").export(0, f.downloads);
    assert.ok(exported.writtenPath);
    const importer = f.create(f.target, "target"),
      picked = await importer.add(exported.writtenPath);
    assert.ok(picked.source);
    await assert.rejects(
      importer.run(0, [picked.source.id], () => f.revoke()),
      /Account changed/,
    );
    assert.equal(f.target.conversations.length, 0);
    assert.deepEqual(
      fs.readdirSync(path.join(f.target.root, "session-imports")),
      [],
    );
  } finally {
    f.close();
  }
});

test("native single-session export uses both original JSONL names and safe metadata", async () => {
  const f = fixture();
  try {
    const result = await f
      .create(f.source, "source")
      .share(`local_${f.conversation.id}`, f.downloads);
    assert.equal(result.success, true);
    assert.ok(result.filePath);
    const zip = await JSZip.loadAsync(fs.readFileSync(result.filePath));
    assert.deepEqual(
      Object.keys(zip.files).sort(),
      [
        `${f.conversation.id}.jsonl`,
        "local-session-state.json",
        "metadata.json",
        "transcript.jsonl",
      ].sort(),
    );
    assert.equal(
      await zip.file("transcript.jsonl")!.async("string"),
      await zip.file(`${f.conversation.id}.jsonl`)!.async("string"),
    );
    const metadata = JSON.parse(
      await zip.file("metadata.json")!.async("string"),
    );
    assert.equal(metadata.sessionId, `local_${f.conversation.id}`);
    assert.equal(metadata.providerId, undefined);
    assert.equal(metadata.sessionAuthors, undefined);
    const state = JSON.parse(
      await zip.file("local-session-state.json")!.async("string"),
    );
    assert.equal(state.sessionId, metadata.sessionId);
    assert.equal(state.cliSessionId, metadata.cliSessionId);
    assert.equal(state.isRunning, false);
    assert.equal(state.cliProvablyIdle, null);
  } finally {
    f.close();
  }
});

const original = process.env.CLAUDEX_ORIGINAL_DESKTOP_MAIN;
test(
  "pinned official marker and transcript locator accept the exported archive",
  { skip: !original },
  async () => {
    const f = fixture();
    try {
      const exportSource = fs.readFileSync(
        path.join(original!, "index.chunk-BiXcoU-e.js"),
        "utf8",
      );
      const scanSource = fs.readFileSync(
        path.join(original!, "index.chunk-DIg4rEdf.js"),
        "utf8",
      );
      const marker = vm.runInNewContext(
        `(${exportSource.slice(exportSource.indexOf("function ye(e) {"), exportSource.indexOf("var be ="))})`,
      );
      const parse = vm.runInNewContext(
        `(${scanSource.slice(scanSource.indexOf("function Qe(e) {"), scanSource.indexOf("async function $e"))})`,
      );
      const locate = vm.runInNewContext(
        `(${scanSource.slice(scanSource.indexOf("async function at("), scanSource.indexOf("var ot ="))})`,
        {
          c: { default: path },
          f: fs.promises,
          n: {},
          t: {
            Qit: "local_",
            wft: (s: string) => /^[0-9a-f-]{36}$/.test(s),
            z1: (root: string, id: string) => path.join(root, id),
            Vdt: async () => {},
            t5: async (file: string) => (fs.existsSync(file) ? file : false),
          },
        },
      );
      const exported = await f
        .create(f.source, "source")
        .export(0, f.downloads);
      assert.ok(exported.writtenPath);
      const zip = await JSZip.loadAsync(fs.readFileSync(exported.writtenPath));
      const manifest = marker(
        JSON.parse(await zip.file("claude-3p-export.json")!.async("string")),
      );
      assert.equal(manifest.kind, "claude-desktop-export");
      const extracted = path.join(f.root, "official-reader");
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const target = path.join(extracted, entry.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await entry.async("nodebuffer"));
      }
      const recordEntry = Object.keys(zip.files).find((name) =>
        /^claude-code-sessions\/[^/]+\/[^/]+\/local_[^/]+\.json$/.test(name),
      )!;
      const record = parse(await zip.file(recordEntry)!.async("string"));
      const located = await locate(
        "code",
        path.dirname(path.join(extracted, recordEntry)),
        "/unused",
        record,
        extracted,
      );
      assert.ok(located.transcriptPath);
      assert.equal(located.slug, "claudex");
      assert.equal(
        fs
          .readFileSync(located.transcriptPath, "utf8")
          .includes("Keep spacing"),
        true,
      );
      assert.equal(
        fs.readFileSync(path.join(located.outputsDir, "report.txt"), "utf8"),
        "saved report",
      );
    } finally {
      f.close();
    }
  },
);

test("output directories preserve same-name files and the 100 MiB per-session omission", async () => {
  const f = fixture();
  try {
    const outputs = f.conversation.turns[0].items.find(
      (item) => item.type === "outputFiles",
    )!;
    outputs.generatedFiles!.push({
      id: "other-report",
      name: "report.txt",
      path: "/outputs/nested/report.txt",
      language: "text",
      operation: "create",
      state: "ready",
      content: "nested report",
      bytes: 13,
    });
    const exporter = f.create(f.source, "source");
    const exported = await exporter.export(0, f.downloads);
    assert.ok(exported.writtenPath);
    const importer = f.create(f.target, "target");
    const picked = await importer.add(exported.writtenPath);
    assert.ok(picked.source);
    await importer.run(0, [picked.source.id]);
    const restored = f.target.conversations[0].turns[0].items.flatMap(
      (item) => item.generatedFiles ?? [],
    );
    assert.deepEqual(
      restored.map((file) =>
        new GeneratedBlobs(f.target.root).read(file.digest!).toString(),
      ),
      ["saved report", "nested report"],
    );
    outputs.generatedFiles!.push({
      id: "large",
      name: "large.bin",
      path: "/outputs/large.bin",
      language: "text",
      operation: "create",
      state: "ready",
      content: "x".repeat(100 * 1024 * 1024),
      bytes: 100 * 1024 * 1024,
    });
    const omitted = await exporter.export(0, f.downloads);
    assert.ok(omitted.writtenPath);
    const zip = await JSZip.loadAsync(fs.readFileSync(omitted.writtenPath));
    const manifest = JSON.parse(
      await zip.file("claude-3p-export.json")!.async("string"),
    );
    assert.deepEqual(manifest.skippedOutputs, [`local_${f.conversation.id}`]);
    assert.equal(
      Object.keys(zip.files).some((name) => name.includes("/outputs/")),
      false,
    );
  } finally {
    f.close();
  }
});

test("failed store save publishes no imported history and cleans staged session files", async () => {
  const f = fixture();
  try {
    const exported = await f.create(f.source, "source").export(0, f.downloads);
    assert.ok(exported.writtenPath);
    const importer = f.create(f.target, "target"),
      picked = await importer.add(exported.writtenPath);
    assert.ok(picked.source);
    f.target.commitImportedConversations = () => {
      throw Error("Disk write failed");
    };
    await assert.rejects(
      importer.run(0, [picked.source.id]),
      /Disk write failed/,
    );
    assert.equal(f.target.conversations.length, 0);
    assert.deepEqual(await importer.history(), []);
    assert.deepEqual(
      fs.readdirSync(path.join(f.target.root, "session-imports")),
      [],
    );
  } finally {
    f.close();
  }
});

test("project grouping is published only after conversation persistence succeeds", () => {
  const f = fixture();
  try {
    const project = {
      id: randomUUID(),
      name: "Imported space",
      description: "",
      instructions: "",
      createdAt: 1,
    };
    const conversation = {
      ...f.conversation,
      id: randomUUID(),
      projectId: project.id,
    };
    const target = path.join(f.target.root, "conversations.json");
    fs.mkdirSync(target);
    assert.throws(() =>
      f.target.commitImportedConversations([conversation], () => true, [
        project,
      ]),
    );
    assert.deepEqual(f.target.projects, []);
    assert.deepEqual(f.target.conversations, []);
    fs.rmdirSync(target);
    const reopened = new Store(f.target.root);
    assert.deepEqual(reopened.projects, []);
    assert.deepEqual(reopened.conversations, []);
    f.target.commitImportedConversations([conversation], () => true, [project]);
    const saved = new Store(f.target.root);
    assert.equal(saved.projects[0].id, project.id);
    assert.equal(saved.conversations[0].projectId, project.id);
  } finally {
    f.close();
  }
});
