import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseMcpConfig } from "./mcp-config-file";
import type { StorageCipher } from "../engine/provider-credentials";
import type { ClientPolicy } from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import type {
  DesktopExtensionField,
  DesktopExtensionSummary,
  ExtensionValue,
  DesktopExtensionsAPI,
} from "../../shared/desktop-extensions-api";
import { idSchema } from "./extension-lifecycle-support";
import { valueSchema } from "./extension-lifecycle-support";
import { unavailable } from "./extension-lifecycle-support";
import { changed } from "./extension-lifecycle-support";
import { configurationUnavailable } from "./extension-lifecycle-support";
import { text } from "./extension-lifecycle-support";
import { object } from "./extension-lifecycle-support";
import * as extensionLifecycleEdit from "./extension-lifecycle-edit";
import { installMethods } from "./install-methods";

export interface ExtensionLifecycleOwner {
  root: string;
  /** Current account store identity; a reused path cannot revive a stale lease. */
  scope: object;
  servers: Record<string, unknown>;
  policy: ClientPolicy;
}
export interface ExtensionLifecycleOptions {
  owner(): ExtensionLifecycleOwner;
  cipher: StorageCipher;
  /** True only after Engine has actually installed runtimeConfig as its resolver. */
  runtimeConfiguration(entry?: Record<string, unknown>): boolean;
  /** Atomically publish durable account settings, or throw with prior servers retained. */
  update(servers: Record<string, unknown>): void;
  /** Quiesce all real account-owned runtimes; refuse while any is busy. */
  prepareUninstall?(
    owner: ExtensionLifecycleOwner,
    id: string,
  ): Promise<void | (() => void)>;
}
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Native account-owned package lifecycle. Never exposed on an unauthenticated route. */
export class ExtensionLifecycle {
  uninstalling = new WeakMap<object, Set<string>>();
  constructor(public options: ExtensionLifecycleOptions) {}
  entry(owner: ExtensionLifecycleOwner, id: string) {
    idSchema.parse(id);
    const entry = object(owner.servers[id]);
    if (typeof entry.claudex_extension !== "string") throw Error(unavailable);
    return entry;
  }
  directory(owner: ExtensionLifecycleOwner, entry: Record<string, any>) {
    const base = path.join(owner.root, "desktop-extensions");
    const directory = path.resolve(entry.claudex_extension);
    if (
      path.dirname(directory) !== path.resolve(base) ||
      !/^[a-f0-9-]{36}$/.test(path.basename(directory))
    )
      throw Error(unavailable);
    if (
      fs.lstatSync(base).isSymbolicLink() ||
      fs.lstatSync(directory).isSymbolicLink() ||
      !fs.statSync(directory).isDirectory()
    )
      throw Error(unavailable);
    if (
      fs.realpathSync(directory) !==
      path.join(
        fs.realpathSync(owner.root),
        "desktop-extensions",
        path.basename(directory),
      )
    )
      throw Error(unavailable);
    return directory;
  }
  manifest(directory: string) {
    const file = path.join(directory, "manifest.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
      throw Error(unavailable);
    const raw = fs.readFileSync(file);
    const manifest = object(JSON.parse(raw.toString("utf8")));
    if (typeof manifest.name !== "string") throw Error(unavailable);
    return { manifest, hash: digest(raw) };
  }
  settingsFile(
    owner: ExtensionLifecycleOwner,
    id: string,
    create = false,
    version = this.entry(owner, id).claudex_extension_settings,
  ) {
    const directory = path.join(owner.root, "desktop-extension-settings");
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(directory)) {
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        fs.realpathSync(directory) !==
          path.join(fs.realpathSync(owner.root), "desktop-extension-settings")
      )
        throw Error(unavailable);
    }
    if (typeof version !== "string" || !/^[a-f0-9-]{36}$/.test(version))
      throw Error(configurationUnavailable);
    const file = path.join(
      directory,
      `${this.settingsPrefix(owner, id)}-${version}.enc`,
    );
    try {
      if (!fs.lstatSync(file).isFile()) throw Error(unavailable);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return file;
  }
  settingsPrefix(owner: ExtensionLifecycleOwner, id: string) {
    return digest(
      JSON.stringify([id, this.entry(owner, id).claudex_extension]),
    );
  }
  private encrypted(owner: ExtensionLifecycleOwner, id: string) {
    const version = this.entry(owner, id).claudex_extension_settings;
    if (version === undefined || version === true) return undefined;
    const file = this.settingsFile(owner, id);
    try {
      const stat = fs.statSync(file);
      if (stat.size > 128 * 1024) throw Error(unavailable);
      return fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
  values(
    owner: ExtensionLifecycleOwner,
    id: string,
  ): Record<string, ExtensionValue> {
    const encrypted = this.encrypted(owner, id);
    if (!encrypted) return {};
    if (!this.options.cipher.isEncryptionAvailable())
      throw Error(configurationUnavailable);
    const saved = object(
      JSON.parse(this.options.cipher.decryptString(encrypted)),
    );
    if (
      saved.version !== 1 ||
      saved.id !== id ||
      saved.root !== fs.realpathSync(owner.root) ||
      saved.package !== this.entry(owner, id).claudex_extension
    )
      throw Error(configurationUnavailable);
    return z.record(z.string(), valueSchema).parse(saved.values);
  }
  fields(manifest: Record<string, any>) {
    const entries = Object.entries(object(manifest.user_config));
    if (entries.length > 64)
      return { fields: [] as DesktopExtensionField[], supported: false };
    let supported = true;
    const fields: DesktopExtensionField[] = [];
    for (const [key, raw] of entries) {
      const field = object(raw);
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(key) ||
        !["string", "number", "boolean"].includes(field.type) ||
        field.multiple === true ||
        (field.sensitive === true && field.type !== "string") ||
        ["__proto__", "constructor", "prototype"].includes(key)
      ) {
        supported = false;
        continue;
      }
      fields.push({
        key,
        type: field.type,
        title: text(field.title, 200) ?? key,
        description: text(field.description),
        required: field.required === true,
        sensitive: field.sensitive === true,
        ...(typeof field.min === "number" ? { min: field.min } : {}),
        ...(typeof field.max === "number" ? { max: field.max } : {}),
      });
    }
    return { fields, supported };
  }
  revision(
    owner: ExtensionLifecycleOwner,
    id: string,
    entry: object,
    hash: string,
  ) {
    let encrypted: string | null;
    try {
      encrypted = this.encrypted(owner, id)?.toString("base64") ?? null;
    } catch {
      encrypted = "unreadable";
    }
    return digest(JSON.stringify([entry, hash, encrypted]));
  }
  blocked(
    owner: ExtensionLifecycleOwner,
    id: string,
    entry: Record<string, any>,
  ) {
    if (owner.policy.desktopExtensionsEnabled === false)
      return "Extensions are disabled by your administrator.";
    if (!connectorAllowed(owner.policy, id, entry))
      return "This extension is not allowed by your administrator.";
    return undefined;
  }
  icon(directory: string, manifest: Record<string, any>) {
    const icon = manifest.icon;
    if (
      typeof icon !== "string" ||
      path.isAbsolute(icon) ||
      icon.split(/[\\/]/).some((part: string) => part === "..")
    )
      return;
    const file = path.resolve(directory, icon);
    const type = (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
      } as Record<string, string>
    )[path.extname(file).toLowerCase()];
    if (!type) return;
    try {
      const stat = fs.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 256 * 1024 ||
        !fs.realpathSync(file).startsWith(`${directory}${path.sep}`)
      )
        return;
      return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      return;
    }
  }
  list(): DesktopExtensionSummary[] {
    const owner = this.options.owner();
    return Object.entries(owner.servers)
      .filter(([, raw]) => typeof object(raw).claudex_extension === "string")
      .map(([id, raw]) => {
        try {
          const {
            revision: _,
            fields: __,
            values: ___,
            savedSecrets: ____,
            ...summary
          } = this.details(id);
          return summary;
        } catch {
          return {
            id,
            name: id,
            enabled: object(raw).enabled !== false,
            owned: false,
            configurable: false,
            uninstallable: false,
            error: unavailable,
          };
        }
      });
  }
  namedItems(raw: unknown): { name: string; description?: string }[] {
    return Array.isArray(raw)
      ? raw.slice(0, 128).flatMap((value) => {
          const entry = object(value);
          const name = text(entry.name, 200);
          return name ? [{ name, description: text(entry.description) }] : [];
        })
      : [];
  }
  current(owner: ExtensionLifecycleOwner, id: string, revision: string) {
    const next = this.options.owner();
    if (
      next.scope !== owner.scope ||
      next.root !== owner.root ||
      this.details(id).revision !== revision ||
      this.details(id).blockedReason ||
      !next.policy.localMcpEditing
    )
      throw Error(changed);
    return next;
  }
  /** Native-only scrub input. Never register this as a renderer/relay method.
   * Engine retains the values for the lifetime of each actual MCP process so
   * a late failure from a previous configuration is still redacted. */
  redactionSecrets(name?: string): string[] {
    const owner = this.options.owner();
    const secrets = new Set<string>();
    for (const [id, raw] of Object.entries(owner.servers)) {
      if (name !== undefined && id !== name) continue;
      const entry = object(raw);
      if (
        typeof entry.claudex_extension !== "string" ||
        typeof entry.claudex_extension_settings !== "string"
      )
        continue;
      this.directory(owner, entry);
      for (const value of Object.values(this.values(owner, id)))
        if (typeof value === "string" && value) secrets.add(value);
    }
    return [...secrets].sort((a, b) => b.length - a.length);
  }

  /** Synchronous Engine hook; expanded secrets exist only in this return value. */
  runtimeConfig(
    name: string,
    raw: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (typeof raw.claudex_extension !== "string") return raw;
    const owner = this.options.owner();
    const entry = this.entry(owner, name);
    if (
      raw.claudex_extension !== entry.claudex_extension ||
      this.blocked(owner, name, entry)
    )
      throw Error(unavailable);
    const directory = this.directory(owner, entry);
    const { manifest } = this.manifest(directory);
    if (this.uninstalling.get(owner.scope)?.has(name)) return undefined;
    if (manifest.name !== name) throw Error(unavailable);
    if (
      !Object.keys(object(manifest.user_config)).length &&
      raw.claudex_extension_settings === undefined
    )
      return raw;
    if (!this.options.runtimeConfiguration(entry))
      throw Error(configurationUnavailable);
    // Disabled or pending configuration packages never reach app-server startup.
    if (raw.enabled === false) return undefined;
    if (!this.encrypted(owner, name)) throw Error(configurationUnavailable);
    const values = this.validate(manifest, this.values(owner, name));
    const { claudex_extension_settings: _, ...rest } = raw;
    return { ...rest, ...this.expanded(directory, manifest, values) };
  }
}

