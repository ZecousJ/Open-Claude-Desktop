/**
 * R9-S1: an SSH host's connection, driven against a fake ssh program that
 * behaves like OpenSSH where it matters (a master with a control socket,
 * `-O check|exit`, askpass questions, error text, running the command with
 * `sh -c` on "the host", which is a temporary HOME here). The askpass
 * questions go through the real broker and the real bundled helper.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { SshEvent, SshHost, SshStatus } from "../../shared/ssh-api";
import { AskpassBroker } from "../../electron/ssh/askpass";
import {
  SshConnection,
  privateRuntimeDir,
  testSshHost,
} from "../../electron/ssh/connection";
import { classifySshError } from "../../electron/ssh/connection-support";
import { baseSshArgs } from "../../electron/ssh/connection-support";
import { controlPath } from "../../electron/ssh/connection-support";
import {
  checkRemotePath,
  folderCheckScript,
  listDirectoryScript,
  parseDirectoryListing,
  parseFolderCheck,
  parseProbe,
  remoteCommand,
  shQuote,
  supportedPlatform,
} from "../../electron/ssh/remote-scripts";

const posix = process.platform !== "win32";
const temp = (prefix = "cxc-") =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A stand-in for ssh. The destination's user part picks the behaviour. */
const FAKE_SSH = String.raw`
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG)
  fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\n");
const option = (name) => {
  for (let i = 0; i < args.length - 1; i++)
    if (args[i] === "-o" && args[i + 1].startsWith(name + "="))
      return args[i + 1].slice(name.length + 1);
};
const dash = args.indexOf("--");
const destination = args[dash + 1];
const command = args[dash + 2];
const user = destination.includes("@") ? destination.split("@")[0] : "ok";
const control = option("ControlPath");
const alive = () => {
  try {
    const pid = Number(fs.readFileSync(control, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
};
const o = args.indexOf("-O");
if (o >= 0) {
  const pid = alive();
  if (args[o + 1] === "check") process.exit(pid ? 0 : 255);
  if (pid) process.kill(pid);
  fs.rmSync(control, { force: true });
  process.exit(0);
}
const ask = (prompt) => {
  try {
    return execFileSync(process.env.SSH_ASKPASS, [prompt], { env: process.env }).toString();
  } catch {
    return null;
  }
};
const signIn = () => {
  if (user === "deny") {
    process.stderr.write(destination + ": Permission denied (publickey,password).\n");
    process.exit(255);
  }
  if (user === "changed") {
    process.stderr.write("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nsecret-host.internal\n");
    process.exit(255);
  }
  if (user === "down") {
    process.stderr.write("ssh: connect to host box port 22: Connection refused\n");
    process.exit(255);
  }
  if (user === "pw") {
    for (let i = 0; i < 3; i++)
      if (ask(user + "@box's password: ") === "secret\n") return;
    process.stderr.write("Permission denied (password).\n");
    process.exit(255);
  }
  if (user === "hk") {
    const answer = ask("The authenticity of host 'box' can't be established.\nED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
    if (answer !== "yes\n") {
      process.stderr.write("Host key verification failed.\n");
      process.exit(255);
    }
  }
};
if (args.includes("-M")) {
  if (user === "slow") setInterval(() => {}, 1000);
  else {
    signIn();
    fs.writeFileSync(control, String(process.pid));
    const done = () => {
      fs.rmSync(control, { force: true });
      process.exit(0);
    };
    process.stdin.on("end", done);
    process.stdin.resume();
    process.on("SIGTERM", done);
  }
} else {
  if (option("ControlPath") === "none" || !alive()) signIn();
  const env = { ...process.env, HOME: process.env.FAKE_HOME };
  if (user === "sunos") env.PATH = process.env.FAKE_UNAME_DIR + ":" + process.env.PATH;
  const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 1));
}
`;

