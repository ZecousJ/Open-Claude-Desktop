import test from "node:test";
import assert from "node:assert/strict";
import { editorUrl, menuEditors } from "../../shared/editors";
import { wantsKeepAwake } from "../../electron/engine/attention-rules";

test("editor URLs open the folder locally, on Windows and over SSH", () => {
  assert.equal(
    editorUrl("vscode://", "/Users/me/My App"),
    "vscode://file//Users/me/My%20App",
  );
  assert.equal(
    editorUrl("cursor://", "C:\\work\\app", undefined, true),
    "cursor://file/C%3A/work/app",
  );
  assert.equal(
    editorUrl("vscode://", "/srv/app", { destination: "me@box", port: 2222 }),
    "vscode://vscode-remote/ssh-remote+me@box:2222/srv/app",
  );
  assert.throws(() =>
    editorUrl("vscode://", "/srv/a#b", { destination: "box" }),
  );
  assert.throws(() =>
    editorUrl("vscode://", "/srv", { destination: "-oProxy" + " x" }),
  );
});

test("Open in lists installed editors by name, without Xcode, and without Zed over SSH", () => {
  const list = [
    { kind: "zed", name: "Zed", installed: true },
    { kind: "vscode", name: "VS Code", installed: true },
    { kind: "cursor", name: "Cursor", installed: false },
    { kind: "xcode", name: "Xcode", installed: true },
  ] as const;
  assert.deepEqual(
    menuEditors([...list], false).map((e) => e.name),
    ["VS Code", "Zed"],
  );
  assert.deepEqual(
    menuEditors([...list], true).map((e) => e.name),
    ["VS Code"],
  );
});

test("a session's Keep computer awake holds the computer on battery too", () => {
  const base = {
    keepAwake: false,
    keepAwakeWhileCoding: false,
    keepAwakeOnBattery: false,
    onBattery: true,
    codeRunning: false,
  };
  assert.equal(wantsKeepAwake(base), false);
  assert.equal(wantsKeepAwake({ ...base, sessionKeepAwake: true }), true);
});
