import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import {
  bundleReportPath,
  webAbsentPackages,
  webChunkGroups,
  webDevDeny,
  devApiOrigin,
  devRequestCookies,
  devResponseCookie,
} from "../../vite.web.config.ts";
import webConfig from "../../vite.web.config.ts";

test("the development proxy rewrites only requests from its own loopback origin", () => {
  const target = "https://claudex.example";
  assert.equal(
    devApiOrigin(target, "http://127.0.0.1:5174", "127.0.0.1:5174"),
    target,
  );
  assert.equal(
    devApiOrigin(target, "http://localhost:5174", "localhost:5174"),
    target,
  );
  for (const [origin, host] of [
    ["https://other.example", "127.0.0.1:5174"],
    ["null", "127.0.0.1:5174"],
    ["http://remote.example:5174", "remote.example:5174"],
    ["http://localhost:5175", "localhost:5175"],
  ]) {
    assert.equal(devApiOrigin(target, origin, host), undefined);
  }
  assert.equal(
    devApiOrigin(
      "http://127.0.0.1:18080",
      "http://127.0.0.1:5174",
      "127.0.0.1:5174",
    ),
    undefined,
  );
});

interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

test("loopback refresh cookie translation preserves HttpOnly, scope, SameSite and opaque values", () => {
  const cookie =
    "__Secure-claudex_web_rt_7=opaque-value; Path=/api/v1/claudex/web/auth/; HttpOnly; Secure; SameSite=Strict";
  assert.equal(
    devResponseCookie(cookie),
    "claudex_dev_web_rt_7=opaque-value; Path=/api/v1/claudex/web/auth/; HttpOnly; SameSite=Strict",
  );
  assert.equal(
    devRequestCookies("other=kept; claudex_dev_web_rt_7=opaque-value"),
    "other=kept; __Secure-claudex_web_rt_7=opaque-value",
  );
  assert.equal(
    devResponseCookie("other=kept; Secure; HttpOnly"),
    "other=kept; Secure; HttpOnly",
  );
  assert.equal(
    devRequestCookies("other=claudex_dev_web_rt_7=inside-value"),
    "other=claudex_dev_web_rt_7=inside-value",
  );
});
interface ImportsModule {
  checkWebImports(options?: { entries?: string[]; root?: string }): {
    files: string[];
    violations: Violation[];
  };
  runtimeImports(
    fileName: string,
    text: string,
  ): { specifier: string; line: number }[];
  forbiddenPackage(specifier: string): string | null;
}
interface BundleResult {
  ok: boolean;
  errors: string[];
  js: { file: string; size: number; gzip: number }[];
  css: { file: string; size: number; gzip: number }[];
  jsGzip: number;
  cssGzip: number;
}
interface Report {
  version: number;
  entry: string;
  chunks: Record<
    string,
    {
      isEntry?: boolean;
      isDynamicEntry?: boolean;
      imports: string[];
      dynamicImports: string[];
      css: string[];
      modules: string[];
    }
  >;
}
interface BundleModule {
  budgets: { js: number; css: number };
  pageAssets(html: string): { scripts: string[]; styles: string[] };
  checkWebBundle(input: {
    html: string;
    report: Report;
    readFile(file: string): Uint8Array | undefined;
  }): BundleResult;
  checkWebBundleDir(outDir: string): BundleResult;
}

const root = path.resolve(".");
const load = async <T>(file: string) =>
  (await import(pathToFileURL(path.join(root, file)).href)) as T;
const imports = await load<ImportsModule>("scripts/check-web-imports.mjs");
const bundle = await load<BundleModule>("scripts/check-web-bundle.mjs");

// --- Source import graph ----------------------------------------------------

