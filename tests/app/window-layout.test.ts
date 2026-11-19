import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { LayoutCommand, OpenLayout } from "../../shared/window-layout";
import { WindowLayoutCommands } from "../../electron/app/window-layout";
import {
  clampOfficialLayoutToDisplays,
  SessionPopouts,
} from "../../electron/app/session-popouts";

function contents() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
  }) as unknown as WebContents;
}

test("layout commands bind acknowledgements to the renderer and clean up", async () => {
  const commands = new WindowLayoutCommands();
  const main = contents();
  const other = contents();
  const command = { kind: "get_layout" as const, callerSessionId: "c-1" };
  assert.deepEqual(
    await commands.dispatch(undefined, command, false, () => {}),
    { kind: "no_window" },
  );
  assert.deepEqual(await commands.dispatch(main, command, false, () => {}), {
    kind: "not_listening",
  });
  commands.setListening(main, true);
  let sent!: LayoutCommand;
  const before = Date.now();
  const response = commands.dispatch(main, command, true, (value) => {
    sent = value;
  });
  assert.ok(sent.deadline >= before + 10000);
  assert.equal(sent.mainWindowHidden, true);
  commands.report(other, { requestId: sent.requestId, outcome: "failed" });
  commands.report(main, { requestId: "unknown", outcome: "failed" });
  commands.report(main, { requestId: sent.requestId, outcome: "done" });
  assert.deepEqual(await response, {
    kind: "result",
    result: { requestId: sent.requestId, outcome: "done" },
  });
  const stopped = commands.dispatch(main, command, false, () => {});
  commands.setListening(main, false);
  assert.deepEqual(await stopped, { kind: "not_listening" });
  for (const event of ["did-navigate", "render-process-gone", "destroyed"]) {
    commands.setListening(main, true);
    const pending = commands.dispatch(main, command, false, () => {});
    main.emit(event);
    assert.deepEqual(await pending, { kind: "no_window" });
  }
  commands.setListening(main, true);
  assert.deepEqual(
    await commands.dispatch(main, command, false, () => {
      throw new Error();
    }),
    { kind: "no_window" },
  );
  assert.deepEqual(await commands.dispatch(main, command, false, () => {}, 1), {
    kind: "timeout",
  });
  const pending = commands.dispatch(main, command, false, () => {});
  commands.dispose();
  assert.deepEqual(await pending, { kind: "no_window" });
});

test("whole layouts are claimed once, retain unhandled panes/projects, and expire", (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-layout-protocol-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session-popouts.json");
  let now = 1000000;
  const layout: OpenLayout = {
    popouts: [{ sessionId: "c-1", sessionType: "local" }],
    panes: [{ sessionId: "c-1", sessionType: "local", paneTileId: "browser" }],
    projects: [{ projectId: "p-1", alwaysOnTop: true }],
  };
  const writer = new SessionPopouts(
    () => file,
    () => now,
  );
  writer.report(layout);
  const reader = new SessionPopouts(
    () => file,
    () => now,
  );
  reader.report({ popouts: [], panes: [] });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).popouts.length, 1);
  assert.deepEqual(reader.take(), layout);
  assert.equal(reader.take(), null);
  reader.report({ popouts: layout.popouts, panes: [] });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).projects.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).panes.length, 1);
  reader.report({
    popouts: [],
    panes: [],
    handledPanes: [{ sessionId: "c-1", paneTileId: "browser" }],
    handledProjects: ["p-1"],
  });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.popouts, []);
  assert.deepEqual(saved.panes, []);
  assert.deepEqual(saved.projects, []);
  writer.report(layout);
  const expiring = new SessionPopouts(
    () => file,
    () => now,
  );
  expiring.report({ popouts: [], panes: [] });
  now += 600001;
  assert.equal(expiring.take(), null);
});

