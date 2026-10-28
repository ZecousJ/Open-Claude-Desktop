import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { ProjectPromptCounts } from "../../electron/projects/project-prompt-counts";
import { desktopNotificationInput } from "../../shared/desktop-notifications-input";
import {
  enableDesktopNotifications,
  type NotificationAuthorization,
} from "../../shared/desktop-notifications";

test("notification enablement requests undetermined permission, opens denied settings and accepts existing permission", async () => {
  for (const status of [
    "notDetermined",
    "denied",
    "authorized",
    "provisional",
    "ephemeral",
  ] as NotificationAuthorization[]) {
    for (const response of ["granted", "denied", "error"] as const) {
      const calls: string[] = [];
      const result = await enableDesktopNotifications({
        getNotificationAuthorizationStatus: async () => status,
        requestNotificationAuthorization: async () => (
          calls.push("request"),
          response
        ),
        openNotificationSettings: async () => {
          calls.push("settings");
        },
      });
      assert.deepEqual(
        calls,
        status === "notDetermined"
          ? ["request"]
          : status === "denied"
            ? ["settings"]
            : [],
      );
      assert.equal(
        result,
        status === "notDetermined"
          ? response === "granted"
          : status !== "denied",
      );
    }
  }
});

test("notification authorization failures remain failures instead of granting permission", async () => {
  await assert.rejects(
    enableDesktopNotifications({
      getNotificationAuthorizationStatus: async () => {
        throw Error("native failure");
      },
      requestNotificationAuthorization: async () =>
        assert.fail("must not request"),
      openNotificationSettings: async () => assert.fail("must not open"),
    }),
    /native failure/,
  );
});

test("renderer notification actions validate opaque tokens, unique IDs and two-button maximum", () => {
  const input = {
    title: "Project",
    body: "Request",
    tag: "project-input",
    token: "one_1-abc",
    actions: [
      { id: "approve", title: " Allow " },
      { id: "reject", title: "Deny" },
    ],
  };
  assert.equal(
    desktopNotificationInput.parse(input).actions?.[0].title,
    "Allow",
  );
  for (const id of [
    "click",
    "close",
    "dismiss",
    "timeout",
    "allow_once",
    "Bad",
    "../bad",
  ])
    assert.equal(
      desktopNotificationInput.safeParse({
        ...input,
        actions: [{ id, title: "Allow" }],
      }).success,
      false,
      id,
    );
  for (const patch of [
    { token: "" },
    { token: "a".repeat(65) },
    { token: "bad/token" },
    { token: undefined },
    { tag: undefined },
    { actions: [input.actions[0], input.actions[0]] },
    { actions: [...input.actions, { id: "third", title: "Third" }] },
    { actions: [{ id: "approve", title: " " }] },
  ])
    assert.equal(
      desktopNotificationInput.safeParse({ ...input, ...patch }).success,
      false,
    );
  assert.equal(
    desktopNotificationInput.safeParse({ title: "Claudex", body: "Complete" })
      .success,
    true,
  );
});

function renderer() {
  let destroyed = false;
  const events = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
  });
  return {
    events,
    sender: events as unknown as WebContents,
    destroy: () => {
      destroyed = true;
      events.emit("destroyed");
    },
  };
}

test("project prompt counts use the largest renderer, not a sum or last writer", () => {
  let changes = 0;
  const counts = new ProjectPromptCounts(() => changes++);
  const first = renderer(),
    second = renderer();
  counts.set(first.sender, 5.9);
  counts.set(second.sender, 2);
  assert.equal(counts.count, 5);
  counts.set(second.sender, 2);
  assert.equal(changes, 2);
  assert.equal(second.events.listenerCount("did-navigate"), 1);
  counts.set(first.sender, -1);
  assert.equal(counts.count, 2);
  counts.set(second.sender, NaN);
  assert.equal(counts.count, 0);
  counts.set(first.sender, 7);
  counts.clear();
  assert.equal(counts.count, 0);
});

test("project prompt counts clear for navigation, renderer failures and destruction", () => {
  const counts = new ProjectPromptCounts(() => {});
  const first = renderer();
  for (const event of ["did-navigate", "render-process-gone"]) {
    counts.set(first.sender, 3);
    first.events.emit(event);
    assert.equal(counts.count, 0);
  }
  counts.set(first.sender, 4);
  first.events.emit("did-fail-load", {}, -2, "failed", "about:blank", false);
  assert.equal(counts.count, 4);
  first.events.emit("did-fail-load", {}, -3, "aborted", "about:blank", true);
  assert.equal(counts.count, 4);
  first.events.emit("did-fail-load", {}, -2, "failed", "about:blank", true);
  assert.equal(counts.count, 0);
  counts.set(first.sender, 3);
  first.destroy();
  assert.equal(counts.count, 0);
  counts.set(first.sender, 8);
  assert.equal(counts.count, 0);
});
