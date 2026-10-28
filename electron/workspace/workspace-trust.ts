/**
 * Codex's own workspace trust (shared/workspace-trust-api.ts), as the
 * desktop main process reads and records it.
 *
 * Codex 0.144.1 (checked against its app-server: `config/read` with a cwd
 * and `includeLayers`): a folder's `.codex/` layers load only when
 * `projects."<root>".trust_level = "trusted"` is in CODEX_HOME/config.toml,
 * else the layer carries "To load project-local config, hooks, and exec
 * policies, add <root> as a trusted project in …". `<root>` is the nearest
 * folder with `.git` (for a worktree, the main checkout its `commondir`
 * points to) or the folder itself; an entry for the folder inside a
 * repository, or for a parent of the root, does not count, and a `-c`
 * override does not either: only the config file does.
 */
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";

/** Codex's project root for a folder (where its trust is recorded). */
export function codexProjectRoot(folder: string): string {
  const start = path.resolve(folder);
  for (let dir = start; ;) {
    const marker = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(marker);
    } catch {}
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) return worktreeMainRoot(marker) ?? dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** A worktree's `.git` file → the main checkout (its common dir's parent). */
function worktreeMainRoot(gitFile: string) {
  try {
    const line = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitFile, "utf8"));
    if (!line) return undefined;
    const gitDir = path.resolve(path.dirname(gitFile), line[1].trim());
    const common = path.resolve(
      gitDir,
      fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
    );
    return path.basename(common) === ".git" ? path.dirname(common) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The folder's own Codex files that load only once it is trusted, from the
 * folder up to its root: config (model, sandbox, MCP servers), hooks and
 * exec policy rules.
 */
export function trustSources(folder: string, root: string): string[] {
  const sources: string[] = [];
  const top = path.resolve(root);
  for (let dir = path.resolve(folder); ;) {
    for (const name of ["config.toml", "hooks.json", "rules"]) {
      const file = path.join(dir, ".codex", name);
      if (fs.existsSync(file)) sources.push(file);
    }
    const parent = path.dirname(dir);
    if (dir === top || parent === dir || !isInside(dir, top)) break;
    dir = parent;
  }
  return sources;
}

function isInside(child: string, parent: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** The `projects` table of a Codex config file (empty when missing or unreadable). */
export function readCodexProjects(configFile: string): Record<string, any> {
  try {
    const parsed = TOML.parse(fs.readFileSync(configFile, "utf8")) as any;
    const projects = parsed?.projects;
    return projects && typeof projects === "object" && !Array.isArray(projects)
      ? { ...projects }
      : {};
  } catch {
    return {};
  }
}

/** The roots a projects table trusts, sorted. */
export function trustedRoots(projects: Record<string, any>): string[] {
  return Object.entries(projects)
    .filter(([, value]) => value?.trust_level === "trusted")
    .map(([root]) => root)
    .sort((a, b) => a.localeCompare(b));
}

/** The path Codex compares with: symbolic links resolved where possible. */
export function realFolder(folder: string) {
  try {
    return fs.realpathSync.native(path.resolve(folder));
  } catch {
    return path.resolve(folder);
  }
}

/**
 * What Codex's app-server needs to record trust while it runs (Engine):
 * `config/batchWrite` writes the file and reloads it into loaded threads.
 */
export interface CodexConfigWriter {
  /** CODEX_HOME on this computer. */
  readonly codexHome: string;
  /** Replaces the projects table; resolves false when Codex isn't running. */
  writeCodexProjects(projects: Record<string, unknown>): Promise<boolean>;
}

/**
 * Trusted folders of one CODEX_HOME. Writes go through the running Codex
 * when there is one (so it reloads them), else straight to its config file,
 * which the engine keeps when it rewrites the file at its next start.
 */
export class WorkspaceTrustStore {
  constructor(private readonly writer: () => CodexConfigWriter) {}
  private get configFile() {
    return path.join(this.writer().codexHome, "config.toml");
  }
  list(): string[] {
    return trustedRoots(readCodexProjects(this.configFile));
  }
  check(folder: string) {
    const real = realFolder(folder);
    const root = codexProjectRoot(real);
    const trusted = this.list().includes(root);
    return {
      folder,
      // The folder as asked when it is its own root (through a link too).
      root: root === real ? folder : root,
      trusted,
      sources: trusted ? [] : trustSources(real, root),
    };
  }
  async trust(folder: string) {
    const root = codexProjectRoot(realFolder(folder));
    const projects = readCodexProjects(this.configFile);
    projects[root] = { ...(projects[root] ?? {}), trust_level: "trusted" };
    await this.write(projects);
    return root;
  }
  async remove(root: string) {
    const projects = readCodexProjects(this.configFile);
    if (!(root in projects)) return;
    delete projects[root];
    await this.write(projects);
  }
  private async write(projects: Record<string, any>) {
    const writer = this.writer();
    if (await writer.writeCodexProjects(projects)) return;
    writeCodexProjectsFile(
      path.join(writer.codexHome, "config.toml"),
      projects,
    );
  }
}

/** Replaces the projects table of a Codex config file, keeping the rest. */
export function writeCodexProjectsFile(
  configFile: string,
  projects: Record<string, any>,
) {
  let config: Record<string, any> = {};
  try {
    config = TOML.parse(fs.readFileSync(configFile, "utf8")) as any;
  } catch {}
  if (Object.keys(projects).length) config.projects = projects;
  else delete config.projects;
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, TOML.stringify(config as any), { mode: 0o600 });
}

