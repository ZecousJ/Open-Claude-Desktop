import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  DesktopExtensionDetails,
  ExtensionValue,
  DesktopExtensionsAPI,
} from "../../shared/desktop-extensions-api";
import { idSchema } from "./extension-lifecycle-support";
import { valueSchema } from "./extension-lifecycle-support";
import { saveSchema } from "./extension-lifecycle-support";
import { unavailable } from "./extension-lifecycle-support";
import { changed } from "./extension-lifecycle-support";
import { configurationUnavailable } from "./extension-lifecycle-support";
import { text } from "./extension-lifecycle-support";
import { object } from "./extension-lifecycle-support";
import type { ExtensionLifecycle } from "./extension-lifecycle";

export function details(
  this: ExtensionLifecycle,
  id: string,
): DesktopExtensionDetails {
  const owner = this.options.owner();
  const entry = this.entry(owner, id);
  const directory = this.directory(owner, entry);
  let record: ReturnType<ExtensionLifecycle["manifest"]>;
  try {
    record = this.manifest(directory);
  } catch {
    const blockedReason = this.blocked(owner, id, entry);
    return {
      id,
      name: id,
      owned: true,
      enabled: entry.enabled !== false,
      configurable: false,
      uninstallable:
        !blockedReason &&
        owner.policy.localMcpEditing &&
        !!this.options.prepareUninstall,
      blockedReason,
      error: unavailable,
      revision: this.revision(owner, id, entry, "unreadable-manifest"),
      fields: [],
      tools: [],
      prompts: [],
      values: {},
      savedSecrets: [],
      configurationUnavailable,
    };
  }
  const { manifest, hash } = record;
  if (manifest.name !== id) throw Error(unavailable);
  const blockedReason = this.blocked(owner, id, entry);
  const { fields, supported } = this.fields(manifest);
  const configurable =
    !blockedReason &&
    owner.policy.localMcpEditing &&
    supported &&
    this.options.runtimeConfiguration(entry) &&
    this.options.cipher.isEncryptionAvailable();
  let values: Record<string, ExtensionValue> = {};
  let readError = false;
  try {
    values = this.values(owner, id);
  } catch {
    readError = true;
  }
  const publicValues: Record<string, ExtensionValue> = {};
  const savedSecrets: string[] = [];
  for (const field of fields) {
    const value =
      values[field.key] ?? object(manifest.user_config[field.key]).default;
    if (valueSchema.safeParse(value).success) {
      if (field.sensitive) {
        if (Object.hasOwn(values, field.key)) savedSecrets.push(field.key);
      } else publicValues[field.key] = value;
    }
  }
  return {
    id,
    name: text(manifest.display_name, 200) ?? text(manifest.name, 200) ?? id,
    description: text(manifest.description),
    version: text(manifest.version, 100),
    icon: this.icon(directory, manifest),
    author: text(object(manifest.author).name, 200),
    longDescription: text(manifest.long_description, 16384),
    tools: this.namedItems(manifest.tools),
    prompts: this.namedItems(manifest.prompts),
    support: text(manifest.support),
    documentation: text(manifest.documentation),
    license: text(manifest.license, 200),
    enabled: entry.enabled !== false,
    owned: true,
    blockedReason,
    configurable: configurable && !readError,
    uninstallable:
      !blockedReason &&
      owner.policy.localMcpEditing &&
      !!this.options.prepareUninstall,
    revision: this.revision(owner, id, entry, hash),
    fields,
    values: publicValues,
    savedSecrets,
    ...(!configurable || readError ? { configurationUnavailable } : {}),
  };
}

export function validate(
  this: ExtensionLifecycle,
  manifest: Record<string, any>,
  values: Record<string, ExtensionValue>,
) {
  const { fields, supported } = this.fields(manifest);
  if (!supported) throw Error(configurationUnavailable);
  if (
    Object.keys(values).some(
      (key) => !fields.some((field) => field.key === key),
    )
  )
    throw Error("Unknown extension setting.");
  const checked: Record<string, ExtensionValue> = {};
  for (const field of fields) {
    const value =
      values[field.key] ?? object(manifest.user_config[field.key]).default;
    if (value === undefined || value === "") {
      if (field.required)
        throw Error("Fill in all required extension settings.");
      if (value === "") checked[field.key] = "";
      continue;
    }
    if (
      typeof value !== field.type ||
      (typeof value === "number" &&
        (!Number.isFinite(value) ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max))) ||
      (typeof value === "string" && value.length > 8192)
    )
      throw Error("An extension setting has an invalid value.");
    checked[field.key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(checked)) > 64 * 1024)
    throw Error("Extension settings are too large.");
  return checked;
}

