import test from "node:test";
import assert from "node:assert/strict";
import { KeepAwakeNoticeTracker } from "../../electron/app/keep-awake-notice";
import { remoteControlCopy } from "../../src/remote-control/model";
import { awakeDuration, sleepTitle } from "../../src/code-sleep/sleep-band";
import { environmentMenu } from "../../src/ssh/model";
import { codeEnvironmentMenu } from "../../src/composer/code/code-environment-menu";
import {
  dismissRemoteNotice,
  forgetRemoteDismissal,
  remoteNotice,
  setRemoteNotice,
  useRemoteNotice,
} from "../../src/remote-control/notices";
import {
  setRemoteEnvironment,
  useRemoteEnvironment,
} from "../../src/remote-control/environment";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SleepBand } from "../../src/code-sleep/SleepBand";
import { recordSleep } from "../../src/code-sleep/sleep-band";
import type { Conversation, Settings } from "../../shared/types";

test("Remote Control stores expose their current snapshots during server rendering", () => {
  function Snapshot() {
    const environment = useRemoteEnvironment();
    const notice = useRemoteNotice("server-render");
    return createElement(
      "span",
      null,
      `${environment?.name ?? "Local"}:${notice?.kind ?? "none"}`,
    );
  }
  try {
    assert.equal(
      renderToStaticMarkup(createElement(Snapshot)),
      "<span>Local:none</span>",
    );
    setRemoteEnvironment({ id: "remote", name: "Work computer" });
    setRemoteNotice("server-render", { kind: "on" });
    assert.equal(
      renderToStaticMarkup(createElement(Snapshot)),
      "<span>Work computer:on</span>",
    );
  } finally {
    setRemoteEnvironment(undefined);
    setRemoteNotice("server-render");
  }
});

test("Remote Control notices preserve causes and retry copy", () => {
  assert.equal(
    remoteControlCopy({ kind: "on" }).title,
    "Remote Control is on now.",
  );
  assert.equal(
    remoteControlCopy({
      kind: "connect_failed",
      cause: "sign_in",
      retries: true,
    }).body,
    "Sign in again. Remote Control retries with your next message.",
  );
  assert.match(
    remoteControlCopy({ kind: "connect_failed", cause: "network" }).body!,
    /VPN or proxy/,
  );
  assert.match(
    remoteControlCopy({ kind: "connect_failed", cause: "process_stopped" })
      .body!,
    /then turn on Remote Control/,
  );
  assert.match(
    remoteControlCopy({
      kind: "connect_failed",
      cause: "process_stopped",
      retries: true,
    }).body!,
    /Remote Control retries/,
  );
  assert.equal(
    remoteControlCopy({ kind: "disconnect_failed", cause: "retry" }).title,
    "Remote Control couldn’t turn off",
  );
  assert.equal(
    remoteControlCopy({ kind: "disconnect_failed", cause: "process_stopped" })
      .warning,
    false,
  );
  assert.equal(
    remoteControlCopy({ kind: "reconnect_failed" }).title,
    "Remote Control is off",
  );
});

test("dismissing a connection cause survives repeated polling, but a changed state shows", () => {
  setRemoteNotice("notice-test", { kind: "connect_failed", cause: "network" });
  dismissRemoteNotice("notice-test");
  setRemoteNotice("notice-test", { kind: "connect_failed", cause: "network" });
  assert.equal(remoteNotice("notice-test"), undefined);
  setRemoteNotice("notice-test", { kind: "on" });
  assert.deepEqual(remoteNotice("notice-test"), { kind: "on" });
});

test("turning Remote Control off or on does not count as dismissing; only the banner's × does", () => {
  const failure = { kind: "connect_failed", cause: "network" } as const;
  // Switching off clears the notice without remembering it ...
  setRemoteNotice("switch-test", { kind: "on" });
  setRemoteNotice("switch-test");
  setRemoteNotice("switch-test", { kind: "on" });
  assert.deepEqual(remoteNotice("switch-test"), { kind: "on" });
  // ... and a dismissed failure is forgotten when the switch is used again.
  setRemoteNotice("switch-test", failure);
  dismissRemoteNotice("switch-test");
  setRemoteNotice("switch-test", failure);
  assert.equal(remoteNotice("switch-test"), undefined);
  forgetRemoteDismissal("switch-test");
  setRemoteNotice("switch-test", failure);
  assert.deepEqual(remoteNotice("switch-test"), failure);
});

test("sleep titles follow the rework flag, not keep-awake preferences, and localize duration", () => {
  assert.equal(
    sleepTitle(true, true),
    "Your computer went to sleep while Claudex was working.",
  );
  assert.equal(
    sleepTitle(false, true),
    "Your computer went to sleep and paused this session.",
  );
  assert.equal(
    sleepTitle(false, false),
    "Claudex was interrupted when your computer went to sleep.",
  );
  assert.equal(awakeDuration(0, "en-US"), "1 min");
  assert.equal(awakeDuration(3_660_000, "en-US"), "1 hr 1 min");
});

