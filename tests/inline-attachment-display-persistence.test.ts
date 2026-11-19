import { coworkFolderGrants } from "../electron/workspace/cowork-folders";
import { Readable } from "node:stream";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import { flushState, writeState } from "../electron/official-ui/api/state";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { Engine } from "../electron/engine/engine";
import { Store } from "../electron/store/store";
import { CloudRouter } from "../electron/cloud/cloud-router";
import { registerComposerHandlers } from "../electron/ipc/composer";
import { registerConversationTurnHandlers } from "../electron/ipc/conversation-turn-handlers";
import { withNativeCompletionAttachments } from "../electron/official-ui/api/native-completion-attachments";
import {
  projectInlineAttachmentDisplays,
  inlineDisplayForSend,
} from "../electron/official-ui/api/inline-attachment-displays";
import {
  conversationsRoute,
  conversationRestMessages,
  rememberTurnIds,
  assistantMessageId,
  userMessageId,
} from "../electron/official-ui/api/conversations";
import { conversationUpdate } from "../electron/official-ui/api/timeline";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { knownFile, loadFileRegistry, storeUpload } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import { storeAttachment } from "../electron/engine/composer-files";
import { prepareDerivedTextAttachment } from "../electron/engine/derived-text-attachment";
import { openPolicy } from "../shared/client-policy";
import {
  splitConversation,
  parseTurnDoc,
  joinConversation,
} from "../shared/web-docs";
import { inlineDisplayKey } from "../shared/inline-attachment-display";
import type { Conversation, Turn, Attachment } from "../shared/types";

const sourceText =
  "Alpha paragraph.\n\nHello **bold** world and [link](https://example.invalid).";
