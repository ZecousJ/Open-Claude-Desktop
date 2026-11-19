import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import { registerOfficialAttachmentHandlers } from "../electron/ipc/official-attachments";
import { AttachmentSelectionGrants } from "../electron/official-ui/native/attachment-selection-grants";
import { openPolicy } from "../shared/client-policy";

test("Cowork inline images and internal file-byte extension use policy-checked storage and replay", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-cowork-storage-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ipc = new Map<string, (...args: any[]) => any>();
  const selectedAttachments = new Map<string, any>();
  registerOfficialAttachmentHandlers((name, fn) => ipc.set(name, fn), {
    store: { root },
    selectedAttachments,
    policy: () => openPolicy,
  } as never);
  const conversation: any = {
    id: "stored",
    title: "Task",
    mode: "cowork",
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    cwd: root,
    turns: [],
  };
  let sent = 0;
  const identity = {},
    caller = {};
  const attachmentSelections = new AttachmentSelectionGrants(() => ({
    owner: "owner",
    activation: identity,
  }));
  const makeHost = () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    registerExperimentalCoworkSessions({
      caller,
      attachmentSelections,
      takeSelectedAttachments(
        window: object,
        paths: string[],
        budget: number,
        target: string,
      ) {
        assert.equal(target, "local_stored");
        return attachmentSelections.take(
          window,
          paths,
          budget,
          "session-fixture",
        );
      },
      ctx: {
        stateDirectory: () => root,
        account: () => ({ id: "owner" }),
        sessionIdentity: () => identity,
        settings: () => ({
          providers: [{ id: "p", model: "m" }],
          activeProviderId: "p",
        }),
        localLoadConversation: async (id: string) =>
          id === conversation.id ? conversation : undefined,
        localCall: async (name: string, ...args: any[]) => {
          if (ipc.has(name)) return ipc.get(name)!(...args);
          if (name !== "send") throw Error(`Unexpected call ${name}`);
          const input = args[0];
          assert.equal(input.mode, "cowork");
          const attachments = input.attachments.map(
            ({ id }: { id: string }) => {
              const attachment = selectedAttachments.get(id);
              assert.ok(
                attachment,
                "engine input must reference the host's attachment registry",
              );
              return attachment;
            },
          );
          conversation.turns.push({
            id: `turn-${++sent}`,
            prompt: input.text,
            attachments,
            status: "completed",
            createdAt: sent,
            items: [],
          });
          return conversation;
        },
        onEvent: () => () => {},
        log() {},
      },
      on(name: string, fn: (...args: any[]) => any) {
        handlers.set(name, fn);
      },
      emit() {},
    } as never);
    return (method: string, ...args: any[]) =>
      handlers.get(`LocalAgentModeSessions.${method}`)!(...args);
  };
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const run = makeHost();
  await run("start", {
    message: "read attachments",
    images: [{ mimeType: "image/png", base64: png }],
    userSelectedFiles: [
      { name: "notes.txt", base64: Buffer.from("notes").toString("base64") },
    ],
  });
  assert.equal(sent, 1);
  const [picture, document] = conversation.turns[0].attachments;
  assert.equal(fs.readFileSync(picture.path).toString("base64"), png);
  assert.equal(fs.readFileSync(document.path, "utf8"), "notes");
  const persisted = fs.readdirSync(path.join(root, "attachments"));
  await assert.rejects(
    run(
      "sendMessage",
      "local_stored",
      "bad file",
      [],
      [{ name: "bad.exe", base64: "YQ==" }],
    ),
  );
  assert.equal(sent, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "attachments")), persisted);
  // Recreated adapters read persisted conversation attachments, not volatile
  // composer selection, and do not need to resend or restage a completed turn.
  selectedAttachments.clear();
  const reopened = makeHost();
  const rows = await reopened("getTranscript", "local_stored");
  assert.equal(rows[0].message.content[0].source.data, png);
  assert.deepEqual(rows[0].file_attachments, [
    { file_uuid: document.id, file_name: "notes.txt", is_image: false },
  ]);
  assert.equal(sent, 1);
  // Official Cowork wire format: a path minted by the account's host store
  // (the same result FileSystem.savePastedFile returns), not arbitrary OS input.
  selectedAttachments.clear();
  await reopened("sendMessage", "local_stored", "", [], [document.path]);
  assert.equal(sent, 2);
  assert.equal(conversation.turns[1].attachments[0].id, document.id);
  assert.deepEqual(fs.readdirSync(path.join(root, "attachments")), persisted);
  // Unit-level trusted selection fixture, not an OS picker/E2E claim.
  const external = path.join(fs.realpathSync(root), "selected.txt");
  fs.writeFileSync(external, "explicitly selected fixture");
  attachmentSelections.grant(caller, [external], "session-fixture");
  await reopened("sendMessage", "local_stored", "", [], [external]);
  assert.equal(sent, 3);
  const selected = conversation.turns[2].attachments[0];
  assert.notEqual(selected.path, external);
  assert.equal(
    fs.readFileSync(selected.path, "utf8"),
    "explicitly selected fixture",
  );
  await assert.rejects(
    reopened("sendMessage", "local_stored", "", [], [external]),
    /Select/,
  );
  assert.equal(sent, 3);
});
