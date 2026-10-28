import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin as EsbuildPlugin } from "esbuild";
import type { Plugin } from "vite";

/**
 * `virtual:preview-runtime/<name>` exports a library as script text, inlined
 * into sandboxed Artifact previews. The renderer imports these lazily, so
 * each runtime is a separate chunk loaded on first use.
 */
const prefix = "virtual:preview-runtime/";
// Absolute entries: the dev server watches them, and a relative path would be
// resolved as an import of the virtual module.
const entry = (name: string) =>
  fileURLToPath(new URL(`../src/artifacts/runtime/${name}`, import.meta.url));
const bundled: Record<string, { entry: string; globalName: string }> = {
  react: { entry: entry("react-runtime.ts"), globalName: "ClaudexReact" },
  pdf: { entry: entry("pdf-runtime.ts"), globalName: "ClaudexPdf" },
  office: { entry: entry("office-runtime.ts"), globalName: "ClaudexOffice" },
};
// Already self-contained browser builds (global `mermaid`, global `mammoth`).
const prebuilt: Record<string, string> = {
  mermaid: "mermaid/dist/mermaid.min.js",
  docx: "mammoth/mammoth.browser.min.js",
};
const require = createRequire(import.meta.url);

/**
 * `claudex:pdf-cmaps`: pdf.js's predefined Adobe CMaps (the CJK encodings,
 * about 1.6 MB packed), as base64 by file name. The sandboxed frame has no
 * network, so a PDF whose Chinese, Japanese or Korean text uses a font it
 * does not embed can only be read with these inlined.
 */
const pdfCmaps: EsbuildPlugin = {
  name: "claudex-pdf-cmaps",
  setup(builder) {
    builder.onResolve({ filter: /^claudex:pdf-cmaps$/ }, (args) => ({
      path: args.path,
      namespace: "claudex-pdf-cmaps",
    }));
    builder.onLoad({ filter: /.*/, namespace: "claudex-pdf-cmaps" }, () => {
      const folder = path.join(
        path.dirname(require.resolve("pdfjs-dist/package.json")),
        "cmaps",
      );
      const maps = Object.fromEntries(
        readdirSync(folder)
          .filter((name) => name.endsWith(".bcmap"))
          .sort()
          .map((name) => [
            name,
            readFileSync(path.join(folder, name)).toString("base64"),
          ]),
      );
      return {
        contents: `export default ${JSON.stringify(maps)};`,
        loader: "js",
      };
    });
  },
};

async function runtime(name: string) {
  if (name in prebuilt)
    return readFileSync(require.resolve(prebuilt[name]), "utf8");
  const { entry, globalName } = bundled[name];
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    globalName,
    target: "chrome130",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [pdfCmaps],
  });
  return result.outputFiles[0].text;
}

export function previewRuntimes(): Plugin {
  const cache = new Map<string, Promise<string>>();
  return {
    name: "claudex-preview-runtimes",
    resolveId(id) {
      if (id.startsWith(prefix)) return `\0${id}`;
    },
    async load(id) {
      if (!id.startsWith(`\0${prefix}`)) return;
      const name = id.slice(prefix.length + 1);
      if (!(name in bundled) && !(name in prebuilt))
        throw Error(`Unknown preview runtime: ${name}`);
      if (name in bundled) this.addWatchFile(bundled[name].entry);
      if (!cache.has(name)) cache.set(name, runtime(name));
      return `export default ${JSON.stringify(await cache.get(name))};`;
    },
    handleHotUpdate({ file }) {
      for (const [name, { entry }] of Object.entries(bundled))
        if (file.endsWith(entry)) cache.delete(name);
    },
  };
}