const excerpt = "Hello bold world and link.";
const originalName = "excerpt_from_previous_claude_message.txt";
const sourceTurn = (): Turn => ({
  id: "source",
  prompt: "source question",
  promptVersionId: "source-prompt",
  items: [{ id: "answer", type: "agentMessage", text: sourceText }],
  attachments: [],
  status: "completed",
  createdAt: 1,
});
function fixture(t: any, mode: "chat" | "cowork" = "chat") {
  const scopes: ReturnType<typeof newAdapterScope>[] = [];
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "inline-display-boundary-")),
  );
  let store = new Store(path.join(root, "runner"));
  store.settings.providers = [
    {
      id: "p",
      name: "Inert",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m"],
    },
  ];
  store.settings.activeProviderId = "p";
  const id = randomUUID(),
    identity = {};
  store.conversations.push({
    id,
    title: "Fixture",
    mode,
    providerId: "p",
    model: "m",
    threadId: "thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [sourceTurn()],
  });
  if (mode === "cowork")
    coworkFolderGrants(store.root).grantConversation(
      store.conversation(id),
      root,
    );
  let engine: Engine,
    ipc: any,
    handlers: Map<string, Function>,
    sends = 0,
    uploadCount = 0,
    live = true,
    supports = true;
  const modelInputs: unknown[] = [];
  function boot() {
    engine = new Engine(
      store,
      "unused",
      () => "",
      () => {},
    );
    engine.policy = () => openPolicy;
    engine.ensure = async () => {};
    (engine as any).windowsSandbox = {
      assertReady() {},
      async ensureReady() {},
    };
    (engine as any).loaded.add(store.conversation(id).threadId);
    engine.rpc = {
      call: async (method: string, params: any) => {
        if (method === "thread/start" || method === "thread/fork")
          return { thread: { id: "branch-" + randomUUID() } };
        if (method === "turn/start") {
          sends++;
          modelInputs.push(params.input);
          store.flush();
          assert.deepEqual(
            new Store(store.root).conversation(id).turns.at(-1)!
              .inlineAttachmentDisplays,
            store.conversation(id).turns.at(-1)!.inlineAttachmentDisplays,
          );
          return { turn: { id: "reply-" + sends } };
        }
        return {};
      },
    } as any;
    handlers = new Map();
    ipc = {
      store,
      engine,
      activeAccount: { id: "owner" },
      accountActivationIdentity: identity,
      accountRetiring: false,
      selectedAttachments: new Map(),
      allowedFolder() {},
      services: {},
      policy: () => openPolicy,
    };
    const handle = (name: string, fn: Function) => handlers.set(name, fn);
    registerComposerHandlers(handle as any, ipc);
    registerConversationTurnHandlers({
      context: ipc,
      handle,
      cli: {},
      resumable: {},
    } as any);
    handlers.set("conversationTurns", () =>
      structuredClone({
        turns: store.conversation(id).turns,
        savedBranches: store.conversation(id).savedBranches,
      }),
    );
  }
  boot();
  const locals = new Map<string, Attachment>(),
    macRoot = path.join(root, "mac"),
    macIdentity = {};
  fs.mkdirSync(macRoot, { recursive: true });
  const client: any = {
    snapshot: async () => ({
      snapshot: { ...(supports ? { inlineAttachmentDisplayVersion: 1 } : {}) },
    }),
    call: async (name: string, args: unknown[]) => {
      if (name === "addAttachmentData") uploadCount++;
      return handlers.get(name)!(...args);
    },
  };
  const router = new CloudRouter({
    client: () => (live ? client : undefined),
    push() {},
    attachmentBytes: async (id) => {
      const local = locals.get(id);
      return local
        ? {
            name: local.name,
            data: new Uint8Array(fs.readFileSync(local.path)),
          }
        : undefined;
    },
    receiptScope: () => ({
      root: macRoot,
      service: "https://fixture.invalid",
      current: () => live,
      attachment: (id) => locals.get(id),
    }),
  });
  router.conversations.add(id);
  const macScope = newAdapterScope("owner", macRoot, macIdentity);
  scopes.push(macScope);
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => macIdentity,
    stateDirectory: () => macRoot,
    isCurrent: () => live,
    settings: () => store.settings,
    loadConversation: async () => structuredClone(store.conversation(id)),
    log() {},
    call: async (name: string, ...args: any[]) => {
      if (name === "addAttachmentData") {
        const row = storeAttachment(
          path.join(macRoot, "attachments"),
          args[0],
          args[1],
          openPolicy,
        );
        locals.set(row.id, row);
        return row;
      }
      if (name === "send")
        return router.send(args[0], () => {
          throw Error("unexpected local send");
        });
      return router.route(name, () => {
        throw Error("unexpected local operation");
      })(...args);
    },
  };
  const native = withNativeCompletionAttachments(ctx);
  async function nativeSend(
    text = "Explain Emerald",
    selected = excerpt,
    role: "assistant" | "user" = "assistant",
  ) {
    return inAdapterScope(macScope, async () => {
      const source = store.conversation(id).turns[0];
      rememberTurnIds(source, { user: randomUUID(), assistant: randomUUID() });
      const assets = fs.readFileSync(
        "build/official-ui/ui/assets/v1/shared-m-1-Nm0kn4Ee.js",
        "utf8",
      );
      const scope: any = {
        Blob,
        GI: originalName,
        rM: { UserUpload: "user_upload" },
        dS: { Excerpt: "excerpt" },
      };
      vm.runInNewContext(
        assets.slice(
          assets.indexOf("function OF("),
          assets.indexOf("function mx("),
        ) + ";this.quote=OF;",
        scope,
      );
      const inline = JSON.parse(JSON.stringify(scope.quote(selected)));
      inline.quote_message_uuid =
        role === "assistant"
          ? assistantMessageId(source)
          : userMessageId(source);
      const prepared = await native.prepareCompletionAttachments!({
        model: "m",
        providerId: "p",
        conversationId: id,
        files: [],
        attachments: [inline],
      });
      return native.submitCompletionWithAttachments!(
        {
          conversationId: id,
          text,
          mode,
          attachments: [],
          providerId: "p",
          model: "m",
        },
        prepared,
      );
    });
  }
  function reader() {
    const readRoot = path.join(root, "windows-" + randomUUID()),
      readIdentity = {};
    fs.mkdirSync(readRoot, { recursive: true });
    const scope = newAdapterScope("owner", readRoot, readIdentity);
    scopes.push(scope);
    const ctx: any = {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => readIdentity,
      stateDirectory: () => readRoot,
      isCurrent: () => live,
      loadConversation: async () => structuredClone(store.conversation(id)),
      call: async (name: string, ...args: any[]) =>
        handlers.get(name)!(...args),
      log() {},
    };
    return { scope, ctx };
  }
  t.after(() => {
    for (const scope of scopes)
      inAdapterScope(scope, () => {
        for (const key of ["files", "aliases", "message-ids"]) flushState(key);
      });
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    id,
    nativeSend,
    router,
    client,
    macScope,
    ctx,
    locals,
    reader,
    modelInputs,
    get store() {
      return store;
    },
    get engine() {
      return engine;
    },
    get handlers() {
      return handlers;
    },
    get ipc() {
      return ipc;
    },
    get sends() {
      return sends;
    },
    get uploads() {
      return uploadCount;
    },
    supports(value: boolean) {
      supports = value;
    },
    retire() {
      live = false;
      ipc.accountActivationIdentity = {};
    },
    restart() {
      store.flush();
      store = new Store(store.root);
      boot();
    },
    complete() {
      store.conversation(id).turns.at(-1)!.status = "completed";
    },
    get conversation() {
      return store.conversation(id);
    },
  };
}

