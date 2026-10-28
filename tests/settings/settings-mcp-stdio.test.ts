import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import { build } from "esbuild";
import { McpStdioCapture } from "../../electron/connectors/mcp-stdio-capture";
import { McpPrivateLogStore } from "../../server/mcp-private-log-store";
import {
  mcpStdioCaptureEnvironment,
  type McpStdioDescriptor,
} from "../../shared/mcp-stdio-logs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b34-stdio-"));
const helperPath = path.join(root, "mcp-stdio-wrapper.cjs");
before(async () => {
  await build({
    entryPoints: [path.resolve("server/mcp-stdio-wrapper.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: helperPath,
  });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
async function fixture() {
  const directory = fs.mkdtempSync(path.join(root, "account-"));
  let owner: { root: string; accountScope: string; scope: object } | undefined =
    { root: directory, accountScope: "account-a", scope: {} };
  const configurations: Record<string, unknown> = {};
  const capture = new McpStdioCapture({
    currentConfiguration: (name) => configurations[name],
    owner: () => owner,
    helperPath,
    node: { executable: process.execPath, electron: false },
    secrets: () => ["synthetic-secret", "multi\nline-secret"],
  });
  assert.equal(await capture.start(), true);
  return {
    capture,
    launch(name: string, entry: Record<string, unknown>) {
      configurations[name] = entry;
      return capture.launchWrapper(name, entry);
    },
    configurations,
    directory,
    set owner(
      value: { root: string; accountScope: string; scope: object } | undefined,
    ) {
      owner = value;
    },
    clean() {
      capture.retire();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
function start(
  entry: Record<string, any>,
  inherited: Record<string, string> = {},
) {
  const child = spawn(entry.command, entry.args, {
    cwd: entry.cwd,
    env: { ...process.env, ...inherited, ...entry.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const ended = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    ended,
    stdout: () => Buffer.concat(stdout),
    stderr: () => Buffer.concat(stderr),
  };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), "child condition became ready");
}
function allFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? allFiles(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    );
}

test("bundled helper preserves binary stdio/backpressure, command args/cwd and actually received environment", async () => {
  const f = await fixture();
  try {
    const program = path.join(f.directory, "server.cjs");
    fs.writeFileSync(
      program,
      `const chunks=[]; process.stdin.on('data',b=>chunks.push(b)); process.stdin.on('end',()=>{ process.stdout.write(Buffer.concat(chunks)); require('fs').writeFileSync('environment-report.txt',JSON.stringify([process.argv[2],process.cwd(),process.env.KEPT,process.env.INHERITED,process.env.ELECTRON_RUN_AS_NODE,process.env.CLAUDEX_MCP_STDIO_CAPTURE]));process.stderr.write(JSON.stringify([process.argv[2],process.cwd(),process.env.KEPT,process.env.INHERITED,process.env.ELECTRON_RUN_AS_NODE,process.env.CLAUDEX_MCP_STDIO_CAPTURE])+'\\n'); });`,
    );
    const entry = {
      command: process.execPath,
      args: [program, "argument with spaces"],
      cwd: f.directory,
      env: {
        KEPT: "explicit",
        TOKEN: "synthetic-secret",
        ELECTRON_RUN_AS_NODE: "original",
      },
      env_vars: ["INHERITED"],
    };
    const launch = f.launch("server", entry);
    assert.equal(launch.supported, true);
    assert.equal(
      JSON.stringify(launch.entry).includes("synthetic-secret"),
      false,
      "runtime config may be cached without credentials",
    );
    assert.equal(
      JSON.stringify(launch.entry).includes("argument with spaces"),
      false,
      "original argv is private memory only",
    );
    assert.equal(
      JSON.stringify(launch.entry.args).includes("synthetic-secret"),
      false,
    );
    const run = start(launch.entry, {
      INHERITED: "selected",
      SHOULD_NOT_BE_ADDED: "received baseline",
    });
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    run.child.stdin.end(bytes);
    assert.deepEqual(await run.ended, { code: 0, signal: null });
    assert.deepEqual(run.stdout(), bytes);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(f.directory, "environment-report.txt"),
          "utf8",
        ),
      ),
      [
        "argument with spaces",
        fs.realpathSync(f.directory),
        "explicit",
        "selected",
        "original",
        null,
      ],
    );
    assert.equal(run.stderr().length, 0);
    const logs = f.capture.read("server");
    assert.equal(logs.availability, "available");
    assert.match(logs.lines.join("\n"), /argument with spaces/);
    assert.equal(
      logs.lines.join("\n").includes("selected"),
      false,
      "selected inherited credentials are also scrubbed",
    );
    assert.match(logs.lines.join("\n"), /\[redacted\]/);
    assert.equal(
      logs.lines.join("\n").includes("CLAUDEX_MCP_STDIO_CAPTURE"),
      false,
    );
    for (const file of allFiles(path.join(f.directory, "mcp-stdio-logs"))) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(
        fs.readFileSync(file).includes(Buffer.from("synthetic-secret")),
        false,
      );
    }
  } finally {
    f.clean();
  }
});

test("redaction spans chunks and multiline secrets; oversized lines are suppressed before disk", async () => {
  const f = await fixture();
  try {
    const program = path.join(f.directory, "secret.cjs");
    fs.writeFileSync(
      program,
      `process.stderr.write('synthetic-'); setTimeout(()=>{process.stderr.write('secret\\nmulti\\nline-secret\\nAuthorization: Bearer unknown-credential\\n');process.stderr.write('x'.repeat(70000)+'synthetic-secret\\n');},20);`,
    );
    const run = start(
      f.launch("secret", {
        command: process.execPath,
        args: [program],
      }).entry,
    );
    run.child.stdin.end();
    await run.ended;
    const snapshot = f.capture.read("secret");
    assert.equal(snapshot.availability, "available");
    assert.equal(snapshot.truncated, true);
    const log = snapshot.lines.join("\n");
    for (const secret of [
      "synthetic-secret",
      "line-secret",
      "unknown-credential",
    ])
      assert.equal(log.includes(secret), false);
    assert.match(log, /oversized stderr line suppressed/);
    for (const file of allFiles(path.join(f.directory, "mcp-stdio-logs")))
      assert.equal(
        fs.readFileSync(file).includes(Buffer.from("line-secret")),
        false,
      );
  } finally {
    f.clean();
  }
});

test("real child signal handler and exit status are forwarded through the wrapper", async () => {
  const f = await fixture();
  try {
    const program = path.join(f.directory, "signal.cjs");
    fs.writeFileSync(
      program,
      `process.on('SIGTERM',()=>{process.stderr.write('term received\\n');process.exit(42)});process.stdout.write('ready');setInterval(()=>{},1000);`,
    );
    const run = start(
      f.launch("signal", {
        command: process.execPath,
        args: [program],
      }).entry,
    );
    await waitFor(() => run.stdout().toString() === "ready");
    run.child.kill("SIGTERM");
    assert.deepEqual(await run.ended, { code: 42, signal: null });
    assert.match(f.capture.read("signal").lines.join("\n"), /term received/);
  } finally {
    f.clean();
  }
});

test("account and configuration retirement stop old helpers and never return their output", async () => {
  const f = await fixture();
  try {
    const program = path.join(f.directory, "retire.cjs");
    fs.writeFileSync(
      program,
      `process.stdout.write('ready');setInterval(()=>process.stderr.write('old output\\n'),10);`,
    );
    const first = f.launch("retire", {
      command: process.execPath,
      args: [program],
    });
    const run = start(first.entry);
    await waitFor(() => run.stdout().length > 0);
    const second = f.launch("retire", {
      command: process.execPath,
      args: [program, "new config"],
    });
    assert.notEqual(
      (first.entry.env as any)[mcpStdioCaptureEnvironment],
      (second.entry.env as any)[mcpStdioCaptureEnvironment],
    );
    await run.ended;
    assert.deepEqual(f.capture.read("retire").lines, []);
    const next = start(second.entry);
    await waitFor(() => next.stdout().length > 0);
    f.owner = { root: f.directory, accountScope: "account-b", scope: {} };
    assert.equal(f.capture.read("retire").availability, "unsupported");
    await next.ended;
    assert.ok(
      allFiles(path.join(f.directory, "mcp-stdio-logs")).filter((file) =>
        file.endsWith("stderr.log"),
      ).length <= 5,
    );
  } finally {
    f.clean();
  }
});

test("unknown helper/env restoration/transport and unavailable native secrets do not claim capture", async () => {
  const f = await fixture();
  try {
    const entry = { command: process.execPath, args: ["-e", ""] };
    const capture = new McpStdioCapture({
      currentConfiguration: () => entry,
      owner: () => ({ root: f.directory, accountScope: "a", scope: f }),
      helperPath,
      node: { executable: process.execPath, electron: true },
      secrets: () => [],
    });
    await capture.start();
    assert.equal(capture.launchWrapper("x", entry).supported, false);
    assert.equal(capture.launchWrapper("x", entry, {}).supported, true);
    capture.retire();
    assert.equal(
      f.launch("remote", { url: "https://example.com/mcp" }).supported,
      false,
    );
    assert.equal(
      f.launch("x", {
        ...entry,
        env: { [mcpStdioCaptureEnvironment]: "claimed" },
      }).supported,
      false,
    );
    const broken = new McpStdioCapture({
      currentConfiguration: () => entry,
      owner: () => ({ root: f.directory, accountScope: "a", scope: f }),
      helperPath: path.join(root, "missing"),
      node: { executable: process.execPath, electron: false },
      secrets: () => {
        throw Error("private failure");
      },
    });
    assert.equal(broken.launchWrapper("x", entry).supported, false);
    assert.equal(broken.read("x").availability, "unsupported");
  } finally {
    f.clean();
  }
});

test("private per-server store rotates at exact configured bounds and keeps tail bounded", () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(root, "rotation-")),
  );
  const spec = {
    directory,
    owner: "owner",
    version: "version",
    token: "token",
    command: "unused",
    args: [],
    environment: {},
    secrets: [],
  } as McpStdioDescriptor;
  fs.writeFileSync(
    path.join(directory, "lease.json"),
    JSON.stringify({
      owner: spec.owner,
      version: spec.version,
      token: spec.token,
      active: true,
    }),
    { mode: 0o600 },
  );
  const store = new McpPrivateLogStore(spec, { bytes: 200, files: 5 });
  for (let i = 0; i < 50; i++)
    assert.equal(store.appendRedacted(`record-${i}: ${"x".repeat(60)}`), true);
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.startsWith("stderr.log"));
  assert.equal(files.length, 5);
  for (const file of files)
    assert.ok(fs.statSync(path.join(directory, file)).size <= 200);
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(directory, "stderr.log.fake"),
  );
  fs.unlinkSync(path.join(directory, "stderr.log"));
  fs.symlinkSync(
    path.join(root, "outside"),
    path.join(directory, "stderr.log"),
  );
  assert.equal(store.appendRedacted("must not follow link"), false);
  assert.equal(fs.existsSync(path.join(root, "outside")), false);
});

