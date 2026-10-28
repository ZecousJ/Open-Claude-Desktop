/**
 * R9-S2: the Codex engine on an SSH host. "The host" is this computer's
 * own sh with a temporary HOME, reached through the same command line ssh
 * sends (remote-scripts' remoteCommand), and the package is a small real
 * .tgz with the npm layout, served over loopback HTTP with range support.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { SshStatus } from "../../shared/ssh-api";
import { type SshConnection } from "../../electron/ssh/connection";
import { collectOutput } from "../../electron/ssh/connection-support";
import {
  PROBE_SCRIPT,
  parseProbe,
  remoteCommand,
  type HostProbe,
} from "../../electron/ssh/remote-scripts";
import {
  RemoteRuntime,
  RemoteRuntimeError,
  clientIdFor,
  clientRoot,
  defaultRemoteRoot,
  remoteTriple,
  type RemoteShell,
} from "../../electron/ssh/remote-runtime";
import { parseSha512 } from "../../electron/ssh/remote-runtime-support";
import {
  RuntimeCache,
  checkDownloadUrl,
  downloadUrls,
  fileSha512Hex,
  integrityHex,
  packageFileName,
  parseManifest,
  runtimeManifest,
  type FetchFn,
  type RuntimeManifest,
} from "../../electron/ssh/runtime-cache";

const posix = process.platform !== "win32";
const project = path.resolve(import.meta.dirname, "..", "..");
const temp = (prefix = "cxr-") =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const VERSION = "0.144.1";
const TRIPLE = "x86_64-unknown-linux-musl";
const LINUX = { os: "Linux", arch: "x86_64" };

// SshConnection is what production hands the runtime.
const _shellFromConnection = (c: SshConnection): RemoteShell => c;
void _shellFromConnection;

/** A package with the npm layout; its engine prints `versionLine`. */
function makePackage(versionLine = `codex-cli ${VERSION}`) {
  const dir = temp("cxr-pkg-");
  const vendor = path.join(dir, "package", "vendor", TRIPLE);
  fs.mkdirSync(path.join(vendor, "bin"), { recursive: true });
  fs.mkdirSync(path.join(vendor, "codex-path"), { recursive: true });
  fs.writeFileSync(
    path.join(vendor, "bin", "codex"),
    `#!/bin/sh\necho ${JSON.stringify(versionLine)}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(vendor, "codex-path", "rg"), "rg", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(dir, "package", "package.json"), "{}");
  // Padding so chunked uploads take several rounds.
  fs.writeFileSync(
    path.join(dir, "package", "README.md"),
    Buffer.from(
      Array.from({ length: 40_000 }, (_, i) => (i * 7919) % 251),
    ).toString("base64"),
  );
  const file = path.join(dir, "codex.tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "package"]);
  const bytes = fs.readFileSync(file);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { bytes, integrity };
}

/** Loopback server: /good serves the package (ranges too), /bad junk. */
let server: http.Server;
let base = "";
let good: ReturnType<typeof makePackage>;
const hits: string[] = [];
let dropNext = 0;

before(async () => {
  good = makePackage();
  server = http.createServer((req, res) => {
    hits.push(`${req.url} ${req.headers.range ?? ""}`.trim());
    if (req.url?.startsWith("/bad")) {
      res.writeHead(200, { "content-length": "5" });
      return res.end("junk!");
    }
    if (!req.url?.startsWith("/good")) {
      res.writeHead(404);
      return res.end();
    }
    const body = good.bytes;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    if (start >= body.length) {
      res.writeHead(416);
      return res.end();
    }
    res.writeHead(range ? 206 : 200, {
      "content-length": String(body.length - start),
      ...(range
        ? {
            "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
          }
        : {}),
    });
    if (dropNext > 0) {
      dropNext--;
      res.write(body.subarray(start, start + Math.floor(body.length / 3)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body.subarray(start));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

function manifestFor(url: string, integrity = good.integrity): RuntimeManifest {
  return parseManifest({
    version: VERSION,
    platforms: {
      [TRIPLE]: {
        os: "linux",
        arch: "x64",
        npmPackage: `@openai/codex@${VERSION}-linux-x64`,
        url,
        integrity,
      },
    },
  });
}

/** Runs scripts the way ssh does, with `home` as $HOME; counts calls. */
function fakeHost(home: string) {
  const calls: string[] = [];
  const shell: RemoteShell = {
    exec(script, options) {
      calls.push(script);
      const child = spawn("sh", ["-c", remoteCommand(script)], {
        env: { PATH: process.env.PATH ?? "", HOME: home, LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return collectOutput(child, options);
    },
  };
  return { shell, calls };
}

async function probeOf(shell: RemoteShell): Promise<HostProbe> {
  const result = await shell.exec(PROBE_SCRIPT);
  const probe = parseProbe(result.stdout);
  assert.ok(probe);
  return probe;
}

const noFetch: FetchFn = async () => {
  throw new Error("no local download expected");
};

test("the committed manifest matches package-lock.json and parses", () => {
  const check = spawnSync(
    process.execPath,
    ["scripts/codex-runtime-manifest.mjs", "--check"],
    { cwd: project, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr);
  const manifest = runtimeManifest();
  const lock = JSON.parse(
    fs.readFileSync(path.join(project, "package-lock.json"), "utf8"),
  );
  assert.equal(
    manifest.version,
    lock.packages["node_modules/@openai/codex"].version,
  );
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "aarch64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-musl",
  ]);
  const linux = manifest.platforms["x86_64-unknown-linux-musl"];
  assert.equal(
    linux.integrity,
    lock.packages["node_modules/@openai/codex-linux-x64"].integrity,
  );
  assert.equal(
    linux.url,
    `https://registry.npmjs.org/@openai/codex/-/codex-${manifest.version}-linux-x64.tgz`,
  );
  assert.equal(integrityHex(linux.integrity).length, 128);
});

