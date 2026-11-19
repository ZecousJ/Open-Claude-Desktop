import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { organizationUuid } from "../../electron/official-ui/api/context";

const id = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

test("runner REST mutations use real adapter routes without needing recovered protobuf assets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rest-mutation-"));
  const conversation = {
    id,
    mode: "chat",
    title: "Before",
    turns: [],
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const calls: { method: string; args: unknown[] }[] = [];
  let exists = true,
    failStop = false;
  const host = {
    account: () => ({ id: "a", email: "a@example.invalid", name: "A" }),
    settings: () => ({}),
    sessionIdentity: () => 1,
    stateDirectory: () => root,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  };
  const dispatch = async (method: string, args: unknown[]) => {
    calls.push({ method, args });
    if (method === "snapshot")
      return { conversations: exists ? [conversation] : [], projects: [] };
    if (method === "conversationTurns") return { turns: [] };
    if (method === "updateConversation") {
      assert.equal(args[0], id);
      Object.assign(conversation, args[1]);
      return conversation;
    }
    if (method === "deleteConversation") {
      assert.equal(args[0], id);
      exists = false;
      return;
    }
    if (method === "interrupt") {
      assert.equal(args[0], id);
      if (failStop) throw Error("stop failed");
      return;
    }
    throw Error(`Unexpected dispatch ${method}`);
  };
  const base = `/api/organizations/${organizationUuid("a")}/chat_conversations/${id}`;
  try {
    const disabled = createRunnerOfficialAdapter(
      host as never,
      dispatch,
      root,
      { modes: ["chat"] },
    );
    assert.equal(
      (
        await disabled({
          method: "PATCH",
          path: base,
          contentType: "application/json",
          body: json({ name: "After" }),
        })
      ).status,
      501,
    );
    const run = createRunnerOfficialAdapter(
      host as never,
      dispatch,
      root,
      { modes: ["chat"] },
      { allowTextActions: true },
    );
    const changed = await run({
      method: "PATCH",
      path: base,
      contentType: "application/json",
      body: json({ name: "After", is_starred: true, is_archived: true }),
    });
    assert.equal(changed.status, 200);
    assert.equal(conversation.title, "After");
    assert.equal(conversation.pinned, true);
    assert.equal(conversation.archived, true);
    assert.equal(
      (await run({ method: "POST", path: base + "/stop_response" })).status,
      204,
    );
    assert.equal(
      (
        await run({
          method: "PUT",
          path: base + "/read_state",
          contentType: "application/json",
          body: json({ unread: false }),
        })
      ).status,
      200,
    );
    const before = calls.length;
    assert.equal(
      (
        await run({
          method: "PATCH",
          path: base,
          contentType: "application/json",
          body: json({ cwd: "/private" }),
        })
      ).status,
      400,
    );
    assert.equal(
      calls.length,
      before,
      "invalid input must be rejected before account dispatch",
    );
    assert.equal(
      (
        await run({
          method: "DELETE",
          path: base.replace(organizationUuid("a"), organizationUuid("b")),
        })
      ).status,
      404,
    );
    assert.equal(
      calls.length,
      before,
      "another organization must not dispatch",
    );
    const missing = base.replace(id, "33333333-3333-4333-8333-333333333333");
    assert.equal((await run({ method: "DELETE", path: missing })).status, 404);
    assert.equal(
      calls.some((call) => call.method === "deleteConversation"),
      false,
    );
    failStop = true;
    await assert.rejects(
      run({ method: "POST", path: base + "/stop_response" }),
      /stop failed/,
    );
    assert.equal((await run({ method: "DELETE", path: base })).status, 204);
    assert.equal(exists, false);
    assert.equal((await run({ method: "DELETE", path: base })).status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("account changes while a conversation is looked up cannot dispatch a write", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-rest-account-"));
  let account = "a",
    identity = {};
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const host = {
    account: () => ({
      id: account,
      email: `${account}@example.invalid`,
      name: account,
    }),
    settings: () => ({}),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    onEvent: () => () => {},
    appVersion: "test",
    log() {},
  };
  const run = createRunnerOfficialAdapter(
    host as never,
    async (method) => {
      calls.push(method);
      if (method === "snapshot") {
        entered();
        await waiting;
        return {
          conversations: [{ id, mode: "chat", turns: [] }],
          projects: [],
        };
      }
      throw Error("A late lookup must not access the new account");
    },
    root,
    { modes: ["chat"] },
    { allowTextActions: true },
  );
  try {
    const pending = run({
      method: "DELETE",
      path: `/api/organizations/${organizationUuid("a")}/chat_conversations/${id}`,
    });
    await started;
    account = "b";
    identity = {};
    release();
    await assert.rejects(pending, /account changed/i);
    assert.deepEqual(calls, ["snapshot"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
