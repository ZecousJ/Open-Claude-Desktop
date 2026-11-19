/** Actual authenticated handler + runner adapter; inert executor and temporary receipt stores only. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { encodeWireValue } from "../../shared/web-wire";
import {
  officialUiCapabilitiesPath,
  officialUiActionPath,
  type OfficialUiReadRequest,
} from "../../shared/official-ui-web";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { StrictTextExecution } from "../../runner/src/official-ui-text-authority";
const conv = "11111111-1111-4111-8111-111111111111";
const body = () => ({
  prompt: "Inert source test",
  model: "fixture-model",
  tools: [],
  attachments: [],
  files: [],
  sync_sources: [],
  rendering_mode: "messages",
  turn_message_uuids: {
    human_message_uuid: "22222222-2222-4222-8222-222222222222",
    assistant_message_uuid: "33333333-3333-4333-8333-333333333333",
  },
  completion_request_id: "44444444-4444-4444-8444-444444444444",
  create_conversation_params: {
    name: "",
    model: "fixture-model",
    include_conversation_preferences: true,
    is_temporary: false,
  },
});
function fixture(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "strict-text-negotiation-"),
  );
  t.after(async () => {
    t.mock.restoreAll();
    await new Promise((r) => setTimeout(r, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  let identity: unknown = {},
    account = "owner",
    stateRoot = root,
    executes = 0,
    legacySends = 0,
    legacyInterrupts = 0,
    inspectCalls = 0;
  let snapshotHook: () => Promise<void> = async () => {};
  let readiness: any = { state: "ready", reason: "ready" },
    conversation: any;
  let inspect: () => Promise<any> = async () => readiness;
  let executor: (input: StrictTextExecution) => Promise<any> = async (
    input,
  ) => {
    const prior = conversation?.turns ?? [];
    conversation = {
      id: conv,
      mode: "chat",
      providerId: "p",
      model: "fixture-model",
      createdAt: 1,
      updatedAt: 1,
      turns: [
        ...prior,
        {
          id: `turn-${executions.length}`,
          prompt: input.send.text,
          createdAt: 1,
          status: "completed",
          attachments: [],
          items: [{ type: "agentMessage", id: "a", text: "Inert result" }],
        },
      ],
    };
    return conversation;
  };
  const executions: StrictTextExecution[] = [];
  const authority: any = {
    inspect: async () => {
      inspectCalls++;
      return inspect();
    },
    execute: async (input: StrictTextExecution) => {
      executes++;
      executions.push(input);
      return executor(input);
    },
  };
  const ctx: any = {
    selectedAttachments: new Map(),
    userId: 7,
    signedOut: false,
    closedFlag: false,
    get activeAccount() {
      return { id: account, email: "fixture@example.invalid", name: "Fixture" };
    },
    officialSessionIdentity: () => identity,
    setAccessToken() {},
    reclaimCaches() {},
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
    store: {
      get root() {
        return stateRoot;
      },
      settings: {
        activeProviderId: "p",
        providers: [
          {
            id: "p",
            model: "fixture-model",
            models: ["fixture-model"],
            protocol: "chat",
            baseUrl: "https://fixture.invalid/unused",
          },
        ],
      },
    },
  };
  const dispatcher: any = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"),
      officialUiActions: true,
      officialUiStrictTextChat: { executor: authority },
    },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    run: async (frame: any) => {
      if (frame.method === "send") {
        legacySends++;
        throw Error("Legacy send must not execute in strict mode");
      }
      if (frame.method === "snapshot") {
        await snapshotHook();
        return {
          conversations: conversation ? [conversation] : [],
          projects: [],
        };
      }
      if (frame.method === "conversationTurns")
        return { turns: conversation?.turns ?? [] };
      if (frame.method === "modelCatalog")
        return {
          defaultModel: "fixture-model",
          items: [
            {
              id: "fixture-model",
              displayName: "Fixture",
              description: "Inert",
              badges: [],
              sort: 0,
              hidden: false,
              isDefault: true,
              usageHint: "",
              efforts: [],
            },
          ],
        };
      if (frame.method === "interrupt") {
        legacyInterrupts++;
        return { status: "already_finished" };
      }
      throw Error(`Unexpected inert method ${frame.method}`);
    },
  };
  const call = (request: OfficialUiReadRequest, method = "officialUiRead") =>
    officialUiRead(dispatcher, {
      t: "call",
      id: "fixture-call",
      method,
      args: encodeWireValue([request]),
      user: { id: 7, accessToken: "INERT_TEST_VALUE" },
    } as any) as Promise<any>;
  const describe = async () => {
    const answer = await call({
      method: "GET",
      path: officialUiCapabilitiesPath,
    });
    return { ...answer, data: JSON.parse(Buffer.from(answer.body).toString()) };
  };
  const submit = (lease: string | undefined, value: any = body()) =>
    call(
      {
        method: "POST",
        path: `/api/organizations/${organizationUuid(account)}/chat_conversations/${conv}/completion`,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(value)),
        ...(lease ? { capabilityLease: lease } : {}),
      },
      "officialUiAction",
    );
  return {
    root,
    authority,
    ctx,
    dispatcher,
    call,
    describe,
    submit,
    executions,
    retire: () => (identity = {}),
    rootChange: (value: string) => (stateRoot = value),
    readiness: (value: any) => (readiness = value),
    inspect: (fn: typeof inspect) => (inspect = fn),
    executor: (fn: typeof executor) => (executor = fn),
    snapshotHook: (fn: typeof snapshotHook) => (snapshotHook = fn),
    get executes() {
      return executes;
    },
    get legacySends() {
      return legacySends;
    },
    get legacyInterrupts() {
      return legacyInterrupts;
    },
    get inspectCalls() {
      return inspectCalls;
    },
  };
}
const inline = {
  file_name: "report.pdf",
  file_type: "application/pdf",
  file_size: 9000,
  extracted_content: "Visible extracted UTF-8 文本",
  origin: "user_upload",
  kind: "file",
};
const supported = {
  version: 1,
  maxCount: 12,
  maxTotalBytes: 1024 * 1024,
  ownedFileKinds: ["image", "text", "document"],
  extractedText: true,
};
function enableAttachments(f: ReturnType<typeof fixture>) {
  f.authority.inspectAttachments = async (selection: any) => {
    assert.equal(selection.model, "fixture-model");
    assert.equal(selection.providerId, "p");
    return supported;
  };
  f.authority.executeWithAttachments = f.authority.execute;
  f.ctx.selectedAttachments.set("owned-image", {
    id: "owned-image",
    name: "image.png",
    kind: "image",
    size: 8,
    path: "/host-only-not-read",
  });
}
test("exact file ID plus extracted text reaches explicit executor; first/followup and identical retry do not replay", async (t) => {
  const f = fixture(t);
  enableAttachments(f);
  const cap = (await f.describe()).data;
  const initial = { ...body(), files: ["owned-image"], attachments: [inline] };
  const first = await f.submit(cap.activationLease, initial);
  assert.equal(first.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.executes, 1);
  assert.equal(f.legacySends, 0);
  const accepted = (f.executions[0] as any).attachments;
  assert.deepEqual(accepted[0], {
    source: "owned-file",
    id: "owned-image",
    name: "image.png",
    size: 8,
    kind: "image",
  });
  assert.equal(accepted[1].source, "extracted-text");
  assert.equal(accepted[1].name, "report.pdf.extracted.txt");
  assert.equal(accepted[1].text, inline.extracted_content);
  assert.notEqual(accepted[1].size, inline.file_size);
  assert.equal(JSON.stringify(accepted).includes("/host-only"), false);
  assert.equal((await f.submit(cap.activationLease, initial)).status, 200);
  assert.equal(f.executes, 1);
  const follow: any = {
    ...initial,
    completion_request_id: "55555555-5555-4555-8555-555555555555",
    turn_message_uuids: {
      human_message_uuid: "66666666-6666-4666-8666-666666666666",
      assistant_message_uuid: "77777777-7777-4777-8777-777777777777",
    },
  };
  delete follow.create_conversation_params;
  assert.equal((await f.submit(cap.activationLease, follow)).status, 200);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.executes, 2);
});
test("undeclared executor capability and foreign IDs refuse without legacy send", async (t) => {
  for (const mode of ["missing", "foreign", "duplicate", "path"]) {
    const f = fixture(t);
    if (mode !== "missing") enableAttachments(f);
    const cap = (await f.describe()).data;
    const input: any = {
      ...body(),
      files:
        mode === "duplicate"
          ? ["owned-image", "owned-image"]
          : [mode === "foreign" ? "foreign" : "owned-image"],
    };
    if (mode === "path")
      input.files = [{ file_uuid: "owned-image", path: "/arbitrary" }];
    const out = await f.submit(cap.activationLease, input);
    assert.notEqual(out.status, 200, mode);
    assert.equal(f.executes, 0);
    assert.equal(f.legacySends, 0);
  }
});
test("attachment limits and inline unknown path fields fail explicitly", async (t) => {
  for (const change of ["limit", "kind", "path", "binary"]) {
    const f = fixture(t);
    enableAttachments(f);
    if (change === "limit")
      f.authority.inspectAttachments = async () => ({
        ...supported,
        maxTotalBytes: 1,
      });
    if (change === "kind")
      f.authority.inspectAttachments = async () => ({
        ...supported,
        extractedText: false,
      });
    const cap = (await f.describe()).data;
    const value: any = {
      ...inline,
      ...(change === "path" ? { path: "/not-authorized" } : {}),
      ...(change === "binary" ? { extracted_content: "bad\0text" } : {}),
    };
    const out = await f.submit(cap.activationLease, {
      ...body(),
      attachments: [value],
    });
    assert.notEqual(out.status, 200);
    assert.equal(f.executes, 0);
  }
});
test("capability await retirement cannot dispatch; execution failure never calls legacy or silently retries", async (t) => {
  const f = fixture(t);
  enableAttachments(f);
  const cap = (await f.describe()).data;
  f.authority.inspectAttachments = async () => {
    f.retire();
    return supported;
  };
  assert.notEqual(
    (await f.submit(cap.activationLease, { ...body(), attachments: [inline] }))
      .status,
    200,
  );
  assert.equal(f.executes, 0);
  const g = fixture(t);
  enableAttachments(g);
  const ready = (await g.describe()).data;
  g.executor(async () => {
    throw Error("inert attachment model failure");
  });
  const request = { ...body(), attachments: [inline] };
  const answer = await g.submit(ready.activationLease, request);
  assert.equal(answer.status, 200);
  await new Promise((r) => setImmediate(r));
  const again = await g.submit(ready.activationLease, request);
  const batch = JSON.parse(Buffer.from(again.body).toString());
  assert.equal(batch.done, true);
  assert.ok(batch.events.some((e: any) => e.event === "error"));
  assert.equal(g.executes, 1);
  assert.equal(g.legacySends, 0);
});
test("attachment Stop never falls through to an unrelated legacy interrupt", async (t) => {
  const f = fixture(t);
  enableAttachments(f);
  const cap = (await f.describe()).data;
  const out = await f.call(
    {
      method: "POST",
      path: `/api/organizations/${organizationUuid("owner")}/chat_conversations/${conv}/stop_response`,
      contentType: "application/json",
      body: Buffer.from("{}"),
      capabilityLease: cap.activationLease,
    },
    "officialUiAction",
  );
  assert.equal(out.status, 501);
  assert.equal(f.legacyInterrupts, 0);
  assert.equal(f.executes, 0);
});
test("same-ID selected object replacement or metadata changes before dispatch refuse without replay", async (t) => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    enableAttachments(f);
    let inspections = 0;
    f.authority.inspectAttachments = async () => {
      if (++inspections === 2) {
        const old = f.ctx.selectedAttachments.get("owned-image");
        if (replace) f.ctx.selectedAttachments.set("owned-image", { ...old });
        else old.size++;
      }
      return supported;
    };
    const cap = (await f.describe()).data;
    const request = { ...body(), files: ["owned-image"] };
    const answer = await f.submit(cap.activationLease, request);
    assert.equal(answer.status, 200);
    await new Promise((r) => setImmediate(r));
    const again = await f.submit(cap.activationLease, request);
    const result = JSON.parse(Buffer.from(again.body).toString());
    assert.equal(result.done, true);
    assert.ok(result.events.some((e: any) => e.event === "error"));
    assert.equal(f.executes, 0);
    assert.equal(f.legacySends, 0);
  }
});
test("read-only default and capability source error remain explicit refusals without sending", async (t) => {
  const f = fixture(t);
  enableAttachments(f);
  f.dispatcher.options.officialUiActions = false;
  await assert.rejects(
    f.submit(undefined, { ...body(), attachments: [inline] }),
    /available/,
  );
  assert.equal(f.executes, 0);
  const g = fixture(t);
  enableAttachments(g);
  g.authority.inspectAttachments = async () => {
    throw Error("inert capability source failure");
  };
  const cap = (await g.describe()).data;
  const result = await g.submit(cap.activationLease, {
    ...body(),
    attachments: [inline],
  });
  assert.equal(result.status, 503);
  assert.match(
    Buffer.from(result.body).toString(),
    /capabilities could not be checked/i,
  );
  assert.equal(g.executes, 0);
});
test("same-metadata replacement inside repeated lookup await prevents executor dispatch", async (t) => {
  const f = fixture(t);
  enableAttachments(f);
  const selected = f.ctx.selectedAttachments;
  const originalGet = selected.get.bind(selected);
  let reads = 0;
  selected.get = (id: string) => {
    const value = originalGet(id);
    if (id === "owned-image" && ++reads === 4)
      queueMicrotask(() => selected.set(id, { ...value }));
    return value;
  };
  const cap = (await f.describe()).data,
    request = { ...body(), files: ["owned-image"] };
  assert.equal((await f.submit(cap.activationLease, request)).status, 200);
  await new Promise((r) => setImmediate(r));
  const out = await f.submit(cap.activationLease, request);
  const data = JSON.parse(Buffer.from(out.body).toString());
  assert.equal(data.done, true);
  assert.ok(data.events.some((e: any) => e.event === "error"));
  assert.equal(f.executes, 0);
});
test("executor current predicate includes selected file identity after its own await", async (t) => {
  for (const replace of [false, true]) {
    const f = fixture(t);
    enableAttachments(f);
    let sawRevocation = false;
    f.executor(async (input) => {
      assert.equal(input.isCurrent(), true);
      await Promise.resolve();
      const old = f.ctx.selectedAttachments.get("owned-image");
      if (replace) f.ctx.selectedAttachments.set("owned-image", { ...old });
      else old.size++;
      sawRevocation = !input.isCurrent();
      throw Error("inert revoked input; upstream outcome unknown");
    });
    const cap = (await f.describe()).data,
      request = { ...body(), files: ["owned-image"] };
    assert.equal((await f.submit(cap.activationLease, request)).status, 200);
    await new Promise((r) => setImmediate(r));
    assert.equal(sawRevocation, true);
    await f.submit(cap.activationLease, request);
    assert.equal(f.executes, 1);
    assert.equal(f.legacySends, 0);
  }
});
