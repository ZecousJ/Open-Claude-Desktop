import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { createCodeRewind } from "../../electron/official-ui/native/code-rewind";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import { rewindCodeFiles } from "../../electron/engine/code-file-rewind";
import { rewindChanges } from "../../shared/rewind-files";
import type { Conversation, Turn } from "../../shared/types";
import {
  CodexHost,
  MockResponses,
  MODEL,
  tempRoot,
  message,
  until,
  flattenTools,
  functionCall,
} from "../spikes/harness";

test(
  "native rewind and Undo use actual Codex history, including a steered prompt",
  { timeout: 120_000 },
  async () => {
    const root = tempRoot("f106-rewind"),
      mock = await new MockResponses().start();
    const store = new Store(path.join(root, "profile"));
    const host = new CodexHost(path.join(store.root, "codex-home"), mock);
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    try {
      await host.start();
      const cwd = path.join(root, "workspace"),
        threadId = await host.thread(MODEL, cwd, { approvalPolicy: "never" });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      mock.script = async (_, index) => {
        if (index === 0) await held;
        return [message(`REWIND_REPLY_${index}`)];
      };
      const task = host.turn(threadId, "REWIND_FIRST");
      await until(() => mock.requests.length > 0, "first model request");
      const active = host.notifications.find(
        (event) => event.method === "turn/started",
      )!.params.turn.id;
      await host.rpc.call("turn/steer", {
        threadId,
        expectedTurnId: active,
        input: [{ type: "text", text: "REWIND_STEER", text_elements: [] }],
      });
      release();
      const first = await task;
      const second = await host.turn(threadId, "REWIND_SECOND");
      const steer = first.items.find(
        (item) =>
          item.type === "userMessage" &&
          JSON.stringify(item).includes("REWIND_STEER"),
      );
      assert.ok(steer, "the SDK records the accepted steer as a user message");
      const firstTurn: Turn = {
        id: first.start.turn.id,
        prompt: "REWIND_FIRST",
        attachments: [],
        createdAt: Date.now(),
        status: "completed",
        items: first.items
          .filter((item) => item.type !== "userMessage" || item.id === steer.id)
          .map((item) =>
            item.id === steer.id
              ? {
                  ...item,
                  steered: true,
                  clientId: "steer-client",
                  text: "REWIND_STEER",
                  attachments: [],
                }
              : item,
          ),
      };
      const turns: Turn[] = [
        firstTurn,
        {
          id: second.start.turn.id,
          prompt: "REWIND_SECOND",
          attachments: [],
          createdAt: Date.now(),
          status: "completed",
          items: second.items.filter((item) => item.type !== "userMessage"),
        },
      ];
      const source: Conversation = {
        id: randomUUID(),
        title: "Rewind",
        mode: "code",
        providerId: "default",
        model: MODEL,
        cwd,
        threadId,
        pinned: false,
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns,
      };
      store.conversations.push(source);
      store.flush();
      engine.rpc = host.rpc;
      engine.ensure = async () => {};
      engine.assertModel = () => {};
      engine.threadOptions = (c) => ({
        model: MODEL,
        modelProvider: "spike",
        cwd: c.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: {},
        developerInstructions: "",
      });
      const rewind = createCodeRewind({
        current: () => true,
        reserve: () => true,
        load: async () => structuredClone(source),
        convert: convertCodeTranscript,
        call: (method, id, turn) =>
          method === "swapRewind"
            ? engine.swapRewind(id)
            : engine.rewindConversation(id, turn),
      });
      assert.deepEqual(
        await rewind.rewind("local_" + source.id, "steer-client"),
        { prefill: "REWIND_STEER" },
      );
      assert.equal(source.turns.length, 1);
      assert.equal(
        source.turns[0].items.some((item) => item.id === steer.id),
        false,
      );
      await host.turn(source.threadId!, "REWIND_CONTINUE");
      const continued = JSON.stringify(mock.requests.at(-1)?.input);
      assert.ok(continued.includes("REWIND_FIRST"));
      assert.equal(continued.includes("REWIND_STEER"), false);
      assert.equal(continued.includes("REWIND_SECOND"), false);
      await rewind.undo("local_" + source.id);
      assert.equal(source.threadId, threadId);
      assert.deepEqual(source.turns, turns);
      const reopened = new Store(store.root);
      assert.deepEqual(reopened.conversation(source.id).turns, turns);
      reopened.flush();
    } finally {
      engine.rpc = undefined;
      await host.stop();
      await mock.close();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "recorded real Codex file edits support dry-run and restore actual disk bytes",
  { timeout: 120_000 },
  async () => {
    const root = tempRoot("f106-file-sdk"),
      mock = await new MockResponses().start();
    const host = new CodexHost(path.join(root, "codex-home"), mock);
    try {
      await host.start();
      const cwd = path.join(root, "workspace"),
        threadId = await host.thread(MODEL, cwd, { approvalPolicy: "never" });
      const file = path.join(cwd, "created.txt");
      mock.script = (body) => {
        if (
          (body.input ?? []).some(
            (item: { call_id?: string; type: string }) =>
              item.call_id === "patch_rewind" && item.type.endsWith("_output"),
          )
        )
          return [message("FILE_DONE")];
        const tool = flattenTools(body.tools).find(
          (item) => item.name === "apply_patch",
        );
        assert.ok(tool);
        const input = `*** Begin Patch\n*** Add File: ${file}\n+created by SDK\n*** End Patch`;
        return [
          tool.type === "custom"
            ? {
                id: "ct_patch_rewind",
                type: "custom_tool_call",
                call_id: "patch_rewind",
                name: "apply_patch",
                input,
                status: "completed",
              }
            : functionCall(tool, "patch_rewind", { input }),
        ];
      };
      const result = await host.turn(threadId, "Create the fixture file");
      assert.equal(fs.readFileSync(file, "utf8"), "created by SDK\n");
      const turn: Turn = {
        id: result.start.turn.id,
        prompt: "Create",
        attachments: [],
        status: "completed",
        createdAt: Date.now(),
        items: result.items,
      };
      const changes = rewindChanges([turn]);
      assert.equal(changes.length, 1);
      assert.equal(rewindCodeFiles(changes, cwd, true).canRewind, true);
      assert.equal(fs.existsSync(file), true);
      assert.equal(rewindCodeFiles(changes, cwd, false).canRewind, true);
      assert.equal(fs.existsSync(file), false);
    } finally {
      await host.stop();
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
