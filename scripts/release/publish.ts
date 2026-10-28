/**
 * Publishes built Claudex files to Cloudflare R2 and
 * prints what to paste into the admin pages (docs/releasing.md).
 *
 *   npx tsx scripts/release/publish.ts --claudex release
 *       [--notes notes.md] [--minimum 0.0.1]
 *       [--download-base https://claudex.example.com/downloads]
 *       [--json out.json] [--upload]
 *
 * Dry run by default: computes SHA-256, prints object keys, public URLs, the
 * Claudex release JSON (PUT /api/v1/admin/claudex/release, or the admin
 * release page). `--upload` also uploads, with credentials only from the environment:
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  claudexArtifacts,
  claudexReleasePayload,
  encodeKeyPath,
  claudexDownloadUrl,
  defaultDownloadBase,
  r2Credentials,
  signV4,
  type Artifact,
  type PlatformKey,
} from "./release-lib";

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const upload = argv.includes("--upload");
const downloadBase = option("download-base") ?? defaultDownloadBase;

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
const sha256 = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function put(artifact: Artifact, digest: string) {
  const credentials = r2Credentials(process.env);
  const objectPath = `/${encodeKeyPath(credentials.bucket)}/${encodeKeyPath(artifact.key)}`;
  const body = fs.readFileSync(artifact.file);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const headers = signV4({
      method: "PUT",
      host: credentials.host,
      path: objectPath,
      payloadSha256: digest,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      headers: { "content-type": artifact.contentType },
    });
    try {
      const response = await fetch(`https://${credentials.host}${objectPath}`, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (response.ok) return;
      const text = (await response.text()).slice(0, 300);
      if (response.status < 500 && response.status !== 429)
        throw Object.assign(
          new Error(`R2 answered ${response.status}: ${text}`),
          { fatal: true },
        );
      console.warn(
        `  ${artifact.key}: R2 answered ${response.status}, retrying`,
      );
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error;
      console.warn(`  ${artifact.key}: ${(error as Error).message}, retrying`);
    }
    await sleep(attempt * 5_000);
  }
  throw new Error(`${artifact.key} couldn't be uploaded.`);
}

const claudexDir = option("claudex");
if (!claudexDir) {
  console.error("usage: publish.ts --claudex <release dir> [--upload]");
  process.exit(2);
}

const artifacts: Artifact[] = [];
let claudexVersion: string | undefined;
if (claudexDir) {
  const found = claudexArtifacts(listFiles(claudexDir));
  claudexVersion = found.version;
  artifacts.push(...found.artifacts);
}

const digests = new Map<Artifact, string>();
for (const artifact of artifacts) {
  const digest = await sha256(artifact.file);
  digests.set(artifact, digest);
  console.log(
    `${digest}  ${artifact.key}  (${fs.statSync(artifact.file).size} bytes)`,
  );
}

if (upload) {
  console.log(`\nUploading ${artifacts.length} files to R2…`);
  for (const artifact of artifacts) {
    await put(artifact, digests.get(artifact)!);
    console.log(`  uploaded ${artifact.key}`);
  }
} else console.log("\nDry run: nothing uploaded (add --upload).");

const output: Record<string, unknown> = {};
if (claudexVersion) {
  const downloads: Partial<
    Record<PlatformKey, { url: string; sha256: string }>
  > = {};
  for (const artifact of artifacts)
    if (artifact.platform)
      downloads[artifact.platform] = {
        url: claudexDownloadUrl(downloadBase, artifact.key),
        sha256: digests.get(artifact)!,
      };
  const notes = option("notes");
  output.claudexRelease = claudexReleasePayload({
    version: claudexVersion,
    downloads,
    minimumVersion: option("minimum"),
    releaseNotesMd: notes ? fs.readFileSync(notes, "utf8") : "",
  });
}
const json = JSON.stringify(output, null, 2);
console.log(`\n${json}`);
const jsonFile = option("json");
if (jsonFile) fs.writeFileSync(jsonFile, json);