test("awake notices require ten minutes of both held work and idle time", () => {
  const tracker = new KeepAwakeNoticeTracker();
  tracker.observe("short", true, false, 0, 0);
  tracker.observe("short", false, true, 599_999, 600_000);
  assert.equal(tracker.release(true), undefined);
  tracker.observe("done", true, false, 1000, 0);
  tracker.observe("done", false, true, 601_000, 600_000);
  assert.deepEqual(tracker.release(true), {
    sessionId: "done",
    heldMs: 600_000,
  });
  assert.equal(tracker.release(true), undefined);
  tracker.observe("failed", true, false, 0, 0);
  tracker.observe("failed", false, false, 700_000, 700_000);
  assert.equal(tracker.release(true), undefined);
  tracker.observe("battery", true, false, 0, 0);
  tracker.observe("battery", false, true, 700_000, 700_000);
  assert.equal(tracker.release(false), undefined);
});

test("sleep rendering keeps the rework title even when keep-awake is already enabled", () => {
  const now = Date.now();
  recordSleep({ suspendedAt: now - 100_000, wakeAt: now - 90_000 });
  const conversation = {
    id: "sleep-render",
    mode: "code",
    updatedAt: now,
    turns: [
      { id: "turn", status: "failed", createdAt: now - 200_000, items: [] },
    ],
  } as unknown as Conversation;
  const settings = {
    keepAwakeWhileCoding: true,
    keepAwakeOnBattery: true,
  } as Settings;
  const render = (keepAwakeRework: boolean) =>
    renderToStaticMarkup(
      createElement(SleepBand, {
        conversation,
        settings,
        variant: "conversation",
        keepAwakeRework,
        updatePreference: async () => {},
        onError() {},
      }),
    );
  assert.match(
    render(true),
    /Your computer went to sleep while Claudex was working\./,
  );
  assert.doesNotMatch(render(true), /hasn’t made progress/);
  assert.match(
    render(false),
    /Claudex was interrupted when your computer went to sleep\./,
  );
  assert.match(render(false), /hasn’t made progress since it woke up/);
});

test("completed awake notices offer both preferences and disappear for subsequent work", () => {
  const now = Date.now();
  const conversation = {
    id: "awake-render",
    mode: "code",
    updatedAt: now,
    keptAwake: { heldMs: 600_000, endedAt: now },
    turns: [
      { id: "turn", status: "completed", createdAt: now - 700_000, items: [] },
    ],
  } as unknown as Conversation;
  const render = () =>
    renderToStaticMarkup(
      createElement(SleepBand, {
        conversation,
        settings: {
          keepAwakeWhileCoding: true,
          keepAwakeOnBattery: true,
        } as Settings,
        variant: "conversation",
        updatePreference: async () => {},
        onError() {},
      }),
    );
  const markup = render();
  assert.match(markup, /Claudex kept your computer awake for 10 min\./);
  assert.match(markup, /Only when plugged in/);
  assert.match(markup, /Don’t keep awake/);
  conversation.turns[0].createdAt = now + 1;
  assert.equal(render(), "");
});

const options = {
  hosts: [],
  statuses: {},
  selected: { kind: "local" as const },
  ssh: true,
  onLocal() {},
  onHost() {},
  onAdd() {},
  onManage() {},
};

test("SSH exposes the loading/empty lines without hiding Add", () => {
  const entry = environmentMenu({ ...options, loading: true })[1];
  assert.ok("label" in entry && entry.submenu);
  assert.equal(
    "label" in entry.submenu[0] && entry.submenu[0].label,
    "SSH hosts are still loading. Try again in a moment.",
  );
  const add = entry.submenu.at(-1)!;
  assert.equal("label" in add && add.label, "Add SSH connection…");
});

test("Remote Control machine rows select an environment and setup remains usable", () => {
  const calls: string[] = [];
  const entries = codeEnvironmentMenu({
    ...options,
    onEditLocal() {},
    onCloud() {},
    onCreateCloud() {},
    onEditCloud() {},
    onRemote: (id) => calls.push(id),
    onSetupRemote: () => calls.push("setup"),
    remote: {
      appLink: "",
      paired: true,
      pending: [],
      onlineDeviceIds: [],
      devices: [
        {
          id: "machine1",
          name: "Dev computer",
          platform: "linux",
          version: "1",
          connectedAt: "",
        },
      ],
    },
  });
  const remote = entries[2];
  assert.ok("label" in remote && remote.submenu && !remote.disabled);
  const machine = remote.submenu[0];
  assert.ok("label" in machine);
  assert.equal(machine.description, "offline");
  machine.onSelect?.();
  const setup = remote.submenu[1];
  assert.ok("label" in setup);
  setup.onSelect?.();
  assert.deepEqual(calls, ["machine1", "setup"]);
});

test("Remote Control searches machines and keeps setup available during loading and failure", () => {
  const menu = (remote?: { failed: boolean }) =>
    codeEnvironmentMenu({
      ...options,
      onEditLocal() {},
      onCloud() {},
      onCreateCloud() {},
      onEditCloud() {},
      remote,
    })[2];
  const pending = menu();
  assert.ok("label" in pending && pending.submenu);
  assert.equal(pending.searchable, "Search computers…");
  assert.equal(
    "label" in pending.submenu[0] && pending.submenu[0].label,
    "Loading…",
  );
  const failed = menu({ failed: true });
  assert.ok("label" in failed && failed.submenu);
  assert.equal(
    "label" in failed.submenu[0] && failed.submenu[0].label,
    "Couldn’t load your computers",
  );
  const setup = failed.submenu.at(-1)!;
  assert.ok("label" in setup && !setup.disabled);
});
