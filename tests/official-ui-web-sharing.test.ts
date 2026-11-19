import assert from "node:assert/strict";
import test from "node:test";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";
import { readOfficialShareAddress } from "../src-web/official/share-link";
import type { OfficialUiReadRequest } from "../shared/official-ui-web";

const origin = "https://app.example.test";
const org = "/api/organizations/11111111-1111-4111-8111-111111111111";
const conversation =
  org + "/chat_conversations/22222222-2222-4222-8222-222222222222";
const revoke = org + "/share/share_42";
const grant =
  org + "/chat_snapshots/share_42/grants/33333333-3333-4333-8333-333333333333";
const address = "/api/__claudex/share-url/share_42";
const bytes = (text: string) => new TextEncoder().encode(text);

test("original sharing fetches stay on the scoped read and mutation channels", async () => {
  const reads: OfficialUiReadRequest[] = [];
  const writes: OfficialUiReadRequest[] = [];
  const fetch = createOfficialReadFetch(
    origin,
    async (request) => {
      reads.push(request);
      return {
        status: 200,
        contentType: "text/plain; charset=utf-8",
        body: bytes("response"),
      };
    },
    async () => assert.fail("Must use the authenticated sharing bridge."),
    undefined,
    async (request) => {
      writes.push(request);
      return { status: 204, contentType: "application/json", body: bytes("") };
    },
  );
  const paths = [
    conversation + "/latest",
    conversation + "/latest?last_message_uuid=turn%3Aassistant",
    conversation + "/share_access",
    conversation + "/shares",
    conversation + "/access_requests",
    org + "/shares",
    address,
  ];
  for (const path of paths)
    assert.equal(await (await fetch(path)).text(), "response");
  assert.deepEqual(
    reads,
    paths.map((path) => ({ method: "GET", path })),
  );

  const body = JSON.stringify({
    visibility: "invite_only",
    emails: ["test@example.test"],
  });
  const options = { headers: { "content-type": "application/json" } };
  assert.equal(
    (await fetch(conversation + "/share", { ...options, method: "POST", body }))
      .status,
    204,
  );
  assert.equal((await fetch(revoke, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(grant, { method: "DELETE" })).status, 204);
  assert.deepEqual(
    writes.map(({ method, path }) => [method, path]),
    [
      ["POST", conversation + "/share"],
      ["DELETE", revoke],
      ["DELETE", grant],
    ],
  );
  assert.equal(new TextDecoder().decode(writes[0].body), body);

  for (const [method, path] of [
    ["GET", conversation + "/share"],
    ["POST", org + "/shares"],
    [
      "GET",
      conversation + "/latest?last_message_uuid=one&last_message_uuid=two",
    ],
    ["GET", conversation + "/latest?limit=1"],
    ["GET", address + "?foo=bar"],
    ["POST", conversation + "/share?visibility=public"],
    ["DELETE", revoke + "/extra"],
    ["DELETE", grant.replace("grants", "people")],
  ])
    assert.equal((await fetch(path, { method })).status, 501, path);
  assert.equal(reads.length, paths.length);
  assert.equal(writes.length, 3);
});

test("share handoff uses the current authenticated read and refuses an unusable response", async () => {
  const read =
    (body: string, status = 200) =>
    async (request: OfficialUiReadRequest) => {
      assert.deepEqual(request, { method: "GET", path: address });
      return {
        status,
        contentType: "text/plain; charset=utf-8",
        body: bytes(body),
      };
    };
  for (const path of ["/s/public-token", "/shared/invited-token"]) {
    const destination = "https://shares.example.test" + path;
    assert.equal(
      await readOfficialShareAddress(read(destination), "share_42", origin),
      destination,
    );
  }
  for (const body of ["", "javascript:alert(1)", origin + "/share/share_42"]) {
    await assert.rejects(
      readOfficialShareAddress(read(body), "share_42", origin),
    );
  }
  await assert.rejects(
    readOfficialShareAddress(
      read("https://shares.example.test/s/revoked", 404),
      "share_42",
      origin,
    ),
  );
});
