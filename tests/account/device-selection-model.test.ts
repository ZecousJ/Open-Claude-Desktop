import test from "node:test";
import assert from "node:assert/strict";
import type { DeviceInfo } from "../../shared/remote-devices";
import {
  composerDeviceElection,
  deriveComposerDeviceState,
  resolveComposerDeviceSend,
  type ComposerDeviceContext,
  type ComposerDeviceList,
} from "../../src/composer/device-selection-model";

const computer: DeviceInfo = {
  id: "computer-a",
  name: "Test computer",
  platform: "darwin",
  version: "test",
  connectedAt: "2026-10-18T00:00:00Z",
  online: true,
  computerAccess: true,
};
const chat: ComposerDeviceContext = {
  accountId: "account-a",
  draftId: "draft-a",
  mode: "chat",
};
const linked: ComposerDeviceContext = {
  ...chat,
  mode: "cowork",
  conversation: {
    id: "task-a",
    mode: "cowork",
    linkedToComputer: true,
    linkedComputerId: computer.id,
  },
};
const available: ComposerDeviceList = {
  status: "ready",
  devices: [computer],
};

test("a new Chat shows only real devices and never claims an unsupported election works", () => {
  const state = deriveComposerDeviceState(chat, available);
  assert.equal(state.visible, true);
  assert.equal(state.selectedDeviceId, undefined);
  assert.equal(state.canChangeSelection, false);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].device, computer);
  assert.equal(state.rows[0].checked, false);
  assert.equal(state.rows[0].selectable, false);
  assert.equal(state.rows[0].reason, "chat-binding-unavailable");
  assert.deepEqual(resolveComposerDeviceSend(chat, available), {
    kind: "ordinary",
  });
  assert.deepEqual(
    resolveComposerDeviceSend(
      chat,
      available,
      composerDeviceElection(chat, computer.id),
    ),
    { kind: "blocked", reason: "chat-binding-unavailable" },
  );
});

test("the current bridge can continue only the actual owning Cowork computer", () => {
  const state = deriveComposerDeviceState(linked, available);
  assert.equal(state.selectedDeviceId, computer.id);
  assert.equal(state.rows[0].checked, true);
  assert.equal(state.rows[0].selectable, false);
  assert.equal(state.rows[0].reason, "conversation-binding-fixed");
  const target = {
    kind: "device",
    deviceId: computer.id,
    conversationId: "task-a",
  };
  assert.deepEqual(resolveComposerDeviceSend(linked, available), target);
  assert.deepEqual(
    resolveComposerDeviceSend(
      linked,
      available,
      composerDeviceElection(linked, computer.id),
    ),
    target,
  );
  assert.deepEqual(
    resolveComposerDeviceSend(
      linked,
      available,
      composerDeviceElection(linked, "computer-b"),
    ),
    { kind: "blocked", reason: "conversation-binding-fixed" },
  );
});

test("old account, conversation, draft and target-kind intentions cannot leak into another composer", () => {
  const election = composerDeviceElection(chat, computer.id);
  for (const next of [
    { ...chat, accountId: "account-b" },
    { ...chat, draftId: "draft-b" },
    {
      ...chat,
      conversation: { id: chat.draftId, mode: "chat" as const },
    },
    { ...chat, draftId: "" },
  ])
    assert.deepEqual(resolveComposerDeviceSend(next, available, election), {
      kind: "blocked",
      reason: "stale-selection",
    });
  const conversationElection = composerDeviceElection(linked, computer.id);
  assert.deepEqual(
    resolveComposerDeviceSend(
      {
        ...linked,
        conversation: { ...linked.conversation!, id: "task-b" },
      },
      available,
      conversationElection,
    ),
    { kind: "blocked", reason: "stale-selection" },
  );
});

