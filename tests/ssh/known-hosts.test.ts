import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  forgetHostKey,
  knownHostsName,
  parseSshG,
  sshToolBinding,
} from "../../electron/ssh/known-hosts";

test("known_hosts names a host on another port with brackets", () => {
  assert.equal(knownHostsName("localhost", 2222), "[localhost]:2222");
  assert.equal(knownHostsName("devbox", 22), "devbox");
  const g = parseSshG(
    "hostname 10.0.0.5\nport 2222\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n",
  );
  assert.deepEqual(g, {
    host: "10.0.0.5",
    port: 2222,
    files: ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"],
  });
  assert.equal(parseSshG("hostname a\nhostkeyalias b\n").host, "b");
});

test("tool grants bind resolved aliases to trusted keys and reject removed keys", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fake ssh");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-tool-binding-"));
  try {
    const known = path.join(dir, "known_hosts");
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIORHSKB+cC+jT2Xo8Jh1KOSoZHxxxxxxxxxxxxxxxxxxxx";
    fs.writeFileSync(known, `[localhost]:2222 ${key}\nother.example ${key}\n`);
    const fakeSsh = path.join(dir, "ssh");
    fs.writeFileSync(
      fakeSsh,
      `#!/bin/sh\nprintf 'hostname localhost\\nuser ubuntu\\nport 2222\\nuserknownhostsfile ${known}\\n'\n`,
      { mode: 0o755 },
    );
    const binding = await sshToolBinding(fakeSsh, { destination: "alias" });
    assert.equal(binding?.endpointKey, '["ubuntu@localhost",2222]');
    assert.equal(binding?.hostKey.length, 64);
    assert.deepEqual(
      await sshToolBinding(fakeSsh, {
        destination: "ubuntu@localhost",
        port: 2222,
      }),
      binding,
    );
    fs.appendFileSync(known, `unrelated.example ${key}\n`);
    assert.deepEqual(
      await sshToolBinding(fakeSsh, { destination: "alias" }),
      binding,
    );
    fs.writeFileSync(known, "");
    assert.equal(
      await sshToolBinding(fakeSsh, { destination: "alias" }),
      undefined,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The WonderSim case: localhost:2222 was rebuilt.
test("the old key of a host is removed and other hosts are kept", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fake ssh");
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return t.skip("no ssh-keygen");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-kh-"));
  try {
    const known = path.join(dir, "known_hosts");
    const key =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIORHSKB+cC+jT2Xo8Jh1KOSoZHxxxxxxxxxxxxxxxxxxxx";
    fs.writeFileSync(known, `[localhost]:2222 ${key}\nother.example ${key}\n`);
    const fakeSsh = path.join(dir, "ssh");
    fs.writeFileSync(
      fakeSsh,
      `#!/bin/sh\nprintf 'hostname localhost\\nport 2222\\nuserknownhostsfile ${known}\\n'\n`,
      { mode: 0o755 },
    );
    const result = await forgetHostKey({
      sshPath: fakeSsh,
      destination: "ubuntu@localhost",
      port: 2222,
    });
    assert.equal(result.removed, true);
    const left = fs.readFileSync(known, "utf8");
    assert.doesNotMatch(left, /\[localhost\]:2222/);
    assert.match(left, /other\.example/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
