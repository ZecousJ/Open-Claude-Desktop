import test from "node:test";
import assert from "node:assert/strict";
import { SshConnection } from "../../electron/ssh/connection";
import { classifySshError } from "../../electron/ssh/connection-support";
import { sshTechnicalDetails } from "../../electron/ssh/connection-support";
import { errorMessage } from "../../electron/ssh/connection-support";
import {
  RemoteRuntime,
  RemoteRuntimeError,
} from "../../electron/ssh/remote-runtime";
import { RuntimeCache } from "../../electron/ssh/runtime-cache";
import { sshHostAllowed, sshPolicyError } from "../../electron/ssh/policy";
import { parseSshG } from "../../electron/ssh/ssh-config";
import { supportedSshVersion } from "../../electron/ssh/ssh-binary";
import { applyManagedSettings } from "../../electron/account/managed-settings";
import { openPolicy } from "../../shared/client-policy";
import { sshDiagnosticMessages } from "../../shared/ssh-diagnostics";
import { errorExplanation } from "../../src/ssh/model";
import { setLocale } from "../../src/i18n";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { collectOutput } from "../../electron/ssh/connection-support";
import {
  INPUT_PROBE_SCRIPT,
  remoteCommand,
} from "../../electron/ssh/remote-scripts";

test("specific SSH diagnostics take precedence over generic sign-in failures", () => {
  const cases = {
    "key-permissions":
      "WARNING: UNPROTECTED PRIVATE KEY FILE!\nPermission denied (publickey).",
    "key-putty": "PuTTY .ppk invalid format",
    "agent-refused":
      "sign_and_send_pubkey: signing failed: agent refused operation",
    "too-many-keys": "Too many authentication failures",
    "key-passphrase":
      "Load key: incorrect passphrase supplied to decrypt private key",
    "key-algorithm": "sign_and_send_pubkey: no mutual signature supported",
    "key-missing": "no such identity: /keys/private: No such file or directory",
    "key-invalid": 'Load key "/keys/private": invalid format',
    "session-limit": "mux_client_request_session: Session open refused by peer",
    "remote-disk-full": "mkdir: No space left on device",
    "remote-read-only": "mkdir: Read-only file system",
    "ssh-config-invalid": "/config: line 4: Bad configuration option: oops",
    "host-keys-not-kept":
      "SSH authentication failed: keeps no known_hosts for this host",
    "key-sign-failed": "sign_and_send_pubkey: signing failed for ED25519",
    "key-public-half": 'Load key "/keys/key.pub": invalid format',
    "key-not-private": "not a private key",
    "key-read-blocked": 'Load key "/keys/key": Operation not permitted',
    "key-protected-folder": 'Load key "/keys/key": Permission denied',
    "key-rsa-rejected": "ssh-rsa not in PubkeyAcceptedAlgorithms",
    "handshake-incompatible": "no matching key exchange method found",
    "proxy-failed": "proxy command exited with status 1",
    "proxy-browser-sign-in": "Open your browser to sign in",
    "teleport-sign-in": "Please run tsh login",
    "remote-no-input": "EXEC_NO_INPUT",
  };
  for (const [code, stderr] of Object.entries(cases))
    assert.equal(classifySshError(stderr), code, stderr);
  assert.equal(
    classifySshError("channel 3: open failed: administratively prohibited"),
    "host-unreachable",
  );
  assert.equal(
    classifySshError(
      "REMOTE HOST IDENTIFICATION HAS CHANGED\nToo many authentication failures",
    ),
    "host-key-changed",
  );
});

test("diagnostics translate templates before substituting host names", async () => {
  await setLocale("zh-CN");
  for (const [code, message] of Object.entries(sshDiagnosticMessages)) {
    assert.equal(
      errorMessage(
        code as keyof typeof sshDiagnosticMessages,
        "build.example.com",
      ),
      message.replaceAll("{host}", "build.example.com"),
    );
    const translated = errorExplanation(
      code as keyof typeof sshDiagnosticMessages,
      "build.example.com",
    );
    assert.ok(translated.includes("build.example.com"));
    assert.ok(!translated.includes("{host}"));
    assert.notEqual(
      translated,
      message.replaceAll("{host}", "build.example.com"),
    );
  }
  await setLocale("en-US");
});

test("SSH allowlist matches exact names and wildcard apex at every depth, not suffix lookalikes", () => {
  assert.equal(
    sshHostAllowed("USER@Build.Example.COM", ["*.example.com"]),
    true,
  );
  assert.equal(sshHostAllowed("example.com", ["*.example.com"]), true);
  assert.equal(sshHostAllowed("a.b.example.com", ["*.example.com"]), true);
  for (const host of ["evilexample.com", "example.com.evil", "other.com"])
    assert.equal(sshHostAllowed(host, ["*.example.com"]), false);
  assert.equal(sshHostAllowed("build", []), false);
  assert.equal(sshHostAllowed("build"), true);
  assert.equal(sshHostAllowed("BUILD", ["build"]), true);
  assert.equal(sshHostAllowed("any.example.com", ["*"]), true);
});