test("a replacement document claims the latest layout once and drops expired carry", (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-layout-reoffer-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session-popouts.json");
  let now = 1000000;
  const sessions = new SessionPopouts(
    () => file,
    () => now,
  );
  const original = {
    popouts: [{ sessionId: "original", sessionType: "local" }],
    panes: [],
    projects: [],
  };
  const latest = {
    popouts: [],
    panes: [],
    projects: [{ projectId: "replacement", alwaysOnTop: true }],
  };
  sessions.report(original);
  sessions.reoffer();
  sessions.report({ popouts: [], panes: [] });
  assert.deepEqual(sessions.take(), original);
  sessions.report(latest);
  assert.equal(sessions.take(), null);
  assert.deepEqual(new SessionPopouts(() => file).take(), {
    ...latest,
    popouts: original.popouts,
  });
  now += 600001;
  sessions.reoffer();
  assert.deepEqual(sessions.take(), latest);
  assert.equal(sessions.take(), null);
  assert.deepEqual(new SessionPopouts(() => file).take(), latest);
});

test("discard retires the old activation without touching another account", (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-layout-discard-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "account-a.json");
  const otherFile = path.join(root, "account-b.json");
  const layout = {
    popouts: [{ sessionId: "existing", sessionType: "local" }],
    panes: [],
    projects: [],
  };
  const oldActivation = new SessionPopouts(() => file);
  oldActivation.report(layout);
  oldActivation.reoffer();
  assert.deepEqual(oldActivation.take(), layout);
  new SessionPopouts(() => otherFile).report(layout);

  oldActivation.discard();
  oldActivation.report(layout);
  oldActivation.reoffer();
  assert.equal(oldActivation.take(), null);
  assert.equal(new SessionPopouts(() => file).take(), null);
  assert.deepEqual(new SessionPopouts(() => otherFile).take(), layout);

  new SessionPopouts(() => file).report(layout);
  oldActivation.discard();
  assert.deepEqual(new SessionPopouts(() => file).take(), layout);
});

test("a legacy layout with more than 50 windows in one group still restores", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-layout-legacy-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session-popouts.json");
  const geometry = {
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    alwaysOnTop: true,
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      windows: [
        ...Array.from({ length: 51 }, (_, index) => ({
          conversationId: `c-${index}`,
          ...geometry,
        })),
        { conversationId: "c-0", pane: "browser", ...geometry },
      ],
    }),
  );
  const layout = new SessionPopouts(() => file).take();
  assert.equal(layout?.popouts.length, 50);
  assert.deepEqual(layout.popouts[0], {
    sessionId: "c-0",
    sessionType: "code",
    ...geometry,
  });
  assert.deepEqual(layout.panes, [
    {
      sessionId: "c-0",
      sessionType: "code",
      paneTileId: "browser",
      ...geometry,
    },
  ]);
});

test("official pop-outs can span displays, and displaced windows cascade on return", () => {
  const left = { x: 0, y: 20, width: 1000, height: 700 };
  const right = { x: 1000, y: 20, width: 1000, height: 700 };
  const spanning = { x: 936, y: 100, width: 1100, height: 450 };
  const layout = clampOfficialLayoutToDisplays(
    {
      popouts: [
        { sessionId: "spanning", sessionType: "local", bounds: spanning },
        {
          sessionId: "barely-visible",
          sessionType: "local",
          bounds: { x: 1980, y: 100, width: 500, height: 400 },
        },
      ],
      panes: [
        {
          sessionId: "off-screen",
          sessionType: "local",
          paneTileId: "browser",
          bounds: { x: 3000, y: 150, width: 500, height: 400 },
        },
      ],
      projects: [
        {
          projectId: "oversized",
          bounds: { x: -500, y: 0, width: 2600, height: 690 },
        },
      ],
    },
    [left, right],
    (bounds) => (bounds.x >= right.x ? right : left),
  );
  assert.deepEqual(
    layout.popouts.map(({ bounds }) => bounds),
    [spanning, { x: 1250, y: 170, width: 500, height: 400 }],
  );
  assert.deepEqual(layout.panes[0].bounds, {
    x: 1282,
    y: 202,
    width: 500,
    height: 400,
  });
  assert.deepEqual(layout.projects?.[0].bounds, {
    x: 0,
    y: 30,
    width: 2000,
    height: 690,
  });
});

test("an unreadable or unsupported layout is not overwritten", (context) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-layout-invalid-"),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "session-popouts.json");
  for (const raw of ["{", '{"version":2}', "x".repeat(524289)]) {
    fs.writeFileSync(file, raw);
    const sessions = new SessionPopouts(() => file);
    assert.equal(sessions.take(), null);
    sessions.report({ popouts: [], panes: [] });
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});
