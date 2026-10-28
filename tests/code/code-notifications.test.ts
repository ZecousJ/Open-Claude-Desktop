import test from "node:test";
import assert from "node:assert/strict";
import { codeNotificationsExtension } from "../../electron/engine/code-notifications";
import {
  codeNotificationTool,
  newCodeNotifications,
} from "../../shared/code-notifications";
import type { DynamicToolCall } from "../../electron/engine/engine-extensions";
import type { Conversation, Item } from "../../shared/types";

const sent = (id: string, message: string, success = true): Item =>
  ({
    id,
    type: "dynamicToolCall",
    tool: codeNotificationTool,
    status: "completed",
    success,
    arguments: { message },
  }) as Item;
const session = (items: Item[], mode = "code") =>
  ({ mode, turns: [{ id: "t", items }] }) as unknown as Conversation;

test("a Code session gets PushNotification, and a call is sent only while Code notifications is on", async () => {
  let on = false;
  const extension = codeNotificationsExtension(() => ({
    notifyCodeUpdates: on,
  }));
  const tools = (mode: string, notifyCodeUpdates: boolean) =>
    extension.dynamicTools!({
      mode,
      settings: { notifyCodeUpdates },
    } as never)!.map((tool) => tool.name);
  assert.deepEqual(tools("code", true), [codeNotificationTool]);
  assert.deepEqual(tools("code", false), []);
  assert.deepEqual(tools("chat", true), []);
  const call = (message: unknown) =>
    extension.handleDynamicTool!({
      namespace: null,
      tool: codeNotificationTool,
      arguments: { message },
    } as DynamicToolCall) as {
      success: boolean;
      contentItems: { text: string }[];
    };
  assert.equal(call("Build finished").success, false);
  assert.match(
    call("Build finished").contentItems[0].text,
    /turned Code notifications off/,
  );
  on = true;
  assert.equal(call("Build finished").success, true);
  assert.equal(call("  ").success, false);
  assert.equal(
    extension.handleDynamicTool!({
      namespace: null,
      tool: "other",
      arguments: {},
    } as DynamicToolCall),
    undefined,
  );
});

test("only notifications sent since the session was last seen are shown, never on a first sight", () => {
  const before = session([sent("a", "First")]);
  const after = session([
    sent("a", "First"),
    sent("b", "  Tests pass  "),
    sent("c", "Refused", false),
  ]);
  assert.deepEqual(newCodeNotifications(before, after), ["Tests pass"]);
  assert.deepEqual(newCodeNotifications(undefined, after), []);
  assert.deepEqual(
    newCodeNotifications(before, session(after.turns[0].items, "chat")),
    [],
  );
});
