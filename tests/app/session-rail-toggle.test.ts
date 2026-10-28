import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  '<html><body><div id="root"></div></body></html>',
);
const stored = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
};
Object.assign(globalThis, {
  window,
  document,
  localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { setRailFits, setRailRaised, useRailToggle, useRailRaised } =
  await import("../../src/session-rail/rail-store");

test("the rail toggle is pressed while the rail is on screen and raises it when the column has no room", async () => {
  let view: ReturnType<typeof useRailToggle> | undefined;
  let raised: string | null = null;
  function Probe() {
    view = useRailToggle("s1");
    raised = useRailRaised();
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(createElement(Probe)));
  // Shown (the default) but no room: not on screen; the toggle raises it.
  await act(async () => setRailFits(false));
  assert.equal(view!.onScreen, false);
  await act(async () => view!.toggle());
  assert.equal(raised, "s1");
  assert.equal(view!.onScreen, true);
  // Toggled again it lowers, and the rail stays shown for when it fits.
  await act(async () => view!.toggle());
  assert.equal(raised, null);
  await act(async () => setRailFits(true));
  assert.equal(view!.onScreen, true);
  // With room the toggle hides the column, then shows it, never raising.
  await act(async () => view!.toggle());
  assert.equal(view!.onScreen, false);
  await act(async () => view!.toggle());
  assert.equal(view!.onScreen, true);
  assert.equal(raised, null);
  await act(async () => {
    setRailRaised(null);
    root.unmount();
  });
});
