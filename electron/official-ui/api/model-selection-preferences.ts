/** Account-owned selector preferences; no global settings or legacy ownership guesses. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ModelCatalog } from "../../../shared/model-catalog-api";
import type { AdapterContext } from "./context";
const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export const selectorThinkingSchema = z.union([
  z.object({ type: z.literal("disabled") }).strict(),
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("effort"), effort }).strict(),
  z
    .object({
      type: z.literal("effort_and_mode"),
      effort,
      mode: z.literal("auto"),
    })
    .strict(),
]);
export const selectorPatchSchema = z
  .object({
    model: z.string().min(1).max(256).nullable().optional(),
    thinking: selectorThinkingSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const valueSchema = z
  .object({
    model: z.string().min(1).max(256).optional(),
    thinking: selectorThinkingSchema.optional(),
  })
  .strict();
export type SelectorPreference = z.infer<typeof valueSchema>;
export class ModelPreferenceError extends Error {
  constructor(
    readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
type Context = Pick<
  AdapterContext,
  "account" | "stateDirectory" | "sessionIdentity" | "isCurrent" | "readModelPreference"
>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function paths(ctx: Context, surface: string) {
  const owner = ctx.account()?.id,
    root = ctx.stateDirectory?.();
  if (!owner || !root) return;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(surface))
    throw new ModelPreferenceError(400, "Invalid model selector surface.");
  // Matches the existing scoped state's account path even when root is itself account-owned.
  const account = path.join(root, "official-ui", "accounts", digest(owner));
  return {
    root,
    account,
    folder: path.join(account, "model-selections"),
    file: path.join(account, "model-selections", digest(surface) + ".json"),
  };
}
function readJson(file: string, max: number): unknown | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > max) throw Error();
    const buffer = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (
      n !== before.size ||
      n > max ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error();
    return JSON.parse(buffer.subarray(0, n).toString());
  } finally {
    fs.closeSync(fd);
  }
}
function unavailable(): never {
  throw new ModelPreferenceError(
    503,
    "Model preferences could not be stored or read safely.",
  );
}
export function readModelPreference(
  ctx: Context,
  surface: string,
): SelectorPreference {
  if (ctx.readModelPreference) {
    const value = valueSchema.safeParse(ctx.readModelPreference(surface));
    if (!value.success) unavailable();
    return value.data;
  }
  const p = paths(ctx, surface);
  if (!p) return {};
  try {
    for (const folder of [
      p.root,
      path.join(p.root, "official-ui"),
      path.join(p.root, "official-ui", "accounts"),
      p.account,
    ]) {
      try {
        const stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw e;
      }
    }
    try {
      const stat = fs.lstatSync(p.folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const saved = readJson(p.file, 4096);
    if (saved !== undefined) {
      const parsed = z
        .object({ version: z.literal(1), value: valueSchema })
        .strict()
        .safeParse(saved);
      if (!parsed.success) unavailable();
      return parsed.data.value;
    }
    // Only the proven account-scoped aggregate is read. Global userData state is never assigned.
    const legacy = readJson(
      path.join(p.account, "model-selections.json"),
      65536,
    );
    if (
      !legacy ||
      typeof legacy !== "object" ||
      Array.isArray(legacy) ||
      !Object.hasOwn(legacy, surface)
    )
      return {};
    const parsed = valueSchema.safeParse(
      (legacy as Record<string, unknown>)[surface],
    );
    return parsed.success ? parsed.data : {};
  } catch (e) {
    if (e instanceof ModelPreferenceError) throw e;
    unavailable();
  }
}
export function effortOf(token: string | undefined) {
  switch (token) {
    case "low": case "medium": case "high": case "xhigh": case "max": case "ultra":
      return token;
  }
}

/** A fresh composer may omit an override when it uses the saved Chat default. */
export async function savedChatEffort(ctx: AdapterContext, model: string, source?: ModelCatalog | null) {
  const preference = readModelPreference(ctx, "chat");
  const thinking = preference.thinking;
  const effort = effortOf(thinking && "effort" in thinking ? thinking.effort : undefined);
  if (!effort || (preference.model && preference.model !== model)) return;
  const catalog = source === undefined ? await ctx.modelCatalog() : source;
  if (!catalog?.items.find((item) => item.id === model)?.efforts?.includes(effort)) return;
  if (!preference.model) {
    const items = [...catalog.items].sort((a, b) => a.sort - b.sort);
    const defaultModel = (items.find((item) => item.id === catalog.defaultModel) ??
      items.find((item) => item.isDefault) ?? items[0])?.id;
    if (defaultModel !== model) return;
  }
  return effort;
}

export function writeModelPreference(
  ctx: Context,
  surface: string,
  patch: z.infer<typeof selectorPatchSchema>,
): SelectorPreference {
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.();
  const current = () =>
    owner &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity &&
    ctx.isCurrent?.() !== false;
  const check = () => {
    if (!current())
      throw new ModelPreferenceError(
        409,
        "The account changed. Reload model preferences.",
      );
  };
  check();
  const p = paths(ctx, surface);
  if (!p) unavailable();
  let temp: string | undefined;
  try {
    const next = { ...readModelPreference(ctx, surface) };
    if (patch.model === null) delete next.model;
    else if (patch.model !== undefined) next.model = patch.model;
    if (patch.thinking === null) delete next.thinking;
    else if (patch.thinking !== undefined) next.thinking = patch.thinking;
    const value = valueSchema.parse(next);
    check();
    for (const folder of [
      p.root,
      path.join(p.root, "official-ui"),
      path.join(p.root, "official-ui", "accounts"),
      p.account,
      p.folder,
    ]) {
      if (folder !== p.root)
        try {
          fs.mkdirSync(folder, { mode: 0o700 });
          if (process.platform !== "win32") {
            const parent = fs.openSync(path.dirname(folder), "r");
            try {
              fs.fsyncSync(parent);
            } finally {
              fs.closeSync(parent);
            }
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
    }
    check();
    temp = path.join(p.folder, "." + randomUUID() + ".tmp");
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, value }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    check();
    fs.renameSync(temp, p.file);
    temp = undefined;
    if (process.platform !== "win32") {
      const dir = fs.openSync(p.folder, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
    check();
    return value;
  } catch (e) {
    if (e instanceof ModelPreferenceError) throw e;
    return unavailable();
  } finally {
    if (temp)
      try {
        fs.unlinkSync(temp);
      } catch {}
  }
}
