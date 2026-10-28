import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import {
  acceptsPluginArchive,
  pluginArchiveLimit,
  pluginArchiveRule,
  pluginManifestRule,
  type PluginUploadCommand,
  type PluginUploadResult,
} from "../../shared/plugin-upload";
import {
  pluginNamePattern,
  pluginRenameBusy,
} from "../../shared/duplicate-name";
import { duplicatePluginFiles, personalMarketplace } from "./plugin-copy";
import { skillName } from "../skills/skill-folder";
import type { PluginRpc } from "./plugins";

/** Archive upload. */
export class PluginUploads {
  private pending = new Set<Promise<PluginUploadResult>>();
  private closing = false;
  private sessions = new Map<
    string,
    { root: string; file: string; size: number; busy: boolean; expires: number }
  >();
  private installing = new Set<string>();

  constructor(private rpc: () => Promise<PluginRpc>) {}

  command(
    input: PluginUploadCommand,
    root: string,
    home: string,
  ): Promise<PluginUploadResult> {
    if (this.closing) return Promise.reject(Error("Upload failed"));
    const request = this.run(input, root, home);
    this.pending.add(request);
    void request.finally(() => this.pending.delete(request)).catch(() => {});
    return request;
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
    for (const session of this.sessions.values())
      fs.rmSync(path.dirname(session.file), { recursive: true, force: true });
    this.sessions.clear();
    this.closing = false;
  }

  private async run(
    input: PluginUploadCommand,
    root: string,
    home: string,
  ): Promise<PluginUploadResult> {
    for (const [id, session] of this.sessions) {
      if (session.expires < Date.now() && !session.busy) {
        this.sessions.delete(id);
        fs.rmSync(path.dirname(session.file), { recursive: true, force: true });
      }
    }
    if (input.action === "begin") {
      if (!acceptsPluginArchive({ name: input.name, size: 0 }))
        throw Error(pluginArchiveRule);
      if (
        [...this.sessions.values()].filter((session) => session.root === root)
          .length >= 20
      )
        throw Error("You can upload up to 20 plugin files at a time.");
      const id = randomUUID();
      const folder = path.join(root, "plugin-uploads", id);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, "archive.zip");
      fs.writeFileSync(file, "", { mode: 0o600 });
      this.sessions.set(id, {
        root,
        file,
        size: 0,
        busy: false,
        expires: Date.now() + 30 * 60_000,
      });
      return { id };
    }
    const session = this.sessions.get(input.id);
    if (!session || session.root !== root || session.busy)
      throw Error("Upload failed");
    session.expires = Date.now() + 30 * 60_000;
    const clear = () => {
      this.sessions.delete(input.id);
      fs.rmSync(path.dirname(session.file), { recursive: true, force: true });
    };
    if (input.action === "cancel") {
      clear();
      return { id: input.id };
    }
    if (input.action === "append") {
      const bytes = Buffer.from(input.data, "base64");
      if (session.size + bytes.length > pluginArchiveLimit) {
        clear();
        throw Error(pluginArchiveRule);
      }
      fs.appendFileSync(session.file, bytes);
      session.size += bytes.length;
      return { id: input.id };
    }
    session.busy = true;
    let lock: string | undefined;
    try {
      const folder = path.join(path.dirname(session.file), "contents");
      const manifest = await extractPluginArchive(
        fs.readFileSync(session.file),
        folder,
      );
      const places = personalMarketplace(home);
      const target = path.join(places.plugins, manifest.name);
      if (this.installing.has(target)) throw Error(pluginRenameBusy);
      lock = target;
      this.installing.add(lock);
      const rpc = await this.rpc();
      const listed = await rpc.call("plugin/list", { cwds: [home] });
      const candidates = (listed?.marketplaces ?? []).flatMap((market: any) =>
        (market.plugins ?? []).map((plugin: any) => ({ plugin, market })),
      );
      const matching = candidates.filter(
        (entry: any) => entry.plugin.name === manifest.name,
      );
      const existing =
        matching.find((entry: any) => entry.plugin.installed) ?? matching[0];
      if ((fs.existsSync(target) || existing) && !input.overwrite) {
        session.busy = false;
        return { id: input.id, conflict: manifest.name };
      }
      const backup = `${target}.${input.id}.backup`;
      const previous = fs.existsSync(places.file)
        ? fs.readFileSync(places.file, "utf8")
        : undefined;
      let written: ReturnType<typeof duplicatePluginFiles> | undefined;
      let uninstalled = false;
      try {
        if (input.overwrite && fs.existsSync(target))
          fs.renameSync(target, backup);
        if (input.overwrite && previous) {
          const market = JSON.parse(previous);
          market.plugins = market.plugins.filter(
            (plugin: any) => plugin.name !== manifest.name,
          );
          fs.writeFileSync(places.file, JSON.stringify(market));
        }
        written = duplicatePluginFiles(
          { folder },
          { name: manifest.name },
          home,
        );
        if (input.overwrite && existing?.plugin.installed) {
          await rpc.call("plugin/uninstall", { pluginId: existing.plugin.id });
          uninstalled = true;
        }
        const result = await rpc.call("plugin/install", {
          pluginName: manifest.name,
          marketplacePath: written.marketplacePath,
        });
        fs.rmSync(backup, { recursive: true, force: true });
        clear();
        return {
          id: input.id,
          pluginId: result?.id ?? `${manifest.name}@personal`,
        };
      } catch (error) {
        written?.undo();
        if (fs.existsSync(backup)) fs.renameSync(backup, target);
        if (previous !== undefined) fs.writeFileSync(places.file, previous);
        if (uninstalled)
          await rpc
            .call("plugin/install", {
              pluginName: existing.plugin.name,
              marketplacePath: existing.market.path,
            })
            .catch(() => {});
        throw error;
      }
    } catch (error) {
      clear();
      throw error;
    } finally {
      if (lock) this.installing.delete(lock);
    }
  }
}

