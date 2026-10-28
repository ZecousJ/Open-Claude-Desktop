import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { Gateway } from "../../electron/engine/gateway";
import { RequestLimiter } from "../../server/request-limiter";
import {
  loadOperatorLimits,
  parseRequestLimits,
  resolveRequestLimits,
  saveOperatorLimits,
  type RequestLimits,
} from "../../server/operator-limits";

const account = "00000000-0000-4000-8000-000000000001";
const unlimited: RequestLimits = parseRequestLimits({});

test("operator limits are isolated by account and reject invalid policies without overwriting them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-limits-"));
  try {
    assert.deepEqual(resolveRequestLimits(root, account), unlimited);
    saveOperatorLimits(root, {
      version: 1,
      defaults: { requestsPerMinute: 30, dailyTokenLimit: 1000 },
      accounts: { [account]: { requestsPerMinute: 5, maxConcurrent: 2 } },
    });
    assert.deepEqual(resolveRequestLimits(root, account), {
      ...unlimited,
      maxConcurrent: 2,
      requestsPerMinute: 5,
      dailyTokenLimit: 1000,
    });
    assert.deepEqual(
      resolveRequestLimits(root, "00000000-0000-4000-8000-000000000002"),
      { ...unlimited, requestsPerMinute: 30, dailyTokenLimit: 1000 },
    );
    const filename = path.join(root, "backend", "limits.json"),
      before = fs.readFileSync(filename, "utf8");
    assert.throws(
      () =>
        saveOperatorLimits(root, {
          version: 1,
          defaults: { maxConcurrent: 0 },
          accounts: {},
        }),
      /out of range/,
    );
    assert.equal(fs.readFileSync(filename, "utf8"), before);
    fs.writeFileSync(
      filename,
      JSON.stringify({
        version: 1,
        defaults: { secret: "leak" },
        accounts: {},
      }),
    );
    assert.throws(() => loadOperatorLimits(root), /cannot be read/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("operator CLI changes account limits without placing credentials in the file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-limits-cli-"));
  try {
    const configured = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "server/operator-limits-cli.ts",
        "--data-dir",
        root,
        "--account",
        account,
        "--concurrent",
        "3",
        "--per-minute",
        "unlimited",
        "--daily-tokens",
        "400",
      ],
      { encoding: "utf8" },
    );
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(resolveRequestLimits(root, account), {
      ...unlimited,
      maxConcurrent: 3,
      requestsPerMinute: null,
      dailyTokenLimit: 400,
    });
    // Windows reports POSIX mode bits as 0666 even when Node writes with mode 0600.
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(root, "backend", "limits.json")).mode & 0o777,
        0o600,
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sliding request window, concurrency and reported-token threshold reset correctly", () => {
  let now = Date.UTC(2026, 8, 23, 0, 0, 0);
  const day = "2026-09-23";
  const limiter = new RequestLimiter(
    parseRequestLimits({
      maxConcurrent: 1,
      requestsPerMinute: 2,
      dailyTokenLimit: 10,
    }),
    { day, tokens: 8 },
    () => now,
  );
  const release = limiter.acquire();
  assert.throws(() => limiter.acquire(), /too many requests in progress/);
  release();
  release();
  const second = limiter.acquire();
  second();
  assert.throws(() => limiter.acquire(), /requests-per-minute/);
  now += 60_001;
  const third = limiter.acquire();
  third();
  limiter.recordUsage(now, 1, 1);
  assert.throws(() => limiter.acquire(), /daily token limit/);
  now += 86_400_000;
  const tomorrow = limiter.acquire();
  tomorrow();
});

test("localhost gateway rejects concurrent account requests with HTTP 429 before upstream", async (t) => {
  let arrive!: () => void,
    release!: () => void,
    seen = 0;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstream = http.createServer(async (_req, res) => {
    seen++;
    arrive();
    await hold;
    res
      .writeHead(200, { "content-type": "text/event-stream" })
      .end(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(async () => {
    release();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const limiter = new RequestLimiter(parseRequestLimits({ maxConcurrent: 1 }), {
    day: "2026-09-23",
    tokens: 0,
  });
  const bridge = new Gateway(
    () => ({
      provider: {
        id: "managed",
        name: "Mock",
        baseUrl,
        protocol: "responses",
        model: "fixture",
        models: ["fixture"],
      },
      apiKey: "synthetic-key",
    }),
    undefined,
    limiter,
  );
  await bridge.start();
  t.after(() => bridge.close());
  const post = () =>
    fetch(`${bridge.url}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridge.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture",
        stream: true,
        input: "synthetic",
      }),
    });
  const first = post();
  await arrived;
  const rejected = await post();
  assert.equal(rejected.status, 429);
  assert.match(
    (await rejected.json()).error.message,
    /too many requests in progress/,
  );
  assert.equal(seen, 1);
  release();
  assert.equal((await first).status, 200);
  const after = await post();
  assert.equal(after.status, 200);
  assert.equal(seen, 2);
});
