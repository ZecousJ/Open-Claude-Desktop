import test from "node:test";
import assert from "node:assert/strict";
import {
  canStep,
  maxHistory,
  navigate,
  replaceCurrent,
  startHistory,
  step,
  stepFromUnrecorded,
  type NavEntry,
} from "../../src/app/navigation-history";

const home: NavEntry = { page: "chat", surface: "chat" };
const chat = (id: string): NavEntry => ({
  page: "chat",
  surface: "chat",
  conversationId: id,
});
const all = () => true;

test("back and forward walk the recorded pages and conversations", () => {
  let h = startHistory(home);
  h = navigate(h, chat("a"));
  h = navigate(h, { page: "projects", surface: "chat" });
  assert.equal(canStep(h, "forward", all), false);
  const back = step(h, "back", all)!;
  assert.deepEqual(back.current, chat("a"));
  const again = step(back, "back", all)!;
  assert.deepEqual(again.current, home);
  assert.equal(step(again, "back", all), undefined);
  const forward = step(again, "forward", all)!;
  assert.deepEqual(forward.current, chat("a"));
  assert.deepEqual(step(forward, "forward", all)!.current, {
    page: "projects",
    surface: "chat",
  });
});

test("going somewhere new drops the forward entries; repeats are ignored", () => {
  let h = navigate(navigate(startHistory(home), chat("a")), chat("b"));
  h = step(h, "back", all)!;
  assert.equal(navigate(h, chat("a")), h);
  h = navigate(h, chat("c"));
  assert.equal(canStep(h, "forward", all), false);
  assert.deepEqual(
    h.back.map((e) => e.conversationId),
    [undefined, "a"],
  );
});

test("entries of deleted conversations are skipped", () => {
  const h = navigate(navigate(startHistory(chat("a")), chat("gone")), home);
  const valid = (e: NavEntry) => e.conversationId !== "gone";
  assert.deepEqual(step(h, "back", valid)!.current, chat("a"));
  const only = navigate(startHistory(chat("gone")), home);
  assert.equal(canStep(only, "back", valid), false);
});

test("the draft is replaced by the chat it starts, and history is capped", () => {
  const h = replaceCurrent(navigate(startHistory(chat("a")), home), chat("b"));
  assert.deepEqual(step(h, "back", all)!.current, chat("a"));
  let long = startHistory(home);
  for (let i = 0; i < maxHistory + 10; i++) long = navigate(long, chat(`${i}`));
  assert.equal(long.back.length, maxHistory);
});

test("back from an incognito chat returns to where the window was before it", () => {
  // Incognito is never recorded, so the entry before it is still current.
  const h = navigate(startHistory(chat("a")), home);
  assert.deepEqual(stepFromUnrecorded(h, "back", all)!.current, home);
  assert.equal(stepFromUnrecorded(h, "back", all), h);
  // When that entry is gone, back falls through to older ones.
  const gone = navigate(startHistory(chat("a")), chat("gone"));
  const valid = (e: NavEntry) => e.conversationId !== "gone";
  assert.deepEqual(stepFromUnrecorded(gone, "back", valid)!.current, chat("a"));
  const ahead = step(navigate(h, chat("b")), "back", all)!;
  assert.deepEqual(
    stepFromUnrecorded(ahead, "forward", all)!.current,
    chat("b"),
  );
});
