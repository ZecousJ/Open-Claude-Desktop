/**
 * R9-S1: the saved SSH hosts. One unreadable entry never hides the others,
 * the file is private and written atomically, and nothing that could turn
 * into an ssh option or shell text is accepted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOSTS_FILE,
  MAX_HOSTS,
  SshHostStore,
  checkDestination,
  checkHostFields,
  checkPort,
} from "../../electron/ssh/host-store";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cx-sshhosts-"));

test("hosts are saved, changed, touched and removed, and survive a restart", () => {
  const root = temp();
  let now = 1000;
  const store = new SshHostStore(root, () => now);
  const host = store.save({
    label: "",
    destination: " deploy@build.example.test ",
    port: 2222,
    identityFile: "~/.ssh/id_ed25519",
    remoteRoot: "~/claudex",
    forwardAgent: true,
  });
  assert.equal(host.label, "deploy@build.example.test");
  assert.equal(host.destination, "deploy@build.example.test");
  assert.equal(host.createdAt, 1000);
  assert.equal(host.forwardAgent, true);
  assert.match(host.id, /^[0-9a-f-]{36}$/);

  const file = path.join(root, HOSTS_FILE);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith(".tmp")),
    [],
  );

  now = 2000;
  const renamed = store.save({
    id: host.id,
    label: "Build box",
    destination: "build",
  });
  assert.equal(renamed.label, "Build box");
  assert.equal(renamed.createdAt, 1000);
  assert.equal(renamed.port, undefined);
  assert.equal(renamed.forwardAgent, undefined);
  store.touch(host.id);

  const reopened = new SshHostStore(root);
  assert.deepEqual(reopened.list(), [{ ...renamed, lastUsedAt: 2000 }]);
  assert.throws(
    () => store.save({ id: "missing", label: "x", destination: "x" }),
    /no longer exists/,
  );
  assert.equal(store.delete(host.id), true);
  assert.equal(store.delete(host.id), false);
  assert.deepEqual(new SshHostStore(root).list(), []);
});

test("a broken entry is skipped and the others still load", () => {
  const root = temp();
  const good = {
    id: "good-1",
    label: "Good",
    destination: "me@good.example.test",
    createdAt: 1,
  };
  fs.writeFileSync(
    path.join(root, HOSTS_FILE),
    JSON.stringify({
      version: 1,
      hosts: [
        good,
        { ...good, id: "bad-dest", destination: "-oProxyCommand=evil" },
        { ...good, id: "bad port", port: 99999 },
        { ...good, id: "no-time", createdAt: "yesterday" },
        { ...good, id: "bad-root", remoteRoot: "relative/dir" },
        null,
        "text",
        good,
        {
          ...good,
          id: "good-2",
          destination: "alias",
          sshPath: "/usr/bin/ssh",
        },
      ],
    }),
  );
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => void warnings.push(message);
  try {
    const store = new SshHostStore(root);
    assert.deepEqual(
      store.list().map((host) => host.id),
      ["good-1", "good-2"],
    );
    assert.equal(store.skipped, 7);
  } finally {
    console.warn = warn;
  }
  // Only the count is logged, never a host.
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /example|evil|alias/);
});

test("an unreadable file means no hosts, not a failure", () => {
  const root = temp();
  fs.writeFileSync(path.join(root, HOSTS_FILE), "{not json");
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(new SshHostStore(root).list(), []);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(new SshHostStore(temp()).list(), []);
});

test("destinations that ssh could read as an option or a shell could split are refused", () => {
  for (const ok of [
    "host",
    "user@host.example.test",
    "user@[2001:db8::1]",
    "a.b-c_d",
    "me@host:2222",
  ])
    assert.equal(checkDestination(ok), ok);
  for (const bad of [
    "",
    "   ",
    "-oProxyCommand=touch /tmp/x",
    "user@host other",
    "user@host\nHost",
    "host;rm -rf ~",
    "'quoted'",
    'double"',
    "back\\slash",
    "`tick`",
    "@host",
    "user@",
    "x".repeat(256),
    42,
  ])
    assert.throws(() => checkDestination(bad), String(bad));
});

test("ports, identity files and remote folders are checked", () => {
  assert.equal(checkPort("22"), 22);
  assert.equal(checkPort(undefined), undefined);
  assert.equal(checkPort(""), undefined);
  for (const bad of [0, 65536, 22.5, "ssh", -1])
    assert.throws(() => checkPort(bad));
  assert.throws(() =>
    checkHostFields({ destination: "h", identityFile: "id_rsa" }),
  );
  assert.throws(() =>
    checkHostFields({ destination: "h", identityFile: "/k\n-oX" }),
  );
  assert.throws(() =>
    checkHostFields({ destination: "h", defaultFolder: "~/a\nb" }),
  );
  assert.throws(() =>
    checkHostFields({ destination: "h", remoteRoot: "code" }),
  );
  assert.throws(() => checkHostFields({ destination: "h", label: "a\u0007" }));
  assert.throws(() => checkHostFields(null));
  const fields = checkHostFields({
    destination: "h",
    label: "  My   box ",
    identityFile: "C:\\Users\\me\\.ssh\\id_ed25519",
    defaultFolder: "/srv/app",
    forwardAgent: "yes",
  });
  assert.equal(fields.label, "My box");
  assert.equal(fields.defaultFolder, "/srv/app");
  // Only a real true turns agent forwarding on.
  assert.equal(fields.forwardAgent, undefined);
});

test("at most MAX_HOSTS hosts", () => {
  const store = new SshHostStore(temp());
  for (let i = 0; i < MAX_HOSTS; i++)
    store.save({ label: "", destination: `h${i}` });
  assert.throws(
    () => store.save({ label: "", destination: "one-more" }),
    /up to/,
  );
});