test("the manifest script writes from a lock file and refuses a bad one", () => {
  const dir = temp();
  const lock = JSON.parse(
    fs.readFileSync(path.join(project, "package-lock.json"), "utf8"),
  );
  const packages: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(lock.packages))
    if (key.startsWith("node_modules/@openai/codex")) packages[key] = value;
  const lockFile = path.join(dir, "lock.json");
  const out = path.join(dir, "manifest.json");
  fs.writeFileSync(lockFile, JSON.stringify({ packages }));
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "scripts/codex-runtime-manifest.mjs",
        "--lock",
        lockFile,
        "--out",
        out,
        ...args,
      ],
      { cwd: project, encoding: "utf8" },
    );
  assert.equal(run("--check").status, 1);
  assert.equal(run().status, 0);
  assert.equal(run("--check").status, 0);
  assert.equal(
    fs.readFileSync(out, "utf8"),
    fs.readFileSync(
      path.join(project, "shared", "codex-runtime-manifest.json"),
      "utf8",
    ),
  );
  const broken = structuredClone(packages) as Record<
    string,
    { integrity?: string; resolved?: string }
  >;
  delete broken["node_modules/@openai/codex-linux-arm64"].integrity;
  fs.writeFileSync(lockFile, JSON.stringify({ packages: broken }));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /codex-linux-arm64 has no sha512/);
  broken["node_modules/@openai/codex-linux-arm64"].integrity = (
    packages["node_modules/@openai/codex-linux-arm64"] as { integrity: string }
  ).integrity;
  broken["node_modules/@openai/codex-linux-x64"].resolved =
    "https://evil.example/codex.tgz";
  fs.writeFileSync(lockFile, JSON.stringify({ packages: broken }));
  assert.match(run().stderr, /does not come from registry\.npmjs\.org/);
});

