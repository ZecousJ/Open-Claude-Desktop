import assert from "node:assert/strict";
import { test } from "node:test";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";

for (const mode of ["code", "cowork"] as const) test(`${mode} rejects old account work and events after reactivation`, async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: any[] = [];
  let identity = {};
  let release!: (value: any) => void;
  const waiting = new Promise<any>((resolve) => { release = resolve; });
  const c = { id: "shared-id", title: "Private", mode, cwd: process.cwd(), providerId: "p", model: "m", turns: [], createdAt: 1, updatedAt: 1 };
  let listener!: (event: any) => void;
  const host = { ctx: { account: () => ({ id: "same-account" }), sessionIdentity: () => identity,
    localLoadConversation: () => waiting, localCall: async () => ({ approvals: [] }),
    onEvent: (fn: (event: any) => void) => { listener = fn; return () => {}; }, log() {} },
    on(name: string, fn: (...args: any[]) => any) { handlers.set(name, fn); },
    emit(_domain: string, _channel: string, event: unknown) { events.push(event); } };
  if (mode === "code") registerExperimentalCodeSessions(host as never);
  else registerExperimentalCoworkSessions(host as never);
  const domain = mode === "code" ? "LocalSessions" : "LocalAgentModeSessions";
  const oldRequest = handlers.get(`${domain}.getSession`)!("local_shared-id");
  listener({ type: "conversation", conversation: c });
  identity = {};
  release(c);
  await assert.rejects(oldRequest, /account changed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
});

for (const mode of ["code", "cowork"] as const) test(`${mode} never publishes a provisional turn id that later changes`, async () => {
  const events: any[] = [];
  const turn = { id: "pending-provisional", prompt: "test prompt", attachments: [], items: [], createdAt: 1, status: "inProgress" };
  const c = { id: "id", title: "Test", mode, cwd: process.cwd(), providerId: "p", model: "m", turns: [turn], createdAt: 1, updatedAt: 1 };
  let listener!: (event: any) => void;
  const host = { ctx: { localLoadConversation: async () => structuredClone(c), localCall: async () => ({ approvals: [] }),
    onEvent: (fn: (event: any) => void) => { listener = fn; return () => {}; }, log() {} },
    on() {}, emit(_domain: string, _channel: string, event: unknown) { events.push(event); } };
  if (mode === "code") registerExperimentalCodeSessions(host as never);
  else registerExperimentalCoworkSessions(host as never);
  listener({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "message"), false);
  assert.equal(events.some((event) => event.type === "close"), false);
  turn.id = "stable-turn";
  listener({ type: "conversation", conversation: c });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = events.filter((event) => event.type === "message");
  assert.deepEqual(messages.map((event) => event.message.uuid), ["stable-turn:user"]);
  assert.doesNotMatch(JSON.stringify(events), /pending-provisional/);
});
