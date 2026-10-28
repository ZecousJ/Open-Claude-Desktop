import test from "node:test";
import assert from "node:assert/strict";
import {
  readManagedSettings,
  applyManagedSettings,
  ManagedPolicySource,
  type ManagedSettingsHost,
} from "../../electron/account/managed-settings";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";

const absent = () => Object.assign(new Error("absent"), { code: "ENOENT" });
const host = (extra: Partial<ManagedSettingsHost>): ManagedSettingsHost => ({
  platform: "linux",
  username: "owner",
  read: () => {
    throw absent();
  },
  command: () => {
    throw new Error("unexpected command");
  },
  ...extra,
});

test("Linux managed policy is machine-local and missing differs from malformed", () => {
  assert.deepEqual(readManagedSettings(host({})), {});
  assert.deepEqual(
    readManagedSettings(
      host({
        read: (file) => {
          assert.equal(file, "/etc/claudex/managed-settings.json");
          return '{"webSearch":false,"browser":{"blockedDomains":["example.com"]}}';
        },
      }),
    ),
    { webSearch: false, browser: { blockedDomains: ["example.com"] } },
  );
  assert.throws(() => readManagedSettings(host({ read: () => "{" })));
  assert.throws(() =>
    readManagedSettings(host({ read: () => '{"webSearch":"false"}' })),
  );
});

test("MDM machine and user plists are converted without executing shell input", () => {
  const read: string[] = [];
  const policy = readManagedSettings(
    host({
      platform: "darwin",
      read: (file) => {
        read.push(file);
        return "binary plist";
      },
      command: (program, args) => {
        assert.equal(program, "/usr/bin/plutil");
        assert.deepEqual(args.slice(0, 4), ["-convert", "json", "-o", "-"]);
        return args[4].includes("/owner/")
          ? '{"voice":false}'
          : '{"webSearch":false}';
      },
    }),
  );
  assert.deepEqual(policy, { webSearch: false, voice: false, browser: {} });
  assert.deepEqual(read, [
    "/Library/Managed Preferences/dev.claudex.desktop.plist",
    "/Library/Managed Preferences/owner/dev.claudex.desktop.plist",
  ]);
});

test("Windows GPO reads JSON from the machine Settings REG_SZ value", () => {
  const policy = readManagedSettings(
    host({
      platform: "win32",
      command: (program, args) => {
        assert.equal(program, "reg.exe");
        if (args[1] === "HKLM\\SOFTWARE\\Policies")
          return "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claudex";
        assert.deepEqual(args, ["query", "HKLM\\SOFTWARE\\Policies\\Claudex"]);
        return 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claudex\r\n    Settings    REG_SZ    {"localMcpEditing":false}\r\n';
      },
    }),
  );
  assert.deepEqual(policy, { localMcpEditing: false });
  assert.throws(() =>
    readManagedSettings(
      host({
        platform: "win32",
        command: (_program, args) =>
          args[1] === "HKLM\\SOFTWARE\\Policies"
            ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claudex"
            : "Settings REG_DWORD 0x1",
      }),
    ),
  );
});

test("managed restrictions cannot widen server policy; domain denials are combined", () => {
  const policy: ClientPolicy = {
    ...openPolicy,
    webSearch: false,
    revision: 17,
    browser: {
      enabled: true,
      externalSites: true,
      allowScript: false,
      devServers: true,
      blockedDomains: ["server.example"],
    },
  };
  const next = applyManagedSettings(policy, {
    webSearch: true,
    voice: false,
    permissionModes: ["manual"],
    browser: {
      allowScript: true,
      externalSites: false,
      blockedDomains: ["local.example"],
    },
  });
  assert.equal(next.webSearch, false);
  assert.equal(next.voice, false);
  assert.equal(next.revision, 17);
  assert.deepEqual(next.permissionModes, ["manual"]);
  assert.equal(next.browser?.allowScript, false);
  assert.equal(next.browser?.externalSites, false);
  assert.deepEqual(next.browser?.blockedDomains, [
    "server.example",
    "local.example",
  ]);
  assert.deepEqual(policy.browser?.blockedDomains, ["server.example"]);
});

test("policy refresh enforces changed local configuration and fails closed until repaired", async () => {
  let malformed = false;
  let restricted = false;
  const changed: ClientPolicy[] = [];
  const source = new ManagedPolicySource(
    {
      current: () => ({ ...openPolicy, revision: 9 }),
      refresh: async () => {},
    },
    (policy) => changed.push(policy),
    () => {
      if (malformed) throw new Error("bad managed policy");
      return restricted ? { browser: { enabled: false } } : {};
    },
  );
  assert.equal(source.current().browser?.enabled, true);
  restricted = true;
  await source.refresh();
  assert.equal(changed.at(-1)?.browser?.enabled, false);
  malformed = true;
  await source.refresh();
  assert.equal(source.current().localMcpEditing, false);
  assert.equal(source.current().revision, 9);
  malformed = false;
  restricted = false;
  await source.refresh();
  assert.equal(source.current().localMcpEditing, true);
});