test("platforms, client folders, addresses and checksums", () => {
  assert.equal(remoteTriple({ os: "Linux", arch: "x86_64" }), TRIPLE);
  assert.equal(remoteTriple({ os: "Linux", arch: "amd64" }), TRIPLE);
  assert.equal(
    remoteTriple({ os: "Linux", arch: "aarch64" }),
    "aarch64-unknown-linux-musl",
  );
  assert.equal(
    remoteTriple({ os: "Darwin", arch: "arm64" }),
    "aarch64-apple-darwin",
  );
  assert.equal(
    remoteTriple({ os: "Darwin", arch: "x86_64" }),
    "x86_64-apple-darwin",
  );
  assert.equal(remoteTriple({ os: "FreeBSD", arch: "amd64" }), undefined);
  assert.equal(remoteTriple({ os: "Linux", arch: "riscv64" }), undefined);

  const id = clientIdFor("7a1c6c0e-1111-4222-8333-944445555666");
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, clientIdFor("7a1c6c0e-1111-4222-8333-944445555666"));
  assert.notEqual(id, clientIdFor("another-device"));
  assert.equal(defaultRemoteRoot(id), `~/.claudex-remote/${id}`);
  assert.equal(clientRoot(id), `~/.claudex-remote/${id}`);
  assert.equal(clientRoot(id, "~"), `~/${id}`);
  assert.equal(clientRoot(id, "/srv/cx/"), `/srv/cx/${id}`);
  assert.equal(clientRoot(id, "/"), `/${id}`);
  assert.throws(() => clientRoot(id, "relative"), /absolute path/);

  const pkg = runtimeManifest().platforms[TRIPLE];
  assert.deepEqual(downloadUrls(pkg), [pkg.url]);
  assert.deepEqual(downloadUrls(pkg, "https://registry.npmmirror.com"), [
    pkg.url.replace(
      "https://registry.npmjs.org/",
      "https://registry.npmmirror.com/",
    ),
    pkg.url,
  ]);
  // A mirror that isn't https is ignored rather than trusted.
  assert.deepEqual(downloadUrls(pkg, "http://mirror.example/"), [pkg.url]);
  assert.deepEqual(downloadUrls(pkg, "not a url"), [pkg.url]);
  assert.equal(packageFileName(pkg), `codex-${pkg.version}-${TRIPLE}.tgz`);

  assert.equal(checkDownloadUrl(`${base}/good.tgz`), `${base}/good.tgz`);
  for (const bad of [
    "ftp://example.com/x.tgz",
    "http://example.com/x.tgz",
    "https://user:pw@example.com/x.tgz",
    "https://example.com/a'b.tgz",
    "https://example.com/a b.tgz",
    "file:///etc/passwd",
  ])
    assert.throws(() => checkDownloadUrl(bad), bad);
  assert.throws(() =>
    parseManifest({
      version: "1.0.0; rm -rf ~",
      platforms: {},
    }),
  );
  assert.throws(() =>
    parseManifest({
      version: "1.0.0",
      platforms: { "x86_64-$(id)": {} },
    }),
  );

  const hex = "ab".repeat(64);
  assert.equal(parseSha512(`${hex}  -`), hex);
  assert.equal(parseSha512(`SHA2-512(stdin)= ${hex.toUpperCase()}`), hex);
  assert.equal(parseSha512("abc"), undefined);
  assert.equal(parseSha512(`${hex}ff`), undefined);
});

