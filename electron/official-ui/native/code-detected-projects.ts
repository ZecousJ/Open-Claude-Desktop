import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AdapterContext } from "../api/context";

const scanRoots = [
  "code",
  "Code",
  "projects",
  "Projects",
  "src",
  "dev",
  "Developer",
  "repos",
  "Repos",
  "workspace",
  "Workspace",
  "github",
  "GitHub",
  "git",
  "source/repos",
];
const projectMarkers = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Makefile",
  "CMakeLists.txt",
  "pom.xml",
  "build.gradle",
  ".project",
  "Gemfile",
  "mix.exs",
  "dune-project",
];
const vscodeEditors = [
  { source: "vscode", directory: "Code", sharedDirectory: ".vscode-shared" },
  { source: "cursor", directory: "Cursor", sharedDirectory: ".cursor-shared" },
] as const;
const editorProjectLimit = 50;
const databaseSizeLimit = 50 * 1024 * 1024;
const cacheLifetime = 30 * 60_000;
const recentFolder = z.object({ folderUri: z.string() });
const recentEntries = z
  .object({ entries: z.array(z.unknown()).nullish() })
  .nullish();

type DetectedProject = {
  path: string;
  name: string;
  source: (typeof vscodeEditors)[number]["source"] | "zed" | "scan";
  lastActivity: number;
};

