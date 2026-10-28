import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
const output = ".mobile-conversation-tests/effects.mjs";
mkdirSync(".mobile-conversation-tests", { recursive: true });
try {
  await build({
    entryPoints: ["tests/mobile-conversation-effects.test.tsx"],
    outfile: output,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    loader: { ".css": "empty" },
    jsx: "automatic",
  });
  const run = spawnSync(process.execPath, ["--test", output], {
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(".mobile-conversation-tests", { recursive: true, force: true });
}
