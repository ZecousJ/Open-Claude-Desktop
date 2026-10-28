#!/usr/bin/env node
/**
 * The web build's first-load budget (web plan §2, W-ARCH "W-V").
 *
 * The first load is what a browser fetches before the app can start: the
 * scripts and stylesheets `index.html` names (entry script, modulepreload
 * links, stylesheets), plus every chunk those scripts import statically,
 * and the stylesheets those chunks pull in. Dynamic imports are not part of
 * it. Checks:
 *
 * - first-load JavaScript ≤ 500 kB gzip, CSS ≤ 100 kB gzip;
 * - no lazily loaded library in the first load: mermaid, highlight.js, pdf.js, mammoth
 *   (docx), xterm, sucrase, and the Artifact preview runtimes
 *   (`virtual:preview-runtime/*`);
 * - no Node or Electron code anywhere in the bundle (electron/, server/,
 *   runner/, the `electron` package, Vite's stand-in for Node built-ins).
 *
 * Reads `dist-web/index.html`, the files it references and the bundle
 * report vite.web.config.ts writes next to the output folder
 * (`dist-web.report.json`). Usage: `node scripts/check-web-bundle.mjs
 * [outDir]` after `vite build -c vite.web.config.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const budgets = Object.freeze({
  /** First-load JavaScript, gzip bytes (kB as Vite reports them). */
  js: 500_000,
  /** First-load CSS, gzip bytes. */
  css: 100_000,
});

