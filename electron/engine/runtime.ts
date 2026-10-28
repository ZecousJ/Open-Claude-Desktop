import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export function resolveRuntime(resourcesPath?: string) {
  const filename = process.platform === "win32" ? "codex.exe" : "codex";
  if (resourcesPath) {
    for (const parts of [
      ["codex", process.arch, "bin", filename],
      ["codex", "bin", filename],
      ["codex", filename],
    ]) {
      const p = path.join(resourcesPath, ...parts);
      if (fs.existsSync(p)) return p;
    }
  }
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
  };
  const platform = `${process.platform}-${process.arch}`;
  const target = targets[platform];
  const packages = [
    `@openai/codex-${process.platform === "win32" ? "win32" : process.platform}-${process.arch}`,
    "@openai/codex",
  ];
  for (const pkg of packages) {
    try {
      const base = path.dirname(require.resolve(pkg + "/package.json"));
      for (const directory of ["bin", "codex"]) {
        const p = path.join(base, "vendor", target, directory, filename);
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  throw new Error(
    "The bundled Codex engine is missing. Reinstall the app, or run npm install in a development checkout.",
  );
}
