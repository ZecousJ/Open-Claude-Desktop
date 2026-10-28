// W-BWRAP: sandbox driver interface + bubblewrap driver + sandbox-codex
// launcher.  Runs under `npm test` (tsx) on any platform; the tests that need a
// real bubblewrap run only on Linux hosts where `checkBwrap()` passes. Set
// CLAUDEX_TEST_CODEX to a Linux codex binary to also start the real `codex
// app-server` in the sandbox. Erasable TypeScript only, so plain Node can run
// this file too.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SandboxSpecError,
  clampNetworkLevel,
  isSecretEnvName,
  maxNetworkLevel,
  validateSpec,
} from "../../runner/src/sandbox/driver.ts";
import {
  BRIDGE_SOURCE,
  chatSandboxSpec,
  listenUnixToTcp,
  loopbackPorts,
  readSpec,
  sandboxEnv,
  sandboxFileName,
  toSandboxPath,
} from "../../runner/src/sandbox/sandbox-setup.ts";
import { runscSocketPathFits } from "../../runner/src/sandbox/runsc-oci.ts";
import { egressSocketPath } from "../../runner/src/egress-support.ts";
import type { SandboxSpec } from "../../runner/src/sandbox/driver.ts";
import {
  BwrapDriver,
  SANDBOX_UID,
  buildBwrapArgs,
  checkBwrap,
  limitPrefix,
} from "../../runner/src/sandbox/bwrap.ts";
import type { HostProbe, PathKind } from "../../runner/src/sandbox/bwrap.ts";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const wrapper = path.join(repo, "runner/bin/sandbox-codex");
// Short base: Unix socket paths are limited to about 104 bytes on macOS.
const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sbx-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let counter = 0;
function dir(name: string) {
  const d = path.join(base, `${name}${++counter}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A user's store root with Engine's codex-home/workspace layout. */
function userLayout(extra: Partial<SandboxSpec> = {}) {
  const root = dir("u");
  const codexDir = dir("cx");
  const codexBinary = path.join(codexDir, "codex");
  fs.writeFileSync(codexBinary, "#!/bin/sh\n", { mode: 0o755 });
  const spec = chatSandboxSpec({
    userId: 42,
    storeRoot: root,
    stateRoot: dir("st"),
    codexBinary,
  });
  return { root, spec: { ...spec, ...extra } as SandboxSpec };
}

const GATEWAY_ARG = (port: number) =>
  `model_providers.claudex={ name = "Claudex gateway", base_url = "http://127.0.0.1:${port}/v1", env_key = "CLAUDEX_GATEWAY_TOKEN", wire_api = "responses" }`;

const ENGINE_ARGS = (port: number) => [
  "app-server",
  "--listen",
  "stdio://",
  "-c",
  'model_provider="claudex"',
  "-c",
  GATEWAY_ARG(port),
  "-c",
  'web_search="disabled"',
];

/** The runner's environment as Engine hands it over: full of things codex must not see. */
function engineEnv(codexHome: string): NodeJS.ProcessEnv {
  return {
    PATH: "/opt/runner/bin:/usr/bin",
    HOME: "/var/lib/claudex-runner",
    CODEX_HOME: codexHome,
    CLAUDEX_GATEWAY_TOKEN: "loopback-capability",
    OPENAI_API_KEY: "sk-should-not-leak",
    CLAUDEX_RUNNER_TOKEN: "runner-link-secret",
    DATABASE_URL: "postgres://u:p@db/claudex",
    AWS_SECRET_ACCESS_KEY: "aws",
    NODE_OPTIONS: "--require /evil.js",
    LD_PRELOAD: "/evil.so",
    LANG: "en_US.UTF-8",
  };
}

async function freePort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

describe("spec validation", () => {
  test("accepts the per-user Chat layout", () => {
    const { root, spec } = userLayout();
    assert.equal(spec.id, "chat-42");
    assert.deepEqual(
      spec.mounts.map((m) => [m.host, m.writable]),
      [
        [path.join(root, "workspace"), true],
        [path.join(root, "codex-home"), true],
      ],
    );
    assert.equal(validateSpec(spec), spec);
  });

  test("rejects unsafe specs", () => {
    const { root, spec } = userLayout();
    const bad = (patch: Partial<SandboxSpec>, match: RegExp) =>
      assert.throws(
        () => validateSpec({ ...spec, ...patch }),
        (e: unknown) =>
          e instanceof SandboxSpecError && match.test((e as Error).message),
      );
    bad({ id: "../x" }, /id/);
    bad({ stateDir: "relative/dir" }, /stateDir/);
    bad({ codexBinary: "/a/../b" }, /codexBinary/);
    bad({ mounts: [] }, /at least one mount/);
    bad({ mounts: [{ host: root, writable: false }] }, /writable/);
    bad({ mounts: [{ host: "/", writable: true }] }, /host root/);
    for (const target of [
      "/",
      "/etc",
      "/usr/local",
      "/proc/1",
      "/tmp",
      "/run",
      "/run/claudex/x",
    ])
      bad(
        { mounts: [{ host: root, sandbox: target, writable: true }] },
        /reserved/,
      );
    // The sandbox may never write its own launcher or spec.
    bad(
      { mounts: [{ host: path.dirname(spec.stateDir), writable: true }] },
      /stateDir/,
    );
    // Nor see other sandboxes' state (specs, bridge sockets), not even
    // read-only through a mount or a directory bound for codex or node.
    const stateRoot = path.dirname(spec.stateDir);
    bad(
      {
        mounts: [
          ...spec.mounts,
          { host: path.dirname(stateRoot), sandbox: "/srv/x", writable: false },
        ],
      },
      /stateDir/,
    );
    bad({ codexRoot: stateRoot }, /runner-private state/);
    bad({ node: path.join(stateRoot, "node") }, /runner-private state/);
    bad({ pathDirs: [path.join(spec.stateDir, "run")] }, /runner-private/);
    bad({ pathDirs: ["/"] }, /runner-private state/);
    bad({ stateDir: "/usr/lib/claudex/chat-42" }, /system directory/);
    bad(
      {
        mounts: [
          ...spec.mounts,
          { host: path.join(root, "nope"), writable: false },
        ],
      },
      /does not exist/,
    );
    bad({ cwd: "/elsewhere" }, /cwd/);
    bad({ env: { OPENAI_API_KEY: "x" } }, /cannot be set/);
    bad({ env: { NODE_OPTIONS: "--require x" } }, /cannot be set/);
    bad({ env: { "BAD-NAME": "x" } }, /Bad environment name/);
    bad({ limits: { memoryMb: -1 } }, /limits.memoryMb/);
    bad({ egress: { socket: "/run/egress.sock", port: 70000 } }, /egress.port/);
    bad({ codexRoot: path.join(root, "workspace") }, /codexRoot/);
    bad({ stateDir: "/" + "x".repeat(120) }, /too long/);
  });

  test("mounts below /tmp are allowed (the driver mounts a fresh tmpfs first)", () => {
    const { root, spec } = userLayout();
    validateSpec({
      ...spec,
      mounts: [
        ...spec.mounts,
        { host: root + "/workspace", sandbox: "/tmp/in", writable: false },
      ],
    });
  });

  test("readSpec refuses specs others can write", () => {
    const { spec } = userLayout();
    const prepared = new BwrapDriver({
      wrapper,
      node: process.execPath,
    }).prepare(spec);
    assert.equal(readSpec(prepared.specPath).id, "chat-42");
    fs.chmodSync(prepared.specPath, 0o666);
    assert.throws(() => readSpec(prepared.specPath), /writable by others/);
    prepared.dispose();
  });
});

describe("environment", () => {
  test("only the allowlist crosses into the sandbox", () => {
    const { root, spec } = userLayout();
    const env = sandboxEnv(spec, engineEnv(path.join(root, "codex-home")));
    assert.equal(env.CLAUDEX_GATEWAY_TOKEN, "loopback-capability");
    assert.equal(env.CODEX_HOME, path.join(root, "codex-home"));
    assert.equal(env.HOME, path.join(root, "codex-home", "home"));
    assert.equal(env.LANG, "en_US.UTF-8");
    for (const leaked of [
      "OPENAI_API_KEY",
      "CLAUDEX_RUNNER_TOKEN",
      "DATABASE_URL",
      "AWS_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "HTTPS_PROXY",
    ])
      assert.equal(env[leaked], undefined, leaked);
    assert.ok(!env.PATH.includes("/opt/runner/bin"));
    assert.ok(!JSON.stringify(env).includes("sk-should-not-leak"));
  });

  test("CODEX_HOME is translated through mapped mounts and must be writable", () => {
    const { root, spec } = userLayout();
    const mapped: SandboxSpec = {
      ...spec,
      cwd: "/workspace",
      mounts: [
        {
          host: path.join(root, "workspace"),
          sandbox: "/workspace",
          writable: true,
        },
        {
          host: path.join(root, "codex-home"),
          sandbox: "/codex-home",
          writable: true,
        },
      ],
    };
    const env = sandboxEnv(mapped, engineEnv(path.join(root, "codex-home")));
    assert.equal(env.CODEX_HOME, "/codex-home");
    assert.equal(
      toSandboxPath(mapped.mounts, path.join(root, "workspace", "a.txt")),
      "/workspace/a.txt",
    );
    assert.equal(toSandboxPath(mapped.mounts, "/etc/passwd"), undefined);
    assert.throws(
      () => sandboxEnv(mapped, engineEnv("/somewhere/else")),
      /CODEX_HOME/,
    );
    assert.throws(() => sandboxEnv(mapped, { PATH: "/usr/bin" }), /CODEX_HOME/);
  });

  test("proxy variables appear only with an egress socket", () => {
    const { root, spec } = userLayout();
    const env = sandboxEnv(spec, engineEnv(path.join(root, "codex-home")), {
      proxyPort: 3128,
    });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
    assert.equal(env.NO_PROXY, "127.0.0.1,localhost");
  });

  test("credential-looking names", () => {
    for (const n of [
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "DB_PASSWORD",
      "AWS_SECRET",
      "X_AUTH",
    ])
      assert.ok(isSecretEnvName(n), n);
    for (const n of ["LANG", "RUST_LOG", "PIP_INDEX_URL"])
      assert.ok(!isSecretEnvName(n), n);
  });
});

describe("loopback ports and network levels", () => {
  test("finds the provider service port in Engine's arguments", () => {
    assert.deepEqual(loopbackPorts(ENGINE_ARGS(53211)), [53211]);
    assert.deepEqual(
      loopbackPorts([
        "-c",
        'x="http://localhost:8080"',
        "-c",
        "y=http://[::1]:9",
      ]),
      [9, 8080],
    );
    assert.deepEqual(
      loopbackPorts([
        "-c",
        'x="http://127.0.0.1.evil.com:80/"',
        "https://example.com:443",
      ]),
      [],
    );
  });

  test("namespace isolation is capped at trusted", () => {
    assert.equal(maxNetworkLevel("namespaces"), "trusted");
    assert.equal(maxNetworkLevel("gvisor"), "full");
    assert.equal(clampNetworkLevel("full", "namespaces"), "trusted");
    assert.equal(clampNetworkLevel("custom", "namespaces"), "trusted");
    assert.equal(clampNetworkLevel("none", "namespaces"), "none");
    assert.equal(clampNetworkLevel("full", "gvisor"), "full");
    assert.equal(new BwrapDriver().isolation, "namespaces");
  });
});

describe("bubblewrap arguments", () => {
  // A merged-/usr host like Ubuntu 24.04.
  const probe: HostProbe = {
    kind(p: string): PathKind {
      if (["/bin", "/sbin", "/lib", "/lib64"].includes(p)) return "symlink";
      if (p === "/usr" || p === "/etc/ssl" || p === "/etc/alternatives")
        return "dir";
      if (p === "/etc/ld.so.cache" || p === "/etc/hosts") return "file";
      return "missing";
    },
    readlink: (p: string) => "usr" + p,
  };
  const pairs = (args: string[], flag: string) =>
    args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));

  test("hardened namespaces, minimal host view, clean environment", () => {
    const { root, spec } = userLayout({ node: "/usr/bin/node" });
    const launchDir = path.join(spec.stateDir, "run", "1");
    const { args, forwards } = buildBwrapArgs({
      spec,
      args: ENGINE_ARGS(53211),
      engineEnv: engineEnv(path.join(root, "codex-home")),
      launchDir,
      ports: [53211],
      probe,
    });
    for (const flag of [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--unshare-user",
      "--clearenv",
    ])
      assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
    assert.equal(args[args.indexOf("--uid") + 1], String(SANDBOX_UID));
    assert.ok(!args.includes("--share-net"));
    assert.deepEqual(pairs(args, "--symlink"), [
      ["usr/bin", "/bin"],
      ["usr/sbin", "/sbin"],
      ["usr/lib", "/lib"],
      ["usr/lib64", "/lib64"],
    ]);
    const ro = pairs(args, "--ro-bind");
    const rw = pairs(args, "--bind");
    // Never the host root or the host's /etc as a whole.
    for (const [src] of [...ro, ...rw]) {
      assert.notEqual(src, "/");
      assert.notEqual(src, "/etc");
    }
    assert.deepEqual(
      ro.filter(([, dst]) => dst.startsWith("/etc")).map(([, dst]) => dst),
      [
        "/etc/alternatives",
        "/etc/ssl",
        "/etc/ld.so.cache",
        "/etc/hosts",
        "/etc/passwd",
        "/etc/group",
      ],
    );
    // Runner-private files: only the synthesized identity files and the socket dir.
    const fromState = [...ro, ...rw].filter(([src]) =>
      src.startsWith(spec.stateDir),
    );
    assert.deepEqual(fromState, [
      [path.join(spec.stateDir, "etc/passwd"), "/etc/passwd"],
      [path.join(spec.stateDir, "etc/group"), "/etc/group"],
      [launchDir, "/run/claudex/fwd"],
    ]);
    assert.deepEqual(rw, [
      [path.join(root, "workspace"), path.join(root, "workspace")],
      [path.join(root, "codex-home"), path.join(root, "codex-home")],
    ]);
    assert.ok(ro.some(([src]) => src === path.dirname(spec.codexBinary)));
    assert.ok(
      !ro.some(([src]) => src === "/usr/bin"),
      "node under /usr needs no extra bind",
    );
    assert.equal(
      args[args.indexOf("--chdir") + 1],
      path.join(root, "workspace"),
    );
    // Environment: cleared first, then only the allowlist.
    const setenv = Object.fromEntries(pairs(args, "--setenv"));
    assert.ok(args.indexOf("--clearenv") < args.indexOf("--setenv"));
    assert.ok(!JSON.stringify(setenv).includes("sk-should-not-leak"));
    assert.ok(!JSON.stringify(setenv).includes("runner-link-secret"));
    assert.equal(setenv.OPENAI_API_KEY, undefined);
    // The bridge runs codex with Engine's arguments unchanged.
    const bridge = JSON.parse(setenv.CLAUDEX_SANDBOX_BRIDGE);
    assert.deepEqual(bridge.argv, [spec.codexBinary, ...ENGINE_ARGS(53211)]);
    assert.deepEqual(forwards, [
      { port: 53211, socket: "/run/claudex/fwd/p53211.sock" },
    ]);
    const tail = args.slice(args.indexOf("--") + 1);
    assert.deepEqual(tail, ["/usr/bin/node", "-e", BRIDGE_SOURCE]);
  });

  test("without ports or egress codex runs directly", () => {
    const { root, spec } = userLayout();
    const { args } = buildBwrapArgs({
      spec,
      args: ["app-server"],
      engineEnv: engineEnv(path.join(root, "codex-home")),
      launchDir: path.join(spec.stateDir, "run", "1"),
      ports: [],
      probe,
    });
    assert.deepEqual(args.slice(args.indexOf("--") + 1), [
      spec.codexBinary,
      "app-server",
    ]);
    assert.ok(!args.includes("/run/claudex/fwd"));
  });

  test("egress socket is bridged to the proxy port", () => {
    const { root, spec } = userLayout({
      egress: { socket: "/var/run/claudex-egress/u42.sock" },
    });
    const { args, env, forwards } = buildBwrapArgs({
      spec,
      args: ["app-server"],
      engineEnv: engineEnv(path.join(root, "codex-home")),
      launchDir: path.join(spec.stateDir, "run", "1"),
      ports: [],
      probe,
    });
    assert.ok(
      pairs(args, "--ro-bind").some(
        ([s, d]) =>
          s === "/var/run/claudex-egress/u42.sock" &&
          d === "/run/claudex/egress.sock",
      ),
    );
    assert.deepEqual(forwards, [
      { port: 3128, socket: "/run/claudex/egress.sock" },
    ]);
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
  });

  test("resource limits through a transient systemd scope", () => {
    assert.deepEqual(
      limitPrefix({ memoryMb: 768, pids: 256, cpus: 0.5 }, "systemd-run"),
      [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "-p",
        "MemoryMax=768M",
        "-p",
        "MemorySwapMax=0",
        "-p",
        "TasksMax=256",
        "-p",
        "CPUQuota=50%",
        "--",
      ],
    );
    assert.deepEqual(limitPrefix({ memoryMb: 768 }, "none"), []);
    assert.deepEqual(limitPrefix(undefined, "systemd-run"), []);
  });
});

describe("launcher", () => {
  test("prepare writes a private spec and an executable launcher", () => {
    const { spec } = userLayout();
    const prepared = new BwrapDriver({
      wrapper,
      node: process.execPath,
      bwrap: "/usr/bin/bwrap",
    }).prepare(spec);
    assert.equal(prepared.binary, path.join(spec.stateDir, "codex"));
    assert.equal(fs.statSync(spec.stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(prepared.specPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(prepared.binary).mode & 0o777, 0o700);
    const script = fs.readFileSync(prepared.binary, "utf8");
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.ok(
      script.includes(`'${wrapper}' --spec '${prepared.specPath}' -- "$@"`),
    );
    assert.equal(readSpec(prepared.specPath).options?.bwrap, "/usr/bin/bwrap");
    prepared.dispose();
    assert.ok(!fs.existsSync(prepared.binary));
    assert.ok(!fs.existsSync(prepared.specPath));
  });

  test("launcher quoting survives awkward paths", () => {
    const { spec } = userLayout();
    const odd = dir("it's $(x)");
    const prepared = new BwrapDriver({
      wrapper: path.join(odd, "w"),
      node: process.execPath,
    }).prepare(spec);
    assert.ok(
      fs
        .readFileSync(prepared.binary, "utf8")
        .includes(`'${odd.replace(/'/g, `'\\''`)}/w'`),
    );
    prepared.dispose();
  });

  test("a bad spec path fails before anything runs", async () => {
    const r = await run(process.execPath, [
      wrapper,
      "--spec",
      path.join(base, "missing.json"),
      "--",
      "app-server",
    ]);
    assert.equal(r.code, 126);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /sandbox-codex:/);
  });
});