test("native producer through CloudRouter, handlers, Engine and Store reopens as Quote in a disjoint profile", async (t) => {
  for (const mode of ["chat", "cowork"] as const) {
    const f = fixture(t, mode);
    await f.nativeSend();
    f.complete();
    const sent = f.conversation.turns.at(-1)!;
    assert.equal(sent.inlineAttachmentDisplays?.[0].fileName, originalName);
    assert.deepEqual(sent.inlineAttachmentDisplays?.[0].quoteSource, {
      role: "assistant",
      turnId: "source",
    });
    assert.notEqual(sent.attachments[0].id, [...f.locals.keys()][0]);
    assert.equal(
      sent.inlineAttachmentDisplays?.[0].attachmentId,
      sent.attachments[0].id,
    );
    assert.equal(sent.prompt, "Explain Emerald");
    assert.equal(f.sends, 1);
    assert.equal(fs.readFileSync(sent.attachments[0].path, "utf8"), excerpt);
    assert.equal(JSON.stringify(f.modelInputs[0]).includes(excerpt), true);
    f.restart();
    const split = splitConversation(f.conversation),
      history = joinConversation(
        split.doc,
        split.turns.map((row) => parseTurnDoc(JSON.stringify(row))),
      );
    const r = f.reader();
    await inAdapterScope(r.scope, async () => {
      assert.equal(knownFile(sent.attachments[0].id), undefined);
      rememberTurnIds(history.turns[0], { assistant: "windows-source" });
      const projection = await projectInlineAttachmentDisplays(r.ctx, history, {
        user: userMessageId,
        assistant: assistantMessageId,
      });
      const rest = conversationRestMessages(
        history,
        organizationUuid("owner"),
        projection,
      );
      const message = rest.messages.find(
        (m: any) => m.text === "Explain Emerald",
      )!;
      assert.equal(message.files.length, 0);
      assert.deepEqual(message.attachments, [
        {
          file_name: originalName,
          file_type: "txt",
          file_size: Buffer.byteLength(excerpt),
          extracted_content: excerpt,
          kind: "excerpt",
          quote_message_uuid: "windows-source",
        },
      ]);
      const pb = conversationUpdate(history, false, {
        org: organizationUuid("owner"),
        inlineDisplays: projection,
      });
      assert.equal(
        pb.messages!.find(
          (m: any) =>
            m.role === 1 && m.id === userMessageId(history.turns.at(-1)!),
        )?.attachments[0].fileName,
        originalName,
      );
      let status = 0,
        body: any;
      await conversationsRoute(
        { method: "GET" } as any,
        {
          writeHead: (code: number) => (status = code),
          end: (data: any) => (body = data),
        } as any,
        `/api/organizations/${organizationUuid("owner")}/chat_conversations/${f.id}`,
        new URL("https://fixture.invalid"),
        r.ctx,
      );
      assert.equal(status, 200);
      assert.equal(
        JSON.parse(body).chat_messages.find(
          (m: any) => m.text === "Explain Emerald",
        ).attachments[0].kind,
        "excerpt",
      );
    });
    assert.equal(f.sends, 1);
  }
});

test("retry and prompt edits after restart retain exact bindings and saved-branch sources", async (t) => {
  const f = fixture(t);
  await f.nativeSend("ask", "source question", "user");
  f.complete();
  f.restart();
  let turn = f.conversation.turns.at(-1)!;
  assert.deepEqual(turn.inlineAttachmentDisplays?.[0].quoteSource, {
    role: "user",
    promptKey: "source-prompt",
  });
  await f.handlers.get("retryResponse")!(f.id, turn.id, "p", "m");
  f.complete();
  assert.deepEqual(
    f.conversation.turns.at(-1)!.inlineAttachmentDisplays,
    turn.inlineAttachmentDisplays,
  );
  turn = f.conversation.turns.at(-1)!;
  f.restart();
  await f.handlers.get("editPrompt")!(f.id, turn.id, "edited", "p", "m", {
    attachments: turn.attachments.map((file) => ({ id: file.id })),
  });
  f.complete();
  assert.deepEqual(
    f.conversation.turns.at(-1)!.inlineAttachmentDisplays,
    turn.inlineAttachmentDisplays,
  );
  assert.ok(
    f.conversation.savedBranches?.some((branch) =>
      branch.turns.some((item) => item.id === turn.id),
    ),
  );
  const r = f.reader();
  await inAdapterScope(r.scope, async () =>
    assert.equal(
      (
        await projectInlineAttachmentDisplays(r.ctx, f.conversation, {
          user: userMessageId,
          assistant: assistantMessageId,
        })
      ).get(
        inlineDisplayKey(
          f.conversation.turns.at(-1)!.id,
          turn.attachments[0].id,
        ),
      )?.extracted_content,
      "source question",
    ),
  );
  assert.equal(f.sends, 3);
});