test("the connection probe detects commands deprived of standard input", async () => {
  if (process.platform === "win32") return;
  const run = (input?: string) =>
    collectOutput(spawn("sh", ["-c", remoteCommand(INPUT_PROBE_SCRIPT)]), {
      input,
    });
  assert.equal((await run("claudex-stdin\n")).code, 0);
  const missing = await run();
  assert.equal(missing.code, 1);
  assert.equal(classifySshError(missing.stderr), "remote-no-input");
});

test("remote install preserves disk diagnostics before uploading", async () => {
  for (const [stderr, expected] of [
    ["mkdir: No space left on device", "remote-disk-full"],
    ["mkdir: Read-only file system", "remote-read-only"],
  ]) {
    const runtime = new RemoteRuntime({
      shell: { exec: async () => ({ code: 3, stdout: "", stderr }) },
      probe: { os: "Linux", arch: "x86_64", home: "/home/me", tools: [] },
      label: "host",
      clientId: "012345abcdef",
      cache: {} as RuntimeCache,
    });
    await assert.rejects(
      runtime.ensure(),
      (error: unknown) =>
        error instanceof RemoteRuntimeError && error.code === expected,
    );
  }
});

test("disconnect during policy preflight never launches SSH", async () => {
  let finish!: (value: undefined) => void;
  const connection = new SshConnection({
    host: { id: "host", label: "host", destination: "host", createdAt: 1 },
    sshPath: "/missing/ssh",
    runtimeDir: os.tmpdir(),
    askpass: {
      session: () => {
        throw new Error("must not create a prompt");
      },
    },
    beforeConnect: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onStatus: () => {},
    spawn: () => {
      throw new Error("must not launch SSH");
    },
  });
  const connecting = connection.connect();
  await connection.disconnect();
  finish(undefined);
  assert.deepEqual(await connecting, { state: "idle" });
});

test("SSH policy disabled fails before launching a program", async () => {
  assert.deepEqual(
    await sshPolicyError(
      { sshRemote: false },
      { destination: "host" },
      "/missing/ssh",
    ),
    {
      code: "policy-disabled",
      message:
        "SSH connections are disabled by your organization's managed settings.",
    },
  );
  assert.deepEqual(
    await sshPolicyError(
      { sshHostAllowlist: [] },
      { destination: "user@host" },
      "/missing/ssh",
    ),
    {
      code: "host-not-allowed",
      message:
        'SSH host "host" is not allowed by your organization\'s managed settings.',
    },
  );
});

test("allowlist checks resolved HostName rather than the SSH alias", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-ssh-policy-"));
  const program = path.join(root, "ssh");
  fs.writeFileSync(
    program,
    "#!/bin/sh\nprintf 'hostname Build.Example.com\\n'\n",
    { mode: 0o700 },
  );
  try {
    assert.equal(
      await sshPolicyError(
        { sshHostAllowlist: ["*.example.com"] },
        { destination: "user@alias" },
        program,
      ),
      undefined,
    );
    assert.deepEqual(
      await sshPolicyError(
        { sshHostAllowlist: ["alias"] },
        { destination: "user@alias" },
        program,
      ),
      {
        code: "host-not-allowed",
        message:
          'SSH host "Build.Example.com" is not allowed by your organization\'s managed settings.',
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed SSH constraints and pin survive policy overlay", () => {
  const managed = {
    sshHostAllowlist: ["*.dev.example.com"],
    sshClientPath: "/opt/openssh/bin/ssh",
  };
  const policy = applyManagedSettings(openPolicy, managed);
  assert.deepEqual(policy.sshHostAllowlist, managed.sshHostAllowlist);
  assert.equal(policy.sshClientPath, managed.sshClientPath);
});

test("SSH minimum versions and known-hosts configuration are explicit", () => {
  assert.equal(supportedSshVersion("OpenSSH_7.5", "linux"), false);
  assert.equal(supportedSshVersion("OpenSSH_7.6p1", "darwin"), true);
  assert.equal(supportedSshVersion("OpenSSH_for_Windows_9.3", "win32"), false);
  assert.equal(supportedSshVersion("OpenSSH_for_Windows_9.4p1", "win32"), true);
  assert.equal(supportedSshVersion(undefined), false);
  const config = parseSshG(
    "hostname build.example.com\nuserknownhostsfile /dev/null\nstricthostkeychecking ask\nproxyjump bastion\n",
  );
  assert.deepEqual(config.userKnownHostsFiles, ["/dev/null"]);
  assert.equal(config.strictHostKeyChecking, "ask");
  assert.equal(config.proxyJump, "bastion");
  assert.equal(
    sshTechnicalDetails("\u001b[31mPermission denied\u001b[0m\u0000\n"),
    "Permission denied",
  );
  assert.equal(sshTechnicalDetails("a".repeat(9000)).length, 8192);
});