let root = "";
let fakeSsh = "";
let fakeHome = "";
let log = "";
let broker: AskpassBroker;
const events: SshEvent[] = [];
/** What the "person" answers in the window, by prompt kind. */
let answers: Record<string, string | null> = {};

before(async () => {
  if (!posix) return;
  root = temp();
  fakeSsh = path.join(root, "ssh");
  fs.writeFileSync(fakeSsh, `#!${process.execPath}\n${FAKE_SSH}`, {
    mode: 0o755,
  });
  fakeHome = path.join(root, "home");
  fs.mkdirSync(path.join(fakeHome, "code", "app"), { recursive: true });
  const unameDir = path.join(root, "uname");
  fs.mkdirSync(unameDir);
  fs.writeFileSync(
    path.join(unameDir, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo SunOS ;; *) echo sparc ;; esac\n',
    { mode: 0o755 },
  );
  log = path.join(root, "ssh.log");
  process.env.FAKE_HOME = fakeHome;
  process.env.FAKE_UNAME_DIR = unameDir;
  process.env.FAKE_SSH_LOG = log;
  const helper = path.join(root, "ssh-askpass.cjs");
  await build({
    entryPoints: [
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../electron/ssh/askpass-helper.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: helper,
    logLevel: "silent",
  });
  broker = new AskpassBroker({
    dir: path.join(root, "rt", "askpass"),
    helperScript: helper,
    execPath: process.execPath,
    emit: (event) => {
      events.push(event);
      if (event.type === "ssh-prompt") {
        const answer = answers[event.prompt.kind];
        if (answer !== undefined)
          setTimeout(() => broker.answer(event.prompt.id, answer), 5);
      }
    },
  });
  await broker.start();
});

after(() => {
  broker?.close();
  delete process.env.FAKE_SSH_LOG;
});

function host(destination: string, extra: Partial<SshHost> = {}): SshHost {
  return {
    id: `id-${destination.replace(/[^a-z0-9]/gi, "")}-${Math.random().toString(16).slice(2, 8)}`,
    label: "Box",
    destination,
    createdAt: 0,
    ...extra,
  };
}

function connection(
  destination: string,
  options: Partial<ConstructorParameters<typeof SshConnection>[0]> = {},
) {
  const statuses: SshStatus[] = [];
  const conn = new SshConnection({
    host: host(destination),
    sshPath: fakeSsh,
    runtimeDir: path.join(root, "rt"),
    askpass: broker,
    onStatus: (status) => statuses.push(status),
    backoff: () => 20,
    ...options,
  });
  return { conn, statuses };
}

const states = (statuses: SshStatus[]) => statuses.map((s) => s.state);

const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("every ssh gets safe options, and the destination after --", () => {
  const args = baseSshArgs({ port: 2222, identityFile: "~/.ssh/k" });
  const options = args.filter((_, i) => args[i - 1] === "-o");
  assert.ok(options.includes("ForwardAgent=no"));
  assert.ok(options.includes("ForwardX11=no"));
  assert.ok(options.includes("StrictHostKeyChecking=ask"));
  assert.ok(options.includes("PermitLocalCommand=no"));
  assert.ok(!args.includes("-A") && !args.includes("-X"));
  assert.deepEqual(args.slice(-4), ["-p", "2222", "-i", "~/.ssh/k"]);
  assert.ok(baseSshArgs({ forwardAgent: true }).includes("ForwardAgent=yes"));

  const h = host("me@box");
  const mac = new SshConnection({
    host: h,
    sshPath: "/usr/bin/ssh",
    platform: "darwin",
    runtimeDir: "/rt",
    askpass: { session: () => ({ env: {}, close() {} }) },
    onStatus: () => {},
  });
  const macArgs = mac.commandArgs("cmd", ["-R", "x"]);
  assert.deepEqual(macArgs.slice(-5), ["-R", "x", "--", "me@box", "cmd"]);
  assert.ok(macArgs.includes(`ControlPath=${controlPath("/rt", h.id)}`));
  assert.ok(macArgs.includes("ControlMaster=no"));
  const win = new SshConnection({
    host: h,
    sshPath: "C:\\ssh.exe",
    platform: "win32",
    runtimeDir: "C:\\rt",
    askpass: { session: () => ({ env: {}, close() {} }) },
    onStatus: () => {},
  });
  assert.ok(win.commandArgs("cmd").includes("ControlPath=none"));
  assert.match(path.basename(controlPath("/rt", h.id)), /^[0-9a-f]{16}$/);
});

test("on Windows every command signs in again with the saved password", async () => {
  const sessions: { interactive: boolean; password?: string }[] = [];
  const win = new SshConnection({
    host: host("me@box"),
    sshPath: "C:\\ssh.exe",
    platform: "win32",
    runtimeDir: "C:\\rt",
    password: () => "saved",
    askpass: {
      session: (options: { interactive: boolean; password?: string }) => {
        sessions.push(options);
        return { env: {}, close() {} };
      },
    },
    onStatus: () => {},
  } as ConstructorParameters<typeof SshConnection>[0]);
  // Ready without a real sign-in: only the command's askpass matters here.
  (win as unknown as { current: { state: string } }).current = {
    state: "ready",
  };
  (win as unknown as { execWith: () => Promise<unknown> }).execWith =
    async () => ({ code: 0, stdout: "", stderr: "" });
  await win.exec("true");
  assert.deepEqual(
    sessions.map((s) => [s.interactive, s.password]),
    [[false, "saved"]],
  );
  assert.equal(win.savedPassword(), "saved");
});

test("ssh's error text maps to a code", () => {
  assert.equal(
    classifySshError("u@h: Permission denied (publickey)."),
    "auth-failed",
  );
  assert.equal(
    classifySshError("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!"),
    "host-key-changed",
  );
  assert.equal(
    classifySshError("Host key verification failed."),
    "auth-failed",
  );
  assert.equal(
    classifySshError("ssh: connect to host h port 22: Operation timed out"),
    "timeout",
  );
  assert.equal(
    classifySshError(
      "ssh: Could not resolve hostname h: nodename nor servname",
    ),
    "host-unreachable",
  );
});

test("the runtime folder is private and short enough for sockets", (t) => {
  if (!posix) return t.skip("POSIX modes");
  const dir = privateRuntimeDir(temp("cxr-"));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const long = privateRuntimeDir(path.join(temp("cxr-"), "x".repeat(80)));
  assert.equal(long, `/tmp/claudex-${process.getuid!()}`);
  assert.equal(fs.statSync(long).mode & 0o077, 0);
  // ssh cuts ControlPath at a space: a profile under "Application Support"
  // (every Mac) uses the /tmp folder too.
  const spaced = privateRuntimeDir(path.join(temp("cxr-"), "App Support"));
  assert.equal(spaced, `/tmp/claudex-${process.getuid!()}`);
});

test("a master connection works from a profile folder with a space", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const dataRoot = path.join(temp("cxs-"), "Application Support", "Claudex");
  fs.mkdirSync(dataRoot, { recursive: true });
  const { conn } = connection("ok@box", {
    runtimeDir: privateRuntimeDir(dataRoot),
  });
  assert.equal((await conn.connect()).state, "ready");
  conn.kill();
});

