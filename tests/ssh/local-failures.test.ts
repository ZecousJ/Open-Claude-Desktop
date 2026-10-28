import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SshConnection, testSshHost } from "../../electron/ssh/connection";
import { classifySshError } from "../../electron/ssh/connection-support";
import { errorMessage } from "../../electron/ssh/connection-support";
import { sshLocalFailureMessages } from "../../shared/ssh-failures";
import { bannerFor, errorExplanation } from "../../src/ssh/model";

test("connection and Test connection propagate local failures and keep the host", async () => {
  const host = {
    id: "host",
    label: "Host",
    destination: "DOMAIN\\user@host",
    createdAt: 1,
  };
  for (const stderr of [
    "remote username contains invalid characters\n",
    "ssh_askpass: exec(/helper): Permission denied\nPermission denied (password).\n",
  ]) {
    let closed = 0;
    const options = {
      host,
      sshPath: "/ssh",
      platform: "win32" as const,
      runtimeDir: "/unused",
      askpass: {
        session: () => ({
          env: {},
          close: () => {
            closed++;
          },
        }),
      },
      onStatus() {},
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => {
          child.stderr.end(stderr);
          child.emit("close", 255);
        });
        return child as unknown as ChildProcess;
      },
    };
    const connection = new SshConnection(options);
    const status = await connection.connect();
    const code = classifySshError(stderr);
    assert.deepEqual(status, {
      state: "error",
      code,
      message: errorMessage(code, host.label),
    });
    assert.deepEqual(await testSshHost(options), {
      ok: false,
      code,
      error: errorMessage(code, host.label),
    });
    assert.equal(closed, 2);
    assert.equal(connection.host, host);
    assert.equal(host.destination, "DOMAIN\\user@host");
    connection.kill();
  }
});

test("other ssh failures keep their own codes", () => {
  assert.equal(classifySshError("proxy_jump_unsupported"), "host-unreachable");
  assert.equal(
    classifySshError("no matching key exchange method found"),
    "handshake-incompatible",
  );
});

test("OpenSSH's exact username rejection is local, not a rejected password", () => {
  for (const ending of ["\n", "\r\n", ""])
    assert.equal(
      classifySshError(`remote username contains invalid characters${ending}`),
      "local_ssh_login_refused",
    );
  assert.equal(
    classifySshError("user$@box: Permission denied (publickey)."),
    "auth-failed",
  );
  assert.equal(
    classifySshError("DOMAIN\\user@box: Connection refused"),
    "host-unreachable",
  );
  assert.equal(
    classifySshError("remote username contains invalid characters in a log"),
    "host-unreachable",
  );
});

test("helper blocking requires an interactive sign-in, a launch refusal and password or code auth", () => {
  const refused =
    "ssh_askpass: exec(/private/claudex-askpass): Permission denied\n";
  for (const methods of [
    "password",
    "keyboard-interactive",
    "publickey,password",
  ])
    assert.equal(
      classifySshError(`${refused}user@host: Permission denied (${methods}).`),
      "local_ssh_helper_blocked",
    );
  assert.equal(
    classifySshError(`${refused}Permission denied (password).`, false),
    "auth-failed",
  );
  assert.equal(
    classifySshError(`${refused}Permission denied (publickey).`),
    "auth-failed",
  );
  assert.equal(
    classifySshError("Permission denied (password)."),
    "auth-failed",
  );
  assert.equal(
    classifySshError(
      "ssh_askpass: exec(/helper): No such file or directory\nPermission denied (password).",
    ),
    "auth-failed",
  );
  assert.equal(classifySshError(refused), "auth-failed");
  assert.equal(
    classifySshError(`${refused}REMOTE HOST IDENTIFICATION HAS CHANGED!`),
    "host-key-changed",
  );
});

test("main process, settings and reconnect banner share the exact explanation without raw diagnostics", () => {
  assert.equal(
    sshLocalFailureMessages.local_ssh_helper_blocked,
    "This computer won’t start Claudex’s SSH sign-in helper. Ask your admin to allow it, then reconnect. Your sessions there are kept.",
  );
  assert.equal(
    sshLocalFailureMessages.local_ssh_login_refused,
    "This computer’s ssh refuses a backslash or dollar sign in user names. Send a message in one of your sessions there to see what to do. Your sessions are kept.",
  );
  for (const code of Object.keys(
    sshLocalFailureMessages,
  ) as (keyof typeof sshLocalFailureMessages)[]) {
    const message = sshLocalFailureMessages[code];
    assert.equal(errorMessage(code, "private-host"), message);
    assert.equal(errorExplanation(code), message);
    const view = bannerFor(
      { state: "error", code, message: "private diagnostics" },
      "private-host",
    );
    assert.equal(view?.text, message);
    assert.equal(view?.error, true);
    assert.equal(view?.action?.kind, "connect");
  }
});
