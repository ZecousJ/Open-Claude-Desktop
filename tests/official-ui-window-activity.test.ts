import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  observeWindowActivity,
  observeWindowPresentation,
  registerWindowActivity,
} from "../electron/official-ui/native/window-activity";

class Window extends EventEmitter {
  active = false;
  destroyed = false;
  visible = true;
  minimized = false;
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isFocused() {
    return this.active;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

test("native window focus/blur follows each window and removes listeners on disposal", () => {
  const a = new Window(),
    b = new Window(),
    first: boolean[] = [],
    second: boolean[] = [];
  const stop = observeWindowActivity(a, (v) => first.push(v));
  const stopB = observeWindowActivity(b, (v) => second.push(v));
  a.active = true;
  a.emit("focus");
  a.active = false;
  a.emit("blur");
  b.active = true;
  b.emit("focus");
  assert.deepEqual(first, [true, false]);
  assert.deepEqual(second, [true]);
  a.destroyed = true;
  a.emit("focus");
  assert.deepEqual(first, [true, false]);
  stop();
  stopB();
  assert.equal(a.listenerCount("focus"), 0);
  assert.equal(b.listenerCount("blur"), 0);
});

test("initial WindowState reads the calling window, not a hardcoded foreground value", () => {
  const a = new Window(),
    b = new Window(),
    methods = new Map<string, any>();
  const host = {
    caller: b,
    window: a,
    isAnyWindowFocused: () => a.active || b.active,
    on(name: string, fn: any) {
      methods.set(name, fn);
    },
  };
  registerWindowActivity(host as never);
  a.active = true;
  b.minimized = true;
  assert.equal(methods.get("WindowState.getVisibility")(), true);
  assert.equal(methods.get("WindowState.getOnScreen")(), false);
  b.minimized = false;
  assert.equal(methods.get("WindowState.getOnScreen")(), true);
  b.visible = false;
  assert.equal(methods.get("WindowState.getVisibility")(), false);
  assert.equal(methods.get("WindowState.getWindowActive")(), false);
  assert.equal(methods.get("WindowState.getAppFocused")(), true);
  b.active = true;
  assert.equal(methods.get("WindowState.getWindowActive")(), true);
  a.active = false;
  b.active = false;
  assert.equal(methods.get("WindowState.getAppFocused")(), false);
  b.destroyed = true;
  assert.equal(methods.get("WindowState.getWindowActive")(), false);
});

test("native fullscreen and visibility change events describe only their attached window", () => {
  const win = new Window();
  const changes: [string, boolean][] = [];
  const stop = observeWindowPresentation(win, (event, value) =>
    changes.push([event, value]),
  );
  win.visible = false;
  win.emit("hide");
  win.visible = true;
  win.emit("show");
  win.emit("enter-full-screen");
  win.emit("leave-full-screen");
  stop();
  win.emit("enter-full-screen");
  assert.deepEqual(changes, [
    ["visibilityChanged", false],
    ["visibilityChanged", true],
    ["fullscreenChanged", true],
    ["fullscreenChanged", false],
  ]);
});
