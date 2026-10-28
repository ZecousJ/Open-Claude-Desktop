import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
