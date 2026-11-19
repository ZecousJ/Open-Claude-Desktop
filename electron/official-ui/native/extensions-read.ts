/** Failure-preserving, account-leased native extension reads. No inventory cache. */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Settings } from "../../../shared/types";
import type { AdapterContext } from "../api/context";
import { sessionAccountScope } from "./session-account-scope";

export function officialLocalMcpServersConfig(servers: Settings["mcpServers"]) {
  return Object.fromEntries(
    Object.entries(servers ?? {}).flatMap(([name, value]) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("command" in value) ||
        typeof value.command !== "string" ||
        ("claudex_extension" in value && value.claudex_extension) ||
        ("enabled" in value && value.enabled === false)
      )
        return [];
      return [
        [
          name,
          {
            command: value.command,
            args: "args" in value ? (value.args ?? []) : [],
            ...("env" in value && value.env ? { env: value.env } : {}),
          },
        ] as const,
      ];
    }),
  );
}

const id = z.string().min(1).max(256);
const summary = z
  .object({
    id,
    name: z.string().min(1).max(4096),
    enabled: z.boolean(),
    version: z.string().max(256).optional(),
    description: z.string().max(16384).optional(),
    blockedReason: z.string().max(4096).optional(),
    error: z.string().optional(),
  })
  .passthrough();
const details = summary.extend({
  values: z.record(
    z.string(),
    z.union([
      z.string().max(262144),
      z.number().finite(),
      z.boolean(),
      z.array(z.string().max(8192)).max(256),
    ]),
  ),
  savedSecrets: z.array(z.string()).optional(),
  configurationUnavailable: z.string().optional(),
});
export function officialExtensionSettings(raw: unknown) {
  const detail = details.parse(raw);
  return {
    isEnabled: detail.enabled,
    userConfig: detail.values,
    ...(detail.savedSecrets?.length ? { savedSecrets: detail.savedSecrets } : {}),
    ...(detail.blockedReason ? { orgBlockedReason: detail.blockedReason } : {}),
  };
}
const unavailable = () =>
  Error("Installed extension details could not be read.");
function manifestAt(folder: string) {
  const file = path.join(folder, "manifest.json");
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 256 * 1024)
      throw unavailable();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const actual = fs.fstatSync(fd);
    if (
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      actual.size !== before.size
    )
      throw unavailable();
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 256 * 1024 || size !== actual.size) throw unavailable();
    const bytes = buffer.subarray(0, size);
    const value = z
      .object({ name: z.string().min(1), version: z.string().min(1) })
      .passthrough()
      .parse(JSON.parse(bytes.toString("utf8")));
    const after = fs.lstatSync(file);
    if (
      after.dev !== actual.dev ||
      after.ino !== actual.ino ||
      after.size !== actual.size ||
      after.mtimeMs !== actual.mtimeMs ||
      after.ctimeMs !== actual.ctimeMs
    )
      throw unavailable();
    return value;
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function createExtensionReads(ctx: AdapterContext) {
  const scope = sessionAccountScope(ctx, () => {});
  const check = () => {
    scope.sync();
    if (!ctx.account()?.id)
      throw Error("Sign in to read installed extensions.");
    if (ctx.isCurrent?.() === false)
      throw Error("The account changed during this request.");
  };
  const call = async (name: string, ...args: unknown[]) => {
    check();
    const result = await scope.guard(() => ctx.call(name, ...args));
    check();
    return result;
  };
  const readDetails = async (rawId: unknown) => {
    const key = id.parse(rawId);
    const result = details.parse(await call("desktopExtension", key));
    if (result.id !== key || result.error)
      throw unavailable();
    if (result.configurationUnavailable && !result.blockedReason) {
      const policy = z.object({ localMcpEditing: z.boolean() }).parse(await call("clientPolicy"));
      if (policy.localMcpEditing) throw unavailable();
    }
    return result;
  };
  const resolve = (rawId: unknown) => {
    check();
    const key = id.parse(rawId);
    const servers = (ctx.settings() as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
    const matches = Object.entries(servers).filter(([, value]) => value?.claudex_extension_id === key);
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) throw unavailable();
    if (servers[key] && !servers[key].claudex_extension_id) return key;
    throw unavailable();
  };
  return {
    resolve,
    installed: (...args: unknown[]) =>
      scope.run(async () => {
        if (args.length)
          throw Error("The extension inventory takes no arguments.");
        const list = z
          .array(summary)
          .max(500)
          .parse(await call("desktopExtensions"));
        if (new Set(list.map((e) => e.id)).size !== list.length)
          throw unavailable();
        const out = [];
        let bytes = 2;
        for (const extension of list) {
          if (extension.error) throw unavailable();
          const detail = await readDetails(extension.id);
          check();
          const server = (
            ctx.settings() as {
              mcpServers?: Record<string, { claudex_extension?: unknown; claudex_extension_id?: unknown }>;
            }
          ).mcpServers?.[extension.id];
          const folder = server?.claudex_extension;
          if (typeof folder !== "string" || !folder) throw unavailable();
          const manifest = manifestAt(folder);
          if (
            detail.enabled !== extension.enabled ||
            detail.name !== extension.name
          )
            throw Error("The extension inventory changed; retry the read.");
          const row = {
            id: typeof server?.claudex_extension_id === "string" ? server.claudex_extension_id : extension.id,
            displayName: extension.name,
            path: folder,
            manifest,
            settings: officialExtensionSettings(detail),
          };
          bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
          if (bytes > 4 * 1024 * 1024)
            throw Error("The extension inventory is too large.");
          out.push(row);
        }
        check();
        if (new Set(out.map(row => row.id)).size !== out.length) throw unavailable();
        if (Buffer.byteLength(JSON.stringify(out)) > 4 * 1024 * 1024)
          throw Error("The extension inventory is too large.");
        return out;
      }),
    settings: (...args: unknown[]) =>
      scope.run(async () => {
        if (args.length !== 1) throw Error("Choose one installed extension.");
        const detail = await readDetails(resolve(args[0]));
        const result = officialExtensionSettings(detail);
        if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
          throw Error("The extension settings are too large.");
        return result;
      }),
  };
}
