import { z } from "zod";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";

const identity = z.object({
  uuid: z.string().min(1).max(128),
  settings: z.object({ locale: z.string().max(32).optional() }).optional(),
  claudex_composer_layout_seed: z.literal("marlin").optional(),
  memberships: z
    .array(
      z.object({
        organization: z.object({
          uuid: z.string().uuid(),
          capabilities: z.array(z.string()),
        }),
      }),
    )
    .refine((rows) =>
      rows.some((row) => row.organization.capabilities.includes("chat")),
    ),
});
export type StartupIdentity = z.infer<typeof identity>;
const record = z.object({ sessionMarker: z.string(), identity });
const key = "claudex:official-startup-identity";

export function isChatStartupPath(pathname: string) {
  return /^\/(?:new\/?|chat\/[a-zA-Z0-9_-]+\/?)?$/.test(pathname);
}

/** Only establishes the frame's storage namespace; live bootstrap still owns account capabilities. */
export function readStartupIdentity(
  storage: Storage,
  sessionMarker: string | undefined,
) {
  if (!sessionMarker) return;
  try {
    const saved = record.parse(JSON.parse(storage.getItem(key) ?? "null"));
    if (saved.sessionMarker === sessionMarker) return saved.identity;
  } catch {
    /* A missing or old record needs a fresh account read. */
  }
}

export function rememberStartupIdentity(
  storage: Storage,
  sessionMarker: string | undefined,
  answer: OfficialUiReadResponse,
) {
  if (!sessionMarker || answer.status !== 200) return;
  try {
    const data = identity.parse(
      JSON.parse(new TextDecoder().decode(answer.body)),
    );
    storage.setItem(key, JSON.stringify({ sessionMarker, identity: data }));
  } catch {
    /* Unavailable storage does not prevent live initialization. */
  }
}