test("scripts survive any login shell and any folder name, and run nothing they're given", async (t) => {
  if (!posix) return t.skip("POSIX shells");
  const dir = temp();
  const names = [
    "plain",
    "with space",
    "it's",
    'dq"uote',
    "$(touch pwned)",
    "`touch pwned2`",
    "-dash",
    ".hidden",
    "line\nbreak",
    "ünï",
  ];
  for (const name of names) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "file.txt"), "x");
  const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((s) =>
    fs.existsSync(s),
  );
  for (const shell of shells) {
    const output = await new Promise<string>((resolve, reject) =>
      execFile(
        shell,
        ["-c", remoteCommand(listDirectoryScript(dir))],
        { env: { ...process.env, HOME: dir } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    const listing = parseDirectoryListing(output);
    assert.equal(listing?.path, fs.realpathSync(dir), shell);
    assert.deepEqual(
      listing?.entries,
      [
        ...[...names]
          .sort((a, b) => a.localeCompare(b))
          .map((name) => ({ name, kind: "folder" })),
        { name: "file.txt", kind: "file" },
      ],
      shell,
    );
  }
  assert.ok(!fs.existsSync(path.join(dir, "pwned")));
  assert.ok(!fs.existsSync(path.join(dir, "pwned2")));

  // A path with shell syntax is only ever a path.
  const tricky = path.join(dir, "it's");
  const check = await new Promise<string>((resolve) =>
    execFile(
      "/bin/sh",
      ["-c", remoteCommand(folderCheckScript(tricky))],
      (_e, stdout) => resolve(stdout),
    ),
  );
  assert.equal(parseFolderCheck(check), fs.realpathSync(tricky));
  const home = await new Promise<string>((resolve) =>
    execFile(
      "/bin/sh",
      ["-c", remoteCommand(folderCheckScript("~/with space"))],
      { env: { ...process.env, HOME: dir } },
      (_e, stdout) => resolve(stdout),
    ),
  );
  assert.equal(
    parseFolderCheck(home),
    fs.realpathSync(path.join(dir, "with space")),
  );
  const missing = await new Promise<number>((resolve) =>
    execFile(
      "/bin/sh",
      ["-c", remoteCommand(folderCheckScript(`${dir}/nope`))],
      (error) => resolve((error?.code as number) ?? 0),
    ),
  );
  assert.equal(missing, 3);

  assert.equal(shQuote("it's"), `'it'\\''s'`);
  for (const bad of ["relative", "/a\nb", "/a\u0000b", "", "~user/x"])
    assert.throws(() => checkRemotePath(bad));
  assert.throws(() => listDirectoryScript("/a\nb"));
});

test("probe output is read strictly, and only Linux and macOS on x64/arm64 are supported", () => {
  assert.deepEqual(
    parseProbe(
      "os=Linux\narch=x86_64\nhome=/home/me\nshell=/bin/bash\ntool=curl\ntool=tar\nend=1\n",
    ),
    {
      os: "Linux",
      arch: "x86_64",
      home: "/home/me",
      shell: "/bin/bash",
      tools: ["curl", "tar"],
    },
  );
  assert.equal(parseProbe("os=Linux\narch=x86_64\nhome=/h\n"), undefined);
  assert.equal(supportedPlatform({ os: "Darwin", arch: "arm64" }), true);
  assert.equal(supportedPlatform({ os: "Linux", arch: "aarch64" }), true);
  assert.equal(supportedPlatform({ os: "Linux", arch: "armv7l" }), false);
  assert.equal(supportedPlatform({ os: "FreeBSD", arch: "amd64" }), false);
});

test("connects through a master, runs commands on it, and disconnects cleanly", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const { conn, statuses } = connection("ok@box");
  const status = await conn.connect();
  assert.deepEqual(status, { state: "ready" });
  assert.deepEqual(states(statuses), ["connecting", "probing", "ready"]);
  assert.equal(conn.probe?.home, fakeHome);
  const socket = controlPath(path.join(root, "rt"), conn.host.id);
  assert.ok(fs.existsSync(socket));
  // Connecting again is a no-op while ready, and while R9-S2/S3 set the
  // host up on the connection (it must not restart the master).
  assert.equal(await conn.connect(), status);
  conn.setStatus({ state: "installing", phase: "upload" });
  assert.deepEqual(await conn.connect(), {
    state: "installing",
    phase: "upload",
  });
  assert.ok(fs.existsSync(socket));
  conn.setStatus({ state: "ready" });

  const listing = parseDirectoryListing(
    (await conn.exec(listDirectoryScript("~/code"))).stdout,
  );
  assert.deepEqual(listing?.entries, [{ name: "app", kind: "folder" }]);
  const lines = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const exec = lines.at(-1) as string[];
  assert.ok(exec.includes("ControlMaster=no"));
  assert.equal(exec[exec.indexOf("--") + 1], "ok@box");

  await conn.disconnect();
  assert.equal(conn.status.state, "idle");
  assert.ok(!fs.existsSync(socket));
  await assert.rejects(conn.exec("true"), /Connect to Box first/);
});