export interface ExtensionLifecycle {
  details: OmitThisParameter<typeof extensionLifecycleEdit.details>;
  validate: OmitThisParameter<typeof extensionLifecycleEdit.validate>;
  expanded: OmitThisParameter<typeof extensionLifecycleEdit.expanded>;
  save: OmitThisParameter<typeof extensionLifecycleEdit.save>;
  uninstall: OmitThisParameter<typeof extensionLifecycleEdit.uninstall>;
}
installMethods(ExtensionLifecycle.prototype, extensionLifecycleEdit);

/** Root supplies its authenticated local IPC registrar; never a web/runner registry. */
export function registerDesktopExtensionHandlers(
  handle: (
    name: keyof DesktopExtensionsAPI,
    fn: (...args: any[]) => unknown,
  ) => void,
  lifecycle: ExtensionLifecycle,
) {
  handle("desktopExtensions", () => lifecycle.list());
  handle("desktopExtension", (id: unknown) =>
    lifecycle.details(idSchema.parse(id)),
  );
  handle("saveDesktopExtension", (input) => lifecycle.save(input));
  handle("uninstallDesktopExtension", (input) => lifecycle.uninstall(input));
}

/** Installation keeps schema-based packages disabled until configuration is saved.
 * No sensitive value is ever put in the MCP configuration file. */
