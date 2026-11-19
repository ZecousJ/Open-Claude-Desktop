import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtensionLifecycle } from "../../electron/connectors/extension-lifecycle";
import { installUnpackedExtension } from "../../electron/connectors/desktop-extension";
import { openPolicy } from "../../shared/client-policy";

for (const outcome of ["retire", "referenced", "publication-fails"] as const) {
  test(`upgrade settings cleanup when ${outcome}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-upgrade-retire-"));
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const manifest = {
      name: "demo", version: "1", user_config: {
        token: { type: "string", title: "Token", required: true, sensitive: true },
      }, server: { mcp_config: { command: "node", env: { TOKEN: "${user_config.token}" } } },
    };
    const writeManifest = () => fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    let servers: Record<string, any> = {};
    const scope = {};
    const update = (next: Record<string, unknown>) => { servers = next; };
    try {
      writeManifest();
      installUnpackedExtension({ source, root, current: servers, allowed: () => true, update });
      const lifecycle = new ExtensionLifecycle({
        owner: () => ({ root, scope, servers, policy: openPolicy }),
        cipher: {
          isEncryptionAvailable: () => true,
          encryptString: value => Buffer.from(value),
          decryptString: value => value.toString(),
        },
        runtimeConfiguration: () => true,
        update,
      });
      for (const token of ["first", "second"]) {
        lifecycle.save({ id: "demo", revision: lifecycle.details("demo").revision, enabled: true, values: { token } });
      }
      const settingsDir = path.join(root, "desktop-extension-settings");
      const oldFiles = fs.readdirSync(settingsDir);
      const oldPath = servers.demo.claudex_extension;
      manifest.version = "2";
      writeManifest();
      const install = () => installUnpackedExtension({
        source, root, current: servers, allowed: () => true,
        update: outcome === "publication-fails" ? () => { throw Error("publication failed"); } : update,
        prepareUpgrade: (id, next, target) => lifecycle.prepareUpgrade(id, next, target),
        retirePrevious: () => outcome === "retire",
      });
      if (outcome === "publication-fails") assert.throws(install, /publication failed/);
      else install();
      const files = fs.readdirSync(settingsDir);
      for (const file of oldFiles) assert.equal(files.includes(file), outcome !== "retire");
      assert.equal(fs.existsSync(oldPath), outcome !== "retire");
      assert.deepEqual(lifecycle.runtimeConfig("demo", servers.demo)?.env, { TOKEN: "second" });
      assert.equal(files.length, outcome === "retire" ? 1 : outcome === "referenced" ? oldFiles.length + 1 : oldFiles.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