test("a refused sign-in, a changed host key and a refused connection are errors with fixed text", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const denied = await connection("deny@box").conn.connect();
  assert.equal(denied.state, "error");
  assert.equal((denied as { code: string }).code, "auth-failed");
  const changed = await connection("changed@box").conn.connect();
  assert.equal((changed as { code: string }).code, "host-key-changed");
  assert.doesNotMatch(
    (changed as { message: string }).message,
    /secret-host|WARNING/,
  );
  const down = await connection("down@box").conn.connect();
  assert.equal((down as { code: string }).code, "host-unreachable");
  assert.equal((down as { message: string }).message, "Can't reach Box.");
});

test("a password prompt asks the person once and connects", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  events.length = 0;
  answers = { password: "secret" };
  const { conn, statuses } = connection("pw@box");
  const status = await conn.connect();
  assert.equal(status.state, "ready");
  assert.deepEqual(states(statuses), [
    "connecting",
    "needs-auth",
    "connecting",
    "probing",
    "ready",
  ]);
  const prompts = events.filter((e) => e.type === "ssh-prompt");
  assert.equal(prompts.length, 1);
  assert.equal(
    (prompts[0] as { prompt: { hostId: string } }).prompt.hostId,
    conn.host.id,
  );
  // Commands ride on the master: no more questions.
  await conn.exec("true");
  assert.equal(events.filter((e) => e.type === "ssh-prompt").length, 1);
  await conn.disconnect();
});

