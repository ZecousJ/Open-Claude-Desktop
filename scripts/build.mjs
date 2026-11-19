import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const edition = process.env.CLAUDEX_EDITION ?? "full";
if (edition !== "local" && edition !== "full") throw Error("CLAUDEX_EDITION must be local or full.");
await import("./build-quick-access.mjs");
await import("./build-notification-authorization.mjs");
const commitProperty = (format, fallback) => {
  try {
    return (
      execFileSync("git", ["log", "-1", `--format=${format}`], {
        encoding: "utf8",
      }).trim() || fallback
    );
  } catch {
    return fallback;
  }
};
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
  target: "node22",
  format: "esm",
  banner: {
    js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);",
  },
  outfile: "dist-electron/main.js",
  external: ["electron"],
  sourcemap: true,
  define: {
    __CLAUDEX_EDITION__: JSON.stringify(edition),
    __CLAUDEX_SELF_HOSTED_SERVICE_URL__: JSON.stringify(process.env.CLAUDEX_SUB2API_URL || "http://127.0.0.1:18080"),
    __CLAUDEX_BUILD_TIMESTAMP__: JSON.stringify(
      commitProperty("%cI", new Date().toISOString()),
    ),
    __CLAUDEX_COMMIT_HASH__: JSON.stringify(commitProperty("%H", "unknown")),
  },
});
await build({
  entryPoints: ["electron/preload.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-electron/preload.cjs",
  external: ["electron"],
});
// Static artifact previews use only their own narrow preload, never the official page shim.
await build({
  entryPoints: ["electron/official-ui/preview/static-preload.cjs"],
  bundle: true, platform: "node", target: "node22", format: "cjs",
  outfile: "dist-electron/static-artifact-preview-preload.cjs", external: ["electron"],
});
// The extra pages' own preloads (electron/extra-pages.ts): each exposes
// only its page's calls.
for (const name of [
  "find-preload",
  "quick-preload",
  "checkout-preload",
  "design-window-preload",
  "design-pdf-preload",
  "computer-use/teach-preload",
  "official-ui/legacy-draft-preload",
])
  await build({
    entryPoints: [`electron/${name}.ts`],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: `dist-electron/${path.basename(name)}.cjs`,
    external: ["electron"],
  });
await build({
  entryPoints: ["server/provider-service.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/provider-service.cjs",
});
await build({
  entryPoints: ["server/operator-report.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/operator-report.cjs",
});
await build({
  entryPoints: ["server/operator-limits-cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/operator-limits.cjs",
});
await build({
  entryPoints: ["server/operator-sub2api-cli.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/operator-sub2api.cjs",
});
// Round two. dist-server/ ships as resources/provider-service/, so these
// helpers sit beside the provider service in a packaged app.
// Computer use (R10): the stdio MCP server Codex starts.
await build({
  entryPoints: ["server/computer-use-mcp.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/computer-use-mcp.cjs",
});
// SSH environments (R9): the SSH_ASKPASS program ssh runs for prompts.
await build({
  entryPoints: ["electron/ssh/askpass-helper.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist-server/ssh-askpass.cjs",
});
// SSH environments (R9-S2): the pinned Codex runtimes a remote host may
// download, checked against package.json's @openai/codex version. The
// script arrives with R9-S2; until then there is nothing to check.
if (existsSync("scripts/codex-runtime-manifest.mjs"))
  await import(
    pathToFileURL(path.resolve("scripts/codex-runtime-manifest.mjs")).href
  );