export function expanded(
  this: ExtensionLifecycle,
  directory: string,
  manifest: Record<string, any>,
  values: Record<string, ExtensionValue>,
) {
  const template = object(object(manifest.server).mcp_config);
  const expand = (value: unknown) => {
    if (typeof value !== "string" || value.length > 32768)
      throw Error(configurationUnavailable);
    return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (key === "__dirname") return directory;
      if (key === "pathSeparator") return path.sep;
      if (
        key.startsWith("user_config.") &&
        Object.hasOwn(values, key.slice(12))
      )
        return String(values[key.slice(12)]);
      throw Error(configurationUnavailable);
    });
  };
  if (!Array.isArray(template.args ?? []) || (template.args?.length ?? 0) > 256)
    throw Error(configurationUnavailable);
  const env = Object.fromEntries(
    Object.entries(object(template.env)).map(([key, value]) => [
      key,
      expand(value),
    ]),
  );
  const result = {
    command: expand(template.command),
    args: (template.args ?? []).map(expand),
    env,
  };
  if (
    !result.command.trim() ||
    [result.command, ...result.args, ...Object.values(env)].some((value) =>
      value.includes("\0"),
    )
  )
    throw Error(configurationUnavailable);
  return result;
}

export function save(
  this: ExtensionLifecycle,
  raw: Parameters<DesktopExtensionsAPI["saveDesktopExtension"]>[0],
): DesktopExtensionDetails {
  const input = saveSchema.parse(raw);
  const owner = this.options.owner();
  const before = this.details(input.id);
  if (before.revision !== input.revision) throw Error(changed);
  if (!before.configurable) throw Error(configurationUnavailable);
  const entry = this.entry(owner, input.id);
  const directory = this.directory(owner, entry);
  const { manifest } = this.manifest(directory);
  const values = this.validate(manifest, {
    ...this.values(owner, input.id),
    ...input.values,
  });
  this.expanded(directory, manifest, values);
  const version = randomUUID();
  const file = this.settingsFile(owner, input.id, true, version);
  let published = false;
  try {
    fs.writeFileSync(
      file,
      this.options.cipher.encryptString(
        JSON.stringify({
          version: 1,
          id: input.id,
          root: fs.realpathSync(owner.root),
          package: entry.claudex_extension,
          values,
        }),
      ),
      { mode: 0o600, flag: "wx" },
    );
    this.current(owner, input.id, input.revision);
    // The caller atomically publishes the pointer to one immutable encrypted
    // version. Interrupted/failed publication leaves the old version active.
    this.options.update({
      ...owner.servers,
      [input.id]: {
        ...entry,
        enabled: input.enabled,
        claudex_extension_settings: version,
      },
    });
    published = true;
  } finally {
    if (!published) fs.rmSync(file, { force: true });
  }
  // Retain prior encrypted versions: a secondary MCP config mirror may still
  // reference one. Only package uninstall removes its versions.
  return this.details(input.id);
}

export async function uninstall(
  this: ExtensionLifecycle,
  raw: { id: string; revision: string },
): Promise<void> {
  const input = z
    .object({ id: idSchema, revision: z.string().length(64) })
    .strict()
    .parse(raw);
  const owner = this.options.owner();
  const details = this.details(input.id);
  if (details.revision !== input.revision) throw Error(changed);
  if (!details.uninstallable || !this.options.prepareUninstall)
    throw Error(unavailable);
  const pending = this.uninstalling.get(owner.scope) ?? new Set<string>();
  if (pending.has(input.id)) throw Error(changed);
  this.uninstalling.set(owner.scope, pending);
  pending.add(input.id);
  let release: void | (() => void) = undefined;
  try {
    release = await this.options.prepareUninstall(owner, input.id);
    this.current(owner, input.id, input.revision);
    const directory = this.directory(owner, this.entry(owner, input.id));
    const staged = path.join(
      path.dirname(directory),
      `.remove-${randomUUID()}`,
    );
    this.current(owner, input.id, input.revision);
    if (
      Object.entries(owner.servers).some(
        ([name, value]) =>
          name !== input.id && object(value).claudex_extension === directory,
      )
    )
      throw Error("This extension package is used by another MCP entry.");
    const settingsPrefix = this.settingsPrefix(owner, input.id);
    const settingsDirectory = path.join(
      owner.root,
      "desktop-extension-settings",
    );
    // Validate an existing settings directory even when this package is pending.
    if (
      fs.existsSync(settingsDirectory) &&
      (fs.lstatSync(settingsDirectory).isSymbolicLink() ||
        fs.realpathSync(settingsDirectory) !==
          path.join(fs.realpathSync(owner.root), "desktop-extension-settings"))
    )
      throw Error(unavailable);
    fs.renameSync(directory, staged);
    try {
      const { [input.id]: _, ...servers } = owner.servers;
      this.options.update(servers);
    } catch (error) {
      fs.renameSync(staged, directory);
      throw error;
    }
    fs.rmSync(staged, { recursive: true, force: true });
    if (fs.existsSync(settingsDirectory))
      for (const file of fs.readdirSync(settingsDirectory)) {
        if (
          file.startsWith(`${settingsPrefix}-`) &&
          /^[a-f0-9-]{36}\.enc$/.test(file.slice(settingsPrefix.length + 1))
        )
          fs.rmSync(path.join(settingsDirectory, file), { force: true });
      }
  } finally {
    release?.();
    pending.delete(input.id);
  }
}