test("a new host key is confirmed by the person; cancelling leaves the host idle", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  events.length = 0;
  answers = { hostkey: "yes" };
  const ok = connection("hk@box");
  assert.equal((await ok.conn.connect()).state, "ready");
  await ok.conn.disconnect();

  events.length = 0;
  answers = { password: null };
  const cancelled = connection("pw@box");
  const status = await cancelled.conn.connect();
  assert.equal(status.state, "idle");
  assert.equal(events.filter((e) => e.type === "ssh-prompt").length, 1);
});

test("an attempt the person didn't start never pops a question up", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  events.length = 0;
  answers = { password: "secret" };
  const { conn } = connection("pw@box");
  const status = await conn.connect({ interactive: false });
  assert.equal(status.state, "needs-auth");
  assert.deepEqual(events, []);
});

test("a master that never comes up times out", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const { conn } = connection("slow@box", { connectTimeoutMs: 300 });
  const status = await conn.connect();
  assert.equal((status as { code: string }).code, "timeout");
});

test("an unsupported host system is reported", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const status = await connection("sunos@box").conn.connect();
  assert.equal((status as { code: string }).code, "unsupported-platform");
  assert.match((status as { message: string }).message, /SunOS sparc/);
});

test("a dropped master reconnects in the background", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const { conn, statuses } = connection("ok@box");
  await conn.connect();
  const socket = controlPath(path.join(root, "rt"), conn.host.id);
  process.kill(Number(fs.readFileSync(socket, "utf8")));
  await waitFor(() => statuses.some((s) => s.state === "reconnecting"));
  await waitFor(() => conn.status.state === "ready");
  assert.deepEqual(
    statuses.find((s) => s.state === "reconnecting"),
    {
      state: "reconnecting",
      attempt: 1,
    },
  );
  // Quitting the app ends the master too (its session's pipe closes).
  conn.kill();
  await waitFor(() => !fs.existsSync(socket));
});

