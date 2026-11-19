/** Actual WebAuth methods; all service calls inert/deferred, no real credentials. */
import test from "node:test";
import assert from "node:assert/strict";
import { WebAuth } from "../../src-web/bridge/auth";
import { fakeTab } from "./web-bridge-fakes.test";
const answer = (token: string, id = "42") => ({
  access_token: token,
  expires_in: 3600,
  account: { id, email: "fixture@example.invalid", name: "Fixture" },
});
function fixture(t: any) {
  const tab = fakeTab();
  const auth = new WebAuth(tab.env, "inert", () => {});
  t.after(() => auth.dispose());
  return { auth, tab };
}
function deferred() {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
}
for (const action of [
  "logout",
  "revokeAll",
  "switchAccount",
  "forgetBrowserAccount",
  "login",
] as const) {
  test(`late ${action} response cannot mutate a new activation`, async (t) => {
    const { auth } = fixture(t);
    if (action !== "login") await auth.adopt(answer("old"));
    const d = deferred();
    let started!: () => void;
    const posted = new Promise<void>((r) => (started = r));
    auth.post = async () => {
      started();
      return d.promise;
    };
    const pending =
      action === "switchAccount"
        ? auth.switchAccount("43")
        : action === "forgetBrowserAccount"
          ? auth.forgetBrowserAccount("43")
          : action === "login"
            ? auth.login("fixture@example.invalid", "inert")
            : auth[action]();
    const checked = assert.rejects(pending, /changed|retired|session/i);
    await posted;
    await auth.adopt(answer("new", "43"));
    const epoch = auth.sessionEpoch;
    let tells = 0;
    auth.tell = () => {
      tells++;
    };
    d.resolve({ status: 200, value: answer("stale", "43") });
    await checked;
    assert.equal(auth.current?.accessToken, "new");
    assert.equal(auth.sessionEpoch, epoch);
    assert.equal(tells, 0);
  });
}
test("queued switch and pending revoke token do not dispatch after retirement", async (t) => {
  for (const kind of ["switch", "revoke"]) {
    const { auth, tab } = fixture(t);
    await auth.adopt(answer("old"));
    const gate = deferred();
    let posts = 0;
    auth.post = async () => {
      posts++;
      return { status: 200, value: answer("stale", "43") };
    };
    if (kind === "switch")
      tab.env.withLock = async (_name, work) => {
        await gate.promise;
        return work();
      };
    else
      auth.accessToken = async () => {
        await gate.promise;
        return "old";
      };
    const p = kind === "switch" ? auth.switchAccount("43") : auth.revokeAll();
    const rejected = assert.rejects(p, /session changed/i);
    auth.set(undefined);
    await auth.adopt(answer("new"));
    gate.resolve(undefined);
    await rejected;
    assert.equal(posts, 0);
    assert.equal(auth.current?.accessToken, "new");
  }
});
test("same-account ABA logout response cannot clear renewed session", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt(answer("old"));
  const d = deferred();
  auth.post = () => d.promise;
  const p = auth.logout();
  const rejected = assert.rejects(p, /session changed/i);
  auth.set(undefined);
  await auth.adopt(answer("new"));
  d.resolve({ status: 200, value: {} });
  await rejected;
  assert.equal(auth.current?.accessToken, "new");
});
test("2FA cancellation prevents pending response adoption", async (t) => {
  const { auth } = fixture(t);
  auth.pendingTwoFactor = { tempToken: "inert", maskedEmail: "fixture" };
  const d = deferred();
  auth.post = () => d.promise;
  const p = auth.completeTwoFactor("000000");
  const rejected = assert.rejects(p);
  const cancel = auth.cancelTwoFactor();
  d.resolve({ status: 200, value: answer("stale") });
  await cancel;
  await rejected;
  assert.equal(auth.current, undefined);
});
test("passkey browser prompt cannot submit after activation changes", async (t) => {
  const { auth, tab } = fixture(t);
  const d = deferred();
  let started!: () => void;
  const prompting = new Promise<void>((r) => (started = r));
  let posts = 0;
  tab.env.passkey = async () => {
    started();
    return d.promise;
  };
  auth.post = async () => {
    posts++;
    return { status: 200, value: { session_token: "inert", options: {} } };
  };
  const p = auth.loginWithPasskey();
  const rejected = assert.rejects(p, /session changed/i);
  await prompting;
  await auth.adopt(answer("new"));
  d.resolve({ inert: true });
  await rejected;
  assert.equal(posts, 1);
  assert.equal(auth.current?.accessToken, "new");
});
test("same-activation logout and switch still work", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt(answer("old"));
  auth.post = async () => ({ status: 200, value: answer("switched", "43") });
  assert.equal((await auth.switchAccount("43")).id, "43");
  await auth.logout();
  assert.equal(auth.current, undefined);
});
test("synchronous signout subscriber cannot be cleared or followed by old account effects", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt(answer("old"));
  auth.post = async () => ({ status: 200, value: {} });
  let afterNew = 0;
  let reentered = false;
  const tell = auth.tell.bind(auth);
  auth.tell = (m) => {
    if (reentered) afterNew++;
    tell(m);
  };
  auth.changes.add((session) => {
    if (!session && !reentered) {
      reentered = true;
      void auth.adopt(answer("new", "43"));
    }
  });
  await assert.rejects(auth.logout(), /session changed/i);
  assert.equal(auth.current?.accessToken, "new");
  assert.equal(afterNew, 1); // only new adoption's own session broadcast
});
test("late signout policy result is not returned for a new activation", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt(answer("old"));
  auth.post = async () => ({ status: 200, value: {} });
  const d = deferred();
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  auth.signedOutStatus = async () => {
    entered();
    return d.promise;
  };
  const p = auth.logout();
  const rejected = assert.rejects(p, /session changed/i);
  await started;
  await auth.adopt(answer("new"));
  d.resolve({});
  await rejected;
  assert.equal(auth.current?.accessToken, "new");
});
for (const kind of ["code", "google", "register", "two-factor"] as const) {
  test(`late ${kind} sign-in cannot replace a later session`, async (t) => {
    const { auth } = fixture(t);
    const d = deferred();
    auth.post = () => d.promise;
    if (kind === "two-factor")
      auth.pendingTwoFactor = { tempToken: "inert", maskedEmail: "fixture" };
    const p =
      kind === "code"
        ? auth.loginWithCode("fixture@example.invalid", "inert")
        : kind === "google"
          ? auth.loginWithGoogle("inert")
          : kind === "register"
            ? auth.register("fixture@example.invalid", "inert", "Fixture")
            : auth.completeTwoFactor("000000");
    const rejected = assert.rejects(p, /session changed/i);
    await auth.adopt(answer("new"));
    d.resolve({ status: 200, value: answer("stale") });
    await rejected;
    assert.equal(auth.current?.accessToken, "new");
  });
}
test("late switch expiry does not mark a renewed target signed out", async (t) => {
  const { auth } = fixture(t);
  await auth.adopt(answer("old"));
  let reject!: (error: unknown) => void;
  auth.post = () => new Promise((_r, j) => (reject = j));
  let marks = 0;
  auth.markSignInAgain = () => {
    marks++;
  };
  const p = auth.switchAccount("43");
  const rejected = assert.rejects(p, /session changed/i);
  await Promise.resolve();
  await auth.adopt(answer("new", "43"));
  reject(Object.assign(Error("inert"), { status: 401 }));
  await rejected;
  assert.equal(marks, 0);
});

