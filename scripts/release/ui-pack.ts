/**
 * Publishes a desktop interface pack (docs/releasing.md).
 *
 *   npx tsx scripts/release/ui-pack.ts --n 1 [--skip-build] [--dist dist]
 *       [--out <dir>] [--download-base https://claudex.example.com/downloads] [--upload]
 *
 * Builds the window (`vite build`) unless --skip-build, then signs it with
 * the release key (~/.config/claudex/ui-signing.key, or the file named by
 * CLAUDEX_UI_SIGNING_KEY; never printed) as version `uiVersionFor(<app
 * version in package.json>, n)`, writes `claudex-ui-<version>.zip` and prints
 * the `ui` section for claudex_client_release. `--upload` puts it in R2
 * (credentials from R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET) under <downloads prefix>/claudex/ui/<version>/.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeLevel, uiVersionFor } from "../../shared/ui-pack";
import { verifyPack } from "../../electron/ui-pack/verify";
import {
  claudexDownloadUrl,
  defaultDownloadBase,
  downloadsPrefix,
  encodeKeyPath,
  r2Credentials,
  signV4,
} from "./release-lib";
import { buildUiPack } from "./ui-pack-lib";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const n = Number(option("n"));
if (!Number.isInteger(n) || n < 1) {
  console.error(
    "usage: ui-pack.ts --n <pack number, 1 and up> [--skip-build] [--upload]",
  );
  process.exit(2);
}
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version as string;
const version = uiVersionFor(appVersion, n);
const dist = path.resolve(option("dist") ?? path.join(root, "dist"));
const outDir = path.resolve(option("out") ?? os.tmpdir());
const downloadBase = option("download-base") ?? defaultDownloadBase;

if (!argv.includes("--skip-build"))
  execFileSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit" });

const keyFile =
  process.env.CLAUDEX_UI_SIGNING_KEY ??
  path.join(os.homedir(), ".config", "claudex", "ui-signing.key");
const { zip, manifest } = await buildUiPack({
  dist,
  version,
  bridge: bridgeLevel,
  privateKey: fs.readFileSync(keyFile, "utf8"),
});
// The pack must pass the app's own check before anyone downloads it.
await verifyPack(zip, { expectVersion: version });

const fileName = `claudex-ui-${version}.zip`;
const file = path.join(outDir, fileName);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(file, zip);
const sha256 = createHash("sha256").update(zip).digest("hex");
const key = `${downloadsPrefix}/claudex/ui/${version}/${fileName}`;
const url = claudexDownloadUrl(downloadBase, key);

console.log(`Interface ${version} (app ${appVersion}, bridge ${bridgeLevel})`);
console.log(
  `  ${Object.keys(manifest.files).length} files, ${(zip.length / 1048576).toFixed(1)} MB`,
);
console.log(`  file    ${file}`);
console.log(`  object  ${key}`);
console.log(`  sha256  ${sha256}`);
console.log(
  `  Desktop apps whose bridge level is below ${bridgeLevel} keep their own interface until they install a newer build.`,
);

if (argv.includes("--upload")) {
  const credentials = r2Credentials(process.env);
  const objectPath = `/${encodeKeyPath(credentials.bucket)}/${encodeKeyPath(key)}`;
  const headers = signV4({
    method: "PUT",
    host: credentials.host,
    path: objectPath,
    payloadSha256: sha256,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    headers: { "content-type": "application/zip" },
  });
  const response = await fetch(`https://${credentials.host}${objectPath}`, {
    method: "PUT",
    headers,
    body: zip,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok)
    throw new Error(
      `R2 answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  console.log("  uploaded");
}

console.log("\nThe ui section of channels.stable in claudex_client_release:");
console.log(
  JSON.stringify(
    { ui: { version, bridge: bridgeLevel, url, sha256 } },
    null,
    2,
  ),
);