test("without connection sharing (Windows) every command signs in on its own", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  events.length = 0;
  answers = { password: "secret" };
  const { conn, statuses } = connection("pw@box", { platform: "win32" });
  assert.equal((await conn.connect()).state, "ready");
  assert.deepEqual(states(statuses).slice(0, 2), ["connecting", "probing"]);
  assert.equal(events.filter((e) => e.type === "ssh-prompt").length, 1);
  // A later command would have to ask again, which unasked commands may not.
  const result = await conn.exec("echo hi");
  assert.notEqual(result.code, 0);
  const ok = connection("ok@box", { platform: "win32" });
  await ok.conn.connect();
  assert.equal((await ok.conn.exec("echo hi")).stdout, "hi\n");
});

test("Test connection reports the host's system or a plain error", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  const ok = await testSshHost({
    host: { destination: "ok@box", label: "ok@box" },
    sshPath: fakeSsh,
    askpass: broker,
  });
  assert.equal(ok.ok, true);
  assert.match(ok.platform ?? "", /^(macOS|Linux) /);
  const denied = await testSshHost({
    host: { destination: "deny@box", label: "deny@box" },
    sshPath: fakeSsh,
    askpass: broker,
  });
  assert.deepEqual(denied, {
    ok: false,
    code: "auth-failed",
    error:
      "Couldn't sign in to deny@box. Check your SSH key, ssh-agent or password.",
    details: "deny@box: Permission denied (publickey,password).",
  });
  events.length = 0;
  answers = { password: "secret" };
  const prompted = await testSshHost({
    host: { destination: "pw@box", label: "pw@box" },
    sshPath: fakeSsh,
    askpass: broker,
  });
  assert.equal(prompted.ok, true);
  const prompt = events.find((e) => e.type === "ssh-prompt") as {
    prompt: { hostId: string };
  };
  assert.equal(prompt.prompt.hostId, "");
});