test("offline, unreported presence and missing access block instead of falling back to a runner", () => {
  for (const [patch, reason] of [
    [{ online: false }, "device-offline"],
    [{ online: undefined }, "device-presence-unknown"],
    [{ computerAccess: false }, "computer-access-off"],
    [{ computerAccess: undefined }, "computer-access-unknown"],
  ] as const) {
    const list = {
      status: "ready" as const,
      devices: [{ ...computer, ...patch }],
    };
    assert.equal(
      deriveComposerDeviceState(linked, list).rows[0].reason,
      reason,
    );
    assert.deepEqual(resolveComposerDeviceSend(linked, list), {
      kind: "blocked",
      reason,
    });
  }
  assert.deepEqual(
    resolveComposerDeviceSend(linked, { status: "ready", devices: [] }),
    { kind: "blocked", reason: "device-missing" },
  );
});

test("loading and failed device lists do not create a placeholder device or a local send", () => {
  for (const [list, reason] of [
    [{ status: "loading" }, "loading"],
    [{ status: "error" }, "list-unavailable"],
  ] as const) {
    assert.deepEqual(deriveComposerDeviceState(chat, list), {
      visible: false,
      selectedDeviceId: undefined,
      canChangeSelection: false,
      reason,
      rows: [],
    });
    assert.deepEqual(resolveComposerDeviceSend(linked, list), {
      kind: "blocked",
      reason,
    });
  }
});

test("an incognito or unsupported-mode composer cannot expose or use a device election", () => {
  for (const [context, reason] of [
    [{ ...linked, incognito: true }, "incognito"],
    [
      {
        ...linked,
        conversation: { ...linked.conversation!, incognito: true },
      },
      "incognito",
    ],
    [{ ...linked, mode: "code" }, "unsupported-mode"],
    [{ ...linked, accountId: "" }, "signed-out"],
  ] as const) {
    const state = deriveComposerDeviceState(context, available);
    assert.equal(state.visible, false);
    assert.equal(state.rows[0].reason, reason);
    assert.deepEqual(resolveComposerDeviceSend(context, available), {
      kind: "blocked",
      reason,
    });
  }
});

test("malformed or Chat-linked metadata is not accepted as an existing Cowork binding", () => {
  for (const conversation of [
    { ...linked.conversation!, mode: "chat" as const },
    { ...linked.conversation!, linkedComputerId: undefined },
    { ...linked.conversation!, id: "" },
  ]) {
    const context = { ...linked, conversation };
    assert.equal(
      deriveComposerDeviceState(context, available).reason,
      "conversation-binding-invalid",
    );
    assert.deepEqual(resolveComposerDeviceSend(context, available), {
      kind: "blocked",
      reason: "conversation-binding-invalid",
    });
  }
});

test("no device is selected by list order, capacity or advertised connection time", () => {
  const list: ComposerDeviceList = {
    status: "ready",
    devices: [
      { ...computer, sessions: { active: 32, max: 32 } },
      { ...computer, name: "Duplicate must not become another row" },
      { ...computer, id: "", name: "No identity" },
      { ...computer, id: "computer-b", connectedAt: "invalid" },
    ],
  };
  const state = deriveComposerDeviceState(chat, list);
  assert.equal(state.rows.length, 2);
  assert.equal(state.rows[0].connectedAt, computer.connectedAt);
  assert.equal(state.rows[1].connectedAt, undefined);
  assert.equal(
    state.rows.every((row) => !row.checked),
    true,
  );
  assert.equal(
    state.rows.some((row) => "lastSeen" in row || "default" in row),
    false,
  );
  // Capacity limits creating sessions. They must not refuse a message in
  // an existing bound session merely because all session slots are occupied.
  assert.deepEqual(resolveComposerDeviceSend(linked, list), {
    kind: "device",
    deviceId: computer.id,
    conversationId: "task-a",
  });
});

test("a failed device resolution invokes no send or newSession side effect", async () => {
  const calls: string[] = [];
  const target = resolveComposerDeviceSend(
    chat,
    available,
    composerDeviceElection(chat, computer.id),
  );
  if (target.kind === "device") calls.push(`device:${target.deviceId}`);
  else if (target.kind === "ordinary") calls.push("runner");
  assert.deepEqual(calls, []);
});
