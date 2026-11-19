import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readClaudeTranscript } from "../../electron/conversations/claude-transcripts";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { createCodeFork } from "../../electron/official-ui/native/code-history";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import type { Conversation, Turn } from "../../shared/types";
import {
  CodexHost,
  MockResponses,
  MODEL,
  historyText,
  tempRoot,
  message,
  until,
} from "../spikes/harness";

test(
  "native Code fork retains the selected history on the real Codex branch and after reopening",
  { timeout: 120_000 },
  async () => {
    const root = tempRoot("f106-code-fork");
    const mock = await new MockResponses().start();
    const host = new CodexHost(path.join(root, "codex-home"), mock);
    const store = new Store(path.join(root, "profile"));
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    const cwd = path.join(root, "source"),
      target = path.join(root, "target");
    fs.mkdirSync(target);
    mock.script = (_, index) => [message(`F106_REPLY_${index}`)];
    try {
      await host.start();
      const threadId = await host.thread(MODEL, cwd, {
        approvalPolicy: "never",
      });
      const turns: Turn[] = [];
      for (const prompt of ["F106_FIRST", "F106_SECOND", "F106_THIRD"]) {
        const result = await host.turn(threadId, prompt);
        turns.push({
          id: result.start.turn.id,
          prompt,
          attachments: [],
          createdAt: Date.now(),
          status: "completed",
          items: result.items.filter((item) => item.type !== "userMessage"),
        });
      }
      const source: Conversation = {
        id: randomUUID(),
        title: "Fork source",
        mode: "code",
        providerId: "default",
        model: MODEL,
        cwd,
        threadId,
        pinned: true,
        archived: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sessionAuthors: {
          ownerAccountUuid: "fixture",
          viewerAccountUuid: "fixture",
        },
        turns,
      };
      store.conversations.push(source);
      store.flush();
      await host.rpc.call("thread/archive", { threadId });
      engine.rpc = host.rpc;
      engine.ensure = async () => {};
      engine.assertModel = () => {};
      engine.threadOptions = (c, _provider, model) => ({
        model,
        modelProvider: "spike",
        cwd: c.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: {},
        developerInstructions: "",
      });
      const canceledFork = randomUUID();
      await assert.rejects(
        engine.forkConversation(
          source.id,
          turns.at(-1)?.id,
          undefined,
          undefined,
          () => !engine.pendingSend,
          { conversationId: canceledFork },
        ),
        /account or engine changed/i,
      );
      assert.equal(engine.pendingSend, false);
      assert.equal(store.conversations.some(row => row.id === canceledFork), false);
      const fork = createCodeFork({
        current: () => true,
        load: async (id) =>
          structuredClone(
            store.conversations.find((row) => row.id === id.slice(6)),
          ),
        convert: convertCodeTranscript,
        reserve: () => true,
        fork: (id, options) =>
          engine.forkConversation(
            id,
            options.turnId,
            undefined,
            undefined,
            () => true,
            options,
          ),
      });
      const cases = [
        {
          message: `${turns[1].id}:user`,
          prompts: ["F106_FIRST"],
          replies: ["F106_REPLY_0"],
        },
        {
          message: `${turns[1].id}:item:${turns[1].items[0].id}`,
          prompts: ["F106_FIRST", "F106_SECOND"],
          replies: ["F106_REPLY_0"],
        },
        { message: `${turns[0].id}:user`, prompts: [], replies: [] },
        {
          message: undefined,
          prompts: ["F106_FIRST", "F106_SECOND", "F106_THIRD"],
          replies: ["F106_REPLY_0", "F106_REPLY_1", "F106_REPLY_2"],
        },
      ];
      for (const [index, scenario] of cases.entries()) {
        const requested = randomUUID();
        const result = await fork(
          "local_" + source.id,
          "local_" + requested,
          scenario.message,
          target,
        );
        assert.equal(result.sessionId, "local_" + requested);
        const child = store.conversation(requested);
        assert.equal(child.cwd, fs.realpathSync(target));
        assert.equal(child.archived, false);
        assert.deepEqual(
          child.turns.map((turn) => turn.prompt),
          scenario.prompts,
        );
        assert.deepEqual(child.sessionAuthors, source.sessionAuthors);
        assert.notEqual(child.threadId, source.threadId);
        await host.turn(child.threadId!, "F106_CHILD_CONTINUE_" + index);
        const input = JSON.stringify(mock.requests.at(-1)?.input);
        for (const prompt of ["F106_FIRST", "F106_SECOND", "F106_THIRD"])
          assert.equal(
            input.includes(prompt),
            scenario.prompts.includes(prompt),
            prompt,
          );
        for (const reply of ["F106_REPLY_0", "F106_REPLY_1", "F106_REPLY_2"])
          assert.equal(
            input.includes(reply),
            scenario.replies.includes(reply),
            reply,
          );
        assert.ok(input.includes(target));
        const reopened = new Store(store.root).conversation(requested);
        assert.deepEqual(reopened.turns, child.turns);
        assert.equal(reopened.threadId, child.threadId);
      }
      assert.deepEqual(source.turns, turns);
      assert.equal(source.archived, true);
      assert.equal(source.threadId, threadId);
      await host.rpc.call("thread/unarchive", { threadId });
      await host.rpc.call("thread/resume", {
        threadId,
        model: MODEL,
        modelProvider: "spike",
        cwd,
      });
      source.archived = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pendingRequest = false;
      mock.script = async (body, index) => {
        if (body.client_metadata?.thread_id === threadId) {
          pendingRequest = true;
          await held;
        }
        return [message("F106_ACTIVE_REPLY_" + index)];
      };
      const activeWork = host.turn(threadId, "F106_ACTIVE_PARENT");
      await until(() => pendingRequest, "parent active request");
      const activeId = host.notifications
        .filter(
          (event) =>
            event.method === "turn/started" &&
            event.params.threadId === threadId,
        )
        .at(-1)!.params.turn.id;
      const activeTurn: Turn = {
        id: activeId,
        prompt: "F106_ACTIVE_PARENT",
        createdAt: Date.now(),
        status: "inProgress",
        attachments: [],
        items: [],
      };
      source.turns.push(activeTurn);
      try {
        for (const boundary of [`${turns[1].id}:user`, `${activeId}:user`]) {
          const during = await fork(
            "local_" + source.id,
            undefined,
            boundary,
            target,
          );
          const child = store.conversation(during.sessionId.slice(6));
          assert.equal(
            child.turns.some((turn) => turn.id === activeId),
            false,
          );
          assert.equal(activeTurn.status, "inProgress");
          await host.turn(child.threadId!, "F106_CHILD_WHILE_PARENT_ACTIVE");
          assert.equal(
            JSON.stringify(mock.requests.at(-1)?.input).includes(
              "F106_ACTIVE_PARENT",
            ),
            false,
          );
          assert.equal(
            host.notifications.some(
              (event) =>
                event.method === "turn/completed" &&
                event.params.turn.id === activeId,
            ),
            false,
          );
        }
      } finally {
        release();
        const completed = await activeWork;
        activeTurn.status = "completed";
        activeTurn.items = completed.items.filter(
          (item) => item.type !== "userMessage",
        );
      }
      fs.renameSync(cwd, cwd + "-moved");
      const recovered = await fork(
        "local_" + source.id,
        undefined,
        undefined,
        target,
      );
      assert.equal(
        store.conversation(recovered.sessionId.slice(6)).cwd,
        fs.realpathSync(target),
      );
      turns[1].refusedPrompt = { model: "gpt-5.1-codex" };
      const restoredModel = await fork(
        "local_" + source.id,
        undefined,
        `${turns[1].id}:user`,
        target,
      );
      const restoredChild = store.conversation(
        restoredModel.sessionId.slice(6),
      );
      assert.equal(restoredChild.model, "gpt-5.1-codex");
      await host.turn(restoredChild.threadId!, "F106_RESTORED_MODEL");
      assert.equal(mock.requests.at(-1)?.model, "gpt-5.1-codex");
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
  "an imported Code fork sends only the selected history on a new Codex thread",
  { timeout: 120_000 },
  async () => {
    const root = tempRoot("f106-imported-code-fork");
    const mock = await new MockResponses().start();
    const host = new CodexHost(path.join(root, "codex-home"), mock);
    const store = new Store(path.join(root, "profile"));
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const rows = [
      ["user", "imported-user", "F106_IMPORT_QUESTION"],
      ["assistant", "imported-reply", "F106_IMPORT_RETAINED"],
      ["assistant", "imported-later", "F106_IMPORT_EXCLUDED"],
    ];
    const { turns } = readClaudeTranscript(
      rows
        .map(([type, uuid, content], i) =>
          JSON.stringify({
            type,
            uuid,
            sessionId: "cli-id",
            parentUuid: rows[i - 1]?.[1] ?? null,
            message: { role: type, content },
          }),
        )
        .join("\n"),
      "cli-id",
    );
    const source: Conversation = {
      id: randomUUID(),
      title: "Imported Code session",
      mode: "code",
      cwd,
      providerId: "default",
      model: MODEL,
      turns,
      importedHistory: true,
      importedCliSessionId: "cli-id",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    };
    store.conversations.push(source);
    store.flush();
    const engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    const realThreadOptions = engine.threadOptions.bind(engine);
    engine.threadOptions = (...args) => ({
      ...realThreadOptions(...args),
      modelProvider: "spike",
      approvalPolicy: "never",
    });
    engine.ensure = async () => {};
    try {
      await host.start();
      engine.rpc = host.rpc;
      host.rpc.on("notification", (notification) =>
        engine.notification(notification),
      );
      const fork = createCodeFork({
        current: () => true,
        load: async (id) =>
          structuredClone(
            store.conversations.find((row) => row.id === id.slice(6)),
          ),
        convert: convertCodeTranscript,
        reserve: () => true,
        fork: (id, options) =>
          engine.forkConversation(
            id,
            options.turnId,
            undefined,
            undefined,
            () => true,
            options,
          ),
      });
      const send = async (c: Conversation, text: string) => {
        await engine.send({
          conversationId: c.id,
          text,
          attachments: [],
          mode: "code",
          cwd,
          providerId: c.providerId,
          model: c.model,
        });
        await until(
          () => c.turns.at(-1)?.status === "completed",
          `completed ${text}`,
        );
        assert.ok(c.threadId);
        const request = mock.forThread(c.threadId).at(-1);
        assert.ok(request);
        return historyText(request);
      };
      for (const continued of [false, true]) {
        if (continued) await send(source, "F106_PARENT_NATIVE_TURN");
        const original = structuredClone(source.turns);
        const parentThread = source.threadId;
        const childId = randomUUID();
        const branch = () =>
          fork("local_" + source.id, "local_" + childId, "imported-later");
        const result = await branch();
        assert.equal(result.sessionId, "local_" + childId);
        assert.equal(
          new Store(store.root).conversation(childId).threadId,
          undefined,
        );
        const child = store.conversation(childId);
        const context = await send(child, "F106_CONTINUE_IMPORTED_FORK");
        assert.notEqual(child.threadId, parentThread);
        assert.match(context, /F106_IMPORT_QUESTION/);
        assert.match(context, /F106_IMPORT_RETAINED/);
        assert.match(context, /F106_CONTINUE_IMPORTED_FORK/);
        assert.doesNotMatch(
          context,
          /F106_IMPORT_EXCLUDED|F106_PARENT_NATIVE_TURN/,
        );
        assert.deepEqual(source.turns, original);
        assert.equal(source.threadId, parentThread);
        assert.deepEqual(await branch(), result);
      }
      const native = await fork("local_" + source.id, undefined);
      const nativeChild = store.conversation(native.sessionId.slice(6));
      assert.ok(nativeChild.threadId);
      assert.notEqual(nativeChild.threadId, source.threadId);
      assert.match(
        await send(nativeChild, "F106_CONTINUE_NATIVE_FORK"),
        /F106_PARENT_NATIVE_TURN/,
      );
    } finally {
      engine.rpc = undefined;
      await host.stop();
      await mock.close();
      for (const timer of engine.notificationTimer.values())
        clearTimeout(timer);
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