test("ordinary reused attachment never inherits another turn's quote display", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const original = f.conversation.turns.at(-1)!;
  const plain: Turn = {
    ...structuredClone(original),
    id: "plain",
    prompt: "plain",
    inlineAttachmentDisplays: undefined,
  };
  f.conversation.turns.push(plain);
  const r = f.reader();
  await inAdapterScope(r.scope, async () => {
    const displays = await projectInlineAttachmentDisplays(
      r.ctx,
      f.conversation,
      { user: userMessageId, assistant: assistantMessageId },
    );
    const history = conversationRestMessages(
      f.conversation,
      organizationUuid("owner"),
      displays,
    ).messages;
    assert.equal(
      history.find((row: any) => row.text === "plain")!.attachments.length,
      0,
    );
    assert.equal(
      history.find((row: any) => row.text === "plain")!.files[0].file_name,
      original.attachments[0].name,
    );
    assert.equal(
      conversationUpdate(f.conversation, false, {
        org: organizationUuid("owner"),
        inlineDisplays: displays,
      }).messages!.find((row: any) => row.id === "plain:user")!.attachments[0]
        .fileName,
      original.attachments[0].name,
    );
  });
});

test("bad bytes, membership, duplicate binding and foreign source fail before model dispatch", async (t) => {
  for (const mode of [
    "bytes",
    "foreign",
    "duplicate",
    "binding",
    "path",
    "non-excerpt",
  ]) {
    const f = fixture(t),
      derived = prepareDerivedTextAttachment({
        fileName: originalName,
        fileType: "txt",
        extractedContent: excerpt,
      });
    const file = await f.handlers.get("addAttachmentData")!(
      derived.name,
      derived.data,
    );
    const display: any = inlineDisplayForSend(
      file.id,
      { file_name: originalName, file_type: "txt", kind: "excerpt" },
      excerpt,
      { role: "assistant", turnId: "source" },
    );
    if (mode === "bytes") fs.writeFileSync(file.path, "changed");
    if (mode === "foreign") display.quoteSource.turnId = "foreign";
    if (mode === "binding") display.attachmentId = "not-selected";
    if (mode === "path")
      ((file.path = path.join(f.root, "outside.txt")),
        fs.writeFileSync(file.path, excerpt));
    if (mode === "non-excerpt") display.kind = "file";
    await assert.rejects(
      f.handlers.get("send")!({
        conversationId: f.id,
        text: "ask",
        mode: "chat",
        attachments: [{ id: file.id }],
        inlineAttachmentDisplays:
          mode === "duplicate" ? [display, display] : [display],
        providerId: "p",
        model: "m",
      }),
    );
    assert.equal(f.sends, 0, mode);
    assert.equal(f.conversation.turns.length, 1, mode);
  }
});

test("source changes after async Engine preparation reject before branch or model mutation", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const turn = f.conversation.turns.at(-1)!;
  f.engine.ensure = async () => {
    await Promise.resolve();
    f.conversation.turns[0].items[0].text = "changed source";
  };
  await assert.rejects(
    f.handlers.get("retryResponse")!(f.id, turn.id, "p", "m"),
    /does not match/,
  );
  assert.equal(f.sends, 1);
  assert.equal(f.conversation.turns.length, 2);
  assert.equal(f.conversation.savedBranches, undefined);
});

test("old Runner rejects provenance before upload or send", async (t) => {
  const f = fixture(t);
  f.supports(false);
  await assert.rejects(f.nativeSend(), /Update the Runner/);
  assert.equal(f.sends, 0);
  assert.equal(f.uploads, 0);
});

test("retirement in the capability continuation prevents upload to the next account", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.client.snapshot = async () => ({
    snapshot: { inlineAttachmentDisplayVersion: 1 },
  });
  const original = f.router.requireInlineDisplaySupport.bind(f.router);
  f.router.requireInlineDisplaySupport = async (value) => {
    await original(value);
    queueMicrotask(() => f.retire());
  };
  f.client.call = async () => {
    calls++;
    throw Error("must not upload");
  };
  await assert.rejects(f.nativeSend(), /account changed/);
  assert.equal(calls, 0);
  assert.equal(f.sends, 0);
});

