/** Pinned official LibreOffice build; installed privately inside Claudex resources. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const version = "26.2.4.2";
const sha256 =
  "64e0ad05564554eeee639d49b08b20908a38d4722ec95f1620d05c99bcbe9fb1";
const url =
  "https://downloadarchive.documentfoundation.org/libreoffice/old/" +
  version +
  "/mac/aarch64/LibreOffice_" +
  version +
  "_MacOS_aarch64.dmg";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error(
    "Document conversion runtime is currently packaged for macOS arm64; other targets remain unverified.",
  );
const root = path.resolve("build/document-runtime");
const info = await fs
  .readFile(path.join(root, "manifest.json"), "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (
  info?.sha256 === sha256 &&
  (await fs
    .stat(path.join(root, "LibreOffice.app/Contents/MacOS/soffice"))
    .catch(() => null))
)
  process.exit(0);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "claudex-document-runtime-"),
);
const mount = path.join(temporary, "mount");
const dmg =
  process.env.CLAUDEX_DOCUMENT_RUNTIME_DMG ||
  path.join(temporary, "runtime.dmg");
let mounted = false;
try {
  if (!process.env.CLAUDEX_DOCUMENT_RUNTIME_DMG)
    await exec(
      "curl",
      ["--fail", "--location", "--retry", "2", url, "-o", dmg],
      { timeout: 600000 },
    );
  if (
    createHash("sha256")
      .update(await fs.readFile(dmg))
      .digest("hex") !== sha256
  )
    throw Error("Document runtime checksum mismatch");
  await fs.mkdir(mount);
  await exec("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
    dmg,
  ]);
  mounted = true;
  await fs.mkdir(root, { recursive: true });
  await exec("ditto", [
    path.join(mount, "LibreOffice.app"),
    path.join(root, "LibreOffice.app"),
  ]);
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        version,
        url,
        sha256,
        license: "MPL-2.0 / LGPL-3.0+; bundled notices inside LibreOffice.app",
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Prepared private document runtime", version, sha256);
} finally {
  if (mounted) await exec("hdiutil", ["detach", mount]);
  await fs.rm(temporary, { recursive: true, force: true });
}
