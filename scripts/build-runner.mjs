#!/usr/bin/env node
/**
 * Builds claudex-runner (web plan §8) into dist-runner/:
 *
 *   runner.mjs            the runner (runner/src/main.ts), "electron" mapped
 *                         to runner/src/electron-shim.ts, every dependency
 *                         bundled (Node 22+, ES module)
 *   provider-service.cjs  the desktop's provider service (the gateway child
 *                         each engine starts, outside the sandbox)
 *   sandbox-codex.mjs     the bubblewrap launcher program (runner/bin/sandbox-codex)
 *   sandbox-runsc.mjs     the gVisor launcher program (runner/bin/sandbox-runsc)
 *
 * The codex executable is not bundled: install @openai/codex (the version in
 * package.json) on the runner host and point CLAUDEX_RUNNER_CODEX at it.
 *
 *   node scripts/build-runner.mjs [--outdir <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--outdir");
const outdir = path.resolve(
  root,
  at >= 0 && args[at + 1] ? args[at + 1] : "dist-runner",
);
fs.mkdirSync(outdir, { recursive: true });

const shim = path.join(root, "runner/src/electron-shim.ts");
/** Maps every import of "electron" (static or dynamic) to the shim. */
const electronShim = {
  name: "electron-shim",
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: shim }));
  },
};
const esmBanner = {
  js: "import { createRequire as __runnerCreateRequire } from 'node:module'; const require = __runnerCreateRequire(import.meta.url);",
};
await build({
  absWorkingDir: root,
  entryPoints: ["server/connector-sse-mcp.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(outdir, "connector-sse-mcp.mjs"),
});

await build({
  absWorkingDir: root,
  entryPoints: ["runner/src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: esmBanner,
  outfile: path.join(outdir, "runner.mjs"),
  plugins: [electronShim],
  sourcemap: true,
  logLevel: "warning",
});

await build({
  absWorkingDir: root,
  entryPoints: ["server/provider-service.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(outdir, "provider-service.cjs"),
  logLevel: "warning",
});

// The launchers (bubblewrap and gVisor): runner/bin/<name> without its
// shebang, bundled.
for (const name of ["sandbox-codex", "sandbox-runsc"]) {
  const launcher = fs
    .readFileSync(path.join(root, "runner/bin", name), "utf8")
    .replace(/^#!.*\n/, "");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: launcher,
      resolveDir: path.join(root, "runner/bin"),
      sourcefile: name,
      loader: "js",
    },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    banner: { js: `#!/usr/bin/env node\n${esmBanner.js}` },
    outfile: path.join(outdir, `${name}.mjs`),
    logLevel: "warning",
  });
  fs.chmodSync(path.join(outdir, `${name}.mjs`), 0o755);
}

console.log(`claudex-runner built in ${path.relative(root, outdir) || "."}`);