test("the local cache resumes a dropped download and checks the sum", async () => {
  const dir = temp();
  const manifest = manifestFor(`${base}/good-cache.tgz`);
  const pkg = manifest.platforms[TRIPLE];
  hits.length = 0;
  dropNext = 1;
  const progress: number[] = [];
  const cache = new RuntimeCache({ dir, backoff: () => 5 });
  const file = await cache.ensure(pkg, {
    onProgress: (received) => progress.push(received),
  });
  assert.equal(file, path.join(dir, `codex-${VERSION}-${TRIPLE}.tgz`));
  assert.equal(await fileSha512Hex(file), integrityHex(pkg.integrity));
  assert.equal(hits.length, 2);
  assert.match(hits[1], /bytes=\d+-$/);
  assert.ok(progress.at(-1) === good.bytes.length);
  assert.ok(!fs.existsSync(`${file}.partial`));
  if (posix) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  // Cached: no request. An older version's package is pruned.
  fs.writeFileSync(path.join(dir, `codex-0.1.0-${TRIPLE}.tgz`), "old");
  hits.length = 0;
  assert.equal(await new RuntimeCache({ dir }).ensure(pkg), file);
  assert.equal(hits.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, `codex-0.1.0-${TRIPLE}.tgz`)));

  // A damaged cached file is fetched again.
  fs.writeFileSync(file, "damaged");
  await new RuntimeCache({ dir }).ensure(pkg);
  assert.equal(await fileSha512Hex(file), integrityHex(pkg.integrity));
});

test("a mirror serving other bytes falls back to npm; nothing bad is cached", async () => {
  const dir = temp();
  const pkg = runtimeManifest().platforms[TRIPLE];
  // The real package's sum with our small package's bytes can't match, so
  // use a manifest whose npm URL is the real one and whose sum is ours.
  const ours = { ...pkg, integrity: good.integrity };
  const asked: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    asked.push(url);
    if (url.startsWith("https://mirror.example/"))
      return new Response("tampered", { status: 200 });
    return new Response(new Uint8Array(good.bytes), {
      status: 200,
      headers: { "content-length": String(good.bytes.length) },
    });
  };
  const cache = new RuntimeCache({ dir, fetch: fetchFn, backoff: () => 1 });
  const file = await cache.ensure(ours, { mirror: "https://mirror.example" });
  assert.deepEqual(asked, [
    pkg.url.replace("https://registry.npmjs.org/", "https://mirror.example/"),
    pkg.url,
  ]);
  assert.equal(await fileSha512Hex(file), integrityHex(good.integrity));

  // Only wrong bytes anywhere: an error, and no file in the cache.
  const empty = temp();
  const bad = new RuntimeCache({
    dir: empty,
    fetch: async () => new Response("nope", { status: 200 }),
    backoff: () => 1,
  });
  await assert.rejects(bad.ensure(ours), /didn't match its checksum/);
  assert.deepEqual(fs.readdirSync(empty), []);

  // 404 is not retried five times.
  let calls = 0;
  const missing = new RuntimeCache({
    dir: temp(),
    fetch: async () => {
      calls++;
      return new Response("", { status: 404 });
    },
    backoff: () => 1,
  });
  await assert.rejects(missing.ensure(ours), /answered 404/);
  assert.equal(calls, 1);
});

