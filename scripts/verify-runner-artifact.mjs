import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { wsServer } from "../tests/runner/runner-core-support.test.ts";

const [, , bundle = "dist-runner/runner.mjs"] = process.argv;
const { startRunner } = await import(pathToFileURL(resolve(bundle)).href);
const stateDir = await mkdtemp(resolve(tmpdir(), "verify-runner-"));
const mib = 1024 * 1024;
const content = randomBytes(19 * mib).toString("base64") + "完整快照";
const id = "verify-large-snapshot";
const snapshot = { projects: [], conversations: [{ text: content }] };
const { promise, resolve: acceptResult, reject } = Promise.withResolvers();
const timeout = setTimeout(() => reject(Error("Runner snapshot timed out")), 15_000);
const parts = [];
let offset = 0;
let server;
let runner;

try {
  server = await wsServer((socket) => {
    socket.onText = (text) => {
      try {
        const frame = JSON.parse(text);
        if (frame.t === "hello") {
          assert.ok(frame.methods.includes("snapshot"), "Runner does not advertise snapshot");
          socket.send(JSON.stringify({ t: "welcome", v: 1, runnerId: "verify", heartbeatMs: 25_000 }));
          socket.send(JSON.stringify({
            t: "call", id, user: { id: 1, accessToken: "fixture" },
            method: "snapshot", args: [], deadlineMs: 10_000,
          }));
        } else if (frame.t === "result" && frame.id === id) {
          acceptResult(frame);
        } else if (frame.t === "chunk") {
          assert.ok(Buffer.byteLength(text) <= 16 * mib, "Runner exceeded the 16 MiB frame limit");
          assert.equal(frame.offset, offset, "Runner chunks arrived out of order");
          const part = Buffer.from(frame.data, "base64");
          parts.push(part);
          offset += part.length;
          if (offset === frame.totalBytes) {
            const payload = Buffer.concat(parts);
            const decoded = frame.encoding === "gzip" ? gunzipSync(payload) : payload;
            assert.equal(decoded.length, frame.decodedBytes, "Runner reported the wrong decoded size");
            acceptResult(JSON.parse(decoded.toString("utf8")));
          }
        }
      } catch (error) {
        reject(error);
      }
    };
  });
  runner = await startRunner({
    serviceUrl: server.url, token: "verifier-fixture-token", stateDir,
    driver: "none", diskQuota: "none", modes: ["chat"],
    network: { level: "none" }, maxEngines: 1, maxUsers: 1, labels: {},
  }, () => {});
  // Supply a snapshot at the method boundary; the built runner handles the RPC and link.
  runner.dispatcher.run = (frame) => {
    assert.equal(frame.method, "snapshot");
    return snapshot;
  };
  const result = await promise;
  assert.equal(result.id, id);
  assert.ok(result.ok, `Runner returned ${result.error?.code ?? "an unsuccessful result"}`);
  assert.ok(result.value?.conversations?.[0]?.text === content, "Runner changed the snapshot content");
  assert.ok(parts.length > 1, "Runner did not chunk the large snapshot");
  console.log(`Runner relayed a ${(Buffer.byteLength(content) / mib).toFixed(1)} MiB snapshot in ${parts.length} frames`);
} finally {
  clearTimeout(timeout);
  await runner?.stop(1_000);
  await server?.close();
  await rm(stateDir, { recursive: true, force: true });
}
