/** Capture the public official user-content renderer without rewriting its assets. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const root = path.resolve(process.argv[2] ?? "build/official-usercontent");
const origin = "https://www.claudeusercontent.com";
const documentUrl =
  origin +
  "/?domain=claude.ai&parentOrigin=https%3A%2F%2Fclaude.ai&formattedSpreadsheets=true&contentType=text%2Fhtml";
await fs.mkdir(root, { recursive: true });
const pending = new Set(["/"]);
const done = new Map();
const unavailable = new Map();
const pattern = new RegExp(
  "(?:_next/)?static/(?:chunks|media)/[A-Za-z0-9_.~-]+[.](?:js|css|woff2?|wasm)",
  "g",
);
while (pending.size) {
  const batch = [...pending].slice(0, 6);
  batch.forEach((p) => pending.delete(p));
  const fetched = await Promise.all(
    batch.map(async (p) => {
      const relative = p === "/" ? "index.html" : p.slice(1);
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        if (p === "/" || !(await fs.stat(file).catch(() => null))?.size)
          await exec("curl", [
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "2",
            "--max-time",
            "45",
            p === "/" ? documentUrl : origin + p,
            "-o",
            file,
          ]);
      } catch (error) {
        if (p === "/" || !String(error.stderr).includes("404")) throw error;
        return { p, relative, error: "Official origin returned 404" };
      }
      const data = await fs.readFile(file);
      return { p, relative, data };
    }),
  );
  for (const { p, relative, data, error } of fetched) {
    if (error) {
      unavailable.set(p, error);
      continue;
    }
    done.set(p, {
      path: p,
      file: relative,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    if (/\.(?:js|css)$/.test(p) || p === "/")
      for (const m of data.toString().matchAll(pattern)) {
        const ref = "/" + (m[0].startsWith("_next/") ? m[0] : "_next/" + m[0]);
        if (
          !done.has(ref) &&
          !unavailable.has(ref) &&
          !fetched.some((f) => f.p === ref)
        )
          pending.add(ref);
      }
  }
  if (done.size > 1000) throw Error("Unexpected resource graph size");
  console.log(JSON.stringify({ captured: done.size, pending: pending.size }));
}
await fs.writeFile(
  path.join(root, "manifest.json"),
  JSON.stringify(
    {
      origin,
      documentUrl,
      capturedAt: new Date().toISOString(),
      assets: [...done.values()].sort((a, b) => a.path.localeCompare(b.path)),
      unavailable: [...unavailable].map(([path, reason]) => ({ path, reason })),
    },
    null,
    2,
  ),
);
// PDF/Office previews load runtime files outside Next's chunk graph.
await exec(process.execPath,[path.resolve('scripts/capture-official-pdf-resources.mjs'),root],{maxBuffer:2_000_000});
