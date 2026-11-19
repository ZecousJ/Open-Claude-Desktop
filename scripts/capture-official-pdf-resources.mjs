/** Discover the pinned PDF.js ancillary filenames; fetch bytes from the official UI origin. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const root = path.resolve(process.argv[2] ?? "build/official-usercontent");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "manifest.json"), "utf8"),
);
const versions = new Set();
for (const a of manifest.assets.filter((a) => a.path.endsWith(".js"))) {
  const text = await fs.readFile(path.join(root, a.file), "utf8");
  for (const m of text.matchAll(/\/libs\/pdfjs-([\d.]+)/g)) versions.add(m[1]);
}
if (versions.size !== 1)
  throw Error("Expected one pinned official PDF.js runtime");
const version = [...versions][0];
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "claudex-pdf-assets-"),
);
try {
  const packed = await exec("npm", [
    "pack",
    "pdfjs-dist@" + version,
    "--pack-destination",
    temporary,
    "--silent",
  ]);
  const archive = path.join(temporary, packed.stdout.trim().split("\n").at(-1));
  const entries = (
    await exec("tar", ["-tzf", archive], { maxBuffer: 10_000_000 })
  ).stdout.split("\n");
  const files = [
    "pdf.min.mjs",
    "pdf.worker.min.mjs",
    ...entries
      .filter((p) => /^package\/(cmaps|standard_fonts|wasm)\/[^/]+$/.test(p))
      .map((p) => p.slice(8)),
  ];
  const assets = new Map(manifest.assets.map((a) => [a.path, a]));
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (name) => {
        const urlPath = "/libs/pdfjs-" + version + "/" + name;
        const file = urlPath.slice(1),
          destination = path.join(root, file);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await exec(
          "curl",
          [
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "2",
            "--max-time",
            "45",
            manifest.origin + urlPath,
            "-o",
            destination,
          ],
          { maxBuffer: 1_000_000 },
        );
        const data = await fs.readFile(destination);
        assets.set(urlPath, {
          path: urlPath,
          file,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }),
    );
    console.log(
      "Captured PDF resources",
      Math.min(i + 8, files.length),
      "/",
      files.length,
    );
  }
  manifest.assets = [...assets.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  manifest.pdfRuntime = {
    version,
    source: manifest.origin + "/libs/pdfjs-" + version,
    capturedAt: new Date().toISOString(),
    files: files.length,
  };
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
