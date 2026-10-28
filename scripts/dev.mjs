import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
import electron from "electron";
import "./build-quick-access.mjs";
import "./build-notification-authorization.mjs";
await build({
  entryPoints: ["server/mcp-stdio-wrapper.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/mcp-stdio-wrapper.cjs",
});
await build({
  entryPoints: ["server/connector-sse-mcp.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist-server/connector-sse-mcp.mjs",
});
await build({
  entryPoints: ["electron/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
  },
  outfile: "dist-electron/main.js",
  external: ["electron"],
});
await build({
  entryPoints: ["electron/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist-electron/preload.cjs",
  external: ["electron"],
});
// The extra pages' preloads (electron/extra-pages.ts).
for (const name of ["find-preload", "quick-preload", "design-pdf-preload"])
  await build({
    entryPoints: [`electron/${name}.ts`],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: `dist-electron/${name}.cjs`,
    external: ["electron"],
  });
const server = await createServer();
await server.listen();
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, CLAUDEX_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
