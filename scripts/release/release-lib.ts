/**
 * Release tooling's pure parts: which built files are which, where they go in
 * the R2 bucket, the Claudex admin release payload, and AWS Signature V4 for R2's S3 API. Tested in
 * tests/release-tooling.test.ts.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Bucket prefix every download lives under, and the bucket's public
 * address (CLAUDEX_DOWNLOADS_PREFIX, CLAUDEX_PUBLIC_BASE).
 */
export const downloadsPrefix =
  process.env.CLAUDEX_DOWNLOADS_PREFIX ?? "claudex/downloads";
export const defaultPublicBase = process.env.CLAUDEX_PUBLIC_BASE ?? "";

export type PlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "darwin-universal"
  | "win32-x64"
  | `linux-${"x64" | "arm64"}-${"deb" | "rpm" | "tar"}`;

/** electron-builder's and the package managers' names for the two Linux arches. */
const linuxArch = (name: string) =>
  ["amd64", "x86_64", "x64"].includes(name) ? "x64" : "arm64";

export interface Artifact {
  /** Local file. */
  file: string;
  /** Object key in the bucket. */
  key: string;
  contentType: string;
  platform?: PlatformKey;
}

const version = String.raw`(\d+\.\d+\.\d+(?:[-+][\w.]+)?)`;

/** Claudex's electron-builder outputs: universal or per-arch mac zips and NSIS. */
export function claudexArtifacts(files: string[]): {
  version: string;
  artifacts: Artifact[];
} {
  const found: { platform: PlatformKey; file: string; version: string }[] = [];
  for (const file of files) {
    const name = path.basename(file);
    let match = new RegExp(
      `^Claudex-${version}-(arm64|x64|universal)-mac\\.zip$`,
    ).exec(name);
    if (match) {
      found.push({
        platform: `darwin-${match[2]}` as PlatformKey,
        file,
        version: match[1],
      });
      continue;
    }
    match = new RegExp(`^Claudex[- ]Setup[- ]${version}\\.exe$`).exec(name);
    if (match) {
      found.push({ platform: "win32-x64", file, version: match[1] });
      continue;
    }
    // Linux: claudex_<v>_<arch>.deb, claudex-<v>.<arch>.rpm, Claudex-<v>-linux-<arch>.tar.gz.
    const linux: [RegExp, "deb" | "rpm" | "tar"][] = [
      [new RegExp(`^claudex_${version}_(amd64|x64|arm64)\\.deb$`), "deb"],
      [
        new RegExp(`^claudex-${version}\\.(x86_64|x64|aarch64|arm64)\\.rpm$`),
        "rpm",
      ],
      [new RegExp(`^Claudex-${version}-linux-(x64|arm64)\\.tar\\.gz$`), "tar"],
    ];
    for (const [pattern, format] of linux) {
      match = pattern.exec(name);
      if (match) {
        found.push({
          platform: `linux-${linuxArch(match[2])}-${format}` as PlatformKey,
          file,
          version: match[1],
        });
        break;
      }
    }
  }
  if (!found.length)
    throw new Error(
      "No Claudex build (Claudex-<v>-<arch>-mac.zip or Claudex-Setup-<v>.exe) found.",
    );
  const versions = [...new Set(found.map((item) => item.version))];
  if (versions.length > 1)
    throw new Error(`Builds of several versions: ${versions.join(", ")}`);
  const platforms = found.map((item) => item.platform);
  if (new Set(platforms).size !== platforms.length)
    throw new Error("Two builds for one platform.");
  return {
    version: versions[0],
    artifacts: found.map(({ platform, file, version: v }) => ({
      file,
      platform,
      // No spaces in keys: the NSIS installer is renamed Claudex-Setup-<v>.exe.
      key: `${downloadsPrefix}/claudex/${v}/${
        platform === "win32-x64"
          ? `Claudex-Setup-${v}.exe`
          : path.basename(file)
      }`,
      contentType:
        platform === "win32-x64"
          ? "application/vnd.microsoft.portable-executable"
          : platform.endsWith("-deb")
            ? "application/vnd.debian.binary-package"
            : platform.endsWith("-rpm")
              ? "application/x-rpm"
              : platform.endsWith("-tar")
                ? "application/gzip"
                : "application/zip",
    })),
  };
}

export const publicUrl = (base: string, key: string) =>
  `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Where Claudex itself downloads its installers: the Claudex service's
 * /downloads/, which serves the bucket's downloads/claudex/... objects
 * (CLAUDEX_DOWNLOAD_BASE, e.g. https://claudex.example.com/downloads).
 */
export const defaultDownloadBase = process.env.CLAUDEX_DOWNLOAD_BASE ?? "";

export function claudexDownloadUrl(base: string, key: string) {
  if (!base)
    throw new Error(
      "Set CLAUDEX_DOWNLOAD_BASE (or --download-base) to the service's /downloads address.",
    );
  const prefix = `${downloadsPrefix}/`;
  if (!key.startsWith(`${prefix}claudex/`))
    throw new Error(`Not a Claudex installer key: ${key}`);
  return publicUrl(base, key.slice(prefix.length));
}

/** Body for PUT /api/v1/admin/claudex/release (the admin release page's JSON). */
export function claudexReleasePayload(options: {
  version: string;
  downloads: Partial<Record<PlatformKey, { url: string; sha256: string }>>;
  minimumVersion?: string;
  releaseNotesMd?: string;
  publishedAt?: string;
}) {
  return {
    channels: {
      stable: {
        latest_version: options.version,
        minimum_version: options.minimumVersion ?? "",
        published_at: options.publishedAt ?? new Date().toISOString(),
        release_notes_url: "",
        release_notes_md: options.releaseNotesMd ?? "",
        downloads: options.downloads,
      },
    },
    enforce_minimum_on_gateway: false,
  };
}

const sha256Hex = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of each path segment, as S3 signs it. */
export const encodeKeyPath = (key: string) =>
  key
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");

/** AWS Signature V4 headers for one request with no query string (R2: region "auto"). */
export function signV4(options: {
  method: string;
  host: string;
  path: string;
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  date?: Date;
  headers?: Record<string, string>;
}) {
  const region = options.region ?? "auto";
  const service = options.service ?? "s3";
  const stamp = (options.date ?? new Date())
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v.trim(),
      ]),
    ),
    host: options.host,
    "x-amz-content-sha256": options.payloadSha256,
    "x-amz-date": stamp,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    options.method,
    options.path,
    "",
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    names.join(";"),
    options.payloadSha256,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join(
    "\n",
  );
  const key = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, day), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/** R2 credentials, only from the environment; never written anywhere. */
export function r2Credentials(env: Record<string, string | undefined>) {
  const names = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ] as const;
  const missing = names.filter((name) => !env[name]);
  if (missing.length)
    throw new Error(`Set ${missing.join(", ")} in the environment to upload.`);
  if (!/^[0-9a-f]{32}$/i.test(env.R2_ACCOUNT_ID!))
    throw new Error("R2_ACCOUNT_ID must be the 32-hex account id.");
  return {
    host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
  };
}
