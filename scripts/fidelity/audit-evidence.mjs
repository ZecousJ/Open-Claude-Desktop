/** Verify that every local coverage reference resolves, and write a private hash manifest. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fidelity = path.join(repository, "fidelity"),
  work = path.join(repository, "work", "fidelity");
const coverage = JSON.parse(
  fs.readFileSync(path.join(fidelity, "coverage.json"), "utf8"),
);
const missing = [],
  referenced = new Map();
for (const item of coverage.cases) {
  for (const field of ["reference", "measurements"])
    for (const relative of item[field] ?? []) {
      if (/^https?:/.test(relative)) continue;
      const file = path.resolve(fidelity, relative);
      if (!fs.existsSync(file))
        missing.push({ case: item.id, field, path: relative });
      else referenced.set(file, { case: item.id, field });
    }
}
if (missing.length) {
  console.error(
    JSON.stringify(
      { missingCount: missing.length, examples: missing.slice(0, 12) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
const directories = ["screenshots", "recordings"];
const raw = [];
for (const name of directories) {
  const start = path.join(work, name);
  if (!fs.existsSync(start)) continue;
  for (const dirent of fs.readdirSync(start, { withFileTypes: true })) {
    if (
      !dirent.isFile() ||
      ![".png", ".jpg", ".jpeg", ".mov", ".mp4"].includes(
        path.extname(dirent.name).toLowerCase(),
      )
    )
      continue;
    const file = path.join(start, dirent.name),
      stat = fs.statSync(file);
    const hash = createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    raw.push({
      path: path.relative(repository, file),
      bytes: stat.size,
      sha256: hash,
      inCoverage: referenced.has(file),
    });
  }
}
raw.sort((a, b) => a.path.localeCompare(b.path));
fs.mkdirSync(work, { recursive: true });
const manifest = path.join(work, "evidence-manifest.json");
fs.writeFileSync(
  manifest,
  JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      coverageCases: coverage.cases.length,
      coverageReferences: referenced.size,
      missing,
      raw,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    cases: coverage.cases.length,
    references: referenced.size,
    missing: missing.length,
    rawImages: raw.filter((item) => /\.(?:png|jpe?g)$/.test(item.path)).length,
    rawRecordings: raw.filter((item) => /\.(?:mov|mp4)$/.test(item.path))
      .length,
    manifest,
  }),
);
