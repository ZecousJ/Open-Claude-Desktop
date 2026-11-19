import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeDeviceProof } from "../../electron/official-ui/native/device-proof";

const accountId = "00112233-4455-4677-8899-aabbccddeeff";
const orgId = "10213243-5465-4687-98a9-bacbdcedfe0f";
const rowPk = "ffeeddcc-bbaa-4988-b766-554433221100";
const sessionUuid = "12345678-9abc-4def-b123-456789abcdef";
const expected = "01234abc-9def-4567-89ab-0123456789ab";
const issuedAtMs = 1732958734567;
const registration = { accountId, orgId, rowPk, issuedAtMs };
const signatureP1363B64 = Buffer.alloc(64, 251).toString("base64");
const signed = { kid: `creg_${rowPk}`, signatureP1363B64, issuedAtMs };
const fireContentHashHex = "0123456789abcdef".repeat(4);
const session = { orgUuid: orgId, sessionUuid };
const trigger = { orgUuid: orgId, fireContentHashHex };
const clientEvent = "YW50aHJvcGljLmNjci5jbGllbnRfZXZlbnQudjEAAID/";
const sessionHeader =
  "YW50aHJvcGljLmNjci5zdHJlYW1fY29ubmVjdC52MRI0VniavE3vsSNFZ4mrze//7t3Mu6pJiLdmVUQzIhEAAAABk3xjyOc=";

test("client event attestation keeps the supplied bytes and does not require a device registration", () => {
  const proof = encodeDeviceProof(
    "signAttestationPreimage",
    [accountId, clientEvent],
    { accountId },
  );
  assert.equal(proof.ok, true);
  assert.equal(proof.preimage.toString("base64"), clientEvent);
  assert.deepEqual(proof.formatResult(signatureP1363B64), {
    signatureP1363B64,
  });
});

test("attestation refuses a method preimage and a client event missing its NUL separator", () => {
  for (const bytes of [
    sessionHeader,
    Buffer.from("anthropic.ccr.client_event.v1").toString("base64"),
  ]) {
    const proof = encodeDeviceProof(
      "signAttestationPreimage",
      [accountId, bytes],
      { accountId },
    );
    assert.equal(proof.ok, false);
    assert.equal(proof.code, "bad_input");
  }
});

const desktop42120Proofs = [
  {
    name: "session header",
    op: "signForSessionHeader",
    args: [orgId, sessionUuid],
    preimageB64: sessionHeader,
    result:
      "creg_ffeeddcc-bbaa-4988-b766-554433221100.1732958734567.-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-w",
  },
  {
    name: "new session bind",
    op: "signCreateSessionBind",
    args: [orgId],
    preimageB64:
      "YW50aHJvcGljLmNjci5jcmVhdGVfc2Vzc2lvbl9iaW5kLnYxECEyQ1RlRoeYqbrL3O3+DwARIjNEVUZ3iJmqu8zd7v//7t3Mu6pJiLdmVUQzIhEAAAABk3xjyOc=",
  },
  {
    name: "previously unbound session",
    op: "signSessionBind",
    args: [orgId, sessionUuid, null],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX2JpbmQudjEQITJDVGVGh5ipusvc7f4PABEiM0RVRneImaq7zN3u/xI0VniavE3vsSNFZ4mrze8AAAAAAAAAAAAAAAAAAAAA/+7dzLuqSYi3ZlVEMyIRAAAAAZN8Y8jn",
  },
  {
    name: "conversation bind",
    op: "signConversationBind",
    args: [orgId, sessionUuid, expected],
    preimageB64:
      "YW50aHJvcGljLmNjci5jb252ZXJzYXRpb25fYmluZC52MRAhMkNUZUaHmKm6y9zt/g8AESIzRFVGd4iZqrvM3e7/EjRWeJq8Te+xI0VniavN7wEjSryd70VniasBI0Vniav/7t3Mu6pJiLdmVUQzIhEAAAABk3xjyOc=",
  },
  {
    name: "project thread link",
    op: "signProjectThreadLink",
    args: [orgId, sessionUuid, expected],
    preimageB64:
      "YW50aHJvcGljLmNjci5wcm9qZWN0X3RocmVhZF9saW5rLnYxECEyQ1RlRoeYqbrL3O3+DwARIjNEVUZ3iJmqu8zd7v8SNFZ4mrxN77EjRWeJq83vASNKvJ3vRWeJqwEjRWeJq//u3cy7qkmIt2ZVRDMiEQAAAAGTfGPI5w==",
  },
  {
    name: "trigger creation",
    op: "signTriggerOp",
    args: [orgId, "create", "", fireContentHashHex],
    preimageB64:
      "YW50aHJvcGljLmNjci50cmlnZ2VyLnYxABAhMkNUZUaHmKm6y9zt/g8AESIzRFVGd4iZqrvM3e7/Y3JlYXRlAAAAAAGTfGPI5wEjRWeJq83vASNFZ4mrze8BI0VniavN7wEjRWeJq83v",
  },
  {
    name: "trigger update without device binding",
    op: "signTriggerDigest",
    args: [
      {
        ...trigger,
        op: "update",
        subjectId: "trigger_1",
        bindToThisDevice: false,
      },
    ],
    preimageB64:
      "YW50aHJvcGljLmNjci50cmlnZ2VyLnYxABAhMkNUZUaHmKm6y9zt/g8AESIzRFVGd4iZqrvM3e7/dXBkYXRlAHRyaWdnZXJfMQAAAAGTfGPI5wEjRWeJq83vASNFZ4mrze8BI0VniavN7wEjRWeJq83v",
    result: { signed: { ...signed, rowPk } },
  },
  {
    name: "trigger approval bound to this device",
    op: "signTriggerDigest",
    args: [
      {
        ...trigger,
        op: "approve_create",
        subjectId: "cse_s1/tool_2-foo",
        bindToThisDevice: true,
      },
    ],
    preimageB64:
      "YW50aHJvcGljLmNjci50cmlnZ2VyLnYxABAhMkNUZUaHmKm6y9zt/g8AESIzRFVGd4iZqrvM3e7/YXBwcm92ZV9jcmVhdGUAY3NlX3MxL3Rvb2xfMi1mb28AAAABk3xjyOcBI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7//u3cy7qkmIt2ZVRDMiEQA=",
    result: { signed: { ...signed, rowPk } },
  },
  {
    name: "synced file put",
    op: "signSessionRequest",
    args: [
      {
        ...session,
        surface: "session_synced_file_put",
        contentSha256Hex: fireContentHashHex,
        path: "notes/草稿.txt",
        ifMatchSha256: "previous",
      },
    ],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX3N5bmNlZF9maWxlX3B1dC52MQASNFZ4mrxN77EjRWeJq83v/+7dzLuqSYi3ZlVEMyIRAAAAAZN8Y8jnASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze9ub3Rlcy/ojYnnqL8udHh0AHByZXZpb3VzAA==",
  },
  {
    name: "session archive",
    op: "signSessionRequest",
    args: [{ ...session, surface: "session_archive" }],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX2FyY2hpdmUudjEAEjRWeJq8Te+xI0VniavN7//u3cy7qkmIt2ZVRDMiEQAAAAGTfGPI5w==",
  },
  {
    name: "session delete",
    op: "signSessionRequest",
    args: [{ ...session, surface: "session_delete" }],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX2RlbGV0ZS52MQASNFZ4mrxN77EjRWeJq83v/+7dzLuqSYi3ZlVEMyIRAAAAAZN8Y8jn",
  },
  {
    name: "composer notice dismissal",
    op: "signSessionRequest",
    args: [
      {
        ...session,
        surface: "session_composer_notice_dismiss",
        noticeId: "notice_1",
      },
    ],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX2NvbXBvc2VyX25vdGljZV9kaXNtaXNzLnYxABI0VniavE3vsSNFZ4mrze//7t3Mu6pJiLdmVUQzIhEAAAABk3xjyOdub3RpY2VfMQA=",
  },
  {
    name: "session file copy",
    op: "signSessionFileCopy",
    args: [
      {
        ...session,
        fileId: "file_123-abC",
        mountPath: "/mnt/user-data/uploads/草稿.txt",
      },
    ],
    preimageB64:
      "YW50aHJvcGljLmNjci5zZXNzaW9uX2ZpbGVfYWRkLnYxABI0VniavE3vsSNFZ4mrze//7t3Mu6pJiLdmVUQzIhEAAAABk3xjyOdmaWxlXzEyMy1hYkMAL21udC91c2VyLWRhdGEvdXBsb2Fkcy/ojYnnqL8udHh0AA==",
  },
];

