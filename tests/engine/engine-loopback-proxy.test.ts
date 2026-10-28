import assert from "node:assert/strict";
import test from "node:test";
import { withLoopbackBypass } from "../../electron/engine/engine-support";

test("Codex never sends its loopback calls to the user's proxy", () => {
  const env = withLoopbackBypass({
    HTTPS_PROXY: "http://127.0.0.1:7890",
    NO_PROXY: "corp.example, localhost",
  });
  assert.equal(env.NO_PROXY, "corp.example,localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "127.0.0.1,localhost,::1");
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
});
