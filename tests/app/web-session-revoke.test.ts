import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudexErrorCodes } from "../../shared/claudex-contract";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { Sub2ApiError } from "../../electron/sub2api/http";
import { WebSession } from "../../runner/src/web-remote-host";

const revoked = () =>
  new Sub2ApiError(
    401,
    claudexErrorCodes.sessionRevoked,
    "This session was signed out.",
  );

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-session-"));
  const s = new WebSession(new Sub2ApiClient("http://127.0.0.1:1"), root, {
    baseUrl: "http://127.0.0.1:1",
    userId: 7,
    email: "a@example.com",
  });
  let signedOut = 0;
  s.onSignedOut = () => void signedOut++;
  return { s, signedOut: () => signedOut };
}

test("one client's revoked token does not sign the user out", async () => {
  const { s, signedOut } = session();
  s.setAccessToken("desktop");
  await assert.rejects(
    s.authorized(async () => {
      throw revoked();
    }),
  );
  assert.equal(signedOut(), 0);
  assert.equal(s.hasToken, false);
  // The phone's next call brings its own token and works.
  s.setAccessToken("phone");
  assert.equal(await s.authorized(async (t) => t), "phone");
});

test("a newer token from another client is used after a revoke", async () => {
  const { s, signedOut } = session();
  s.setAccessToken("desktop");
  const seen: string[] = [];
  const value = await s.authorized(async (t) => {
    seen.push(t);
    if (t === "desktop") {
      s.setAccessToken("phone");
      throw revoked();
    }
    return t;
  });
  assert.deepEqual(seen, ["desktop", "phone"]);
  assert.equal(value, "phone");
  assert.equal(signedOut(), 0);
});
