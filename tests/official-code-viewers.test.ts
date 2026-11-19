import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOfficialCodeViewerLease,
  officialCodeViewerBody,
  officialCodeViewerSession,
} from "../shared/official-code-viewers";

const sessionA = "0123456789abcdef0123456789abcdef";
const sessionB = "23456789abcdef0123456789abcdef01";
const sessionC = "456789abcdef0123456789abcdef0123";
const clientA = "72987ff4-ad68-41d1-9ba1-06f2aa4df480";
const clientB = "a037fac8-0691-470e-a69e-0c65b4199dd3";

test("viewer presence matches the exact Code session POST without a query", () => {
  const path = "/v1/code/sessions/cse_" + sessionA + "/client/presence";
  assert.equal(officialCodeViewerSession("POST", path), sessionA);
  assert.equal(officialCodeViewerSession("GET", path), undefined);
  assert.equal(
    officialCodeViewerSession("POST", path, "?client_id=1"),
    undefined,
  );

  for (const invalidPath of [
    path.replace("cse_", "session_"),
    path.replace(sessionA, sessionA.toUpperCase()),
    path.replace(sessionA, sessionA.slice(1)),
    path.replace("/code/", "/"),
    path + "/",
  ]) {
    assert.equal(officialCodeViewerSession("POST", invalidPath), undefined);
  }
});

test("viewer presence requires a UUID and accepts only a literal true to clear", () => {
  const register = { client_id: clientA };
  const clear = { ...register, clear: true };
  assert.deepEqual(officialCodeViewerBody.parse(register), register);
  assert.deepEqual(officialCodeViewerBody.parse(clear), clear);

  for (const invalidBody of [
    {},
    { client_id: "invalid" },
    { ...register, clear: false },
    { ...register, clear: null },
    { ...register, session_id: sessionA },
  ]) {
    assert.equal(officialCodeViewerBody.safeParse(invalidBody).success, false);
  }
});

test("renewal and clear affect only the specified viewer in the specified session", () => {
  const sessions = new Map<string, Map<string, number>>();
  applyOfficialCodeViewerLease(sessions, sessionA, { client_id: clientA }, 0);
  applyOfficialCodeViewerLease(
    sessions,
    sessionA,
    { client_id: clientB },
    1_000,
  );
  applyOfficialCodeViewerLease(
    sessions,
    sessionB,
    { client_id: clientA },
    1_000,
  );
  applyOfficialCodeViewerLease(
    sessions,
    sessionA,
    { client_id: clientA },
    20_000,
  );

  assert.deepEqual(
    sessions,
    new Map([
      [
        sessionA,
        new Map([
          [clientA, 80_000],
          [clientB, 61_000],
        ]),
      ],
      [sessionB, new Map([[clientA, 61_000]])],
    ]),
  );

  const clear = officialCodeViewerBody.parse({
    client_id: clientA,
    clear: true,
  });
  applyOfficialCodeViewerLease(sessions, sessionA, clear, 21_000);
  applyOfficialCodeViewerLease(sessions, sessionA, clear, 21_000);

  assert.deepEqual(
    sessions,
    new Map([
      [sessionA, new Map([[clientB, 61_000]])],
      [sessionB, new Map([[clientA, 61_000]])],
    ]),
  );

  applyOfficialCodeViewerLease(sessions, sessionB, clear, 21_000);
  assert.deepEqual(
    sessions,
    new Map([[sessionA, new Map([[clientB, 61_000]])]]),
  );
});

test("a presence update drops expired viewers and empty sessions", () => {
  const sessions = new Map<string, Map<string, number>>();
  applyOfficialCodeViewerLease(sessions, sessionA, { client_id: clientA }, 0);
  applyOfficialCodeViewerLease(sessions, sessionB, { client_id: clientA }, 0);
  applyOfficialCodeViewerLease(sessions, sessionA, { client_id: clientB }, 1);
  applyOfficialCodeViewerLease(
    sessions,
    sessionC,
    { client_id: clientA },
    60_000,
  );

  assert.deepEqual(
    sessions,
    new Map([
      [sessionA, new Map([[clientB, 60_001]])],
      [sessionC, new Map([[clientA, 120_000]])],
    ]),
  );
});
