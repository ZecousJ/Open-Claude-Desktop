/**
 * Detect dev server (R8-B): reads a folder's project files and proposes
 * launch.json configurations. It only reads; the drafts fill the Add server
 * dialog and nothing is written or started until the person saves.
 *
 * - package.json scripts, preferring dev, then start, serve and preview; the
 *   package manager follows the lock file; the port comes from the script
 *   (--port, -p, PORT=) or the framework's default.
 * - Django (manage.py) and Flask (app.py / wsgi.py importing flask).
 * - The folder itself and its direct subfolders (and apps/*, packages/*),
 *   for repositories that keep the site in "web" or "frontend".
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { LaunchConfiguration } from "../../shared/browser";

/** Framework markers in dependencies and scripts, with their default ports. */
const frameworks: { name: string; match: RegExp; port: number }[] = [
  { name: "Next.js", match: /\bnext\b/, port: 3000 },
  { name: "Nuxt", match: /\bnuxi?\b/, port: 3000 },
  { name: "Remix", match: /\bremix\b/, port: 3000 },
  { name: "Astro", match: /\bastro\b/, port: 4321 },
  { name: "SvelteKit", match: /@sveltejs\/kit|\bsvelte-kit\b/, port: 5173 },
  { name: "Angular", match: /@angular\/cli|\bng serve\b/, port: 4200 },
  { name: "Create React App", match: /\breact-scripts\b/, port: 3000 },
  { name: "Gatsby", match: /\bgatsby\b/, port: 8000 },
  { name: "Docusaurus", match: /@docusaurus\/core|\bdocusaurus\b/, port: 3000 },
  { name: "Storybook", match: /\bstorybook\b/, port: 6006 },
  { name: "Vite", match: /\bvite\b/, port: 5173 },
  { name: "Parcel", match: /\bparcel\b/, port: 1234 },
  {
    name: "webpack",
    match: /webpack-dev-server|\bwebpack serve\b/,
    port: 8080,
  },
  { name: "Eleventy", match: /@11ty\/eleventy|\beleventy\b/, port: 8080 },
];

const scriptOrder = ["dev", "start", "serve", "preview"] as const;

const skipFolders = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "vendor",
  "target",
  ".venv",
  "venv",
]);

export interface DetectOptions {
  /** How many folders below the root to look at (default 24). */
  maxFolders?: number;
  platform?: NodeJS.Platform;
}

