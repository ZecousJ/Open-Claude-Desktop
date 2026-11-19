import { z } from "zod";
import type { AdapterContext } from "../api/context";
import { inAdapterScope, newAdapterScope } from "../api/scope";
import { flushState, readState, writeState } from "../api/state";
import type { NativeHost } from "./host";

const stateKey = "code-session-presets";
const maxPresets = 200;
const maxCatalogBytes = 512 * 1024;
const rendererObject = z.record(z.string(), z.unknown());
const catalogSchema = z.object({
  presets: z.array(rendererObject),
  builtIns: rendererObject.optional(),
  seededFromDraft: z.boolean().optional(),
});

function presetScope(ctx: AdapterContext, accountUuid: unknown) {
  if (
    typeof accountUuid !== "string" ||
    accountUuid.length !== 36 ||
    ctx.isCurrent?.() === false ||
    ctx.account()?.id !== accountUuid
  )
    return undefined;
  const root = ctx.stateDirectory?.();
  if (root) return newAdapterScope(accountUuid, root);
}

export function registerCodeSessionPresets(
  host: Pick<NativeHost, "ctx" | "on">,
) {
  const { ctx } = host;
  host.on("LocalSessionPresets.load", (accountUuid: unknown) => {
    const scope = presetScope(ctx, accountUuid);
    if (!scope) return null;
    try {
      return inAdapterScope(scope, () => {
        const catalog = catalogSchema.safeParse(
          readState<unknown>(stateKey, { presets: [] }),
        );
        return catalog.success ? catalog.data : null;
      });
    } catch {
      ctx.log("[official-ui] Code environment presets could not be read.");
      return null;
    }
  });
  host.on(
    "LocalSessionPresets.replaceAll",
    (accountUuid: unknown, value: unknown) => {
      const scope = presetScope(ctx, accountUuid);
      if (!scope) throw Error("Account identity is unresolved right now");
      const catalog = catalogSchema.safeParse(value);
      if (!catalog.success) throw Error("Malformed session preset catalog");
      if (catalog.data.presets.length > maxPresets)
        throw Error("Too many session presets");
      if (Buffer.byteLength(JSON.stringify(catalog.data)) > maxCatalogBytes)
        throw Error("Session preset catalog is too large");
      return inAdapterScope(scope, () => {
        writeState(stateKey, () => catalog.data);
        flushState(stateKey);
        return { success: true };
      });
    },
  );
}
