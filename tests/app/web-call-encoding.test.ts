import test from "node:test";
import assert from "node:assert/strict";
import { encodeCall } from "../../shared/web-client/codec";
import type { WebTransport } from "../../shared/web-client/transport";

const transport = {} as WebTransport;

test("a left-out trailing argument is not sent as null (saveProject without a creation)", async () => {
  const project = { id: "p", name: "Name" };
  assert.deepEqual(
    JSON.parse(await encodeCall([project, undefined], transport)).args,
    [project],
  );
  assert.deepEqual(
    JSON.parse(await encodeCall([undefined, undefined], transport)).args,
    [],
  );
  // A hole before a value keeps its place.
  assert.deepEqual(
    JSON.parse(await encodeCall([undefined, 2], transport)).args,
    [null, 2],
  );
  assert.deepEqual(
    JSON.parse(await encodeCall([project, null], transport)).args,
    [project, null],
  );
});