test(
  "the package is sent from this computer, checked on the host, and installed once",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    const { shell, calls } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX };
    // Even with curl on the host, nothing is downloaded there: this computer's
    // checked copy is uploaded.
    probe.tools = [...new Set([...probe.tools, "curl"])];
    const statuses: SshStatus[] = [];
    const clientId = clientIdFor("device-1");
    const runtime = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId,
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(good.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/good-remote.tgz`),
      onStatus: (s) => statuses.push(s),
    });
    calls.length = 0; // The probe above lists tools by name.
    const layout = await runtime.ensure();
    assert.ok(!calls.some((c) => /\bcurl\b|\bwget\b/.test(c)));
    const root = fs.realpathSync(path.join(home, ".claudex-remote", clientId));
    assert.equal(layout.root, root);
    assert.equal(layout.dir, `${root}/bin/codex-${VERSION}-${TRIPLE}`);
    assert.equal(layout.codex, `${layout.dir}/bin/codex`);
    assert.equal(layout.home, `${root}/codex-home`);
    assert.equal(layout.run, `${root}/run`);
    assert.equal(
      execFileSync(layout.codex, ["--version"], { encoding: "utf8" }).trim(),
      `codex-cli ${VERSION}`,
    );
    assert.ok(fs.existsSync(`${layout.dir}/codex-path/rg`));
    assert.equal(fs.statSync(layout.codex).mode & 0o777, 0o700);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(layout.home).mode & 0o777, 0o700);
    assert.equal(
      fs.readFileSync(`${layout.dir}/.claudex-installed`, "utf8"),
      integrityHex(good.integrity),
    );
    // No leftovers: the package, the extract folder and the lock are gone.
    assert.deepEqual(fs.readdirSync(`${root}/tmp`), []);
    assert.ok(!fs.existsSync(`${root}/run/install.lock`));
    const phases = statuses.map((s) =>
      s.state === "installing" ? s.phase : s.state,
    );
    assert.equal(phases[0], "verify");
    assert.ok(phases.includes("upload"));
    assert.equal(phases.at(-1), "verify");

    // Installed: one check, nothing else.
    calls.length = 0;
    const again = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId,
      cache: new RuntimeCache({ dir: temp(), fetch: noFetch }),
      manifest: manifestFor(`${base}/good-remote.tgz`),
    });
    assert.deepEqual(await again.ensure(), layout);
    assert.equal(calls.length, 1);
  },
);

test(
  "without a downloader on the host the package is uploaded in chunks, resuming",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    const { shell, calls } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX };
    probe.tools = probe.tools.filter((t) => t !== "curl" && t !== "wget");
    const clientId = clientIdFor("device-2");
    // An earlier upload got a third of the way.
    const tmp = path.join(home, ".claudex-remote", clientId, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const third = Math.floor(good.bytes.length / 3);
    fs.writeFileSync(
      path.join(tmp, `codex-${VERSION}-${TRIPLE}.tgz.part`),
      good.bytes.subarray(0, third),
    );
    const statuses: SshStatus[] = [];
    const cacheDir = temp();
    hits.length = 0;
    const runtime = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId,
      cache: new RuntimeCache({ dir: cacheDir }),
      manifest: manifestFor(`${base}/good-upload.tgz`),
      chunkBytes: 4096,
      onStatus: (s) => statuses.push(s),
    });
    const layout = await runtime.ensure();
    assert.equal(
      execFileSync(layout.codex, ["--version"], { encoding: "utf8" }).trim(),
      `codex-cli ${VERSION}`,
    );
    // Downloaded here once; uploaded only what was missing.
    assert.equal(hits.length, 1);
    const chunks = calls.filter((c) => c.includes('cat >> "$F.part"'));
    assert.equal(chunks.length, Math.ceil((good.bytes.length - third) / 4096));
    const uploads = statuses.flatMap((s) =>
      s.state === "installing" && s.phase === "upload"
        ? [s.progress ?? -1]
        : [],
    );
    assert.ok(uploads.length === chunks.length);
    assert.ok(uploads[0] >= third / good.bytes.length - 0.001);
    for (let i = 1; i < uploads.length; i++)
      assert.ok(uploads[i] > uploads[i - 1]);
    assert.ok(
      statuses.some((s) => s.state === "installing" && s.phase === "download"),
    );
    assert.deepEqual(fs.readdirSync(`${layout.root}/tmp`), []);
  },
);

test(
  "an engine that doesn't run is not installed",
  { skip: !posix },
  async () => {
    const broken = makePackage("something else");
    const home = temp("cxr-home-");
    const { shell } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX, tools: [] };
    const runtime = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId: clientIdFor("device-4"),
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(broken.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/unused.tgz`, broken.integrity),
    });
    await assert.rejects(runtime.ensure(), (error: RemoteRuntimeError) => {
      assert.equal(error.code, "install-failed");
      assert.match(error.message, /doesn't start on build/);
      return true;
    });
    const bin = path.join(
      home,
      ".claudex-remote",
      clientIdFor("device-4"),
      "bin",
    );
    assert.deepEqual(fs.readdirSync(bin), []);
    assert.ok(!fs.existsSync(path.join(bin, "..", "run", "install.lock")));
  },
);

