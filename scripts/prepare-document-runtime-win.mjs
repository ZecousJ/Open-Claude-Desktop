import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const version = "26.2.4.2";
const sha256 =
  "202f26cda071c5aa4996a5a28412fddceb3891dceb0366982c62650456c0730f";
const url = `https://downloadarchive.documentfoundation.org/libreoffice/old/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
const root = path.resolve("build/document-runtime-win");
const executable = path.join("program", "soffice.exe");
const cRuntime = path.join("program", "vcruntime140.dll");
const manifest = path.join(root, "manifest.json");
const cached = await fs
  .readFile(manifest, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (
  cached?.sha256 === sha256 &&
  (await fs.stat(path.join(root, executable)).catch(() => null)) &&
  (await fs.stat(path.join(root, cRuntime)).catch(() => null))
)
  process.exit(0);

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "claudex-office-win-"),
);
const extracted = path.join(temporary, "extracted");
const suppliedMsi = process.env.CLAUDEX_DOCUMENT_RUNTIME_MSI;
const msi = suppliedMsi
  ? path.resolve(suppliedMsi)
  : path.join(temporary, "LibreOffice.msi");
try {
  if (!suppliedMsi)
    await exec(
      process.platform === "win32" ? "curl.exe" : "curl",
      ["--fail", "--location", "--retry", "2", url, "-o", msi],
      { timeout: 600_000 },
    );
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(msi)) digest.update(chunk);
  if (digest.digest("hex") !== sha256)
    throw Error("Windows document runtime checksum mismatch");

  await fs.mkdir(extracted);
  if (process.platform === "win32") {
    await exec(
      "msiexec.exe",
      ["/a", `"${msi}"`, `TARGETDIR="${extracted}"`, "/qn", "/norestart"],
      { windowsVerbatimArguments: true, timeout: 300_000 },
    );
  } else {
    await exec("msiextract", ["-C", extracted, msi], {
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const entries = await fs.readdir(extracted, { recursive: true });
  const program = entries.find(
    (entry) => entry === executable || entry.endsWith(path.sep + executable),
  );
  if (!program)
    throw Error("LibreOffice extraction did not contain program/soffice.exe");
  const runtime = path.dirname(path.dirname(path.join(extracted, program)));
  let redistributable = path.join(extracted, "System64");
  const amd64Component = "_amd64.DFEFC2FE_EEE6_424C_841B_D4E66F0C84A3";
  if (process.platform !== "win32") {
    // Both architectures use the same System64 filenames in the MSI directory table.
    const { getPath7za } = await import("app-builder-lib/out/toolsets/7zip.js");
    redistributable = path.join(temporary, "redist");
    await exec(
      await getPath7za(),
      [
        "x",
        "-bd",
        "-bso0",
        "-bsp0",
        msi,
        `*${amd64Component}`,
        `-o${redistributable}`,
      ],
      { timeout: 300_000 },
    );
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.cp(runtime, root, {
    recursive: true,
    filter: (source) => {
      const entry = path.relative(runtime, source);
      return (
        entry !== "System" &&
        entry !== "System64" &&
        path.extname(entry).toLowerCase() !== ".msi"
      );
    },
  });
  for (const name of await fs.readdir(redistributable)) {
    const filename = name.replace(amd64Component, "");
    if (path.extname(filename).toLowerCase() !== ".dll") continue;
    await fs.copyFile(
      path.join(redistributable, name),
      path.join(root, "program", filename),
    );
  }
  await fs.access(path.join(root, cRuntime));
  await fs.writeFile(
    manifest,
    JSON.stringify(
      { version, url, sha256, license: "MPL-2.0 / LGPL-3.0+" },
      null,
      2,
    ) + "\n",
  );
  console.log("Prepared private Windows document runtime", version);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
