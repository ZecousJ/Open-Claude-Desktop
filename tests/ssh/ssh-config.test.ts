/**
 * R9-S1: reading the person's ssh configuration (`ssh -G`, Host names) and
 * finding the ssh program. The configuration is always a temporary HOME;
 * the real ~/.ssh is never read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configHostSuggestions,
  effectiveConfig,
  parseSshG,
} from "../../electron/ssh/ssh-config";
import {
  checkCustomSsh,
  findSsh,
  parseSshVersion,
  sshVersionNumber,
  supportsAskpassRequire,
  supportsControlMaster,
} from "../../electron/ssh/ssh-binary";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cx-sshcfg-"));

test("ssh -G output gives the host name, user, port, keys and jump host", () => {
  const config = parseSshG(
    [
      "host box",
      "hostname 10.0.0.5",
      "user deploy",
      "port 2222",
      "identityfile ~/.ssh/id_ed25519",
      "identityfile ~/.ssh/id_rsa",
      "proxyjump bastion",
      "forwardagent no",
      "port nonsense",
      "",
    ].join("\n"),
  );
  assert.deepEqual(config, {
    hostname: "10.0.0.5",
    user: "deploy",
    port: 2222,
    identityFiles: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"],
    proxyJump: "bastion",
    forwardAgent: false,
  });
  assert.equal(parseSshG("proxyjump none\r\n").proxyJump, undefined);
  assert.equal(parseSshG("port 70000\n").port, undefined);
});

test("effectiveConfig asks ssh -G and puts the destination after --", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX script");
  const dir = temp();
  const fake = path.join(dir, "ssh");
  const log = path.join(dir, "args.json");
  fs.writeFileSync(
    fake,
    `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("hostname example.test\\nuser me\\nport 22\\n");\n`,
    { mode: 0o755 },
  );
  const config = await effectiveConfig(fake, "alias", 2200);
  assert.equal(config?.hostname, "example.test");
  assert.equal(config?.user, "me");
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), [
    "-G",
    "-p",
    "2200",
    "--",
    "alias",
  ]);
  assert.equal(
    await effectiveConfig(path.join(dir, "missing"), "alias"),
    undefined,
  );
});

test("Host names from ~/.ssh/config and its includes are suggested; patterns are not", () => {
  const home = temp();
  const ssh = path.join(home, ".ssh");
  fs.mkdirSync(path.join(ssh, "conf.d"), { recursive: true });
  fs.writeFileSync(
    path.join(ssh, "config"),
    [
      "# comment Host commented",
      "Host dev dev-*  !nothere",
      "  HostName dev.example.test",
      "Host=build",
      'Host "quoted name" *',
      "Include conf.d/*.conf",
      "Include ~/.ssh/extra",
      "Include ~/.ssh/config",
      "Match host other",
      "host dev",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(ssh, "conf.d", "b.conf"), "Host beta\n");
  fs.writeFileSync(path.join(ssh, "conf.d", "a.conf"), "Host alpha\n");
  fs.writeFileSync(path.join(ssh, "conf.d", "skip.txt"), "Host skipped\n");
  fs.writeFileSync(path.join(ssh, "extra"), "HOST gamma -bad\n");
  assert.deepEqual(configHostSuggestions(home), [
    "dev",
    "build",
    "quoted name",
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual(configHostSuggestions(temp()), []);
});

test("the first absolute PATH ssh wins; Windows falls back to in-box OpenSSH", () => {
  const files = new Set([
    "/usr/bin/ssh",
    "/opt/homebrew/bin/ssh",
    "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
  ]);
  const isFile = (file: string) => files.has(file);
  assert.equal(
    findSsh({
      platform: "darwin",
      env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      isFile,
    }),
    "/opt/homebrew/bin/ssh",
  );
  files.delete("/usr/bin/ssh");
  assert.equal(
    findSsh({
      platform: "linux",
      env: { PATH: "relative:/opt/homebrew/bin" },
      isFile,
    }),
    "/opt/homebrew/bin/ssh",
  );
  assert.equal(
    findSsh({ platform: "linux", env: { PATH: "bin" }, isFile }),
    undefined,
  );
  assert.equal(
    findSsh({
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
        Path: "C:\\Program Files\\Git\\usr\\bin",
      },
      isFile,
    }),
    "C:\\Program Files\\Git\\usr\\bin\\ssh.exe",
  );
  files.delete("C:\\Program Files\\Git\\usr\\bin\\ssh.exe");
  assert.equal(
    findSsh({
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
        Path: "C:\\Program Files\\Git\\usr\\bin",
      },
      isFile,
    }),
    "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
  );
});

test("a custom ssh program must be an existing absolute file named ssh", () => {
  const isFile = (file: string) => file.startsWith("/opt/");
  assert.equal(
    checkCustomSsh("/opt/homebrew/bin/ssh", { platform: "darwin", isFile }),
    "/opt/homebrew/bin/ssh",
  );
  for (const bad of [
    "ssh",
    "/opt/bin/bash",
    "/opt/bin/ssh\n",
    "/usr/local/bin/ssh",
    "",
    42,
  ])
    assert.throws(() => checkCustomSsh(bad, { platform: "darwin", isFile }));
  assert.equal(
    checkCustomSsh("C:\\Tools\\SSH.EXE", {
      platform: "win32",
      isFile: () => true,
    }),
    "C:\\Tools\\SSH.EXE",
  );
});

test("ssh versions: parsing, askpass force support and connection sharing", () => {
  assert.equal(
    parseSshVersion("OpenSSH_9.6p1, LibreSSL 3.3.6\n"),
    "OpenSSH_9.6p1",
  );
  assert.equal(
    parseSshVersion("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"),
    "OpenSSH_for_Windows_9.5p1",
  );
  assert.equal(parseSshVersion("something else"), undefined);
  assert.deepEqual(sshVersionNumber("OpenSSH_10.3p1"), [10, 3]);
  assert.deepEqual(sshVersionNumber("OpenSSH_for_Windows_7.7p1"), [7, 7]);
  assert.equal(supportsAskpassRequire("OpenSSH_8.4p1"), true);
  assert.equal(supportsAskpassRequire("OpenSSH_8.2p1"), false);
  assert.equal(supportsAskpassRequire("OpenSSH_10.0p2"), true);
  assert.equal(supportsAskpassRequire(undefined), true);
  assert.equal(supportsControlMaster("win32"), false);
  assert.equal(supportsControlMaster("darwin"), true);
});
