import test from "node:test";
import assert from "node:assert/strict";
import { mainWindowChrome } from "../../electron/app/main-window-chrome";
import { trafficLightPosition } from "../../electron/app/window-zoom";

test("main native window uses the source hidden frame with explicit system-button origin", () => {
  assert.deepEqual(mainWindowChrome("darwin", 0, true), {
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    trafficLightPosition: { x: 17, y: 17 },
  });
  assert.deepEqual(
    mainWindowChrome("darwin", 0, false),
    mainWindowChrome("darwin", 0, true),
  );
});

test("actual native chrome follows zoom without an inset titlebar changing the content origin", () => {
  for (const level of [-3, -0.5, 0, 0.5, 5]) {
    const frame = mainWindowChrome("darwin", level, true);
    assert.equal(frame.titleBarStyle, "hidden");
    assert.deepEqual(frame.trafficLightPosition, trafficLightPosition(level));
  }
});

test("Windows retains actual OS caption hit testing and other platforms do not receive Mac coordinates", () => {
  const dark = mainWindowChrome("win32", 0, true);
  assert.deepEqual(dark, {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#151515", symbolColor: "#f0efec", height: 36 },
  });
  assert.deepEqual(mainWindowChrome("win32", 0, false).titleBarOverlay, {
    color: "#fcfcfb",
    symbolColor: "#141413",
    height: 36,
  });
  assert.deepEqual(mainWindowChrome("linux", 0, false), {
    titleBarStyle: "hidden",
    titleBarOverlay: false,
  });
});
