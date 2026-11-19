import { z } from "zod";

export const bootstrapCatalogRevision = z.string().regex(/^[a-f0-9]{64}$/);
export const bootstrapCatalog = z.object({
  revision: bootstrapCatalogRevision,
  messages: z.record(z.string(), z.string()),
});
export type BootstrapCatalog = z.infer<typeof bootstrapCatalog>;

export function isBootstrapRead(method: string, path: string) {
  return method === "GET" && /^\/(?:edge-api|api)\/bootstrap(?:\/[^/]+\/app_start)?$/.test(path.split("?")[0]);
}

const payload = z.object({
  gated_messages: z.object({ messages: z.record(z.string(), z.string()) }).passthrough(),
  growthbook: z.unknown(),
  org_growthbook: z.unknown(),
}).passthrough();

/** Strip only values the client has already fetched from this exact catalog. */
export function compactBootstrap(value: unknown, catalog: BootstrapCatalog) {
  const parsed = payload.safeParse(value);
  if (!parsed.success) return value;
  const data = parsed.data;
  if (Object.keys(catalog.messages).some(key => !(key in data.gated_messages.messages))) return value;
  const messages = Object.fromEntries(Object.entries(data.gated_messages.messages)
    .filter(([key, message]) => catalog.messages[key] !== message));
  const duplicateGrowthbook = JSON.stringify(data.growthbook) === JSON.stringify(data.org_growthbook);
  return {
    ...data,
    ...(duplicateGrowthbook ? { growthbook: undefined } : {}),
    gated_messages: { ...data.gated_messages, messages },
    claudex_bootstrap_catalog: { revision: catalog.revision, duplicateGrowthbook },
  };
}

const compactPayload = payload.extend({
  growthbook: z.unknown().optional(),
  claudex_bootstrap_catalog: z.object({ revision: bootstrapCatalogRevision, duplicateGrowthbook: z.boolean() }),
});

export function expandBootstrap(value: unknown, catalog: BootstrapCatalog) {
  if (!value || typeof value !== "object" || !("claudex_bootstrap_catalog" in value)) return value;
  const { claudex_bootstrap_catalog: marker, ...data } = compactPayload.parse(value);
  if (marker.revision !== catalog.revision) throw Error("The bootstrap catalog changed.");
  return {
    ...data,
    ...(marker.duplicateGrowthbook ? { growthbook: data.org_growthbook } : {}),
    gated_messages: { ...data.gated_messages, messages: { ...catalog.messages, ...data.gated_messages.messages } },
  };
}