test("an unsupported host is refused before anything runs", async () => {
  const calls: string[] = [];
  const runtime = new RemoteRuntime({
    shell: {
      exec: async (script) => {
        calls.push(script);
        return { code: 0, stdout: "", stderr: "" };
      },
    },
    probe: { os: "FreeBSD", arch: "amd64", home: "/home/x", tools: [] },
    label: "bsd",
    clientId: clientIdFor("device-5"),
    cache: new RuntimeCache({ dir: temp(), fetch: noFetch }),
  });
  await assert.rejects(runtime.ensure(), (error: RemoteRuntimeError) => {
    assert.equal(error.code, "unsupported-platform");
    assert.equal(error.message, "Claudex can't run on FreeBSD amd64 yet.");
    return true;
  });
  assert.equal(calls.length, 0);
  assert.throws(
    () =>
      new RemoteRuntime({
        shell: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
        probe: { ...LINUX, home: "/", tools: [] },
        label: "x",
        clientId: "../../etc",
        cache: new RuntimeCache({ dir: temp() }),
      }),
  );
});

test(
  "a fresh lock waits for the other install; a stale one is taken over",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    const { shell } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX, tools: [] };
    const clientId = clientIdFor("device-6");
    const lock = path.join(
      home,
      ".claudex-remote",
      clientId,
      "run",
      "install.lock",
    );
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner"), "someone-else");
    const options = {
      shell,
      probe,
      label: "build",
      clientId,
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(good.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/unused.tgz`),
      lockWaitMs: 150,
      lockPollMs: 50,
    };
    await assert.rejects(
      new RemoteRuntime(options).ensure(),
      /Another copy of Claudex is setting up build/,
    );
    // The other install's lock is left alone.
    assert.equal(
      fs.readFileSync(path.join(lock, "owner"), "utf8"),
      "someone-else",
    );

    const old = new Date(Date.now() - 11 * 60_000);
    fs.utimesSync(lock, old, old);
    const layout = await new RemoteRuntime(options).ensure();
    assert.ok(fs.existsSync(layout.codex));
    assert.ok(!fs.existsSync(lock));
  },
);

test(
  "cleanup ends only this client's stale engines and removes other versions",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    const { shell } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX, tools: [] };
    const runtime = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId: clientIdFor("device-7"),
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(good.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/unused.tgz`),
    });
    await assert.rejects(runtime.cleanup(), /Set up the runtime first/);
    const layout = await runtime.ensure();
    const sleeper = path.join(layout.dir, "bin", "sleeper");
    // Not exec: the process keeps the engine folder in its command line.
    fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
    const oldDir = path.join(layout.root, "bin", `codex-0.1.0-${TRIPLE}`);
    fs.mkdirSync(path.join(oldDir, "bin"), { recursive: true });
    // An older version something still runs from stays.
    const busyDir = path.join(layout.root, "bin", `codex-0.2.0-${TRIPLE}`);
    fs.mkdirSync(path.join(busyDir, "bin"), { recursive: true });
    const busySleeper = path.join(busyDir, "bin", "sleeper");
    fs.writeFileSync(busySleeper, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
    // A sleeper script whose command line names the engine folder.
    const start = (file: string) => {
      const child = spawn("sh", [file], { stdio: "ignore", detached: true });
      child.unref();
      return child.pid!;
    };
    const stale = start(sleeper);
    const active = start(sleeper);
    const busy = start(busySleeper);
    const unrelated = spawn("sleep", ["30"], {
      stdio: "ignore",
      detached: true,
    });
    unrelated.unref();
    fs.writeFileSync(path.join(layout.run, "stale.pid"), String(stale));
    fs.writeFileSync(path.join(layout.run, "engine-1.pid"), String(active));
    fs.writeFileSync(
      path.join(layout.run, "reused.pid"),
      String(unrelated.pid),
    );
    fs.writeFileSync(path.join(layout.run, "junk.pid"), "1; rm -rf /");
    fs.writeFileSync(path.join(layout.root, "tmp", "leftover.part"), "x");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.cleanup(["engine-1"]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(alive(stale), false, "stale engine ended");
      assert.equal(alive(active), true, "active engine kept");
      assert.equal(alive(unrelated.pid!), true, "a reused pid is left alone");
      assert.deepEqual(fs.readdirSync(layout.run).sort(), ["engine-1.pid"]);
      assert.ok(!fs.existsSync(oldDir));
      assert.ok(fs.existsSync(busyDir));
      assert.ok(fs.existsSync(layout.codex));
      assert.deepEqual(fs.readdirSync(path.join(layout.root, "tmp")), []);
      await assert.rejects(runtime.cleanup(["bad id!"]), /engine id/);
    } finally {
      for (const pid of [stale, active, busy, unrelated.pid!])
        try {
          process.kill(pid);
        } catch {
          // Already gone.
        }
    }
  },
);