export async function extractPluginArchive(
  bytes: Buffer,
  folder: string,
): Promise<{ name: string }> {
  if (bytes.length > pluginArchiveLimit) throw Error(pluginArchiveRule);
  const zip = await JSZip.loadAsync(bytes).catch(() => {
    throw Error("Invalid zip file");
  });
  const entries = Object.values(zip.files);
  if (entries.length > 5000) throw Error(pluginArchiveRule);
  for (const entry of entries) {
    const unsafe =
      (entry as typeof entry & { unsafeOriginalName?: string })
        .unsafeOriginalName ?? entry.name;
    if (
      unsafe.includes("\\") ||
      unsafe.startsWith("/") ||
      unsafe.split("/").some((part) => part === ".." || part.includes(":")) ||
      (((entry.unixPermissions as number) ?? 0) & 0o170000) === 0o120000
    )
      throw Error(pluginManifestRule);
  }
  const manifests = entries.filter((entry) =>
    /^(?:[^/]+\/)?\.claude-plugin\/plugin\.json$/.test(entry.name),
  );
  if (manifests.length > 1 || (!manifests.length && !zip.file("SKILL.md")))
    throw Error(pluginManifestRule);
  const manifestEntry = manifests[0];
  const prefix = manifestEntry
    ? manifestEntry.name.slice(0, -".claude-plugin/plugin.json".length)
    : "";
  let total = 0;
  fs.mkdirSync(folder, { recursive: true });
  for (const entry of entries) {
    if (entry.dir || !entry.name.startsWith(prefix)) continue;
    const relative = entry.name.slice(prefix.length);
    const content = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = entry.nodeStream() as Readable;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > pluginArchiveLimit)
          stream.destroy(Error(pluginArchiveRule));
        else chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  let manifest: Record<string, unknown>;
  try {
    if (manifestEntry)
      manifest = JSON.parse(
        fs.readFileSync(
          path.join(folder, ".claude-plugin/plugin.json"),
          "utf8",
        ),
      );
    else {
      const markdown = fs.readFileSync(path.join(folder, "SKILL.md"), "utf8");
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
      manifest = { name: skillName(markdown) };
      for (const component of ["skills", "commands", "hooks", "mcpServers"]) {
        const value = new RegExp(`^${component}:\\s*(.+)$`, "m")
          .exec(front)?.[1]
          ?.trim();
        if (value) {
          try {
            manifest[component] = JSON.parse(value);
          } catch {
            manifest[component] = value.replace(/^['"]|['"]$/g, "");
          }
        }
      }
      if (Object.keys(manifest).length === 1) throw Error(pluginManifestRule);
    }
  } catch {
    throw Error(pluginManifestRule);
  }
  if (
    !manifest ||
    typeof manifest.name !== "string" ||
    !pluginNamePattern.test(manifest.name)
  )
    throw Error(pluginManifestRule);
  for (const component of [
    "skills",
    "commands",
    "agents",
    "hooks",
    "mcpServers",
  ]) {
    const value = manifest[component];
    const paths =
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
    if (
      paths.some(
        (file) =>
          path.isAbsolute(file) ||
          file.includes("\\") ||
          file.includes(":") ||
          file.split("/").includes(".."),
      )
    )
      throw Error(pluginManifestRule);
  }
  const runtimeManifest = path.join(folder, ".codex-plugin/plugin.json");
  fs.mkdirSync(path.dirname(runtimeManifest), { recursive: true });
  fs.writeFileSync(runtimeManifest, JSON.stringify(manifest));
  return { name: manifest.name };
}
