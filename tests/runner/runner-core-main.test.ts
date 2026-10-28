/**
 * The runner program: configuration, page addresses, previews and uploads,
 * and the built bundle (scripts/build-runner.mjs) linking to a service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { parseRunnerFrame } from "../../shared/web-runner-frames";
import { webRemoteRunnerMethods as remoteMethods } from "../../shared/web-bridge-methods";
import { useElectronShim, wsServer } from "./runner-core-support.test.ts";

// Built before useElectronShim makes the platform read "linux" (esbuild
// picks its native binary by platform).
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-dist-"));
execFileSync(
  process.execPath,
  ["scripts/build-runner.mjs", "--outdir", outdir],
  {
    stdio: "ignore",
  },
);

useElectronShim();
const { pageForBrowser } = await import("../../runner/src/main");
const { parseConfig } = await import("../../runner/src/runner-config");
const { WebPreviews, previewOwner, previewIdOf } =
  await import("../../runner/src/previews");
const { resolveUploads, uploadRef, pruneAttachments } =
  await import("../../runner/src/attachments");

const env = (extra: Record<string, string> = {}) => ({
  CLAUDEX_RUNNER_SERVICE_URL: "http://127.0.0.1:8080/",
  CLAUDEX_RUNNER_TOKEN: "runner-token-0123456789",
  CLAUDEX_RUNNER_CODEX: "/opt/codex/vendor/x/codex/codex",
  ...extra,
});

test("configuration: gVisor and each user's limits", () => {
  const bwrap = parseConfig(env(), "/opt/claudex-runner");
  assert.equal(bwrap.runsc, undefined);
  assert.deepEqual(
    [bwrap.cpus, bwrap.pids, bwrap.diskMb, bwrap.diskQuota],
    [1, 512, 5120, "none"],
  );
  const gvisor = parseConfig(
    env({
      CLAUDEX_RUNNER_DRIVER: "runsc",
      CLAUDEX_RUNNER_SUDO: "1",
      CLAUDEX_RUNNER_STATE_DIR: "/srv/runner",
      CLAUDEX_RUNNER_CPUS: "1.5",
      CLAUDEX_RUNNER_PIDS: "300",
      CLAUDEX_RUNNER_DISK_MB: "4096",
      CLAUDEX_RUNNER_DISK_QUOTA: "loop",
      CLAUDEX_RUNNER_NETWORK: "full",
    }),
    "/opt/claudex-runner",
  );
  assert.deepEqual(gvisor.runsc, {
    rootfs: "/srv/runner/images/current/rootfs",
    runsc: "runsc",
    platform: "systrap",
    sudo: true,
  });
  assert.deepEqual(
    [gvisor.cpus, gvisor.pids, gvisor.diskMb, gvisor.diskQuota],
    [1.5, 300, 4096, "loop"],
  );
  // gVisor allows the levels bubblewrap caps at trusted.
  assert.equal(gvisor.network.level, "full");
  assert.throws(
    () => parseConfig(env({ CLAUDEX_RUNNER_DISK_QUOTA: "zfs" })),
    /DISK_QUOTA/,
  );
  assert.throws(() => parseConfig(env({ CLAUDEX_RUNNER_CPUS: "0" })), /CPUS/);
});

test("configuration: defaults, and the mistakes it refuses", () => {
  const config = parseConfig(env(), "/opt/claudex-runner");
  assert.equal(config.serviceUrl, "http://127.0.0.1:8080");
  assert.equal(config.driver, "bwrap");
  assert.equal(config.maxEngines, 1);
  assert.deepEqual(config.modes, ["chat"]);
  assert.equal(config.stateDir, "/var/lib/claudex-runner");
  // The codex package's vendor/<target> folder (codex/codex and path/rg).
  assert.equal(config.codexRoot, "/opt/codex/vendor/x");
  assert.equal(
    config.providerServiceScript,
    "/opt/claudex-runner/provider-service.cjs",
  );
  // Plain http only to this machine.
  assert.throws(() =>
    parseConfig(
      env({ CLAUDEX_RUNNER_SERVICE_URL: "http://claudex.example.com" }),
    ),
  );
  assert.doesNotThrow(() =>
    parseConfig(
      env({ CLAUDEX_RUNNER_SERVICE_URL: "https://claudex.example.com" }),
    ),
  );
  assert.throws(() => parseConfig(env({ CLAUDEX_RUNNER_TOKEN: "short" })));
  assert.throws(() => parseConfig(env({ CLAUDEX_RUNNER_DRIVER: "docker" })));
  assert.throws(() => parseConfig(env({ CLAUDEX_RUNNER_MODES: "chat,shell" })));
  assert.throws(() => parseConfig(env({ CLAUDEX_RUNNER_MAX_ENGINES: "0" })));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tok-")), "t");
  fs.writeFileSync(file, "token-from-a-file-0123456789\n");
  const fromFile = parseConfig({
    ...env({ CLAUDEX_RUNNER_TOKEN_FILE: file }),
    CLAUDEX_RUNNER_TOKEN: "",
  });
  assert.equal(fromFile.token, "token-from-a-file-0123456789");
  assert.deepEqual(
    parseConfig(env({ CLAUDEX_RUNNER_LABELS: "host=dc6, zone=hk" })).labels,
    { host: "dc6", zone: "hk" },
  );
});

test("pages of the service open as same-origin paths", () => {
  const config = {
    serviceUrl: "http://127.0.0.1:8080",
    publicUrl: "https://claudex.example.com",
  };
  assert.equal(
    pageForBrowser("http://127.0.0.1:8080/desktop-pay?order=5#x", config),
    "/desktop-pay?order=5#x",
  );
  assert.equal(
    pageForBrowser("https://claudex.example.com/payment/result?o=1", config),
    "/payment/result?o=1",
  );
  assert.equal(
    pageForBrowser("https://pay.example.net/c", config),
    "https://pay.example.net/c",
  );
});

test("preview ids name their user and a random capability", () => {
  const previews = new WebPreviews(31);
  const url = previews.create("<b>x</b>");
  const id = previewIdOf(url)!;
  assert.equal(previewOwner(id), 31);
  assert.equal(previews.has(url), true);
  assert.equal(previews.has(`${url}?k=sig`), true);
  assert.equal(previews.document(id)!.content, "<b>x</b>");
  assert.equal(new WebPreviews(32).document(id), undefined);
  assert.equal(previewOwner("31.not-a-uuid"), undefined);
  for (let i = 0; i < 15; i++) previews.create("x");
  assert.throws(() => previews.create("x"), {
    message: "Too many open previews.",
  });
  previews.clear();
  assert.equal(previews.size, 0);
});

test("upload references are resolved at any depth, within the limits", async () => {
  assert.equal(uploadRef({ $upload: "abc" }), "abc");
  assert.equal(uploadRef({ $upload: "abc", x: 1 }), undefined);
  assert.throws(() => uploadRef({ $upload: "../etc" }));
  const reads: string[] = [];
  const args = await resolveUploads(
    ["a.txt", { $upload: "u1" }, { nested: [{ $upload: "u2" }] }],
    async (id) => {
      reads.push(id);
      return new Uint8Array([1, 2, 3]);
    },
  );
  assert.deepEqual(reads, ["u1", "u2"]);
  assert.ok(args[1] instanceof Uint8Array);
  assert.ok((args[2] as any).nested[0] instanceof Uint8Array);
  await assert.rejects(
    resolveUploads(
      Array.from({ length: 13 }, (_, i) => ({ $upload: `u${i}` })),
      async () => new Uint8Array(1),
    ),
    { message: "Too many files in one request." },
  );
});

test("attachments no conversation uses are removed after 30 days", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "att-"));
  const folder = path.join(root, "attachments");
  for (const id of ["old", "kept", "new"]) {
    fs.mkdirSync(path.join(folder, id), { recursive: true });
    fs.writeFileSync(path.join(folder, id, "f.txt"), "x");
  }
  const old = Date.now() / 1000 - 40 * 86400;
  fs.utimesSync(path.join(folder, "old"), old, old);
  fs.utimesSync(path.join(folder, "kept"), old, old);
  const removed = pruneAttachments(
    root,
    [
      {
        turns: [{ attachments: [{ id: "kept" }] }],
      } as any,
    ],
    [],
  );
  assert.deepEqual(removed, ["old"]);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["kept", "new"]);
});

test("the built runner links to the service and says which methods it serves", async () => {
  for (const file of [
    "runner.mjs",
    "provider-service.cjs",
    "sandbox-codex.mjs",
  ])
    assert.ok(fs.existsSync(path.join(outdir, file)), file);
  const bundle = fs.readFileSync(path.join(outdir, "runner.mjs"), "utf8");
  assert.equal(
    /require\(["']electron["']\)|from ["']electron["']/.test(bundle),
    false,
  );

  let hello: any;
  let authorization = "";
  const server = await wsServer((socket) => {
    authorization = String(socket.headers.authorization);
    socket.onText = (text) => {
      const frame = parseRunnerFrame(text);
      if (frame.t === "hello") {
        hello = frame;
        socket.send(
          JSON.stringify({
            t: "welcome",
            v: 1,
            runnerId: "r",
            heartbeatMs: 25000,
          }),
        );
      }
    };
  });
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "runner-state-"));
  const child = spawn(process.execPath, [path.join(outdir, "runner.mjs")], {
    env: {
      PATH: process.env.PATH,
      CLAUDEX_RUNNER_SERVICE_URL: server.url,
      CLAUDEX_RUNNER_TOKEN: "runner-token-0123456789",
      CLAUDEX_RUNNER_DRIVER: "none",
      CLAUDEX_RUNNER_CODEX: "/bin/false",
      CLAUDEX_RUNNER_STATE_DIR: state,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  try {
    const start = Date.now();
    while (!hello && Date.now() - start < 15_000)
      await new Promise((r) => setTimeout(r, 50));
    assert.ok(hello, `no hello; runner said: ${stderr}`);
    assert.equal(authorization, "Bearer runner-token-0123456789");
    assert.deepEqual(hello.methods, [...remoteMethods]);
    assert.deepEqual(hello.capacity, { engines: 1, users: 20 });
    assert.match(stderr, /without a sandbox/);
  } finally {
    const exited =
      child.exitCode !== null
        ? Promise.resolve(child.exitCode)
        : new Promise<number | null>((resolve) =>
            child.on("exit", (code) => resolve(code)),
          );
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    await server.close();
    fs.rmSync(outdir, { recursive: true, force: true });
  }
});