/** Modules that must only arrive through a dynamic import. */
export const lazyOnly = Object.freeze([
  {
    name: "CodeMirror/Lezer file editor",
    test: /(^|\/)node_modules\/@(?:codemirror|lezer)\//,
  },
  { name: "mermaid", test: /(^|\/)node_modules\/mermaid\// },
  { name: "highlight.js", test: /(^|\/)node_modules\/highlight\.js\// },
  { name: "pdf.js", test: /(^|\/)node_modules\/pdfjs-dist\// },
  { name: "mammoth (docx)", test: /(^|\/)node_modules\/mammoth\// },
  { name: "xterm", test: /(^|\/)node_modules\/@xterm\/.*\.m?js$/ },
  { name: "sucrase", test: /(^|\/)node_modules\/sucrase\// },
  { name: "preview runtime", test: /virtual:preview-runtime\// },
]);

/** Modules that must never be in the web bundle. */
export const neverBundled = Object.freeze([
  { name: "Electron main-process code", test: /^electron\// },
  { name: "Node server code", test: /^(server|runner)\// },
  { name: "the electron package", test: /(^|\/)node_modules\/electron\// },
  { name: "a Node built-in", test: /__vite-browser-external|^node:/ },
]);

/** The script, modulepreload and stylesheet URLs a page references. */
export function pageAssets(html) {
  const scripts = [];
  const styles = [];
  for (const [tag] of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attr = (name) =>
      tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
    if (/^<script/i.test(tag)) {
      const src = attr("src");
      if (src) scripts.push(src);
      continue;
    }
    const rel = (attr("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attr("href");
    if (!href) continue;
    if (rel.includes("modulepreload")) scripts.push(href);
    else if (rel.includes("stylesheet")) styles.push(href);
  }
  return { scripts, styles };
}

/** An absolute page URL ("/assets/x.js") as an output file name. */
function fileNameOf(url) {
  if (/^[a-z]+:|^\/\//i.test(url)) return null; // another origin
  return url.replace(/^\.?\//, "").split(/[?#]/)[0];
}

function kb(bytes) {
  return `${(bytes / 1000).toFixed(2)} kB`;
}

/**
 * Checks one build. `readFile(fileName)` returns an output file's bytes, or
 * undefined when it does not exist.
 */
export function checkWebBundle({ html, report, readFile }) {
  const errors = [];
  const chunks = report?.chunks ?? {};
  const page = pageAssets(html);

  // The first-load closure over static imports.
  const js = new Set();
  const css = new Set();
  const pending = [];
  for (const url of page.scripts) {
    const name = fileNameOf(url);
    if (name === null) {
      errors.push(`index.html loads a script from another origin: ${url}`);
      continue;
    }
    pending.push(name);
  }
  for (const url of page.styles) {
    const name = fileNameOf(url);
    if (name === null) {
      errors.push(`index.html loads a stylesheet from another origin: ${url}`);
      continue;
    }
    css.add(name);
  }
  if (page.scripts.length === 0) errors.push("index.html loads no script.");
  while (pending.length) {
    const name = pending.pop();
    if (js.has(name)) continue;
    js.add(name);
    const chunk = chunks[name];
    if (!chunk) {
      errors.push(`${name} is not in the bundle report (stale report?).`);
      continue;
    }
    for (const next of chunk.imports ?? []) pending.push(next);
    for (const sheet of chunk.css ?? []) css.add(sheet);
  }

  const measure = (names) =>
    [...names].sort().map((file) => {
      const bytes = readFile(file);
      if (bytes === undefined) {
        errors.push(`${file} is referenced but missing from the output.`);
        return { file, size: 0, gzip: 0 };
      }
      return { file, size: bytes.length, gzip: gzipSync(bytes).length };
    });
  const jsFiles = measure(js);
  const cssFiles = measure(css);
  const jsGzip = jsFiles.reduce((sum, file) => sum + file.gzip, 0);
  const cssGzip = cssFiles.reduce((sum, file) => sum + file.gzip, 0);
  if (jsGzip > budgets.js)
    errors.push(
      `First-load JavaScript is ${kb(jsGzip)} gzip, over the ${kb(budgets.js)} budget. Load the heavy page or library with a dynamic import.`,
    );
  if (cssGzip > budgets.css)
    errors.push(
      `First-load CSS is ${kb(cssGzip)} gzip, over the ${kb(budgets.css)} budget.`,
    );

  for (const name of js) {
    for (const id of chunks[name]?.modules ?? []) {
      const rule = lazyOnly.find((entry) => entry.test.test(id));
      if (rule)
        errors.push(
          `${rule.name} is in the first load (${id} in ${name}); import it dynamically.`,
        );
    }
  }
  for (const [name, chunk] of Object.entries(chunks)) {
    for (const id of chunk.modules ?? []) {
      const rule = neverBundled.find((entry) => entry.test.test(id));
      if (rule)
        errors.push(`${rule.name} is in the web bundle (${id} in ${name}).`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    js: jsFiles,
    css: cssFiles,
    jsGzip,
    cssGzip,
  };
}

/** Reads an output folder and its report, then checks it. */
export function checkWebBundleDir(outDir) {
  const root = path.resolve(outDir);
  const reportPath = `${root}.report.json`;
  const htmlPath = path.join(root, "index.html");
  for (const file of [htmlPath, reportPath])
    if (!existsSync(file))
      return {
        ok: false,
        errors: [
          `${path.relative(process.cwd(), file)} is missing: run \`npm run build:web\` first.`,
        ],
        js: [],
        css: [],
        jsGzip: 0,
        cssGzip: 0,
      };
  return checkWebBundle({
    html: readFileSync(htmlPath, "utf8"),
    report: JSON.parse(readFileSync(reportPath, "utf8")),
    readFile: (file) => {
      const full = path.join(root, file);
      if (!full.startsWith(root + path.sep) || !existsSync(full))
        return undefined;
      return readFileSync(full);
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? "dist-web";
  const result = checkWebBundleDir(outDir);
  for (const file of [...result.js, ...result.css])
    console.log(`  ${file.file.padEnd(48)} ${kb(file.gzip).padStart(11)} gzip`);
  console.log(
    `First load: JavaScript ${kb(result.jsGzip)} / ${kb(budgets.js)}, CSS ${kb(result.cssGzip)} / ${kb(budgets.css)} (gzip).`,
  );
  if (!result.ok) {
    for (const error of result.errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log("✓ Web bundle within budget.");
}
