/**
 * Removes a replaced Claudex release's installers from R2. Run it after the
 * newer version is published (docs/releasing.md):
 *
 * npx tsx scripts/release/prune.ts --version 0.0.4 [--delete]
 *
 * Dry run by default: prints the object keys. `--delete` deletes them and
 * checks each is gone, with credentials only from the environment:
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import {
  downloadsPrefix,
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
if (!version || !/^\d+\.\d+\.\d+([-.][\w.]+)?$/.test(version))
  throw new Error("Usage: prune.ts --version <replaced version> [--delete]");

/** The installers publish.ts uploads for a version. */
export const releaseKeys = (v: string) =>
  [
    `Claudex-${v}-arm64-mac.zip`,
    `Claudex-${v}-x64-mac.zip`,
    `Claudex-Setup-${v}.exe`,
    // The Windows app pack (scripts/release/app-pack.ts).
    `Claudex-${v}-x64-app.zip`,
  ].map((file) => `${downloadsPrefix}/claudex/${v}/${file}`);

const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function request(method: "DELETE" | "HEAD", key: string) {
  const credentials = r2Credentials(process.env);
  const path = `/${encodeKeyPath(credentials.bucket)}/${encodeKeyPath(key)}`;
  const headers = signV4({
    method,
    host: credentials.host,
    path,
    payloadSha256: emptySha256,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });
  return fetch(`https://${credentials.host}${path}`, { method, headers });
}

const keys = releaseKeys(version);
if (!argv.includes("--delete")) {
  for (const key of keys) console.log(`would delete ${key}`);
  console.log("\nDry run: nothing deleted (add --delete).");
} else {
  for (const key of keys) {
    const before = await request("HEAD", key);
    if (before.status === 404) {
      console.log(`absent   ${key}`);
      continue;
    }
    const deleted = await request("DELETE", key);
    if (!deleted.ok && deleted.status !== 404)
      throw new Error(`${key}: R2 answered ${deleted.status}`);
    const after = await request("HEAD", key);
    if (after.status !== 404)
      throw new Error(`${key}: still there (${after.status})`);
    console.log(`deleted  ${key}`);
  }
}
