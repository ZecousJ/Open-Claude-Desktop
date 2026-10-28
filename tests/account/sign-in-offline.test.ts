/** Sign-in requests wait for the connection. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  offlineNotes,
  offlineWaitOf,
  runWhenOnline,
  type Connection,
} from "../../src/auth/whenOnline";

/** A connection the test takes down and brings back. */
function fakeConnection(offline: boolean) {
  let waiting: Array<() => void> = [];
  const state = { offline, waits: 0 };
  const connection: Connection = {
    offline: () => state.offline,
    online: () => {
      state.waits++;
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
  const back = () => {
    state.offline = false;
    const run = waiting;
    waiting = [];
    run.forEach((resolve) => resolve());
  };
  return { connection, state, back };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("online, the request goes out at once and says nothing", async () => {
  const { connection } = fakeConnection(false);
  const paused: boolean[] = [];
  let calls = 0;
  const value = await runWhenOnline(
    async () => ++calls,
    (p) => paused.push(p),
    connection,
  );
  assert.equal(value, 1);
  assert.deepEqual(paused, []);
});

test("offline, the request waits, the form says so, and it goes out when the connection returns", async () => {
  const { connection, back } = fakeConnection(true);
  const paused: boolean[] = [];
  let calls = 0;
  const pending = runWhenOnline(
    async () => ++calls,
    (p) => paused.push(p),
    connection,
  );
  await tick();
  assert.equal(calls, 0, "nothing is sent offline");
  assert.deepEqual(paused, [true]);
  back();
  assert.equal(await pending, 1);
  assert.deepEqual(paused, [true, false]);
});

test("a request the dropped connection broke is sent again when it returns", async () => {
  const { connection, state, back } = fakeConnection(false);
  const paused: boolean[] = [];
  let calls = 0;
  const pending = runWhenOnline(
    async () => {
      calls++;
      if (calls === 1) {
        state.offline = true;
        throw new Error("Can't reach Claudex.");
      }
      return "signed in";
    },
    (p) => paused.push(p),
    connection,
  );
  await tick();
  assert.deepEqual(paused, [true]);
  back();
  assert.equal(await pending, "signed in");
  assert.equal(calls, 2);
});

test("a refusal while online is the request's own", async () => {
  const { connection } = fakeConnection(false);
  await assert.rejects(
    runWhenOnline(
      async () => {
        throw new Error("Email or password is incorrect.");
      },
      () => {},
      connection,
    ),
    /incorrect/,
  );
});

test("each step waits as the original names it", () => {
  assert.equal(offlineWaitOf("email", true), "sign-in");
  assert.equal(offlineWaitOf("email", false), undefined);
  assert.equal(offlineWaitOf("password", false), "sign-in");
  assert.equal(offlineWaitOf("code", true), "verify");
  assert.equal(offlineWaitOf("twoFactor", false), "verify");
  assert.equal(offlineWaitOf("createVerify", false), "verify");
  assert.equal(offlineWaitOf("forgot", false), undefined);
  assert.equal(
    offlineNotes["sign-in"],
    "You appear to be offline. Your sign-in will continue when your connection returns.",
  );
  assert.equal(
    offlineNotes.verify,
    "You appear to be offline. Your code will be verified when your connection returns.",
  );
  assert.equal(
    offlineNotes.send,
    "You appear to be offline. Your code will be sent when your connection returns.",
  );
});