/**
 * The roots Codex asks to trust for a folder, read from its `config/read`
 * layers (the web runner's sandboxes trust their workspaces this way, in
 * Codex's own paths).
 */
export function untrustedRootsFromLayers(layers: unknown): string[] {
  if (!Array.isArray(layers)) return [];
  const roots = new Set<string>();
  for (const layer of layers) {
    if (layer?.name?.type !== "project") continue;
    const reason = layer?.disabledReason;
    if (typeof reason !== "string") continue;
    const match = /\badd (.+?) as a trusted project in /.exec(reason);
    if (match) roots.add(match[1]);
  }
  return [...roots];
}

/**
 * Trusted Codex projects on SSH hosts, kept on this computer. The SSH launcher
 * writes the host's config.toml at every start, so the host's `projects` table
 * is made from this file each time (Engine.start) and the trust survives
 * restarts.
 */
export class SshWorkspaceTrustStore {
  constructor(private readonly file: string) {}
  private read(): Record<string, string[]> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const hosts = parsed?.hosts;
      if (!hosts || typeof hosts !== "object" || Array.isArray(hosts))
        return {};
      const out: Record<string, string[]> = {};
      for (const [host, roots] of Object.entries(hosts))
        if (Array.isArray(roots))
          out[host] = roots.filter(
            (root): root is string =>
              typeof root === "string" && root.startsWith("/"),
          );
      return out;
    } catch {
      return {};
    }
  }
  private write(hosts: Record<string, string[]>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, hosts }), {
      mode: 0o600,
    });
  }
  /** The roots trusted on a host, sorted. */
  roots(hostId: string): string[] {
    return [...(this.read()[hostId] ?? [])].sort((a, b) => a.localeCompare(b));
  }
  /** The host's `projects` table for its config.toml. */
  projects(hostId: string): Record<string, { trust_level: "trusted" }> {
    return Object.fromEntries(
      this.roots(hostId).map((root) => [root, { trust_level: "trusted" }]),
    );
  }
  trust(hostId: string, root: string) {
    const hosts = this.read();
    const roots = hosts[hostId] ?? [];
    if (roots.includes(root)) return;
    hosts[hostId] = [...roots, root];
    this.write(hosts);
  }
  /** A removed SSH connection takes its trust with it. */
  forget(hostId: string) {
    const hosts = this.read();
    if (!(hostId in hosts)) return;
    delete hosts[hostId];
    this.write(hosts);
  }
}

/** Where an account keeps its SSH hosts' trust (its store root). */
export const sshWorkspaceTrustFile = (storeRoot: string) =>
  path.join(storeRoot, "ssh-workspace-trust.json");

/**
 * What `workspaceTrustScript` printed on the host: the folder's real path,
 * its Codex project root and the files that load once it is trusted.
 */
export function parseRemoteTrust(stdout: string) {
  let folder = "";
  let root = "";
  const sources: string[] = [];
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1);
    if (!value.startsWith("/")) continue;
    if (key === "folder") folder = value;
    else if (key === "root") root = value;
    else if (key === "source") sources.push(value);
  }
  if (!folder || !root) return undefined;
  return { folder, root, sources };
}