test("revoke-all waits for service confirmation when its events socket closes first", async (t) => {
  for (const fail of [false, true]) {
    const { auth, tab } = fixture(t);
    await auth.adopt(answer("old"));
    let settle!: (value: { status: number; value: unknown }) => void;
    let reject!: (reason: Error) => void;
    let sent!: () => void;
    const dispatched = new Promise<void>((resolve) => { sent = resolve; });
    auth.post = async () => {
      sent();
      return new Promise((resolve, refuse) => { settle = resolve; reject = refuse; });
    };
    auth.signedOutStatus = async () => ({ hasAccounts: true });
    const pending = auth.revokeAll();
    await dispatched;
    auth.expire("revoked");
    assert.equal(auth.current?.account.id, "42");
    if (fail) {
      const rejected = assert.rejects(pending, /unavailable/);
      reject(Error("Service unavailable"));
      await rejected;
      assert.equal(tab.session.get("claudex-web-account"), "42");
    } else {
      settle({ status: 200, value: {} });
      assert.deepEqual(await pending, { hasAccounts: true });
      assert.equal(tab.session.get("claudex-web-account"), undefined);
    }
    assert.equal(auth.current, undefined);
  }
});

test("a failed current sign-out leaves the session active for retry", async (t) => {
  const { auth, tab } = fixture(t);
  await auth.adopt(answer("current"));
  const activation = auth.activationIdentity;
  auth.post = async () => { throw Error("Service unavailable"); };
  await assert.rejects(auth.logout(), /unavailable/);
  assert.equal(auth.activationIdentity, activation);
  assert.equal(tab.session.get("claudex-web-account"), "42");
  auth.post = async () => ({ status: 200, value: {} });
  auth.signedOutStatus = async () => ({ hasAccounts: true });
  await auth.logout();
  assert.equal(auth.current, undefined);
});