test("a retired or foreign reader cannot emit display; corrupt history degrades to plain without replay", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const r = f.reader();
  await inAdapterScope(newAdapterScope("other", f.root, {}), async () =>
    assert.rejects(
      projectInlineAttachmentDisplays(r.ctx, f.conversation, {
        user: userMessageId,
        assistant: assistantMessageId,
      }),
      /account changed/,
    ),
  );
  await inAdapterScope(r.scope, async () => {
    const display = f.conversation.turns.at(-1)!.inlineAttachmentDisplays![0];
    display.sha256 = "0".repeat(64);
    assert.equal(
      (
        await projectInlineAttachmentDisplays(r.ctx, f.conversation, {
          user: userMessageId,
          assistant: assistantMessageId,
        })
      ).size,
      0,
    );
    const call = r.ctx.call;
    r.ctx.call = async (...args: any[]) => {
      const answer = await call(...args);
      f.retire();
      return answer;
    };
    await assert.rejects(
      projectInlineAttachmentDisplays(r.ctx, f.conversation, {
        user: userMessageId,
        assistant: assistantMessageId,
      }),
      /account changed/,
    );
  });
  assert.equal(f.sends, 1);
});

test("actual PB full-snapshot prompt edit preserves retained provenance after Runner restart", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  f.restart();
  const turn = f.conversation.turns.at(-1)!;
  const registry = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  );
  const request = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const response = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionResponse",
  )!;
  const route = createActionRpc(
    f.ctx,
    registry,
  );
  await inAdapterScope(f.macScope, async () => {
    conversationUpdate(f.conversation, false, {
      org: organizationUuid("owner"),
    });
    const bytes = toBinary(
      request,
      deepCreate(request, {
        header: { conversationId: f.id },
        action: {
          case: "sendMessage",
          value: {
            messageId: randomUUID(),
            assistantMessageId: randomUUID(),
            parentMessageId: assistantMessageId(f.conversation.turns[0]),
            text: "edited via PB",
            attachments: [
              { id: turn.attachments[0].id, fileName: originalName },
            ],
          },
        },
      }),
    );
    let body: any;
    await route(
      Object.assign(Readable.from([bytes]), {
        method: "POST",
        headers: { "content-type": "application/proto" },
      }) as any,
      {
        writeHead() {},
        end(value: any) {
          body = value;
        },
      } as any,
      PERFORM_ACTION_PATH,
    );
    const answer: any = fromBinary(response, body);
    assert.equal(answer.ack.outcome.case, "applied", JSON.stringify(answer));
    assert.deepEqual(
      f.conversation.turns.at(-1)!.inlineAttachmentDisplays,
      turn.inlineAttachmentDisplays,
    );
  });
  assert.equal(f.sends, 2);
});

test("equal-name uploads bind displays to the exact upload response independent of descriptor order", async (t) => {
  const f = fixture(t);
  f.conversation.turns.push({
    ...sourceTurn(),
    id: "second-source",
    promptVersionId: "second-prompt",
  });
  const derived = prepareDerivedTextAttachment({
    fileName: originalName,
    fileType: "txt",
    extractedContent: excerpt,
  });
  const files = [0, 1].map(() =>
    storeAttachment(
      path.join(f.root, "mac", "attachments"),
      derived.name,
      derived.data,
      openPolicy,
    ),
  );
  for (const file of files) f.locals.set(file.id, file);
  const uploaded: Attachment[] = [];
  const call = f.client.call;
  f.client.call = async (name: string, args: unknown[]) => {
    const result = await call(name, args);
    if (name === "addAttachmentData") uploaded.push(result);
    return result;
  };
  const displays = files.map((file, index) =>
    inlineDisplayForSend(
      file.id,
      { file_name: originalName, file_type: "txt", kind: "excerpt" },
      excerpt,
      { role: "assistant", turnId: index ? "second-source" : "source" },
    ),
  );
  await f.router.send(
    {
      conversationId: f.id,
      text: "two",
      mode: "chat",
      providerId: "p",
      model: "m",
      attachments: files,
      inlineAttachmentDisplays: [displays[1], displays[0]],
    },
    () => {
      throw Error("unexpected local send");
    },
  );
  assert.deepEqual(f.conversation.turns.at(-1)!.inlineAttachmentDisplays, [
    { ...displays[1], attachmentId: uploaded[1].id },
    { ...displays[0], attachmentId: uploaded[0].id },
  ]);
  assert.equal(f.sends, 1);
});

test("duplicate upload response IDs reject before dispatch even with identical names and sizes", async (t) => {
  const f = fixture(t),
    derived = prepareDerivedTextAttachment({
      fileName: originalName,
      fileType: "txt",
      extractedContent: excerpt,
    });
  const files = [0, 1].map(() =>
    storeAttachment(
      path.join(f.root, "mac", "attachments"),
      derived.name,
      derived.data,
      openPolicy,
    ),
  );
  for (const file of files) f.locals.set(file.id, file);
  const call = f.client.call;
  let first: Attachment | undefined;
  f.client.call = async (name: string, args: unknown[]) => {
    if (name !== "addAttachmentData") return call(name, args);
    first ??= await call(name, args);
    return first;
  };
  const displays = files.map((file) =>
    inlineDisplayForSend(
      file.id,
      { file_name: originalName, file_type: "txt", kind: "excerpt" },
      excerpt,
      { role: "assistant", turnId: "source" },
    ),
  );
  await assert.rejects(
    f.router.send(
      {
        conversationId: f.id,
        text: "two",
        mode: "chat",
        providerId: "p",
        model: "m",
        attachments: files,
        inlineAttachmentDisplays: displays,
      },
      () => {},
    ),
    /ambiguous/,
  );
  assert.equal(f.sends, 0);
  assert.equal(f.conversation.turns.length, 1);
});

