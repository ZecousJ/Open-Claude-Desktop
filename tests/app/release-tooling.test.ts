import assert from "node:assert/strict";
import test from "node:test";
import {
  claudexArtifacts,
  claudexReleasePayload,
  encodeKeyPath,
  publicUrl,
  r2Credentials,
  signV4,
} from "../../scripts/release/release-lib";

test("Claudex builds map to platform keys under the downloads prefix", () => {
  const { version, artifacts } = claudexArtifacts([
    "release/Claudex-0.0.2-arm64-mac.zip",
    "release/Claudex-0.0.2-x64-mac.zip",
    "release/Claudex Setup 0.0.2.exe",
    "release/latest.yml",
    "release/Claudex-0.0.2-arm64-mac.zip.blockmap",
  ]);
  assert.equal(version, "0.0.2");
  assert.deepEqual(
    artifacts.map((item) => [item.platform, item.key]),
    [
      [
        "darwin-arm64",
        "claudex/downloads/claudex/0.0.2/Claudex-0.0.2-arm64-mac.zip",
      ],
      [
        "darwin-x64",
        "claudex/downloads/claudex/0.0.2/Claudex-0.0.2-x64-mac.zip",
      ],
      ["win32-x64", "claudex/downloads/claudex/0.0.2/Claudex-Setup-0.0.2.exe"],
    ],
  );
  assert.throws(
    () =>
      claudexArtifacts([
        "Claudex-0.0.2-arm64-mac.zip",
        "Claudex-Setup-0.0.3.exe",
      ]),
    /several versions/,
  );
  assert.throws(() => claudexArtifacts(["other.zip"]), /No Claudex build/);
});

test("the admin payloads", () => {
  const release = claudexReleasePayload({
    version: "0.0.2",
    downloads: {
      "darwin-arm64": {
        url: "https://downloads.example.com/a.zip",
        sha256: "a".repeat(64),
      },
    },
    publishedAt: "2026-09-26T00:00:00.000Z",
  });
  assert.equal(release.channels.stable.latest_version, "0.0.2");
  assert.equal(release.enforce_minimum_on_gateway, false);
  assert.equal(
    publicUrl("https://downloads.example.com/", "claudex/downloads/a b.exe"),
    "https://downloads.example.com/claudex/downloads/a%20b.exe",
  );
});

test("Signature V4 matches AWS's documented S3 PUT example", () => {
  const headers = signV4({
    method: "PUT",
    host: "examplebucket.s3.amazonaws.com",
    path: `/${encodeKeyPath("test$file.text")}`,
    payloadSha256:
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    date: new Date("2013-05-24T00:00:00Z"),
    headers: {
      Date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});

test("R2 credentials come only from the environment", () => {
  assert.throws(
    () => r2Credentials({}),
    /R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET/,
  );
  const credentials = r2Credentials({
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "id",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "claudex",
  });
  assert.equal(
    credentials.host,
    "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  );
});

test("Claudex downloads its installers from the Claudex server's /downloads/", async () => {
  const { claudexDownloadUrl } =
    await import("../../scripts/release/release-lib");
  assert.equal(
    claudexDownloadUrl(
      "https://claudex.example.com/downloads",
      "claudex/downloads/claudex/0.0.4/Claudex-Setup-0.0.4.exe",
    ),
    "https://claudex.example.com/downloads/claudex/0.0.4/Claudex-Setup-0.0.4.exe",
  );
  assert.throws(() =>
    claudexDownloadUrl(
      "https://claudex.example.com/downloads",
      "claudex/downloads/other/x.exe",
    ),
  );
});
