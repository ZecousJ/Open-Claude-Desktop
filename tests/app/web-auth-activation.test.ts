/** Actual WebAuth methods with inert post/get responses and fake browser clock/storage. */
import test from "node:test";
import assert from "node:assert/strict";
import { WebAuth } from "../../src-web/bridge/auth";
import { fakeTab } from "./web-bridge-fakes.test";
const answer = (token: string, id = "42") => ({ access_token: token, expires_in: 3600, account: { id, email: "fixture@example.invalid", name: "Fixture" } });
function fixture(t: any) {
  const tab = fakeTab(); const events: any[] = [];
  const auth = new WebAuth(tab.env, "inert-tab", event => events.push(event));
  t.after(() => auth.dispose()); return { auth, tab, events };
}
test("verified local refresh changes the token/session object but preserves opaque activation", async t => {
  const { auth, tab } = fixture(t); await auth.adopt(answer("inert-one"));
  const session = auth.current, epoch = auth.activationIdentity; let posts = 0;
  auth.post = async () => { posts++; return { status: 200, value: answer("inert-two") }; };
  const refreshed = await auth.refreshNow(session!.accessToken);
  assert.equal(posts, 1); assert.notEqual(refreshed, session); assert.equal(auth.activationIdentity, epoch);
  assert.equal(auth.current?.accessToken, "inert-two");
  assert.deepEqual(Object.keys(auth.current!).sort(), ["accessToken", "account", "expiresAt"]);
  for (const value of tab.session.values()) assert.doesNotMatch(value, /inert-one|inert-two/);
});
test("clear including repeated empty clear, same-account login and ABA replace activation", async t => {
  const { auth } = fixture(t); const initial = auth.sessionEpoch; assert.equal(auth.activationIdentity, undefined);
  auth.set(undefined); const cleared = auth.sessionEpoch; assert.notEqual(cleared, initial);
  auth.set(undefined); assert.notEqual(auth.sessionEpoch, cleared);
  await auth.adopt(answer("inert-one")); const first = auth.activationIdentity;
  await auth.adopt(answer("inert-two")); assert.notEqual(auth.activationIdentity, first);
  const second = auth.activationIdentity; auth.end("session-expired", "Inert", false); await auth.adopt(answer("inert-three"));
  assert.notEqual(auth.activationIdentity, second); assert.equal(auth.current?.account.id, "42");
});
test("late old refresh success or rejection cannot revive or expire a newer same-account session", async t => {
  for (const fail of [false, true]) {
    const { auth } = fixture(t); await auth.adopt(answer("inert-old"));
    let resolve!: (v: any) => void, reject!: (v: any) => void;
    auth.post = () => new Promise((r, j) => { resolve = r; reject = j; });
    const pending = auth.refreshNow(auth.current!.accessToken);
    auth.end("session-expired", "Inert", false); await auth.adopt(answer("inert-new")); const epoch = auth.activationIdentity;
    if (fail) reject(Object.assign(Error("inert unauthorized"), { status: 401 })); else resolve({ status: 200, value: answer("inert-stale") });
    assert.equal(await pending, null); assert.equal(auth.current?.accessToken, "inert-new"); assert.equal(auth.activationIdentity, epoch); assert.equal(auth.authUnavailable, false);
  }
});
test("late account lookup inside adopt cannot overwrite another activation", async t => {
  const { auth } = fixture(t); await auth.adopt(answer("inert-old"));
  let resolve!: (v: any) => void; auth.get = () => new Promise(r => resolve = r);
  const pending = auth.adopt({ access_token: "inert-awaiting-account" });
  const refused = assert.rejects(pending);
  await auth.adopt(answer("inert-new", "43")); const epoch = auth.activationIdentity;
  resolve({ account: answer("unused").account }); await refused;
  assert.equal(auth.current?.account.id, "43"); assert.equal(auth.current?.accessToken, "inert-new"); assert.equal(auth.activationIdentity, epoch);
});
test("refresh offline keeps current activation; confirmed expiry retires it", async t => {
  const { auth } = fixture(t); await auth.adopt(answer("inert")); const epoch = auth.activationIdentity;
  auth.post = async () => { throw Error("inert offline"); };
  await assert.rejects(() => auth.refreshNow(auth.current!.accessToken)); assert.equal(auth.activationIdentity, epoch); assert.equal(auth.authUnavailable, true);
  auth.post = async () => { throw Object.assign(Error("inert expired"), { status: 401 }); };
  assert.equal(await auth.refreshNow(auth.current!.accessToken), null); assert.equal(auth.activationIdentity, undefined);
});
test("unproven cross-tab token replacement retires epoch; rejected tab messages do not", async t => {
  const { auth } = fixture(t); await auth.adopt(answer("inert-one")); const epoch = auth.activationIdentity;
  for (const message of [null, {}, ...["9999999999999999", Infinity, NaN].map(expiresAt => ({ type: "session", session: { ...auth.current!, accessToken: "inert-invalid", expiresAt } })), { type: "session", session: {} }, { type: "session", session: { account: { id: "43" }, accessToken: "inert-other", expiresAt: Number.MAX_SAFE_INTEGER } }]) auth.fromTab(message);
  assert.equal(auth.activationIdentity, epoch);
  auth.fromTab({ type: "session", session: { ...auth.current!, accessToken: "inert-tab", expiresAt: auth.current!.expiresAt + 1 } });
  assert.notEqual(auth.activationIdentity, epoch); assert.equal(auth.current?.account.id, "42");
});
test("a queued refresh lock from a retired activation cannot adopt the new activation's session", async t => {
  const { auth, tab } = fixture(t); await auth.adopt(answer("inert-old"));
  let unlock!: () => void; const lock = new Promise<void>(r => unlock = r);
  tab.env.withLock = async (_name, work) => { await lock; return work(); };
  let posts = 0; auth.post = async () => { posts++; return { status: 200, value: answer("inert-stale") }; };
  const pending = auth.refresh(auth.current!.accessToken);
  auth.set(undefined); await auth.adopt(answer("inert-new")); unlock();
  assert.equal(await pending, null); assert.equal(posts, 0); assert.equal(auth.current?.accessToken, "inert-new");
});

test("cross-tab refreshes and ordinary logout are scoped to the same browser session", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt({ ...answer("current"), session_id: 12 });
  const opening = auth.activationIdentity;
  const current = auth.current!;
  auth.fromTab({
    type: "session",
    session: { ...current, sessionId: 13, accessToken: "different", expiresAt: current.expiresAt + 1 },
  });
  auth.fromTab({ type: "signed-out", account: "42", sessionId: 13, reason: "revoked", message: "Different browser" });
  assert.equal(auth.current?.accessToken, "current");
  auth.fromTab({
    type: "session",
    session: { ...current, accessToken: "refreshed", expiresAt: current.expiresAt + 1 },
  });
  assert.equal(auth.current?.accessToken, "refreshed");
  assert.equal(auth.activationIdentity, opening);
  auth.fromTab({ type: "signed-out", account: "42", sessionId: 12, reason: "revoked", message: "Current browser" });
  assert.equal(auth.current, undefined);
});

test("refresh refuses a replacement cookie from a different session for the same account", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt({ ...answer("current"), session_id: 12 });
  auth.post = async () => ({ status: 200, value: { ...answer("different"), session_id: 13 } });
  assert.equal(await auth.refreshNow("current"), null);
  assert.equal(auth.current, undefined);
});
