import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import {
  readBoundedJson,
  RequestBodyError,
} from "../electron/official-ui/api/request-body";
const request = () =>
  Object.assign(new EventEmitter(), {
    headers: {},
  }) as unknown as IncomingMessage;
test("bounded JSON accepts split exact-bound objects and cleans listeners", async () => {
  const req = request();
  const body = Buffer.from('{"text":"中文"}');
  const result = readBoundedJson(req, body.length);
  req.emit("data", body.subarray(0, 9));
  req.emit("data", body.subarray(9));
  req.emit("end");
  assert.deepEqual(await result, { text: "中文" });
  assert.equal(req.listenerCount("data"), 0);
});
test("oversized/chunked bodies reject 413 without retaining or destroying the stream", async () => {
  const req = request();
  const result = readBoundedJson(req, 8);
  req.emit("data", Buffer.alloc(9));
  await assert.rejects(result, (e: RequestBodyError) => e.status === 413);
  req.emit("data", Buffer.alloc(100));
  req.emit("end");
  assert.equal(req.listenerCount("data"), 0);
  const declared = request();
  declared.headers["content-length"] = "100";
  const p = readBoundedJson(declared, 8);
  await assert.rejects(p, (e: RequestBodyError) => e.status === 413);
  declared.emit("error", Error("late stream failure"));
  assert.equal(declared.listenerCount("error"), 0);
});
test("malformed JSON, arrays, aborted and incomplete streams produce explicit 400", async () => {
  for (const body of ["null", "[]", "{"]) {
    const req = request(),
      p = readBoundedJson(req, 100);
    req.emit("data", Buffer.from(body));
    req.emit("end");
    await assert.rejects(p, (e: RequestBodyError) => e.status === 400);
  }
  for (const event of ["aborted", "error", "close"]) {
    const req = request(),
      p = readBoundedJson(req, 100);
    req.emit(event, Error("private error"));
    await assert.rejects(
      p,
      (e: RequestBodyError) =>
        e.status === 400 && !e.message.includes("private error"),
    );
    assert.equal(req.listenerCount("data"), 0);
  }
});
