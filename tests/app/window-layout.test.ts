import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { LayoutCommand, OpenLayout } from "../../shared/window-layout";
import { WindowLayoutCommands } from "../../electron/app/window-layout";
import { SessionPopouts } from "../../electron/app/session-popouts";

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