test("the IPC domain saves hosts, connects, lists and records remote folders, and follows the policy", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  // Host suggestions read ~/.ssh/config: point HOME at a temporary folder
  // with its own config so the real one is never read.
  const realHome = process.env.HOME;
  const suggestionsHome = temp("cxh-");
  fs.mkdirSync(path.join(suggestionsHome, ".ssh"));
  fs.writeFileSync(
    path.join(suggestionsHome, ".ssh", "config"),
    "Host ok@box\nHost staging\n",
  );
  process.env.HOME = suggestionsHome;
  t.after(() => {
    process.env.HOME = realHome;
  });
  const { registerSshHandlers } =
    await import("../../electron/ipc/ssh-handlers");
  const handlers = new Map<string, (...args: any[]) => any>();
  const pushed: SshEvent[] = [];
  const eventListeners: ((event: any) => void)[] = [];
  const deactivating: (() => Promise<void> | void)[] = [];
  let sshRemote = true;
  const ctx = {
    dataRoot: temp("cxd-"),
    providerServiceScript: path.join(root, "provider-service.cjs"),
    services: {} as Record<string, unknown>,
    remoteFolders: new Map<string, Set<string>>(),
    policy: () => ({ sshRemote }),
    onAccountActivated: (cb: () => void) => {
      queueMicrotask(cb);
      return () => {};
    },
    onAccountDeactivating: (cb: () => Promise<void>) => {
      deactivating.push(cb);
      return () => {};
    },
    onEvent: (cb: (event: any) => void) => {
      eventListeners.push(cb);
      return () => {};
    },
    push: (event: SshEvent) => pushed.push(event),
  };
  registerSshHandlers((name, fn) => handlers.set(name, fn), ctx as never, {
    prepareRuntimes: false,
  });
  const call = (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(ctx.services.ssh, "the service is shared for R9-S2/S3");

  await assert.rejects(
    call("sshSaveHost", { destination: "ok@box", sshPath: "/bin/sh" }),
    /named ssh/,
  );
  const saved = await call("sshSaveHost", {
    label: "Build",
    destination: "ok@box",
    sshPath: fakeSsh,
  });
  const listed = await call("sshListHosts");
  assert.deepEqual(listed.hosts, [saved]);
  assert.equal(typeof listed.sshAvailable, "boolean");
  // Saved destinations are not suggested again.
  if (listed.sshAvailable) assert.deepEqual(listed.suggestions, ["staging"]);

  await assert.rejects(
    call("sshListDirectory", saved.id),
    /Connect to Build first/,
  );
  assert.deepEqual(await call("sshConnect", saved.id), { state: "ready" });
  assert.deepEqual(await call("sshStatus", saved.id), { state: "ready" });
  assert.ok(
    pushed.some(
      (e) =>
        e.type === "ssh-status" &&
        e.hostId === saved.id &&
        e.status.state === "ready",
    ),
  );
  const home = await call("sshListDirectory", saved.id);
  assert.equal(home.path, fs.realpathSync(fakeHome));
  assert.deepEqual(home.entries, [{ name: "code", kind: "folder" }]);
  await assert.rejects(
    call("sshListDirectory", saved.id, "~/nope"),
    /doesn't exist/,
  );
  await assert.rejects(call("sshListDirectory", saved.id, "rel"), /absolute/);
  await call("sshChooseFolder", saved.id, "~/code/app");
  assert.deepEqual(
    [...ctx.remoteFolders.get(saved.id)!],
    [fs.realpathSync(path.join(fakeHome, "code", "app"))],
  );
  await assert.rejects(call("sshChooseFolder", saved.id, "~/code/missing"));
  assert.equal(await call("sshAnswerPrompt", "unknown", null), undefined);

  // The administrator turns SSH off: connections close, nothing shows.
  sshRemote = false;
  for (const listener of eventListeners)
    listener({ type: "policy", policy: {} });
  await waitFor(() =>
    pushed.some(
      (e) =>
        e.type === "ssh-status" &&
        e.status.state === "error" &&
        e.status.code === "policy-disabled",
    ),
  );
  assert.deepEqual(await call("sshStatus", saved.id), { state: "idle" });
  assert.equal((await call("sshListHosts")).sshAvailable, false);
  const refused = await call("sshConnect", saved.id);
  assert.equal(refused.code, "policy-disabled");
  await assert.rejects(call("sshSaveHost", { destination: "x" }));

  sshRemote = true;
  await call("sshDeleteHost", saved.id);
  assert.equal(ctx.remoteFolders.has(saved.id), false);
  assert.deepEqual((await call("sshListHosts")).hosts, []);
  for (const cb of deactivating) await cb();
  assert.equal(ctx.services.ssh, undefined);
});

test("a saved password answers ssh's password question without a prompt", async (t) => {
  if (!posix) return t.skip("fake ssh is a POSIX script");
  events.length = 0;
  answers = {};
  const signed = await testSshHost({
    host: { destination: "pw@box", label: "pw@box" },
    sshPath: fakeSsh,
    askpass: broker,
    password: "secret",
  });
  assert.equal(signed.ok, true);
  assert.equal(events.filter((e) => e.type === "ssh-prompt").length, 0);
  const { SshPasswordStore } =
    await import("../../electron/ssh/password-store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pw-"));
  // Encrypted at rest under the vault key, never stored as text.
  const store = new SshPasswordStore(dir, () => "vault-key");
  store.set("h1", "s3cret");
  assert.ok(store.has("h1"));
  assert.equal(store.get("h1"), "s3cret");
  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, "ssh-passwords.json"), "utf8"),
    /s3cret/,
  );
  assert.equal(new SshPasswordStore(dir, () => "other").get("h1"), undefined);
  store.delete("h1");
  assert.ok(!store.has("h1"));
  // Without OS encryption: memory only.
  const memory = new SshPasswordStore(dir, () => "");
  memory.set("h2", "m");
  assert.equal(memory.get("h2"), "m");
  assert.ok(
    !fs
      .readFileSync(path.join(dir, "ssh-passwords.json"), "utf8")
      .includes("h2"),
  );
});