test("Electron helper mode restores explicitly proved absence or explicit original flag without leaking its own flag", async () => {
  const f = await fixture();
  const scope = {};
  const entry = {
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE]))",
    ],
  };
  const capture = new McpStdioCapture({
    owner: () => ({ root: f.directory, accountScope: "flag", scope }),
    currentConfiguration: () => entry,
    helperPath,
    node: { executable: process.execPath, electron: true },
    secrets: () => [],
  });
  try {
    await capture.start();
    const absent = start(capture.launchWrapper("flag", entry, {}).entry);
    absent.child.stdin.end();
    await absent.ended;
    assert.equal(absent.stdout().toString(), "[null]");
    const explicit = start(
      capture.launchWrapper("flag", {
        ...entry,
        env: { ELECTRON_RUN_AS_NODE: "original-value" },
      }).entry,
    );
    explicit.child.stdin.end();
    await explicit.ended;
    assert.equal(explicit.stdout().toString(), '["original-value"]');
  } finally {
    capture.retire();
    f.clean();
  }
});

test("configuration edits retire before deferred relaunch, and failed spawn never fabricates server stderr", async () => {
  const f = await fixture();
  try {
    const launch = f.launch("edit", {
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    });
    const run = start(launch.entry);
    await waitFor(() => run.stdout().length > 0);
    f.configurations.edit = {
      command: process.execPath,
      args: ["new-settings"],
    };
    assert.equal(f.capture.read("edit").availability, "unsupported");
    assert.equal(
      run.child.exitCode,
      null,
      "diagnostic reads do not interrupt the active task",
    );
    f.capture.retireServer("edit");
    await run.ended;
    const failed = start(
      f.launch("missing", {
        command: path.join(f.directory, "not-installed"),
        args: [],
      }).entry,
    );
    failed.child.stdin.end();
    assert.equal((await failed.ended).code, 1);
    assert.equal(f.capture.read("missing").availability, "unavailable");
    assert.deepEqual(f.capture.read("missing").lines, []);
  } finally {
    f.clean();
  }
});