describe("bridges", () => {
  test("host side pipes a Unix socket to a loopback TCP port", async () => {
    const tcp = net.createServer((c) => c.on("data", (d) => c.end(`tcp:${d}`)));
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
    const port = (tcp.address() as net.AddressInfo).port;
    const sock = path.join(dir("s"), "p.sock");
    const server = await listenUnixToTcp(sock, port);
    const reply = await new Promise<string>((resolve, reject) => {
      const c = net.connect(sock, () => c.write("hello"));
      let data = "";
      c.on("data", (d) => (data += d));
      c.on("end", () => resolve(data));
      c.on("error", reject);
    });
    assert.equal(reply, "tcp:hello");
    server.close();
    tcp.close();
  });

  test("in-sandbox bridge listens, runs codex, and passes its exit status", async () => {
    const sock = path.join(dir("s"), "m.sock");
    const unix = net.createServer((c) =>
      c.on("data", (d) => c.end(`unix:${d}`)),
    );
    await new Promise<void>((r) => unix.listen(sock, () => r()));
    const port = await freePort();
    const client = `
      const c = require("net").connect(${port}, "127.0.0.1", () => c.write("ping"));
      let d = ""; c.on("data", (x) => (d += x));
      c.on("end", () => { process.stdout.write(d + "|" + (process.env.CLAUDEX_SANDBOX_BRIDGE === undefined)); process.exit(7); });`;
    const r = await run(process.execPath, ["-e", BRIDGE_SOURCE], {
      env: {
        PATH: process.env.PATH,
        CLAUDEX_SANDBOX_BRIDGE: JSON.stringify({
          forwards: [{ port, socket: sock }],
          argv: [process.execPath, "-e", client],
        }),
      },
    });
    unix.close();
    assert.equal(r.stdout, "unix:ping|true");
    assert.equal(r.code, 7);
  });
});