export function prepareDesktopExtensionEntry(folder: string) {
  const file = path.join(folder, "manifest.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw Error(unavailable);
  const manifest = object(JSON.parse(fs.readFileSync(file, "utf8")));
  const name = idSchema.parse(manifest.name);
  const config = object(object(manifest.server).mcp_config);
  if (typeof config.command !== "string")
    throw Error("Couldn’t install the extension. Try again.");
  const fields = object(manifest.user_config);
  const pending = Object.keys(fields).length > 0;
  if (
    Object.keys(fields).length > 64 ||
    Object.entries(fields).some(
      ([key, field]) =>
        !/^[a-zA-Z0-9_-]{1,64}$/.test(key) ||
        !["string", "number", "boolean"].includes(object(field).type) ||
        object(field).multiple === true ||
        (object(field).sensitive === true && object(field).type !== "string") ||
        ["__proto__", "constructor", "prototype"].includes(key),
    )
  )
    throw Error(configurationUnavailable);
  const replace = (value: string) => {
    const replaced = value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (key === "__dirname") return folder;
      if (key === "pathSeparator") return path.sep;
      if (
        pending &&
        key.startsWith("user_config.") &&
        Object.hasOwn(fields, key.slice(12))
      )
        return `\${${key}}`;
      throw Error(configurationUnavailable);
    });
    if (
      replaced.replace(/\$\{user_config\.[a-zA-Z0-9_-]+\}/g, "").includes("${")
    )
      throw Error(configurationUnavailable);
    return replaced;
  };
  const entry = {
    claudex_extension: folder,
    command: replace(config.command),
    args: Array.isArray(config.args)
      ? config.args.map((value: unknown) => replace(String(value)))
      : [],
    env: Object.fromEntries(
      Object.entries(object(config.env)).map(([key, value]) => [
        key,
        replace(String(value)),
      ]),
    ),
    ...(pending ? { enabled: false, claudex_extension_settings: true } : {}),
  };
  parseMcpConfig(JSON.stringify({ mcpServers: { [name]: entry } }));
  return { name, entry };
}