test(
  "unhandled POSIX signals preserve the real child's signal exit",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const run = start(
        f.launch("signal-exit", {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write('ready');setInterval(()=>{},1000)",
          ],
        }).entry,
      );
      await waitFor(() => run.stdout().length > 0);
      run.child.kill("SIGTERM");
      assert.deepEqual(await run.ended, { code: null, signal: "SIGTERM" });
    } finally {
      f.clean();
    }
  },
);

async function bootstrap(
  address: Record<string, unknown>,
): Promise<any | undefined> {
  return new Promise((resolve) => {
    const socket = net.createConnection(address.socketPath as string);
    let data = "";
    socket.on("connect", () => socket.end(`${JSON.stringify(address)}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("error", () => resolve(undefined));
    socket.on("close", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

test("private bootstrap rejects forged/retired account capabilities and never persists original launch credentials", async () => {
  const f = await fixture();
  try {
    const launch = f.launch("private", {
      command: process.execPath,
      args: ["secret-original-argv"],
      env: { TOKEN: "synthetic-secret" },
    });
    const address = JSON.parse(
      (launch.entry.env as any)[mcpStdioCaptureEnvironment],
    );
    assert.equal(fs.statSync(address.socketPath).mode & 0o777, 0o600);
    assert.equal(
      await bootstrap({ ...address, token: "self-asserted" }),
      undefined,
    );
    assert.equal(
      await bootstrap({ ...address, owner: "other-account" }),
      undefined,
    );
    assert.equal(
      await bootstrap({ ...address, version: "other-config" }),
      undefined,
    );
    const authorized = await bootstrap(address);
    assert.equal(authorized.environment.TOKEN, "synthetic-secret");
    assert.equal(authorized.args[0], "secret-original-argv");
    for (const file of allFiles(path.join(f.directory, "mcp-stdio-logs"))) {
      assert.equal(
        fs.readFileSync(file).includes(Buffer.from("secret-original-argv")),
        false,
      );
      assert.equal(
        fs.readFileSync(file).includes(Buffer.from("synthetic-secret")),
        false,
      );
    }
    f.capture.retireServer("private");
    assert.equal(await bootstrap(address), undefined);
  } finally {
    f.clean();
  }
});

test("relative configured cwd is applied once by the app-server, then inherited by the original child", async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.directory, "relative");
    fs.mkdirSync(cwd);
    const launch = f.launch("relative", {
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: "relative",
    });
    const run = start({ ...launch.entry, cwd });
    run.child.stdin.end();
    assert.equal((await run.ended).code, 0);
    assert.equal(run.stdout().toString(), fs.realpathSync(cwd));
  } finally {
    f.clean();
  }
});

test("same-config redacted history persists across native runtime owners while old capabilities retire", async () => {
  const f = await fixture();
  const entry = {
    command: process.execPath,
    args: ["-e", "process.stderr.write('persisted history\\n')"],
  };
  const scope = {};
  const later = new McpStdioCapture({
    owner: () => ({ root: f.directory, accountScope: "account-a", scope }),
    currentConfiguration: () => entry,
    helperPath,
    node: { executable: process.execPath, electron: false },
    secrets: () => ["synthetic-secret", "multi\nline-secret"],
  });
  try {
    const first = start(f.launch("persisted", entry).entry);
    first.child.stdin.end();
    await first.ended;
    assert.match(
      f.capture.read("persisted").lines.join("\n"),
      /persisted history/,
    );
    f.capture.retire();
    assert.equal(await later.start(), true);
    assert.equal(later.launchWrapper("persisted", entry).supported, true);
    assert.match(later.read("persisted").lines.join("\n"), /persisted history/);
  } finally {
    later.retire();
    f.clean();
  }
});

test("private IPC preserves UTF-8 command arguments and environment across socket chunk boundaries", async () => {
  const f = await fixture();
  try {
    const argument = "界".repeat(22000);
    const value = "密".repeat(12000);
    const run = start(
      f.launch("utf8", {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify([process.argv[1],process.env.VALUE.length,process.env.VALUE.slice(-1)]))",
          argument,
        ],
        env: { VALUE: value },
      }).entry,
    );
    run.child.stdin.end();
    assert.equal((await run.ended).code, 0);
    assert.deepEqual(JSON.parse(run.stdout().toString()), [
      argument,
      value.length,
      "密",
    ]);
  } finally {
    f.clean();
  }
});
