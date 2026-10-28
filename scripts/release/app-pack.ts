/**
 * Builds (and with --upload, uploads) the Windows app pack of a release
 * (electron/updates/app-pack.ts): release/win-unpacked/resources less the
 * Codex folder, zipped, and prints the `app_pack` entry for the release
 * row's `downloads["win32-x64"]`.
 *
 *   npx tsx scripts/release/app-pack.ts --version 0.0.38 [--unpacked release/win-unpacked]
 *       [--out release] [--upload]
 *
 * Credentials for --upload only from the environment (R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appPackKeptFolder, keepDigest } from "../../electron/updates/app-pack";
import {
  claudexDownloadUrl,
  defaultDownloadBase,
  encodeKeyPath,
  r2Credentials,
  signV4,
} from "./release-lib";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const version = option("version");
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Pass --version x.y.z");
const unpacked = path.resolve(option("unpacked") ?? "release/win-unpacked");
const out = path.resolve(option("out") ?? "release");
const resources = path.join(unpacked, "resources");
if (!fs.existsSync(path.join(resources, "app.asar")))
  throw new Error(`No app.asar in ${resources}`);
const packageVersion = JSON.parse(
  fs.readFileSync("package.json", "utf8"),
).version;
if (packageVersion !== version)
  console.warn(`package.json is ${packageVersion}, packing ${version}`);
const runtime = JSON.parse(
  fs.readFileSync("node_modules/electron/package.json", "utf8"),
).version as string;

const name = `Claudex-${version}-x64-app.zip`;
const file = path.join(out, name);
fs.rmSync(file, { force: true });
// Stored paths relative to resources/, the kept folder left out.
execFileSync(
  "zip",
  ["-q", "-r", "-X", file, ".", "-x", `${appPackKeptFolder}/*`],
  { cwd: resources },
);
const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const keep = await keepDigest(resources);
if (!keep) throw new Error(`No ${appPackKeptFolder} folder in ${resources}`);
const key = `${downloadsPrefix}/claudex/${version}/${name}`;
const url = claudexDownloadUrl(
  option("download-base") ?? defaultDownloadBase,
  key,
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
    body: fs.readFileSync(file),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok)
    throw new Error(`R2 answered ${response.status}: ${await response.text()}`);
  console.error(`uploaded ${key}`);
}

console.log(
  JSON.stringify(
    {
      file,
      bytes: fs.statSync(file).size,
      app_pack: { url, sha256, runtime, keep },
    },
    null,
    2,
  ),
);