describe("sandbox-codex end to end with a stand-in bwrap", () => {
  // Parses the bwrap options this driver uses and runs the command with the
  // --setenv environment, without namespaces. Checks the whole launcher path
  // (launcher → sandbox-codex → Node type stripping → bwrap.ts → bwrap) on
  // any platform.
  test("stdio passes through, env is filtered, exit status is kept", async () => {
    const { root, spec } = userLayout();
    const tools = dir("tools");
    const record = path.join(tools, "argv.json");
    const fakeBwrap = path.join(tools, "bwrap");
    const victim = path.join(tools, "victim.txt");
    fs.writeFileSync(victim, "runner file");
    fs.writeFileSync(
      fakeBwrap,
      `#!${process.execPath}
const raw = process.argv.slice(2);
// --args FD: NUL-separated arguments from a file descriptor, as bwrap reads them.
// bwrap reads options only from there; the command stays on the command line.
const argv = raw[0] === "--args"
  ? require("fs").readFileSync(Number(raw[1])).toString().split("\\0").slice(0, -1).concat(raw.slice(2))
  : raw;
require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ raw, argv }));
const one = ["--cap-drop","--uid","--gid","--hostname","--proc","--dev","--tmpfs","--chdir"];
const two = ["--ro-bind","--bind","--symlink","--setenv"];
const env = {}; let cwd; let i = 0;
for (; i < argv.length && argv[i] !== "--"; i++) {
  const a = argv[i];
  if (a === "--setenv") { env[argv[i+1]] = argv[i+2]; i += 2; }
  else if (a === "--chdir") { cwd = argv[++i]; }
  else if (two.includes(a)) i += 2; else if (one.includes(a)) i += 1;
}
const rest = argv.slice(i + 1);
const c = require("child_process").spawn(rest[0], rest.slice(1), { env, cwd, stdio: "inherit" });
c.on("exit", (code) => process.exit(code));
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      spec.codexBinary,
      `#!${process.execPath}
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  // A hostile sandbox turns the file Engine rewrites on its next start into a symlink.
  require("fs").symlinkSync(${JSON.stringify(victim)}, require("path").join(process.env.CODEX_HOME, "config.toml"));
  process.stdout.write(JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
  process.exit(3);
});
`,
      { mode: 0o755 },
    );
    const prepared = new BwrapDriver({
      wrapper,
      node: process.execPath,
      bwrap: fakeBwrap,
    }).prepare(spec);
    const r = await run(
      prepared.binary,
      ["app-server", "--listen", "stdio://"],
      {
        env: engineEnv(path.join(root, "codex-home")),
        input: '{"id":1,"method":"initialize"}\n',
      },
    );
    assert.equal(r.code, 3, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.input, '{"id":1,"method":"initialize"}\n');
    assert.deepEqual(out.args, ["app-server", "--listen", "stdio://"]);
    assert.equal(
      fs.realpathSync(out.cwd),
      fs.realpathSync(path.join(root, "workspace")),
    );
    assert.equal(out.env.CLAUDEX_GATEWAY_TOKEN, "loopback-capability");
    assert.equal(out.env.OPENAI_API_KEY, undefined);
    assert.equal(out.env.CLAUDEX_RUNNER_TOKEN, undefined);
    assert.equal(out.env.DATABASE_URL, undefined);
    assert.ok(fs.statSync(path.join(root, "codex-home", "home")).isDirectory());
    const { raw, argv } = JSON.parse(fs.readFileSync(record, "utf8")) as {
      raw: string[];
      argv: string[];
    };
    assert.ok(argv.includes("--die-with-parent"));
    // The token travels through the --args pipe, never on bwrap's command line.
    assert.deepEqual(raw.slice(0, 3), ["--args", "3", "--"]);
    assert.ok(!raw.join(" ").includes("loopback-capability"));
    assert.ok(argv.includes("CLAUDEX_GATEWAY_TOKEN"));
    // The symlink the sandbox left behind is gone; its target is untouched.
    assert.throws(() =>
      fs.lstatSync(path.join(root, "codex-home", "config.toml")),
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "runner file");
    assert.match(r.stderr, /removed a symlink/);
    // Launch directory is removed after codex exits.
    assert.deepEqual(fs.readdirSync(path.join(spec.stateDir, "run")), []);
    prepared.dispose();
  });
});

// ---------------------------------------------------------------------------
// Real bubblewrap (Linux only)

const real = process.platform === "linux" ? checkBwrap() : undefined;
const skipReal =
  !real?.ok &&
  `bubblewrap unavailable: ${real?.problems.join("; ") ?? process.platform}`;

describe("real bubblewrap", { skip: skipReal }, () => {
  test("isolation: filesystem, identity, network, bridges", async () => {
    const { root, spec } = userLayout();
    const hostSecret = path.join(dir("secret"), "runner.env");
    fs.writeFileSync(hostSecret, "RUNNER_TOKEN=x\n", { mode: 0o600 });
    // Model gateway stand-in on the host's loopback.
    const gateway = http.createServer((req, res) =>
      res.end(`gateway:${req.url}:${req.headers.authorization ?? ""}`),
    );
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gport = (gateway.address() as net.AddressInfo).port;
    // Egress proxy stand-in on a Unix socket.
    const egressSock = path.join(dir("eg"), "e.sock");
    const egress = net.createServer((c) =>
      c.on("data", () => c.end("HTTP/1.0 200 OK\r\n\r\negress")),
    );
    await new Promise<void>((r) => egress.listen(egressSock, () => r()));
    fs.writeFileSync(
      spec.codexBinary,
      `#!${process.execPath}
const fs = require("fs"), net = require("net"), http = require("http");
const port = Number(process.argv.find((a) => a.startsWith("--port=")).slice(7));
const res = {};
const tryDo = (k, f) => { try { res[k] = f(); } catch (e) { res[k] = "ERR:" + e.code; } };
tryDo("uid", () => process.getuid());
tryDo("hostname", () => require("os").hostname());
tryDo("secret", () => fs.readFileSync(${JSON.stringify(hostSecret)}, "utf8"));
tryDo("spec", () => fs.readFileSync(${JSON.stringify(path.join(spec.stateDir, "spec.json"))}, "utf8"));
tryDo("etcShadow", () => fs.readFileSync("/etc/shadow", "utf8"));
tryDo("passwd", () => fs.readFileSync("/etc/passwd", "utf8").split("\\n").filter(Boolean).map((l) => l.split(":")[0]));
tryDo("writeUsr", () => fs.writeFileSync("/usr/x", "x"));
tryDo("writeCodexBin", () => fs.writeFileSync(${JSON.stringify(spec.codexBinary)}, "x"));
tryDo("writeWorkspace", () => { fs.writeFileSync("out.txt", "made in sandbox"); return "ok"; });
tryDo("pid1", () => fs.readFileSync("/proc/1/cmdline", "utf8").split("\\0")[0]);
res.env = Object.keys(process.env).sort();
const get = (p) => new Promise((r) => http.get("http://127.0.0.1:" + p + "/v1/models", { headers: { authorization: "Bearer " + process.env.CLAUDEX_GATEWAY_TOKEN } }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => r(d)); }).on("error", (e) => r("ERR:" + e.code)));
const connect = (host, p) => new Promise((r) => { const c = net.connect(p, host, () => { c.destroy(); r("connected"); }); c.on("error", (e) => r("ERR:" + e.code)); setTimeout(() => { c.destroy(); r("timeout"); }, 3000); });
(async () => {
  res.gateway = await get(port);
  res.proxy = await new Promise((r) => { const c = net.connect(3128, "127.0.0.1", () => c.write("GET http://example.com/ HTTP/1.0\\r\\n\\r\\n")); let d = ""; c.on("data", (x) => (d += x)); c.on("end", () => r(d.split("\\r\\n\\r\\n")[1])); c.on("error", (e) => r("ERR:" + e.code)); });
  res.internet = await connect("1.1.1.1", 443);
  process.stdout.write(JSON.stringify(res));
})();
`,
      { mode: 0o755 },
    );
    const prepared = new BwrapDriver({
      wrapper,
      node: process.execPath,
    }).prepare({
      ...spec,
      egress: { socket: egressSock },
    });
    const r = await run(
      prepared.binary,
      ["app-server", "-c", GATEWAY_ARG(gport), `--port=${gport}`],
      { env: engineEnv(path.join(root, "codex-home")), input: "" },
    );
    gateway.close();
    egress.close();
    assert.equal(r.code, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.uid, SANDBOX_UID);
    assert.equal(res.hostname, "sandbox");
    assert.equal(res.secret, "ERR:ENOENT");
    assert.equal(res.spec, "ERR:ENOENT");
    assert.equal(res.etcShadow, "ERR:ENOENT");
    assert.deepEqual(res.passwd, ["root", "sandbox", "nobody"]);
    assert.equal(res.writeUsr, "ERR:EROFS");
    assert.equal(res.writeCodexBin, "ERR:EROFS");
    assert.equal(res.writeWorkspace, "ok");
    assert.equal(
      fs.readFileSync(path.join(root, "workspace", "out.txt"), "utf8"),
      "made in sandbox",
    );
    assert.notEqual(res.pid1, process.execPath, "own pid namespace");
    assert.equal(res.gateway, "gateway:/v1/models:Bearer loopback-capability");
    assert.equal(res.proxy, "egress");
    assert.match(res.internet, /^ERR:|timeout/);
    for (const k of [
      "OPENAI_API_KEY",
      "CLAUDEX_RUNNER_TOKEN",
      "DATABASE_URL",
      "AWS_SECRET_ACCESS_KEY",
      "CLAUDEX_SANDBOX_BRIDGE",
    ])
      assert.ok(!res.env.includes(k), k);
    prepared.dispose();
  });

  const codex = process.env.CLAUDEX_TEST_CODEX;
  test(
    "real codex app-server answers initialize inside the sandbox",
    { skip: !codex && "CLAUDEX_TEST_CODEX not set" },
    async () => {
      const { root, spec } = userLayout();
      const codexRoot = path.dirname(path.dirname(codex!));
      const pathDirs = fs.existsSync(path.join(codexRoot, "codex-path"))
        ? [path.join(codexRoot, "codex-path")]
        : [];
      const prepared = new BwrapDriver({
        wrapper,
        node: process.execPath,
      }).prepare({
        ...spec,
        codexBinary: codex!,
        codexRoot,
        pathDirs,
      });
      const gateway = http.createServer((_q, s) => s.end("{}"));
      await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
      const gport = (gateway.address() as net.AddressInfo).port;
      const child = spawn(prepared.binary, [...ENGINE_ARGS(gport)], {
        env: engineEnv(path.join(root, "codex-home")),
        stdio: "pipe",
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const reply = await new Promise<any>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => {
          // Do not leave the sandbox running and the test process hanging.
          child.kill("SIGKILL");
          gateway.close();
          reject(new Error(`no reply; stderr: ${stderr.slice(-500)}`));
        }, 60000);
        child.stdout.on("data", (d) => {
          buf += d;
          for (const line of buf.split("\n")) {
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1) {
                clearTimeout(timer);
                resolve(msg);
              }
            } catch {}
          }
        });
        child.stdin.write(
          JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "claudex_test", title: "t", version: "0" },
              capabilities: { experimentalApi: true },
            },
          }) + "\n",
        );
      });
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
      gateway.close();
      assert.ok(reply.result, JSON.stringify(reply));
      assert.match(String(reply.result.userAgent ?? ""), /codex|claudex/i);
      // codex wrote its state into the mounted codex-home on the host.
      assert.ok(fs.readdirSync(path.join(root, "codex-home")).length > 0);
      prepared.dispose();
    },
  );
});

test("a space's sandbox keeps its socket paths within Linux's limit", () => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-space-"));
  const id = "space-138-c-2f0c5d7e-8f1a-4b8e-9c3d-0a1b2c3d4e5f";
  const spec = chatSandboxSpec({
    userId: 138,
    id,
    storeRoot,
    stateRoot: "/var/lib/claudex-runner/sandboxes",
    codexBinary: "/usr/bin/codex",
  });
  assert.equal(spec.id, id, "the sandbox keeps its id");
  assert.ok(runscSocketPathFits(spec.stateDir), spec.stateDir);
  assert.ok(egressSocketPath("/var/lib/claudex-runner", id).length <= 107);
  assert.equal(sandboxFileName("chat-138"), "chat-138");
  assert.notEqual(sandboxFileName(id), sandboxFileName(`${id}x`));
});