async function readText(file: string, max = 512 * 1024) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > max) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** pnpm, yarn, bun or npm, from the lock file here or in a parent up to the root. */
async function packageManager(folder: string, root: string) {
  let current = folder;
  for (;;) {
    if (await exists(path.join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (await exists(path.join(current, "yarn.lock"))) return "yarn";
    if (
      (await exists(path.join(current, "bun.lockb"))) ||
      (await exists(path.join(current, "bun.lock")))
    )
      return "bun";
    if (await exists(path.join(current, "package-lock.json"))) return "npm";
    if (current === root) return "npm";
    const parent = path.dirname(current);
    if (parent === current || !parent.startsWith(root)) return "npm";
    current = parent;
  }
}

/** The port a script line asks for: --port 4000, --port=4000, -p 4000, PORT=4000. */
export function portInScript(script: string): number | undefined {
  const patterns = [
    /--port[=\s]+(\d{2,5})\b/,
    /(?:^|\s)-p[=\s]*(\d{2,5})\b/,
    /\bPORT=(\d{2,5})\b/,
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (match) {
      const port = Number(match[1]);
      if (port >= 1 && port <= 65_535) return port;
    }
  }
  return undefined;
}

/** The framework whose default port applies to a script, from the script and the dependencies. */
export function frameworkFor(script: string, dependencies: string[]) {
  const inScript = frameworks.find((framework) => framework.match.test(script));
  if (inScript) return inScript;
  const joined = dependencies.join(" ");
  return frameworks.find((framework) => framework.match.test(joined));
}

function runArgs(manager: string, script: string) {
  // "yarn dev" and "bun run dev" as their users write them; the rest "run".
  if (manager === "yarn") return [script];
  return ["run", script];
}

async function detectNode(
  folder: string,
  root: string,
): Promise<LaunchConfiguration | undefined> {
  const text = await readText(path.join(folder, "package.json"));
  if (!text) return undefined;
  let data: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    name?: unknown;
  };
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const scripts = data.scripts ?? {};
  const scriptName = scriptOrder.find(
    (name) => typeof scripts[name] === "string" && scripts[name],
  );
  if (!scriptName) return undefined;
  const script = String(scripts[scriptName]);
  // A start script that only runs a built server or tsc is not a dev server unless a framework is known.
  const dependencies = [
    ...Object.keys(data.dependencies ?? {}),
    ...Object.keys(data.devDependencies ?? {}),
  ];
  const framework = frameworkFor(script, dependencies);
  const port = portInScript(script) ?? framework?.port;
  if (!port) return undefined;
  const manager = await packageManager(folder, root);
  const config: LaunchConfiguration = {
    name: "",
    runtimeExecutable: manager,
    runtimeArgs: runArgs(manager, scriptName),
    port,
  };
  return config;
}

async function detectPython(
  folder: string,
  platform: NodeJS.Platform,
): Promise<LaunchConfiguration | undefined> {
  const python = platform === "win32" ? "python" : "python3";
  if (await exists(path.join(folder, "manage.py")))
    return {
      name: "",
      runtimeExecutable: python,
      runtimeArgs: ["manage.py", "runserver", "8000"],
      port: 8000,
    };
  for (const file of ["app.py", "wsgi.py"]) {
    const text = await readText(path.join(folder, file), 256 * 1024);
    if (text && /^\s*(?:from\s+flask\s+import|import\s+flask)\b/m.test(text))
      return {
        name: "",
        runtimeExecutable: python,
        runtimeArgs: [
          "-m",
          "flask",
          "--app",
          file.replace(/\.py$/, ""),
          "run",
          "--port",
          "5000",
        ],
        port: 5000,
      };
  }
  return undefined;
}

/** The folders to look at: the root, then its direct subfolders and apps/*, packages/*. */
async function candidateFolders(root: string, max: number) {
  const folders = [root];
  const list = async (dir: string) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !skipFolders.has(entry.name),
        )
        .map((entry) => path.join(dir, entry.name))
        .sort();
    } catch {
      return [];
    }
  };
  const first = await list(root);
  for (const dir of first) {
    if (folders.length > max) break;
    folders.push(dir);
  }
  for (const group of ["apps", "packages", "sites"]) {
    const dir = path.join(root, group);
    if (!first.includes(dir)) continue;
    for (const child of await list(dir)) {
      if (folders.length > max) break;
      folders.push(child);
    }
  }
  return folders;
}

function draftName(relative: string, used: Set<string>) {
  const base = relative === "." ? "dev" : relative.replace(/\\/g, "/");
  let name = base.slice(0, 60);
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 56)} ${n++}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Draft configurations for the dev servers found in `root`: one per folder
 * with a dev script (or Django/Flask app), named "dev" for the root and by
 * the folder otherwise. Ports shared by two drafts are kept as found; the
 * person edits them before saving.
 */
export async function detectDevServers(
  root: string,
  options: DetectOptions = {},
): Promise<LaunchConfiguration[]> {
  const platform = options.platform ?? process.platform;
  const folders = await candidateFolders(root, options.maxFolders ?? 24);
  const used = new Set<string>();
  const drafts: LaunchConfiguration[] = [];
  for (const folder of folders) {
    const found =
      (await detectNode(folder, root)) ??
      (await detectPython(folder, platform));
    if (!found) continue;
    const relative = path.relative(root, folder) || ".";
    const draft: LaunchConfiguration = {
      ...found,
      name: draftName(relative, used),
    };
    if (relative !== ".") draft.cwd = relative.replace(/\\/g, "/");
    drafts.push(draft);
  }
  return drafts;
}
