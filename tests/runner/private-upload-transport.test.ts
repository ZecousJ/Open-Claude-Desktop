import assert from "node:assert/strict";
import test from "node:test";
import { readUpload } from "../../runner/src/attachments";

test("private relay bytes are deleted after reading and after a failed read", async () => {
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const transport = { async request(op: string) {
      calls.push(op);
      if (op === "store.files.delete") return {};
      if (fail) throw Error("fixture read failure");
      return { size: 3, bytes: { $bytes: Buffer.from("abc").toString("base64") } };
    } };
    if (fail) await assert.rejects(readUpload(transport, 1, "private_fixture"));
    else assert.equal(Buffer.from(await readUpload(transport, 1, "private_fixture")).toString(), "abc");
    assert.deepEqual(calls, ["store.files.get", "store.files.delete"]);
  }
});

test("private uploads refuse an older relay before sending file bytes", async () => {
  const { upload } = await import("../../shared/web-client/codec");
  const calls: { path: string; method?: string }[] = [];
  const transport = { async fetch(path: string, init: RequestInit) {
    calls.push({ path, method: init.method });
    return Response.json({ ok: true, value: { id: "old-backend-upload" } });
  } };
  await assert.rejects(upload(transport as never, Buffer.from("private file"), { private: true }), /Private upload staging is unavailable/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});
