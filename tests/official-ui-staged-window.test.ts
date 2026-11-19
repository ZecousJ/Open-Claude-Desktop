import test from "node:test";
import assert from "node:assert/strict";
import { stageOfficialWindow } from "../electron/official-ui/staged-window";
class Window {
  destroyed = false;
  failDestroy = false;
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.failDestroy) throw Error("destroy refused");
    this.destroyed = true;
  }
}
test("synchronous retirement during subscription never commits a candidate", () => {
  const old = new Window(),
    candidate = new Window();
  let main = old;
  const stage = stageOfficialWindow({
    current: () => true,
    subscribeRetirement: (fn) => {
      fn();
      return () => {};
    },
    main: () => main,
    setMain: (win) => {
      main = win;
    },
    extra: false,
  });
  assert.throws(() => stage.attach(candidate), /account or main window changed/);
  stage.dispose();
  assert.equal(candidate.destroyed, true);
  assert.equal(main, old);
});
test("destroy failure stays explicit and does not publish candidate or destroy a replacement login", () => {
  const old = new Window(),
    candidate = new Window(),
    replacement = new Window();
  let main = old,
    retire = () => {};
  const stage = stageOfficialWindow({
    current: () => true,
    subscribeRetirement: (fn) => {
      retire = fn;
      return () => {};
    },
    main: () => main,
    setMain: (win) => {
      main = win;
    },
    extra: false,
  });
  stage.attach(candidate);
  candidate.failDestroy = true;
  main = replacement;
  assert.throws(() => retire(), /destroy refused/);
  assert.throws(() => stage.commit(), /account or main window changed/);
  assert.throws(() => stage.dispose(), /destroy refused/);
  assert.equal(main, replacement);
  assert.equal(old.destroyed, false);
  assert.equal(replacement.destroyed, false);
  candidate.failDestroy = false;
  stage.dispose();
  assert.equal(candidate.destroyed, true);
});
test("committed window is never destroyed by creation cleanup or a late retirement callback", () => {
  const old = new Window(),
    candidate = new Window();
  let main = old,
    retire = () => {};
  const stage = stageOfficialWindow({
    current: () => true,
    subscribeRetirement: (fn) => {
      retire = fn;
      return () => {};
    },
    main: () => main,
    setMain: (win) => {
      main = win;
    },
    extra: false,
  });
  stage.attach(candidate);
  stage.commit();
  retire();
  stage.dispose();
  assert.equal(main, candidate);
  assert.equal(candidate.destroyed, false);
  assert.equal(old.destroyed, false);
});
