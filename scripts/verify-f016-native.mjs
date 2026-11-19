import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { verifyOfficialWebAssets } from "./official-web-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(root))
  throw Error("Run this check from its repository root.");
verifyOfficialWebAssets(root);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f016-verifier-"));
try {
  const fixture = path.join(temp, "fixture.cjs");
  await build({
    entryPoints: [
      path.join(root, "tests/official-ui-e2e/f016-native-fixture.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    nodePaths: (process.env.NODE_PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean),
    outfile: fixture,
    logLevel: "warning",
  });
  const child = spawn(
    process.execPath,
    [path.join(root, "tests/official-ui-e2e/f016-native-driver.cjs")],
    {
      cwd: root,
      env: { ...process.env, F016_NATIVE_FIXTURE: fixture },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