test("source mutation while forking a retry rejects before saved-branch mutation", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const turn = f.conversation.turns.at(-1)!;
  const rpc = f.engine.rpc!,
    call = rpc.call.bind(rpc);
  rpc.call = async (method: string, params: any) => {
    const answer = await call(method, params);
    if (method === "thread/fork")
      f.conversation.turns[0].items[0].text = "replaced";
    return answer;
  };
  await assert.rejects(
    f.handlers.get("retryResponse")!(f.id, turn.id, "p", "m"),
    /does not match/,
  );
  assert.equal(f.sends, 1);
  assert.equal(f.conversation.savedBranches, undefined);
});

test("an early pending turn loses invalid provenance when async preparation changes its source", async (t) => {
  const f = fixture(t);
  f.engine.ensure = async () => {
    await Promise.resolve();
    f.conversation.turns[0].items[0].text = "replaced";
  };
  await assert.rejects(f.nativeSend(), /does not match/);
  assert.equal(f.sends, 0);
  assert.equal(f.conversation.turns.at(-1)!.status, "failed");
  assert.deepEqual(
    f.conversation.turns.at(-1)!.inlineAttachmentDisplays,
    [],
  );
});

test("metadata-only edit can explicitly clear a display without changing attachment bytes", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const turn = f.conversation.turns.at(-1)!;
  await f.handlers.get("editPrompt")!(f.id, turn.id, turn.prompt, "p", "m", {
    inlineAttachmentDisplays: [],
  });
  assert.deepEqual(f.conversation.turns.at(-1)!.inlineAttachmentDisplays, []);
  assert.equal(fs.readFileSync(turn.attachments[0].path, "utf8"), excerpt);
  assert.equal(f.sends, 2);
});

test("an old Runner also rejects inherited retry provenance without replay", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const turn = f.conversation.turns.at(-1)!;
  f.supports(false);
  await assert.rejects(
    f.router.route("retryResponse", () => {})(f.id, turn.id, "p", "m"),
    /Update the Runner/,
  );
  assert.equal(f.sends, 1);
});

test("PB append and edit preserve canonical retained IDs while adding another inline attachment", async (t) => {
  const f = fixture(t),
    registry = loadRegistry(
      "build/official-ui/data/conversation-protocol.json",
    );
  const request = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const response = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionResponse",
  )!;
  const route = createActionRpc(
    f.ctx,
    registry,
  );
  async function action(value: unknown) {
    let body: any;
    const bytes = toBinary(
      request,
      deepCreate(request, {
        header: { conversationId: f.id },
        action: { case: "sendMessage", value },
      }),
    );
    await route(
      Object.assign(Readable.from([bytes]), {
        method: "POST",
        headers: { "content-type": "application/proto" },
      }) as any,
      {
        writeHead() {},
        end(data: any) {
          body = data;
        },
      } as any,
      PERFORM_ACTION_PATH,
    );
    const result: any = fromBinary(response, body);
    assert.equal(result.ack.outcome.case, "applied", JSON.stringify(result));
  }
  await inAdapterScope(f.macScope, async () => {
    await action({
      messageId: randomUUID(),
      assistantMessageId: randomUUID(),
      text: "PB inline",
      inlineAttachments: [
        { fileName: "one.txt", fileType: "txt", extractedContent: "First" },
      ],
    });
    f.complete();
    const turn = f.conversation.turns.at(-1)!;
    const displays = await projectInlineAttachmentDisplays(
      f.ctx,
      f.conversation,
      { user: userMessageId, assistant: assistantMessageId },
    );
    const update = conversationUpdate(f.conversation, false, {
      org: organizationUuid("owner"),
      inlineDisplays: displays,
    });
    const card = update.messages!.find(
      (message: any) => message.id === userMessageId(turn),
    )!.attachments[0];
    assert.equal(card.id, turn.attachments[0].id);
    assert.notEqual(card.id, [...f.locals.keys()][0]);
    f.restart();
    await action({
      messageId: randomUUID(),
      assistantMessageId: randomUUID(),
      parentMessageId: assistantMessageId(f.conversation.turns[0]),
      text: "PB edited",
      attachments: [card],
      inlineAttachments: [
        { fileName: "two.txt", fileType: "txt", extractedContent: "Second" },
      ],
    });
    const edited = f.conversation.turns.at(-1)!;
    assert.equal(edited.attachments[0].id, turn.attachments[0].id);
    assert.deepEqual(
      edited.inlineAttachmentDisplays?.map((display) => display.fileName),
      ["one.txt", "two.txt"],
    );
  });
  assert.equal(f.sends, 2);
});