for (const vector of desktop42120Proofs) {
  test(`${vector.name} matches the Claude Desktop 4.4212.0 signing format`, () => {
    const proof = encodeDeviceProof(
      vector.op,
      [accountId, ...vector.args],
      registration,
    );
    assert.equal(proof.ok, true);
    assert.equal(proof.preimage.toString("base64"), vector.preimageB64);
    assert.deepEqual(
      proof.formatResult(signatureP1363B64),
      vector.result ?? signed,
    );
  });
}

const invalidProofs = [
  {
    name: "zero UUID in place of null",
    op: "signSessionBind",
    args: [orgId, sessionUuid, "00000000-0000-0000-0000-000000000000"],
  },
  {
    name: "trigger create with existing subject",
    op: "signTriggerOp",
    args: [orgId, "create", "trigger_1", fireContentHashHex],
  },
  {
    name: "trigger approval without device binding",
    op: "signTriggerDigest",
    args: [
      {
        ...trigger,
        op: "approve_create",
        subjectId: "cse_s1/tool_2-foo",
        bindToThisDevice: false,
      },
    ],
  },
  {
    name: "archive with a path",
    op: "signSessionRequest",
    args: [{ ...session, surface: "session_archive", path: "draft.txt" }],
  },
  {
    name: "synced file path with a NUL",
    op: "signSessionRequest",
    args: [
      {
        ...session,
        surface: "session_synced_file_put",
        path: "draft\0.txt",
        contentSha256Hex: fireContentHashHex,
        ifMatchSha256: "",
      },
    ],
  },
  {
    name: "unlisted session request domain",
    op: "signSessionRequest",
    args: [{ ...session, surface: "client_event" }],
  },
  {
    name: "copy to a nested uploads path",
    op: "signSessionFileCopy",
    args: [
      {
        ...session,
        fileId: "file_123",
        mountPath: "/mnt/user-data/uploads/nested/draft.txt",
      },
    ],
  },
  {
    name: "copy with a system reminder filename",
    op: "signSessionFileCopy",
    args: [
      {
        ...session,
        fileId: "file_123",
        mountPath: "/mnt/user-data/uploads/system-reminder.txt",
      },
    ],
  },
];

for (const vector of invalidProofs) {
  test(`refuses ${vector.name}`, () => {
    const proof = encodeDeviceProof(
      vector.op,
      [accountId, ...vector.args],
      registration,
    );
    assert.equal(proof.ok, false);
    assert.equal(proof.code, "bad_input");
  });
}