test(
  "a remote folder with shell syntax in it stays a plain folder name",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    const { shell } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX, tools: [] };
    const remoteRoot = `~/we'ird $(touch pwned) \`touch pwned2\` "x"`;
    const clientId = clientIdFor("device-8");
    const layout = await new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId,
      remoteRoot,
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(good.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/unused.tgz`),
    }).ensure();
    assert.equal(
      layout.root,
      path.join(fs.realpathSync(home), remoteRoot.slice(2), clientId),
    );
    assert.ok(fs.existsSync(layout.codex));
    assert.ok(!fs.existsSync(path.join(home, "pwned")));
    assert.ok(!fs.existsSync(path.join(home, "pwned2")));
    assert.ok(!fs.existsSync("pwned"));
  },
);

test(
  "a remote folder of ~ keeps the home folder's own tmp, bin and mode",
  { skip: !posix },
  async () => {
    const home = temp("cxr-home-");
    fs.chmodSync(home, 0o755);
    fs.mkdirSync(path.join(home, "tmp"));
    fs.writeFileSync(path.join(home, "tmp", "keep.txt"), "mine");
    fs.mkdirSync(path.join(home, "bin", "codex-mine"), { recursive: true });
    const { shell } = fakeHost(home);
    const probe = { ...(await probeOf(shell)), ...LINUX, tools: [] };
    const clientId = clientIdFor("device-10");
    const runtime = new RemoteRuntime({
      shell,
      probe,
      label: "build",
      clientId,
      remoteRoot: "~",
      cache: new RuntimeCache({
        dir: temp(),
        fetch: async () =>
          new Response(new Uint8Array(good.bytes), { status: 200 }),
      }),
      manifest: manifestFor(`${base}/unused.tgz`),
    });
    const layout = await runtime.ensure();
    assert.equal(layout.root, path.join(fs.realpathSync(home), clientId));
    await runtime.cleanup();
    assert.equal(fs.statSync(home).mode & 0o777, 0o755);
    assert.equal(
      fs.readFileSync(path.join(home, "tmp", "keep.txt"), "utf8"),
      "mine",
    );
    assert.ok(fs.existsSync(path.join(home, "bin", "codex-mine")));
    assert.ok(fs.existsSync(layout.codex));
  },
);

test("a dropped connection during setup is an install error", async () => {
  const runtime = new RemoteRuntime({
    shell: {
      exec: async () => {
        throw new Error("Reconnecting to build…");
      },
    },
    probe: { ...LINUX, home: "/home/x", tools: [] },
    label: "build",
    clientId: clientIdFor("device-9"),
    cache: new RuntimeCache({ dir: temp(), fetch: noFetch }),
    manifest: manifestFor(`${base}/unused.tgz`),
  });
  await assert.rejects(runtime.ensure(), (error: RemoteRuntimeError) => {
    assert.equal(error.code, "install-failed");
    assert.equal(error.message, "Reconnecting to build…");
    return true;
  });
});