test("retry that changes display context receives a distinct prompt identity", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const turn = f.conversation.turns.at(-1)!;
  await f.handlers.get("retryResponse")!(f.id, turn.id, "p", "m", {
    inlineAttachmentDisplays: [],
  });
  f.complete();
  const edited = f.conversation.turns.at(-1)!;
  assert.notEqual(edited.promptVersionId, turn.promptVersionId);
  const r = f.reader();
  await inAdapterScope(r.scope, async () => {
    const projection = await projectInlineAttachmentDisplays(
      r.ctx,
      f.conversation,
      { user: userMessageId, assistant: assistantMessageId },
    );
    const messages = conversationRestMessages(
      f.conversation,
      organizationUuid("owner"),
      projection,
    ).messages.filter((row: any) => row.text === turn.prompt);
    assert.equal(messages.length, 2);
    assert.deepEqual(
      messages.map((row: any) => row.attachments.length),
      [1, 0],
    );
  });
});


test("owning Engine marks new plain sends canonical and retains legacy retry/edit format", async (t) => {
  const f = fixture(t);
  await f.nativeSend();
  f.complete();
  const quoted = f.conversation.turns.at(-1)!;
  delete quoted.inlineAttachmentDisplays;
  await f.handlers.get("retryResponse")!(f.id, quoted.id, "p", "m");
  f.complete();
  const retried = f.conversation.turns.at(-1)!;
  assert.equal("inlineAttachmentDisplays" in retried, false);
  await f.handlers.get("editPrompt")!(f.id, retried.id, "edited legacy", "p", "m", { attachments: retried.attachments.map(file => ({ id: file.id })) });
  f.complete();
  assert.equal("inlineAttachmentDisplays" in f.conversation.turns.at(-1)!, false);
  await f.handlers.get("send")!({ conversationId: f.id, text: "plain reused", mode: "chat", providerId: "p", model: "m", attachments: quoted.attachments.map(file => ({ id: file.id })) });
  f.complete();
  assert.deepEqual(f.conversation.turns.at(-1)!.inlineAttachmentDisplays, []);
  f.restart();
  assert.deepEqual(f.conversation.turns.at(-1)!.inlineAttachmentDisplays, []);
});

async function retainedLegacyQuoteFixture(t: Parameters<typeof fixture>[0], run: (input: { f: ReturnType<typeof fixture>; before: Turn; attachment: Attachment }) => Promise<void>) {
  const f = fixture(t);
  await f.nativeSend("old prompt");
  f.complete();
  const before = f.conversation.turns.at(-1)!;
  const legacyAttachment = before.attachments[0];
  const legacyDisplay = before.inlineAttachmentDisplays![0];
  delete before.inlineAttachmentDisplays;
  f.restart();
  await inAdapterScope(f.macScope, async () => {
    writeState("files", () => ({
      files: [{
        ...legacyAttachment,
        mediaType: "text/plain",
        kind: "blob",
        conversationId: f.id,
        createdAt: 1,
        inlineDisplay: {
          file_name: originalName,
          file_type: "txt",
          kind: "excerpt",
          quote_message_uuid: assistantMessageId(f.conversation.turns[0]),
          sha256: legacyDisplay.sha256,
        },
      }],
      aliases: [],
    }));
    flushState("files");
    loadFileRegistry();
    const ids = { user: userMessageId, assistant: assistantMessageId };
    const initial = await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids);
    assert.equal(initial.get(inlineDisplayKey(before.id, legacyAttachment.id))?.kind, "excerpt");
    await run({ f, before, attachment: legacyAttachment });
    const oldTurns = [...f.conversation.turns, ...(f.conversation.savedBranches ?? []).flatMap(branch => branch.turns)].filter(turn => turn.id === before.id);
    assert.ok(oldTurns.length);
    assert.ok(oldTurns.every(turn => !("inlineAttachmentDisplays" in turn)), "authoring a new turn never backfills the old turn");
  });
}