test("the web import graph from web.html has no Node or Electron code", () => {
  const { files, violations } = imports.checkWebImports();
  assert.deepEqual(violations, []);
  for (const file of [
    "src-web/main.tsx",
    "src-web/bridge/install.ts",
    "src/main.tsx",
    "src/app/App.tsx",
    "shared/host.ts",
  ])
    assert.ok(files.includes(file), `${file} is in the graph`);
  assert.ok(!files.some((file) => /^(electron|server)\//.test(file)));
});

test("runtimeImports keeps value imports and skips type-only ones", () => {
  const found = imports
    .runtimeImports(
      "x.tsx",
      [
        'import type { A } from "./types";',
        'import { type B, type C } from "./only-types";',
        'import { type D, e } from "./mixed";',
        'import f from "./default";',
        'import "./side-effect.css";',
        'export { g } from "./reexport";',
        'export type { H } from "./type-reexport";',
        'export * from "./star";',
        'const lazy = () => import("./lazy");',
        'const old = require("./required");',
        'import fs = require("fs");',
      ].join("\n"),
    )
    .map((entry) => entry.specifier);
  assert.deepEqual(found, [
    "./mixed",
    "./default",
    "./side-effect.css",
    "./reexport",
    "./star",
    "./lazy",
    "./required",
    "fs",
  ]);
});

test("forbiddenPackage names Electron and Node built-ins only", () => {
  assert.equal(imports.forbiddenPackage("electron"), "the electron package");
  assert.equal(
    imports.forbiddenPackage("electron/main"),
    "the electron package",
  );
  assert.equal(imports.forbiddenPackage("node:fs"), "a Node built-in");
  assert.equal(imports.forbiddenPackage("fs/promises"), "a Node built-in");
  assert.equal(imports.forbiddenPackage("child_process"), "a Node built-in");
  assert.equal(imports.forbiddenPackage("react"), null);
  assert.equal(imports.forbiddenPackage("@xterm/xterm"), null);
  assert.equal(imports.forbiddenPackage("virtual:preview-runtime/react"), null);
  assert.equal(imports.forbiddenPackage("electron-builder-like"), null);
});

test("checkWebImports reports Node-only files and built-ins through the graph", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claudex-web-imports-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    };
    write(
      "src-web/main.tsx",
      [
        'import type { Engine } from "../electron/engine/engine";',
        'import "./a";',
        'export const later = () => import("../src/lazy");',
      ].join("\n"),
    );
    write(
      "src-web/a.ts",
      'import { helper } from "../shared/helper";\nhelper;',
    );
    write(
      "shared/helper.ts",
      'import path from "node:path";\nexport const helper = path;',
    );
    write(
      "src/lazy.tsx",
      'import { app } from "electron";\nimport "../server/x";\nexport { app };',
    );
    write("electron/engine.ts", "export interface Engine {}");
    write("server/x.ts", "export {};");
    const { files, violations } = imports.checkWebImports({
      entries: [path.join(dir, "src-web/main.tsx")],
      root: dir,
    });
    assert.deepEqual(
      violations
        .map((v) => `${v.file}:${v.line} ${v.specifier} (${v.reason})`)
        .sort(),
      [
        "shared/helper.ts:1 node:path (a Node built-in)",
        "src/lazy.tsx:1 electron (the electron package)",
        "src/lazy.tsx:2 ../server/x (Node-only code (server/))",
      ].sort(),
    );
    // The type-only import is not followed.
    assert.ok(!files.includes("electron/engine.ts"));
    assert.ok(files.includes("src/lazy.tsx"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Bundle budget ----------------------------------------------------------

test("pageAssets reads the entry script, modulepreloads and stylesheets", () => {
  const assets = bundle.pageAssets(
    [
      '<script type="module" crossorigin src="/assets/index-1.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/react-2.js">',
      "<link rel='stylesheet' href='/assets/index-3.css'>",
      '<link rel="icon" href="/favicon.svg">',
    ].join("\n"),
  );
  assert.deepEqual(assets, {
    scripts: ["/assets/index-1.js", "/assets/react-2.js"],
    styles: ["/assets/index-3.css"],
  });
});

/** Incompressible bytes, so gzip size ≈ size. */
function noise(size: number, _seed = 1) {
  return new Uint8Array(randomBytes(size));
}

function fakeBuild(options: {
  entrySize?: number;
  cssSize?: number;
  lazyInFirstLoad?: boolean;
  electronLazy?: boolean;
}) {
  const files: Record<string, Uint8Array> = {
    "assets/index.js": noise(options.entrySize ?? 1000, 1),
    "assets/react.js": noise(1000, 2),
    "assets/shared.js": noise(1000, 3),
    "assets/mermaid.js": noise(700_000, 4),
    "assets/index.css": noise(options.cssSize ?? 1000, 5),
    "assets/shared.css": noise(500, 6),
  };
  const report: Report = {
    version: 1,
    entry: "index.html",
    chunks: {
      "assets/index.js": {
        isEntry: true,
        imports: ["assets/react.js"],
        dynamicImports: ["assets/mermaid.js"],
        css: ["assets/index.css"],
        modules: ["src/main.tsx", "src-web/main.tsx"],
      },
      "assets/react.js": {
        imports: ["assets/shared.js"],
        dynamicImports: [],
        css: [],
        modules: ["node_modules/react/index.js"],
      },
      "assets/shared.js": {
        imports: [],
        dynamicImports: [],
        css: ["assets/shared.css"],
        modules: [
          "src/ui/Controls.tsx",
          ...(options.lazyInFirstLoad
            ? ["node_modules/pdfjs-dist/build/pdf.mjs"]
            : []),
        ],
      },
      "assets/mermaid.js": {
        isDynamicEntry: true,
        imports: [],
        dynamicImports: [],
        css: [],
        modules: [
          "\\0virtual:preview-runtime/mermaid",
          ...(options.electronLazy ? ["electron/engine.ts"] : []),
        ],
      },
    },
  };
  const html = [
    '<script type="module" src="/assets/index.js"></script>',
    '<link rel="modulepreload" href="/assets/react.js">',
    '<link rel="stylesheet" href="/assets/index.css">',
  ].join("\n");
  return {
    html,
    report,
    readFile: (file: string) => files[file],
  };
}

test("a build within budget passes and counts only the first load", () => {
  const result = bundle.checkWebBundle(fakeBuild({}));
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
  assert.deepEqual(
    result.js.map((file) => file.file),
    ["assets/index.js", "assets/react.js", "assets/shared.js"],
  );
  // The stylesheet a statically imported chunk pulls in counts too.
  assert.deepEqual(
    result.css.map((file) => file.file),
    ["assets/index.css", "assets/shared.css"],
  );
  // mermaid (dynamic) is not in the first load.
  assert.ok(result.jsGzip < 10_000);
});

test("first-load JavaScript and CSS over budget fail", () => {
  const js = bundle.checkWebBundle(
    fakeBuild({ entrySize: bundle.budgets.js + 1000 }),
  );
  assert.equal(js.ok, false);
  assert.match(
    js.errors.join("\n"),
    /First-load JavaScript is .* over the 500\.00 kB budget/,
  );
  const css = bundle.checkWebBundle(
    fakeBuild({ cssSize: bundle.budgets.css + 1000 }),
  );
  assert.equal(css.ok, false);
  assert.match(
    css.errors.join("\n"),
    /First-load CSS is .* over the 100\.00 kB budget/,
  );
});

test("a lazy-only library in the first load fails", () => {
  const result = bundle.checkWebBundle(fakeBuild({ lazyInFirstLoad: true }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /pdf\.js is in the first load/);
});

test("Electron code anywhere in the bundle fails, lazy or not", () => {
  const result = bundle.checkWebBundle(fakeBuild({ electronLazy: true }));
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /Electron main-process code is in the web bundle \(electron\/engine\.ts/,
  );
});

test("missing files and a missing report are reported", () => {
  const fake = fakeBuild({});
  const result = bundle.checkWebBundle({
    ...fake,
    readFile: (file) =>
      file === "assets/react.js" ? undefined : fake.readFile(file),
  });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join("\n"),
    /assets\/react\.js is referenced but missing/,
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "claudex-web-bundle-"));
  try {
    const missing = bundle.checkWebBundleDir(path.join(dir, "dist-web"));
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /run `npm run build:web` first/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The real web build -------------------------------------------------------

test("chunk groups and absent packages match what they are meant to", () => {
  const group = (id: string) =>
    webChunkGroups.find((entry) => entry.test.test(id))?.name;
  assert.equal(group("/r/node_modules/react-dom/client.js"), "react");
  assert.equal(group("/r/node_modules/react/jsx-runtime.js"), "react");
  assert.equal(group("/r/node_modules/react-markdown/index.js"), "markdown");
  assert.equal(group("/r/node_modules/katex/dist/katex.mjs"), undefined);
  assert.equal(group("/r/node_modules/rehype-katex/lib/index.js"), undefined);
  // The highlighter loads with the code that needs it (ui/lazy-highlight.ts).
  assert.equal(
    group("/r/node_modules/rehype-highlight/lib/index.js"),
    undefined,
  );
  assert.equal(group("/r/node_modules/lowlight/lib/index.js"), undefined);
  assert.equal(group("/r/node_modules/highlight.js/lib/core.js"), undefined);
  assert.equal(group("/r/node_modules/mermaid/dist/mermaid.js"), undefined);
  assert.equal(group("/r/node_modules/pdfjs-dist/build/pdf.mjs"), undefined);
  assert.ok(webAbsentPackages.test("@xterm/xterm"));
  assert.ok(webAbsentPackages.test("@xterm/addon-fit"));
  assert.ok(!webAbsentPackages.test("xterm-like"));
  assert.equal(bundleReportPath("/x/dist-web"), "/x/dist-web.report.json");
});

test("the dev server keeps local secrets out and proxies the service", () => {
  // Vite's defaults stay, plus work/ (dev-stack credentials, service keys).
  for (const pattern of [".env", ".env.*", "*.{crt,pem}", "**/.git/**"])
    assert.ok(webDevDeny.includes(pattern), pattern);
  assert.ok(webDevDeny.includes("**/work/**"));
  const config = webConfig as {
    server?: { host?: string; fs?: { deny?: string[] }; proxy?: object };
  };
  assert.equal(config.server?.host, "127.0.0.1");
  assert.deepEqual(config.server?.fs?.deny, webDevDeny);
  const proxy = config.server?.proxy as Record<string, { ws?: boolean }>;
  // The events WebSocket and dictation's realtime WebSocket.
  assert.equal(proxy["/api"]?.ws, true);
  assert.equal(proxy["/v1"]?.ws, true);
  assert.ok(proxy["/s/"]);
});

test(
  "the web build emits index.html within the first-load budget",
  { timeout: 300_000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claudex-web-build-"));
    const outDir = path.join(dir, "dist-web");
    try {
      await build({
        configFile: path.join(root, "vite.web.config.ts"),
        configLoader: "runner",
        root,
        logLevel: "silent",
        build: { outDir, emptyOutDir: true },
      });
      assert.ok(existsSync(path.join(outDir, "index.html")));
      assert.ok(!existsSync(path.join(outDir, "web.html")));
      assert.ok(existsSync(bundleReportPath(outDir)));
      const html = readFileSync(path.join(outDir, "index.html"), "utf8");
      // Absolute asset URLs: the SPA answers deep links.
      assert.match(
        html,
        /<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js">/,
      );
      assert.doesNotMatch(html, /src-web\/main\.tsx/);

      const result = bundle.checkWebBundleDir(outDir);
      assert.deepEqual(result.errors, []);
      assert.ok(result.jsGzip <= bundle.budgets.js);
      assert.ok(
        result.jsGzip <= 483_000,
        "keep at least 15 kB of first-load headroom",
      );
      assert.ok(result.cssGzip <= bundle.budgets.css);

      const report = JSON.parse(
        readFileSync(bundleReportPath(outDir), "utf8"),
      ) as Report;
      const all = Object.values(report.chunks).flatMap(
        (chunk) => chunk.modules,
      );
      const firstLoad = result.js.flatMap(
        (file) => report.chunks[file.file].modules,
      );
      assert.ok(all.includes("src/settings/tabs/Privacy.tsx"));
      assert.ok(
        !firstLoad.includes("src/settings/tabs/Privacy.tsx"),
        "settings search reads Privacy labels without loading the page",
      );
      assert.ok(all.includes("src/settings/privacy-search.ts"));
      assert.ok(all.includes("src/ui/ItemView.tsx"));
      assert.ok(
        !firstLoad.includes("src/ui/ItemView.tsx"),
        "eager shell icons must not pull in the transcript through the components barrel",
      );
      for (const parser of [
        "react-markdown",
        "remark-gfm",
        "remark-cjk-friendly",
      ]) {
        const includesParser = (id: string) =>
          id.includes(`node_modules/${parser}/`);
        assert.ok(
          all.some(includesParser),
          `${parser} remains available lazily`,
        );
        assert.ok(
          !firstLoad.some(includesParser),
          `${parser} is not in the first load`,
        );
      }
      assert.ok(all.includes("src-web/main.tsx"));
      // The terminal library is replaced, not bundled.
      assert.ok(!all.some((id) => /node_modules\/@xterm\//.test(id)));
      // The lazy libraries are still there, as dynamic chunks.
      for (const runtime of ["mermaid", "pdf", "docx", "react"])
        assert.ok(
          all.includes(`\\0virtual:preview-runtime/${runtime}`),
          `${runtime} preview runtime is bundled`,
        );
      // The build constant for the web surface.
      const entry = Object.entries(report.chunks).find(
        ([, chunk]) => chunk.isEntry,
      )?.[0];
      assert.ok(entry);
      const code = readFileSync(path.join(outDir, entry), "utf8");
      assert.doesNotMatch(code, /__CLAUDEX_SURFACE__/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
