import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareDesktopExtensionEntry } from "./extension-lifecycle";
import { unzipSkill } from "../skills/skill-folder";
import { officialExtensionId, type ExtensionSource } from "./extension-identity";
import { reservedMcpServerName } from "./mcp-config-file";

export const developerModeFolderBlocked =
  "Your organization has turned off Developer Mode, so extensions can’t be installed from a folder.";

export const extensionOpenFailed =
  "Couldn’t open the extension file. Try again.";

export function unpackExtensionArchive(data: Buffer, root: string) {
  const source = fs.mkdtempSync(path.join(root, "extension-import-"));
  try {
    const modes = new Map<string, number>();
    const files = unzipSkill(data, {
      files: 10000,
      bytes: 100 * 1024 * 1024,
      message: extensionOpenFailed,
    }, (name, mode) => modes.set(name, mode));
    let bytes = 0;
    for (const [relative, content] of files) {
      bytes += content.length;
      if (bytes > 100 * 1024 * 1024) throw new Error(extensionOpenFailed);
      const destination = path.join(source, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, { mode: ((modes.get(relative) ?? 0) & 0o111) ? 0o700 : 0o600 });
    }
    unpackedExtensionEntry(source);
    return source;
  } catch {
    fs.rmSync(source, { recursive: true, force: true });
    throw new Error(extensionOpenFailed);
  }
}

export function unpackedExtensionEntry(folder: string, serverName?: string) {
  if (serverName === undefined) {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
    if (typeof manifest?.name !== "string" || !manifest.name) throw Error(extensionOpenFailed);
    const rawName: string = manifest.name;
    serverName = /^[a-zA-Z0-9_-]{1,64}$/.test(rawName)
      ? rawName
      : rawName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 55) || "extension";
    if (reservedMcpServerName(serverName)) serverName = `extension_${serverName}`.slice(0, 64);
  }
  return prepareDesktopExtensionEntry(folder, serverName);
}

// (live claude.ai bundle, 2026-10-14, index.chunk-BWk6pVUt)
export function installUnpackedExtension(options: {
  source: string;
  root: string;
  allowed: () => boolean;
  current: Record<string, unknown>;
  update: (servers: Record<string, unknown>) => void;
  sourceKind?: ExtensionSource;
  uvExecutable?: string;
  prepareUpgrade?: (
    id: string,
    manifest: Record<string, unknown>,
    target: string,
  ) => {
    enabled: boolean;
    settings?: string | true;
    rollback(): void;
    retire(): void;
  };
  retirePrevious?: (serverName: string, previousPath: string) => boolean;
}) {
  if (!options.allowed()) throw new Error(developerModeFolderBlocked);
  const source = fs.realpathSync(options.source);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  if (typeof sourceManifest?.name !== "string" || !sourceManifest.name) throw Error(extensionOpenFailed);
  if (sourceManifest.server?.type === "uv" && !options.uvExecutable) throw Error(extensionOpenFailed);
  let serverName = sourceManifest.name;
  const officialId = options.sourceKind ? officialExtensionId(sourceManifest, options.sourceKind) : undefined;
  if (officialId) {
    const matches = Object.entries(options.current).filter(([, raw]) =>
      !!raw && typeof raw === "object" && (raw as Record<string, unknown>).claudex_extension_id === officialId,
    );
    if (matches.length > 1) throw Error(extensionOpenFailed);
    const legacy = options.current[serverName] as Record<string, unknown> | undefined;
    if (!matches.length && legacy && typeof legacy.claudex_extension === "string" && !legacy.claudex_extension_id) {
      const previous = JSON.parse(fs.readFileSync(path.join(legacy.claudex_extension, "manifest.json"), "utf8"));
      if (previous.name === sourceManifest.name && (previous.author?.name ?? "") === (sourceManifest.author?.name ?? ""))
        matches.push([serverName, legacy]);
    }
    if (matches.length) serverName = matches[0][0];
    else {
      const candidate = /^[a-zA-Z0-9_-]{1,64}$/.test(serverName) ? serverName :
        serverName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 55) || "extension";
      serverName = candidate;
      for (let index = 2; Object.hasOwn(options.current, serverName) || reservedMcpServerName(serverName); index++)
        serverName = `${candidate.slice(0, 55)}_${index}`;
    }
  }
  unpackedExtensionEntry(source, serverName);
  let count = 0;
  let bytes = 0;
  const inspect = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Couldn’t install the extension. Try again.");
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) inspect(full);
      else {
        count++;
        bytes += fs.statSync(full).size;
        if (count > 10000 || bytes > 100 * 1024 * 1024)
          throw new Error("Couldn’t install the extension. Try again.");
      }
    }
  };
  inspect(source);
  const target = path.join(options.root, "desktop-extensions", randomUUID());
  let migration:
    ReturnType<NonNullable<typeof options.prepareUpgrade>> | undefined;
  let previousDirectory: string | undefined;
  let previousReference: string | undefined;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: false });
    inspect(target);
    const staged = unpackedExtensionEntry(target, serverName);
    let name = staged.name;
    let entry: Record<string, unknown> = staged.entry;
    const previous = options.current[name];
    if (previous !== undefined) {
      if (!previous || typeof previous !== "object" || Array.isArray(previous))
        throw new Error(extensionOpenFailed);
      const old = previous as Record<string, unknown>;
      if (typeof old.claudex_extension !== "string")
        throw new Error(extensionOpenFailed);
      const base = fs.realpathSync(
        path.join(options.root, "desktop-extensions"),
      );
      const installed = fs.realpathSync(old.claudex_extension);
      if (
        path.dirname(installed) !== base ||
        !/^[a-f0-9-]{36}$/.test(path.basename(installed))
      )
        throw new Error(extensionOpenFailed);
      const oldManifest = JSON.parse(
        fs.readFileSync(path.join(installed, "manifest.json"), "utf8"),
      );
      const newManifest = JSON.parse(
        fs.readFileSync(path.join(target, "manifest.json"), "utf8"),
      );
      if (oldManifest.name !== sourceManifest.name) throw new Error(extensionOpenFailed);
      previousDirectory = installed;
      previousReference = old.claudex_extension;
      if (options.prepareUpgrade) migration = options.prepareUpgrade(name, newManifest, target);
      else if (old.claudex_extension_settings !== undefined || Object.keys(newManifest.user_config ?? {}).length)
        throw new Error(extensionOpenFailed);
      entry = { ...old, ...entry, enabled: migration?.enabled ?? (old.enabled !== false) };
      delete entry.claudex_extension_settings;
      if (migration?.settings !== undefined) entry.claudex_extension_settings = migration.settings;
    }
    if (officialId) {
      entry.claudex_extension_id = officialId;
      entry.claudex_extension_manifest_name = sourceManifest.name;
    }
    if (sourceManifest.server?.type === "uv") entry.claudex_extension_uv = options.uvExecutable;
    else delete entry.claudex_extension_uv;
    if (!options.allowed()) throw new Error(developerModeFolderBlocked);
    options.update({ ...options.current, [name]: entry });
    if (previousDirectory && previousReference) {
      try {
        if (options.retirePrevious?.(name, previousReference)) {
          fs.rmSync(previousDirectory, { recursive: true, force: true });
          migration?.retire();
        }
      } catch {}
    }
    migration = undefined;
    return name;
  } catch (error) {
    migration?.rollback();
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