for (const addition of ["inline text", "uploaded file"] as const) test(`PB full-snapshot edit preserves a retained legacy Quote when adding new ${addition}`, async (t) => {
  await retainedLegacyQuoteFixture(t, async ({ f, before, attachment: legacyAttachment }) => {
    const registry = loadRegistry("build/official-ui/data/conversation-protocol.json");
    const request = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
    const response = registry.getMessage("anthropic.bard.api.v1alpha.PerformActionResponse")!;
    const route = createActionRpc(f.ctx, registry);
    const ids = { user: userMessageId, assistant: assistantMessageId };
    const initial = await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids);
    conversationUpdate(f.conversation, false, {
      org: organizationUuid("owner"),
      inlineDisplays: initial,
    });
    const upload = addition === "uploaded file" ? await storeUpload(f.ctx, "new-upload.txt", Buffer.from("Newly added file"), "text/plain") : undefined;
    const bytes = toBinary(request, deepCreate(request, {
      header: { conversationId: f.id },
      action: {
        case: "sendMessage",
        value: {
          messageId: randomUUID(),
          assistantMessageId: randomUUID(),
          parentMessageId: assistantMessageId(f.conversation.turns[0]),
          text: "edited with old and new files",
          attachments: [{ id: legacyAttachment.id, fileName: originalName }, ...(upload ? [{ id: upload.id, fileName: upload.name }] : [])],
          inlineAttachments: upload ? [] : [{
            fileName: "new-inline.txt",
            fileType: "txt",
            extractedContent: "Newly added text",
          }],
        },
      },
    }));
    let body: Buffer | undefined;
    await route(
      Object.assign(Readable.from([bytes]), {
        method: "POST",
        headers: { "content-type": "application/proto" },
      }) as any,
      {
        writeHead() {},
        end(value: Buffer) { body = value; },
      } as any,
      PERFORM_ACTION_PATH,
    );
    assert.ok(body);
    const answer: any = fromBinary(response, body);
    assert.equal(answer.ack.outcome.case, "applied", JSON.stringify(answer));
    f.complete();
    assert.equal(f.sends, 2);
    f.restart();
    const turn = f.conversation.turns.at(-1)!;
    assert.equal(turn.attachments.length, 2);
    assert.equal(turn.attachments[0].id, legacyAttachment.id);
    const projection = await projectInlineAttachmentDisplays(f.ctx, f.conversation, ids);
    const rest = conversationRestMessages(f.conversation, organizationUuid("owner"), projection);
    const edited = rest.messages.find(message => message.text === "edited with old and new files")!;
    const labels = {
      cards: edited.attachments.map((a: { file_name: string; kind?: string; quote_message_uuid?: string }) =>
        [a.file_name, a.kind ?? null, a.quote_message_uuid ?? null]),
      files: edited.files.map((a: { file_name: string }) => a.file_name),
    };
    assert.deepEqual(labels, {
      cards: [
        [originalName, "excerpt", assistantMessageId(f.conversation.turns[0])],
        ...(upload ? [] : [["new-inline.txt", null, null]]),
      ],
      files: upload ? [upload.name] : [],
    });
  });
});

test("explicitly clearing a new retry does not erase the old legacy quote", async (t) => {
  await retainedLegacyQuoteFixture(t, async ({ f, before, attachment }) => {
    await f.handlers.get("retryResponse")!(f.id, before.id, "p", "m", { inlineAttachmentDisplays: [] });
    f.complete();
    f.restart();
    const retried = f.conversation.turns.at(-1)!;
    const saved = f.conversation.savedBranches!.flatMap(branch => branch.turns).find(turn => turn.id === before.id)!;
    assert.equal("inlineAttachmentDisplays" in saved, false);
    assert.deepEqual(retried.inlineAttachmentDisplays, []);
    const projection = await projectInlineAttachmentDisplays(f.ctx, f.conversation, {
      user: userMessageId, assistant: assistantMessageId,
    });
    assert.deepEqual({
      old: projection.get(inlineDisplayKey(before.id, attachment.id))?.kind,
      cleared: projection.get(inlineDisplayKey(retried.id, attachment.id))?.kind,
    }, { old: "excerpt", cleared: undefined });
  });
});

test("metadata-only edit from legacy absence to explicit empty creates a separate prompt", async t => {
  await retainedLegacyQuoteFixture(t, async ({ f, before, attachment }) => {
    await f.handlers.get("editPrompt")!(f.id, before.id, before.prompt, "p", "m", { inlineAttachmentDisplays: [] });
    f.complete();
    f.restart();
    const edited = f.conversation.turns.at(-1)!;
    assert.deepEqual(edited.inlineAttachmentDisplays, []);
    const projection = await projectInlineAttachmentDisplays(f.ctx, f.conversation, { user: userMessageId, assistant: assistantMessageId });
    assert.equal(projection.get(inlineDisplayKey(before.id, attachment.id))?.kind, "excerpt");
    assert.equal(projection.has(inlineDisplayKey(edited.id, attachment.id)), false);
  });
});
