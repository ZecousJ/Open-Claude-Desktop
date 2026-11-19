import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import { openPolicy } from "../../shared/client-policy";
import type { AppEvent, Conversation } from "../../shared/types";
import { GeneratedBlobs } from "../../electron/artifacts/generated-blobs";
import { SessionTransfer } from "../../electron/conversations/session-transfer";
import { storeAttachment } from "../../electron/engine/composer-files";
import {
  conversationRestMessages,
  conversationsRoute,
} from "../../electron/official-ui/api/conversations";
import { organizationUuid } from "../../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
import { registerExperimentalCoworkSessions } from "../../electron/official-ui/native/cowork-sessions";
import { Store } from "../../electron/store/store";

test("an account ZIP restores Chat, Cowork and Code in their original modes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-lasm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = new Store(path.join(root, "source"));
  const target = new Store(path.join(root, "target"));
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
    "base64",
  );
  const attachment = storeAttachment(
    path.join(source.root, "attachments"),
    "pixel.png",
    image,
    openPolicy,
  );
  const conversation = (mode: Conversation["mode"]): Conversation => ({
    id: randomUUID(),
    mode,
    title: `${mode} fixture`,
    cwd: mode === "chat" ? undefined : root,
    providerId: "fixture",
    model: "fixture",
    pinned: false,
    archived: mode === "cowork",
    createdAt: 100,
    updatedAt: 200,
    turns: [
      {
        id: randomUUID(),
        createdAt: 100,
        prompt: `Prompt for ${mode}`,
        status: "completed",
        attachments: mode === "chat" ? [attachment] : [],
        items: [
          {
            id: randomUUID(),
            type: "agentMessage",
            text: `Reply from ${mode}`,
          },
        ],
      },
    ],
  });
  const chat = conversation("chat"),
    cowork = conversation("cowork"),
    code = conversation("code");
  chat.turns[0].items.unshift(
    { id: "think", type: "reasoning", summary: ["Check the image first."] },
    {
      id: "lookup",
      type: "dynamicToolCall",
      tool: "Lookup",
      input: { query: "fixture" },
      result: "Found the fixture.",
      status: "completed",
    },
  );
  cowork.turns[0].items.push({
    id: "files",
    type: "outputFiles",
    generatedFiles: [
      {
        id: "report",
        name: "report.txt",
        path: "/outputs/report.txt",
        language: "text",
        operation: "create",
        state: "ready",
        content: "Cowork report",
      },
    ],
  });
  source.conversations.push(chat, cowork, code);
  const transfer = (store: Store, accountId: string) =>
    new SessionTransfer({
      root: store.root,
      accountId,
      appVersion: "fixture",
      conversations: () => store.conversations,
      projects: () => store.projects,
      assertCurrent: () => {},
      provider: () => ({ id: "fixture", model: "fixture" }),
      importConversations: (additions, projects) =>
        store.commitImportedConversations(additions, () => true, projects),
      saveConversation: (next) =>
        store.persistChatMetadata(
          store.conversation(next.id),
          { importedSessionResumePending: next.importedSessionResumePending },
          () => true,
        ),
      removeConversations: async () => {},
      storeImage: (name, data) =>
        storeAttachment(
          path.join(store.root, "attachments"),
          name,
          data,
          openPolicy,
        ),
    });
  const exporter = transfer(source, "source"),
    importer = transfer(target, "target");
  const preview = await exporter.preview(0);
  assert.deepEqual(preview.byKind, { chat: 1, cowork: 1, code: 1 });
  const result = await exporter.export(0, root);
  assert.ok(result.ok && result.writtenPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(result.writtenPath));
  const chatEntry = sessionMetadata(zip, "local-agent-mode-sessions", chat.id);
  const coworkEntry = sessionMetadata(
    zip,
    "local-agent-mode-sessions",
    cowork.id,
  );
  const codeEntry = sessionMetadata(zip, "claude-code-sessions", code.id);
  const chatMetadata = JSON.parse(await chatEntry.async("string"));
  const coworkMetadata = JSON.parse(await coworkEntry.async("string"));
  assert.equal(chatMetadata.sessionType, "chat");
  assert.equal(chatMetadata.hostLoopMode, true);
  assert.equal(coworkMetadata.isArchived, true);
  assert.equal(
    JSON.parse(await codeEntry.async("string")).sessionType,
    undefined,
  );

  const archiveSpace = { id: randomUUID(), name: "Archive Space" };
  const lasmRoot = path.posix.dirname(chatEntry.name);
  zip.file(
    chatEntry.name,
    JSON.stringify({ ...chatMetadata, spaceId: archiveSpace.id }),
  );
  zip.file(
    coworkEntry.name,
    JSON.stringify({ ...coworkMetadata, spaceId: archiveSpace.id }),
  );
  zip.file(
    `${lasmRoot}/spaces.json`,
    JSON.stringify({ spaces: [archiveSpace] }),
  );
  const external = path.join(root, "external.zip");
  fs.writeFileSync(external, await zip.generateAsync({ type: "nodebuffer" }));

  const picked = await importer.add(external);
  assert.ok(picked.source);
  assert.deepEqual(
    importer
      .scan(picked.source.id)
      .sessions.map((session) => session.kind)
      .sort(),
    ["chat", "code", "cowork"],
  );
  assert.deepEqual(await importer.run(0, [picked.source.id]), {
    imported: 3,
    skipped: 0,
  });
  const reopened = new Store(target.root);
  const restored = reopened.conversations;
  const project = reopened.projects.find(
    (row) => row.name === archiveSpace.name,
  );
  assert.ok(project);
  assert.notEqual(project.id, archiveSpace.id);
  for (const original of [chat, cowork, code]) {
    const imported = restored.find((row) => row.mode === original.mode);
    assert.ok(imported);
    assert.equal(imported.title, original.title);
    assert.equal(imported.archived, original.archived);
    assert.equal(imported.importedSessionResumePending, true);
    assert.equal(imported.sessionAuthors?.ownerAccountUuid, "target");
    assert.equal(imported.cwd, original.mode === "code" ? root : undefined);
    assert.equal(
      imported.projectId,
      original.mode === "code" ? undefined : project.id,
    );
    assert.equal(imported.turns[0].prompt, original.turns[0].prompt);
    assert.equal(
      imported.turns[0].items.find((item) => item.type === "agentMessage")
        ?.text,
      `Reply from ${original.mode}`,
    );
  }
  const restoredChat = restored.find((row) => row.mode === "chat")!;
  const identity = {};
  const scope = newAdapterScope("target", undefined, identity);
  const readChatDetail = async () => {
    const route = `/api/organizations/${organizationUuid("target")}/chat_conversations/${restoredChat.id}`;
    let detail = "";
    await inAdapterScope(scope, () =>
      conversationsRoute(
        { method: "GET" } as never,
        {
          writeHead: (status: number) => assert.equal(status, 200),
          end: (body: string) => {
            detail = body;
          },
        } as never,
        route,
        new URL(route, "http://localhost"),
        {
          account: () => ({ id: "target" }),
          sessionIdentity: () => identity,
          stateDirectory: () => target.root,
          loadConversation: async (id: string) => target.conversation(id),
          localCall: async () => {
            throw Error("History reads do not confirm resume.");
          },
        } as never,
      ),
    );
    return JSON.parse(detail);
  };
  assert.equal(
    (await readChatDetail()).claudex_imported_resume_session_id,
    restoredChat.id,
  );
  assert.equal(await importer.confirm(restoredChat.id), true);
  assert.equal(
    (await readChatDetail()).claudex_imported_resume_session_id,
    undefined,
  );
  const restoredImage = restoredChat.turns[0].attachments[0];
  assert.ok(
    restoredImage.path.startsWith(
      path.join(target.root, "attachments") + path.sep,
    ),
  );
  assert.deepEqual(fs.readFileSync(restoredImage.path), image);
  const assistant = conversationRestMessages(
    restoredChat,
    "target",
  ).messages.find((message) => message.sender === "assistant");
  assert.ok(
    assistant.content.some(
      (block: { type: string; name?: string }) =>
        block.type === "tool_result" && block.name === "Lookup",
    ),
  );
  assert.ok(
    assistant.content.some(
      (block: { type: string }) => block.type === "thinking",
    ),
  );
  const output = restored
    .find((row) => row.mode === "cowork")
    ?.turns[0].items.flatMap((item) => item.generatedFiles ?? [])[0];
  assert.ok(output?.digest);
  assert.equal(
    new GeneratedBlobs(target.root).read(output.digest).toString(),
    "Cowork report",
  );
  assert.deepEqual(await importer.run(0, [picked.source.id]), {
    imported: 0,
    skipped: 3,
  });

  const reexport = await transfer(reopened, "target").export(0, root);
  assert.ok(reexport.ok && reexport.writtenPath);
  const reexported = await JSZip.loadAsync(
    fs.readFileSync(reexport.writtenPath),
  );
  const reexportedChat = sessionMetadata(
    reexported,
    "local-agent-mode-sessions",
    restoredChat.id,
  );
  const reexportedMetadata = JSON.parse(await reexportedChat.async("string"));
  assert.equal(reexportedMetadata.spaceId, archiveSpace.id);
  const reexportedSpaces = reexported.file(
    `${path.posix.dirname(reexportedChat.name)}/spaces.json`,
  );
  assert.ok(reexportedSpaces);
  assert.deepEqual(JSON.parse(await reexportedSpaces.async("string")), {
    spaces: [archiveSpace],
  });

  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const events: unknown[][] = [];
  let notify: ((event: AppEvent) => void) | undefined;
  registerExperimentalCoworkSessions({
    ctx: {
      onEvent: (listener: (event: AppEvent) => void) => {
        notify = listener;
        return () => {};
      },
      localListConversations: async () => target.conversations,
      localLoadConversation: async (id: string) => target.conversation(id),
      localCall: async (name: string) => {
        assert.equal(name, "snapshot");
        return { approvals: [] };
      },
    },
    on: (name: string, handle: (...args: unknown[]) => unknown) =>
      handlers.set(name, handle),
    emit: (...args: unknown[]) => events.push(args),
  } as never);
  assert.ok(notify);
  notify({ type: "resync" });
  assert.deepEqual(events, [
    [
      "LocalAgentModeSessions",
      "onEvent",
      { type: "initialized", sessionId: "" },
    ],
  ]);
  const getCowork = async () =>
    (await handlers.get("LocalAgentModeSessions.getSessionList")!()) as {
      sessions: {
        sessionId: string;
        importedFrom?: string;
        resumeConfirmed?: boolean;
        errorCategory?: string;
      }[];
    };
  const pending = (await getCowork()).sessions[0];
  assert.equal(pending.importedFrom, "local-1p-cowork");
  assert.equal(pending.errorCategory, "imported_needs_resume_confirm");
  await assert.rejects(
    async () =>
      handlers.get("LocalAgentModeSessions.sendMessage")!(
        pending.sessionId,
        "Continue",
      ),
    /trust this imported session/,
  );
  assert.equal(await importer.confirm(pending.sessionId), true);
  const confirmed = (await getCowork()).sessions[0];
  assert.equal(confirmed.resumeConfirmed, true);
  assert.equal(confirmed.errorCategory, undefined);
});

function sessionMetadata(zip: JSZip, tree: string, id: string) {
  const entry = Object.values(zip.files).find(
    ({ name }) =>
      name.startsWith(`${tree}/`) && name.endsWith(`/local_${id}.json`),
  );
  assert.ok(entry);
  return entry;
}
