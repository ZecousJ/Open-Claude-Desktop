import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import {
  installUnpackedExtension,
  developerModeFolderBlocked,
  unpackExtensionArchive,
  extensionOpenFailed,
} from "../../electron/connectors/desktop-extension";
import { createZip } from "../../electron/workspace/zip";
import { openPolicy } from "../../shared/client-policy";
import { allowedMcpServers } from "../../shared/client-policy-rules";
import { extensionPolicyNotice } from "../../shared/extension-policy";
import {
  parseOperatorPolicy,
  resolveClientPolicy,
} from "../../server/operator-policy";

test("packaged extensions unpack into the existing MCP runtime, refusing broken and escaping archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-extension-"));
  try {
    const source = unpackExtensionArchive(
      createZip([
        {
          name: "manifest.json",
          data: Buffer.from(
            JSON.stringify({
              name: "example",
              server: {
                mcp_config: {
                  command: "node",
                  args: ["${__dirname}/server.js"],
                },
              },
            }),
          ),
        },
        { name: "server.js", data: Buffer.from("export {};") },
      ]),
      root,
    );
    let saved: Record<string, unknown> = {};
    assert.equal(
      installUnpackedExtension({
        source,
        root,
        allowed: () => true,
        current: {},
        update: (servers) => {
          saved = servers;
        },
      }),
      "example",
    );
    assert.ok(saved.example);
    for (const archive of [
      Buffer.from("not a zip"),
      createZip([{ name: "../outside", data: Buffer.from("x") }]),
    ])
      assert.throws(() => unpackExtensionArchive(archive, root), {
        message: extensionOpenFailed,
      });
    assert.equal(fs.existsSync(path.join(root, "outside")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed device policies independently block extension and developer servers, not remote connectors", () => {
  const servers = {
    extension: { command: "node", claudex_extension: "/private/extension" },
    developer: { command: "node" },
    remote: { url: "https://example.com/mcp" },
  };
  const extensionsOff = { ...openPolicy, desktopExtensionsEnabled: false };
  const developerOff = { ...openPolicy, developerMcpEnabled: false };
  assert.deepEqual(Object.keys(allowedMcpServers(servers, extensionsOff)), [
    "developer",
    "remote",
  ]);
  assert.deepEqual(Object.keys(allowedMcpServers(servers, developerOff)), [
    "extension",
    "remote",
  ]);
  assert.match(
    extensionPolicyNotice(extensionsOff)!,
    /^Desktop extensions are disabled/,
  );
  assert.match(
    extensionPolicyNotice(developerOff)!,
    /^Developer MCP servers are disabled/,
  );
  assert.match(
    extensionPolicyNotice({ ...extensionsOff, developerMcpEnabled: false })!,
    /^Desktop extensions and developer MCP servers are disabled/,
  );
  assert.equal(extensionPolicyNotice(openPolicy), undefined);
  const file = parseOperatorPolicy({
    version: 1,
    defaults: { desktopExtensionsEnabled: false, developerMcpEnabled: false },
  });
  const policy = resolveClientPolicy(file, {
    platform: "darwin",
    appVersion: "1.0.0",
    accountId: "local",
  });
  assert.equal(policy.desktopExtensionsEnabled, false);
  assert.equal(policy.developerMcpEnabled, false);
});

test("unpacked extensions copy private files and resolve their manifest for the runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unpacked-extension-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify({
      name: "example",
      server: {
        mcp_config: { command: "node", args: ["${__dirname}/server.js"] },
      },
    }),
  );
  fs.writeFileSync(path.join(source, "server.js"), "export {};");
  let saved: Record<string, unknown> = {};
  const options = {
    source,
    root: path.join(root, "account"),
    allowed: () => true,
    current: { existing: { command: "existing" } },
    update: (servers: Record<string, unknown>) => {
      saved = servers;
    },
  };
  try {
    assert.equal(installUnpackedExtension(options), "example");
    const entry = saved.example as { command: string; args: string[] };
    assert.equal(entry.command, "node");
    assert.ok(entry.args[0].startsWith(options.root));
    assert.equal(fs.readFileSync(entry.args[0], "utf8"), "export {};");
    assert.deepEqual(saved.existing, options.current.existing);
    assert.throws(
      () => installUnpackedExtension({ ...options, allowed: () => false }),
      { message: developerModeFolderBlocked },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unpacked extension installation rejects symlinks without registering a server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unpacked-extension-"));
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify({
      name: "test",
      server: { mcp_config: { command: "node" } },
    }),
  );
  fs.symlinkSync("manifest.json", path.join(root, "link"));
  try {
    assert.throws(() =>
      installUnpackedExtension({
        source: root,
        root: path.join(root, "data"),
        allowed: () => true,
        current: {},
        update: () => assert.fail("must not register"),
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installing a newer package replaces the owned extension and retains its configuration", () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "extension-upgrade-"),
  );
  const source = path.join(root, "source");
  const account = path.join(root, "account");
  fs.mkdirSync(source);
  const writePackage = (version: string) => {
    fs.writeFileSync(
      path.join(source, "manifest.json"),
      JSON.stringify({
        name: "upgrade-fixture",
        version,
        server: {
          mcp_config: { command: "node", args: ["${__dirname}/server.js"] },
        },
      }),
    );
    fs.writeFileSync(path.join(source, "server.js"), version);
  };
  let servers: Record<string, unknown> = {};
  const install = () =>
    installUnpackedExtension({
      source,
      root: account,
      allowed: () => true,
      current: servers,
      update: (value) => {
        servers = value;
      },
    });
  try {
    writePackage("1.0.0");
    assert.equal(install(), "upgrade-fixture");
    const before = servers["upgrade-fixture"] as { claudex_extension: string };
    writePackage("2.0.0");
    assert.equal(install(), "upgrade-fixture");
    const after = servers["upgrade-fixture"] as { claudex_extension: string };
    assert.notEqual(after.claudex_extension, before.claudex_extension);
    assert.equal(fs.readFileSync(path.join(before.claudex_extension, "server.js"), "utf8"), "1.0.0");
    assert.equal(
      fs.readFileSync(path.join(after.claudex_extension, "server.js"), "utf8"),
      "2.0.0",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an upgrade refusal retains the original extension and does not replace a local MCP server", () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "extension-upgrade-refusal-"),
  );
  const source = path.join(root, "source");
  const account = path.join(root, "account");
  fs.mkdirSync(source);
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    server: {
      mcp_config: { command: "node", args: ["${__dirname}/server.js"] },
    },
  };
  fs.writeFileSync(
    path.join(source, "manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(source, "server.js"), "old");
  let servers: Record<string, unknown> = {};
  const options = () => ({
    source,
    root: account,
    allowed: () => true,
    current: servers,
    update: (value: Record<string, unknown>) => {
      servers = value;
    },
  });
  try {
    installUnpackedExtension(options());
    const before = servers.fixture as { claudex_extension: string };
    fs.writeFileSync(path.join(source, "server.js"), "new");
    assert.throws(
      () =>
        installUnpackedExtension({
          ...options(),
          update: () => {
            throw Error("save refused");
          },
        }),
      /save refused/,
    );
    assert.equal(
      fs.readFileSync(path.join(before.claudex_extension, "server.js"), "utf8"),
      "old",
    );
    servers = { fixture: { command: "node" } };
    assert.throws(() => installUnpackedExtension(options()));
    assert.deepEqual(servers, { fixture: { command: "node" } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extensions from different authors retain distinct identities and upgrade independently", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-identity-"));
  const source = path.join(root, "source");
  const account = path.join(root, "account");
  fs.mkdirSync(source);
  const manifest = {
    name: "same-name", version: "1.0.0", author: { name: "First Author" },
    server: { mcp_config: { command: "node", args: ["${__dirname}/server.js"] } },
  };
  const write = (content: string) => {
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, "server.js"), content);
  };
  let servers: Record<string, unknown> = {};
  const install = () => installUnpackedExtension({
    source, root: account, sourceKind: "local.mcpb", allowed: () => true, current: servers,
    update: value => { servers = value; },
  });
  try {
    write("first-v1");
    const first = install();
    manifest.author.name = "Second Author";
    write("second-v1");
    const second = install();
    assert.notEqual(first, second);
    assert.equal((servers[first] as any).claudex_extension_id, "local.mcpb.first-author.same-name");
    assert.equal((servers[second] as any).claudex_extension_id, "local.mcpb.second-author.same-name");
    manifest.author.name = "First Author";
    manifest.version = "2.0.0";
    write("first-v2");
    assert.equal(install(), first);
    assert.equal(fs.readFileSync(path.join((servers[first] as any).claudex_extension, "server.js"), "utf8"), "first-v2");
    assert.equal(fs.readFileSync(path.join((servers[second] as any).claudex_extension, "server.js"), "utf8"), "second-v1");
    assert.equal(Object.keys(servers).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a valid bundle name containing spaces installs under a usable local server name", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-name-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const manifest = {
    name: "Example Tool", version: "1.0.0", author: { name: "Example Author" },
    server: { mcp_config: { command: "node" } },
  };
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
  let saved: Record<string, unknown> = {};
  try {
    const name = installUnpackedExtension({
      source, root: path.join(root, "account"), sourceKind: "local.unpacked",
      allowed: () => true, current: {}, update: value => { saved = value; },
    });
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
    assert.equal((saved[name] as any).claudex_extension_id, "local.unpacked.example-author.example-tool");
    assert.equal((saved[name] as any).claudex_extension_manifest_name, "Example Tool");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("retiring an old package happens only after the new reference is published", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-retire-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const manifest = { name: "fixture", version: "1", server: { mcp_config: { command: "node" } } };
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
  let servers: Record<string, unknown> = {};
  const base = {
    source, root: path.join(root, "account"), allowed: () => true,
    update: (value: Record<string, unknown>) => { servers = value; },
  };
  try {
    installUnpackedExtension({ ...base, current: servers });
    const oldPath = (servers.fixture as any).claudex_extension;
    manifest.version = "2";
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    installUnpackedExtension({
      ...base, current: servers,
      retirePrevious: (name, old) => {
        assert.equal(name, "fixture");
        assert.equal(old, oldPath);
        assert.notEqual((servers.fixture as any).claudex_extension, oldPath);
        assert.equal(fs.existsSync(oldPath), true);
        return true;
      },
    });
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync((servers.fixture as any).claudex_extension), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an interrupted update keeps either the old or the published new package readable", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-crash-"));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const manifest = { name: "fixture", version: "1", server: { mcp_config: { command: "node" } } };
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
  let servers: Record<string, unknown> = {};
  try {
    installUnpackedExtension({
      source, root: path.join(root, "account"), current: servers, allowed: () => true,
      update: value => { servers = value; },
    });
    manifest.version = "2";
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    const modulePath = path.resolve("electron/connectors/desktop-extension.ts");
    for (const publish of [false, true]) {
      const state = path.join(root, publish ? "after.json" : "before.json");
      fs.writeFileSync(state, JSON.stringify(servers));
      const script = `
        import fs from "node:fs";
        import { installUnpackedExtension } from ${JSON.stringify(modulePath)};
        const state = ${JSON.stringify(state)};
        installUnpackedExtension({
          source: ${JSON.stringify(source)},
          root: ${JSON.stringify(path.join(root, "account"))},
          current: JSON.parse(fs.readFileSync(state, "utf8")),
          allowed: () => true,
          update: value => {
            if (${publish}) fs.writeFileSync(state, JSON.stringify(value));
            process.exit(0);
          },
        });
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      const saved = JSON.parse(fs.readFileSync(state, "utf8"));
      const installed = JSON.parse(fs.readFileSync(path.join(saved.fixture.claudex_extension, "manifest.json"), "utf8"));
      assert.equal(installed.version, publish ? "2" : "1");
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an executable binary in an extension archive remains runnable after installation", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "extension-binary-"));
  try {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      name: "binary-fixture", version: "1.0.0",
      server: { type: "binary", entry_point: "server", mcp_config: { command: "${__dirname}/server" } },
    }));
    zip.file("server", "#!/bin/sh\nprintf binary-fixture", { unixPermissions: 0o100755 });
    const source = unpackExtensionArchive(await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }), root);
    let saved: Record<string, unknown> = {};
    installUnpackedExtension({
      source, root: path.join(root, "account"), allowed: () => true, current: {},
      update: value => { saved = value; },
    });
    const command = (saved["binary-fixture"] as { command: string }).command;
    const result = spawnSync(command, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.stdout, "binary-fixture");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
