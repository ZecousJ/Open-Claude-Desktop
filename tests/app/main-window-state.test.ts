/**
 * The main window's remembered size, position and zoom (electron/main-window-state.ts)
 * and the page zoom helpers (electron/window-zoom.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Rectangle } from "electron";
import {
  defaultMainWindowSize,
  mainWindowPlacement,
  readMainWindowState,
  rememberZoomLevel,
  trackMainWindow,
  writeMainWindowState,
  type TrackedWindow,
} from "../../electron/app/main-window-state";
import {
  applyZoom,
  steppedZoomLevel,
  trafficLightPosition,
  zoomFactorOf,
  zoomLimits,
} from "../../electron/app/window-zoom";

const area: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };
const file = () =>
  path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-window-state-")),
    "main-window.json",
  );

test("the main window opens at 1200 x 800 until it has a remembered size", () => {
  assert.deepEqual(defaultMainWindowSize, { width: 1200, height: 800 });
  assert.deepEqual(mainWindowPlacement(undefined, [area]), {
    width: 1200,
    height: 800,
  });
  // A small display shrinks the default to fit.
  assert.deepEqual(
    mainWindowPlacement(undefined, [{ x: 0, y: 0, width: 1024, height: 700 }]),
    { width: 1024, height: 700 },
  );
  assert.deepEqual(
    mainWindowPlacement(
      { version: 1, bounds: { x: 100, y: 80, width: 1000, height: 700 } },
      [area],
    ),
    { x: 100, y: 80, width: 1000, height: 700 },
  );
});

test("remembered bounds on a display that is gone come back on screen", () => {
  const placed = mainWindowPlacement(
    { version: 1, bounds: { x: 5000, y: 4000, width: 1000, height: 700 } },
    [area],
  );
  assert.ok(placed.x! + placed.width! <= area.width);
  assert.ok(placed.y! + placed.height! <= area.height);
});

test("the state file round-trips and invalid files mean none", () => {
  const path = file();
  assert.equal(readMainWindowState(path), undefined);
  writeMainWindowState(path, {
    version: 1,
    bounds: { x: 10, y: 20, width: 900, height: 600 },
    maximized: true,
    zoomLevel: 1,
  });
  assert.deepEqual(readMainWindowState(path), {
    version: 1,
    bounds: { x: 10, y: 20, width: 900, height: 600 },
    maximized: true,
    zoomLevel: 1,
  });
  fs.writeFileSync(path, "{not json");
  assert.equal(readMainWindowState(path), undefined);
  // A window narrower than the minimum is not a state worth restoring.
  fs.writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }),
  );
  assert.equal(readMainWindowState(path), undefined);
});

test("the zoom level is kept beside the geometry", () => {
  const path = file();
  rememberZoomLevel(path, 1.5);
  assert.equal(readMainWindowState(path)?.zoomLevel, 1.5);
  writeMainWindowState(path, {
    version: 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  });
  rememberZoomLevel(path, -1);
  assert.deepEqual(readMainWindowState(path)?.bounds, {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  assert.equal(readMainWindowState(path)?.zoomLevel, -1);
});

class FakeWindow extends EventEmitter implements TrackedWindow {
  bounds: Rectangle = { x: 40, y: 50, width: 1200, height: 800 };
  maximized = false;
  isDestroyed() {
    return false;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return false;
  }
  getNormalBounds() {
    return this.bounds;
  }
}

test("a window is saved when it is hidden or closes, unless it is the sign-in window", () => {
  const path = file();
  const win = new FakeWindow();
  let persist = true;
  trackMainWindow(
    win,
    path,
    () => 0.5,
    () => persist,
  );
  win.maximized = true;
  win.emit("hide");
  assert.deepEqual(readMainWindowState(path), {
    version: 1,
    bounds: { x: 40, y: 50, width: 1200, height: 800 },
    maximized: true,
    fullScreen: false,
    zoomLevel: 0.5,
  });
  persist = false;
  win.bounds = { x: 0, y: 0, width: 600, height: 600 };
  win.emit("close");
  assert.equal(readMainWindowState(path)?.bounds?.width, 1200);
});

test("zoom moves in half steps within limits", () => {
  assert.equal(steppedZoomLevel(0, 0.5), 0.5);
  assert.equal(steppedZoomLevel(0.5, -0.5), 0);
  assert.equal(steppedZoomLevel(4.5, 0.5), 5);
  assert.equal(steppedZoomLevel(5, 0.5), 5.5);
  // The factor stops at 25% and 500%, as in the original.
  assert.ok(Math.abs(zoomFactorOf(zoomLimits.min) - 0.25) < 1e-9);
  assert.ok(Math.abs(zoomFactorOf(zoomLimits.max) - 5) < 1e-9);
  assert.equal(steppedZoomLevel(zoomLimits.max, 0.5), zoomLimits.max);
  assert.equal(steppedZoomLevel(zoomLimits.min, -0.5), zoomLimits.min);
  assert.equal(steppedZoomLevel(8.5, 0.5), zoomLimits.max);
  assert.equal(steppedZoomLevel(-7.5, -0.5), zoomLimits.min);
  assert.ok(Math.abs(zoomFactorOf(1) - 1.2) < 1e-9);
});

test("the traffic lights follow the zoom around the original's place", () => {
  // 33/2 on both axes, rounded.
  assert.deepEqual(trafficLightPosition(0), { x: 17, y: 17 });
  // One step in (factor 1.2): round((16.5 + 6) * 1.2 - 6) = 21.
  assert.deepEqual(trafficLightPosition(1), { x: 21, y: 21 });
  const zoomed = trafficLightPosition(2);
  assert.ok(zoomed.x > 17 && zoomed.y > 17);
  const smaller = trafficLightPosition(-3);
  assert.ok(smaller.x < 17 && smaller.x >= 0);
});

test("applyZoom sets the level and the lights, and skips a destroyed window", () => {
  const calls: unknown[] = [];
  const win = {
    isDestroyed: () => false,
    setWindowButtonPosition: (position: unknown) =>
      calls.push(["lights", position]),
    webContents: {
      isDestroyed: () => false,
      setZoomLevel: (level: number) => calls.push(["zoom", level]),
    },
  };
  applyZoom(win, 1);
  assert.deepEqual(calls, [
    ["zoom", 1],
    ["lights", trafficLightPosition(1)],
  ]);
  applyZoom({ ...win, isDestroyed: () => true }, 2);
  assert.equal(calls.length, 2);
});
