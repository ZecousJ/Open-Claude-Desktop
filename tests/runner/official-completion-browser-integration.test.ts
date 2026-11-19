import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { openOfficialCompletion } from "../../src-web/official/completion-fetch";
import { organizationUuid } from "../../electron/official-ui/api/context";
import type { AppEvent, Conversation } from "../../shared/types";
import { WebTransport } from "../../shared/web-client/transport";
const id = "11111111-1111-4111-8111-111111111111";
function setup(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "completion-browser-"));
  t.after(async () => {
    // These fixtures queue real 500 ms adapter-state saves; keep their owned
    // temporary directory alive until the queue runs. Do not hide write errors.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const listeners = new Set<(event: AppEvent) => void>();
  let c: Conversation | undefined,
    sends = 0,
    activation = 1;
  const subscribe = (fn: (event: AppEvent) => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const settings = {
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        model: "fixture",
        models: ["fixture"],
        baseUrl: "http://localhost/unused",
        protocol: "chat",
      },
    ],
    activeProviderId: "fixture",
  };
  const run = createRunnerOfficialAdapter(
    {
      account: () => ({ id: "a", name: "Fixture", email: "a@example.invalid" }),
      settings: () => settings,
      sessionIdentity: () => activation,
      stateDirectory: () => root,
      onEvent: subscribe,
      log() {},
      appVersion: "test",
    } as never,
    async (method, args) => {
      if (method === "snapshot")
        return { conversations: c ? [c] : [], projects: [] };
      if (method === "modelCatalog")
        return {
          defaultModel: "fixture",
          items: [
            {
              id: "fixture",
              displayName: "Fixture",
              description: "Synthetic only",
              badges: [],
              sort: 0,
              hidden: false,
              isDefault: true,
              usageHint: "",
              efforts: [],
            },
          ],
        };
      if (method === "conversationTurns") return { turns: c?.turns ?? [] };
      if (method === "send") {
        sends++;
        const input = args[0] as any;
        c = {
          id: input.newConversationId,
          mode: "chat",
          title: "Synthetic fixture",
          providerId: "fixture",
          model: "fixture",
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          turns: [
            {
              id: "real-fixture-turn",
              prompt: input.text,
              attachments: [],
              createdAt: 2,
              status: "inProgress",
              items: [
                {
                  id: "text",
                  type: "agentMessage",
                  text: "First synthetic part. ",
                },
              ],
            },
          ],
        };
        return structuredClone(c);
      }
      throw Error("Unexpected fixture call " + method);
    },
    root,
    { modes: ["chat"] },
    { allowTextActions: true },
  );
  const body = {
    prompt: "Synthetic request only",
    model: "fixture",
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
      model: "fixture",
      include_conversation_preferences: true,
      is_temporary: false,
    },
  };
  const request = {
    method: "POST" as const,
    path: `/api/organizations/${organizationUuid("a")}/chat_conversations/${id}/completion`,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(body)),
  };
  return {
    run,
    request,
    subscribe,
    get sends() {
      return sends;
    },
    get listeners() {
      return listeners.size;
    },
    finish() {
      c!.turns[0].items[0].text += "中文😀";
      c!.turns[0].status = "completed";
      for (const fn of listeners)
        fn({ type: "conversation", conversation: structuredClone(c!) });
    },
    rotate() {
      activation++;
      for (const fn of listeners) fn({ type: "signed-out" } as AppEvent);
    },
  };
}
test("real runner batch route flows through browser SSE incrementally and durable replay sends only once", async (t) => {
  const f = setup(t),
    r = await openOfficialCompletion(
      f.request,
      new AbortController().signal,
      f.run,
      f.run,
      f.subscribe,
      { pollMs: 5, deadlineMs: 1000 },
    );
  assert.equal(r.status, 200);
  const reader = r.body!.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /message_start/);
  assert.doesNotMatch(text, /message_stop/);
  assert.equal(f.sends, 1);
  f.finish();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  assert.match(text, /中文😀/);
  assert.match(text, /event: message_stop/);
  assert.match(text, /end_turn/);
  assert.equal(f.listeners, 0);
  const replay = await openOfficialCompletion(
    f.request,
    new AbortController().signal,
    f.run,
    f.run,
    f.subscribe,
  );
  assert.match(await replay.text(), /message_stop/);
  assert.equal(f.sends, 1);
});
test("browser network outage resumes the real runner stream without another send", async (t) => {
  const f = setup(t);
  let offline = true, attempts = 0;
  const transport = new WebTransport({
    fetch: async () => {
      attempts++;
      if (offline) throw new TypeError("network unavailable");
      return new Response(null, { status: 200 });
    },
    timers: globalThis,
  } as never, {
    activationIdentity: {}, accessToken: async () => "token",
    refresh: async () => null, expire() {},
  }, "fixture");
  const result = await openOfficialCompletion(f.request, new AbortController().signal,
    async (request) => {
      await transport.fetch("/fixture");
      return f.run(request);
    }, f.run, f.subscribe, { pollMs: 5, deadlineMs: 1000 });
  const reader = result.body!.getReader();
  while (!attempts) await new Promise((resolve) => setTimeout(resolve, 1));
  f.finish();
  offline = false;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += new TextDecoder().decode(next.value);
  }
  assert.match(text, /中文😀/);
  assert.match(text, /event: message_stop/);
  assert.doesNotMatch(text, /event: error/);
  assert.ok(attempts >= 2);
  assert.equal(f.sends, 1);
  assert.equal(f.listeners, 0);
});
test("real runner rejects default unimplemented tools before any synthetic send", async (t) => {
  const f = setup(t);
  const body = JSON.parse(Buffer.from(f.request.body).toString());
  body.tools = [{ type: "repl_v0", name: "repl" }];
  const r = await openOfficialCompletion(
    { ...f.request, body: Buffer.from(JSON.stringify(body)) },
    new AbortController().signal,
    f.run,
    f.run,
    f.subscribe,
  );
  assert.equal(r.status, 501);
  assert.equal(f.sends, 0);
  assert.equal(f.listeners, 0);
  assert.match(await r.text(), /unsupported|supported/i);
});
test("real runner plus bridge detaches on account change without claiming completion", async (t) => {
  const f = setup(t),
    r = await openOfficialCompletion(
      f.request,
      new AbortController().signal,
      f.run,
      f.run,
      f.subscribe,
    );
  const reader = r.body!.getReader();
  await reader.read();
  f.rotate();
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(f.sends, 1);
  assert.equal(f.listeners, 0);
});