function errorCode(error: unknown) {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeout: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Project detection read timed out.")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function limitedFileReads() {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active === 50)
      await new Promise<void>((resume) => waiting.push(resume));
    else active++;
    try {
      return await withTimeout(operation(), 2_000);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const pathSeparator = windows ? /[\\/]+/ : /\/+/;
const networkPath = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;
const devicePath = /^[\\/](?:global\?\?|dosdevices|device)[\\/]/i;
const macDataPrefix = /^\/System\/Volumes\/Data(?=\/|$)/i;
const localNamespace = (value: string) =>
  mac ? value.replace(macDataPrefix, "") || "/" : value;

function localPathResolver(home: string) {
  const homeNamespace = localNamespace(path.resolve(home));
  const automount = mac ? /^\/(?:net|home)(?:\/|$)/i : /^\/net(?:\/|$)/i;
  const canRead = (value: string) => {
    if (networkPath.test(value) || (windows && devicePath.test(value)))
      return false;
    const local = localNamespace(value);
    if (/^\/\.(vol|file)(?:\/|$)/i.test(local)) return false;
    return (
      !automount.test(local) ||
      local === homeNamespace ||
      homeNamespace.startsWith(local + path.sep) ||
      local.startsWith(homeNamespace + path.sep)
    );
  };
  return async (input: string) => {
    if (!path.isAbsolute(input) || !canRead(input)) return undefined;
    const absolute = path.resolve(input);
    let { root: current } = path.parse(absolute);
    let parts = absolute
      .slice(current.length)
      .split(pathSeparator)
      .filter(Boolean);
    let links = 0;
    // Check link destinations before stat can reach an automount or network path.
    while (parts.length > 0) {
      const [part, ...rest] = parts;
      parts = rest;
      const next = path.join(current, part);
      if (!canRead(next)) return undefined;
      if (!(await fs.lstat(next)).isSymbolicLink()) {
        current = next;
        continue;
      }
      if (++links > 40) return undefined;
      const target = await fs.readlink(next);
      if (!canRead(target)) return undefined;
      const { root } = path.parse(target);
      if (root)
        current = /^[\\/]+$/.test(root) ? path.parse(current).root : root;
      parts = target
        .slice(root.length)
        .split(pathSeparator)
        .filter(Boolean)
        .concat(parts);
    }
    const canonical = await fs.realpath(current);
    return canRead(canonical) ? canonical : undefined;
  };
}

async function withDatabaseSnapshot<T>(
  source: string,
  query: (db: DatabaseSync) => T,
) {
  if ((await fs.stat(source)).size > databaseSizeLimit) return undefined;
  const directory = await fs.mkdtemp(
    path.join(tmpdir(), "claudex-detected-projects-"),
  );
  try {
    const filename = path.join(directory, path.basename(source));
    await fs.copyFile(source, filename);
    await fs.chmod(filename, 0o600);
    const wal = await fs.lstat(`${source}-wal`).catch(() => undefined);
    if (wal?.isFile() && wal.size <= databaseSizeLimit) {
      await fs
        .copyFile(`${source}-wal`, `${filename}-wal`)
        .then(() => fs.chmod(`${filename}-wal`, 0o600))
        .catch(() => undefined);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      return query(db);
    } finally {
      db.close();
    }
  } finally {
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

async function detectProjects(home: string, log: AdapterContext["log"]) {
  const read = limitedFileReads();
  const realLocalPath = localPathResolver(home);
  const resolve = (value: string) =>
    read(() => realLocalPath(value)).catch(() => undefined);
  const stat = (value: string) =>
    read(() => fs.lstat(value)).catch(() => undefined);
  const directory = async (input: string) => {
    const canonical = await resolve(input);
    return canonical && (await stat(canonical))?.isDirectory()
      ? canonical
      : undefined;
  };
  const activity = async (cwd: string) => {
    const git = path.join(cwd, ".git");
    if ((await stat(git))?.isDirectory()) {
      const index = await stat(path.join(git, "index"));
      if (index) return index.mtimeMs;
    }
    const markers = await Promise.all(
      projectMarkers.map((name) => stat(path.join(cwd, name))),
    );
    return Math.max(0, ...markers.map((marker) => marker?.mtimeMs ?? 0));
  };
  const editorProjects = async (
    folders: string[],
    source: DetectedProject["source"],
  ) => {
    const projects = await Promise.all(
      folders.map(async (folder): Promise<DetectedProject | undefined> => {
        const canonical = await directory(folder);
        if (!canonical) return undefined;
        return {
          path: canonical,
          name: path.basename(canonical) || canonical,
          source,
          lastActivity: await activity(canonical),
        };
      }),
    );
    return projects.filter((project) => project !== undefined);
  };
  const query = async <T>(
    filename: string,
    select: (db: DatabaseSync) => T,
  ) => {
    const canonical = await resolve(filename);
    if (!canonical) return undefined;
    try {
      return await withTimeout(withDatabaseSnapshot(canonical, select), 5_000);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      return undefined;
    }
  };
  const applicationSupport = path.join(home, "Library", "Application Support");
  const readVscode = async ({
    source,
    directory,
    sharedDirectory,
  }: (typeof vscodeEditors)[number]) => {
    for (const filename of [
      path.join(home, sharedDirectory, "sharedStorage", "state.vscdb"),
      path.join(
        applicationSupport,
        directory,
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ]) {
      const row = await query(filename, (db) =>
        db
          .prepare(
            "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'",
          )
          .get(),
      );
      if (typeof row?.value !== "string" || !row.value.trim()) continue;
      const stored = recentEntries.parse(JSON.parse(row.value));
      const folders = (stored?.entries ?? [])
        .slice(0, editorProjectLimit)
        .flatMap((entry) => {
          const parsed = recentFolder.safeParse(entry);
          if (!parsed.success) return [];
          try {
            return [fileURLToPath(parsed.data.folderUri)];
          } catch {
            return [];
          }
        });
      return editorProjects(folders, source);
    }
    return [];
  };
  const readZed = async () => {
    const filename = path.join(
      applicationSupport,
      "Zed",
      "db",
      "0-stable",
      "db.sqlite",
    );
    const rows = await query(filename, (db) =>
      db
        .prepare(
          "SELECT paths FROM workspaces WHERE paths != '' ORDER BY timestamp DESC LIMIT ?",
        )
        .all(editorProjectLimit),
    );
    const folders = (rows ?? [])
      .flatMap(({ paths }) =>
        typeof paths === "string" ? paths.split("\n").filter(Boolean) : [],
      )
      .slice(0, editorProjectLimit);
    return editorProjects(folders, "zed");
  };
  const scanHome = async () => {
    const folders = await Promise.all(
      scanRoots.map((root) => directory(path.join(home, root))),
    );
    const roots = new Set(folders.filter((folder) => folder !== undefined));
    const results = await Promise.all(
      [...roots].map(async (root) => {
        const entries = await read(() => fs.readdir(root)).catch(() => []);
        const projects = await Promise.all(
          entries
            .filter((name) => !name.startsWith("."))
            .map(async (name): Promise<DetectedProject | undefined> => {
              const cwd = await directory(path.join(root, name));
              if (!cwd) return undefined;
              const lastActivity = await activity(cwd);
              if (lastActivity !== 0)
                return { path: cwd, name, source: "scan", lastActivity };
            }),
        );
        return projects.filter((project) => project !== undefined);
      }),
    );
    return results.flat();
  };

  const sources = [
    ...vscodeEditors.map((editor) => ({
      name: editor.source,
      result: readVscode(editor),
    })),
    { name: "zed", result: readZed() },
    { name: "scan", result: scanHome() },
  ];
  const results = await Promise.allSettled(sources.map(({ result }) => result));
  const projects = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    log(
      "[official-ui] project detection source failed",
      sources[index].name,
      errorCode(result.reason),
    );
    return [];
  });
  projects.sort((a, b) => b.lastActivity - a.lastActivity);
  const seen = new Set<string>();
  return projects.filter(({ path }) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

export function registerCodeDetectedProjects(
  host: {
    on(operation: string, handler: () => Promise<DetectedProject[]>): unknown;
    ctx: Pick<AdapterContext, "log">;
  },
  home: string,
) {
  let cached: DetectedProject[] | undefined;
  let updatedAt = 0;
  let pending: Promise<DetectedProject[]> | undefined;
  const refresh = () => {
    pending ??= detectProjects(home, host.ctx.log)
      .then((projects) => (cached = projects))
      .finally(() => {
        updatedAt = Date.now();
        pending = undefined;
      });
    return pending;
  };
  host.on("LocalSessions.getDetectedProjects", async () => {
    if (!cached) return refresh();
    if (Date.now() - updatedAt > cacheLifetime)
      void refresh().catch(() => undefined);
    return cached;
  });
  return (folder: string) => cached?.some(({ path }) => path === folder) === true;
}
