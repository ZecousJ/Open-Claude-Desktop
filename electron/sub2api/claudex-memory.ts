/**
 * The Claudex service's memory API (R3, `internal/claudex/memory`): the
 * signed-in person's switches, documents and edits under
 * `/api/v1/claudex/memory`, and the bootstrap's `memory` section. Every
 * call takes the current access token (`RemoteSession.authorized` renews
 * it). The text is stored encrypted on the server; administrators see only
 * sizes and dates.
 *
 * A service without the memory component answers 404 without a Claudex
 * reason: that reads as "no memory on this server".
 */
import { z } from "zod";
import type { MemoryPrefs } from "../../shared/memory-api";
import {
  isMemoryScope,
  memoryLimits,
  type MemoryDocRecord,
  type MemoryEditRecord,
  type MemoryLimits,
  type MemoryScope,
  type MemorySnapshot,
  type MemorySource,
} from "../memory/types";
import { requestJson, Sub2ApiError, type Fetch } from "./http";

/** The service's memory error reasons (design 3.2). */
export const memoryErrorCodes = Object.freeze({
  disabled: "CLAUDEX_MEMORY_DISABLED",
  conflict: "CLAUDEX_MEMORY_CONFLICT",
  tooLarge: "CLAUDEX_MEMORY_TOO_LARGE",
  limit: "CLAUDEX_MEMORY_LIMIT",
  badScope: "CLAUDEX_MEMORY_BAD_SCOPE",
  sensitive: "CLAUDEX_MEMORY_SENSITIVE",
  invalid: "CLAUDEX_MEMORY_INVALID",
  editNotFound: "CLAUDEX_MEMORY_EDIT_NOT_FOUND",
  keyMissing: "CLAUDEX_MEMORY_ENCRYPTION_KEY_MISSING",
  policyUnavailable: "CLAUDEX_MEMORY_POLICY_UNAVAILABLE",
  storeFailed: "CLAUDEX_MEMORY_STORE_FAILED",
});

const switches = z.object({
  search_chats: z.boolean(),
  generate: z.boolean(),
});
const statusShape = {
  available: z.boolean(),
  reason: z.string().max(40).nullable().optional(),
  allowed: switches,
  prefs: switches,
  prefs_set: z.boolean().optional(),
  effective: switches.optional(),
  model: z.string().max(200).nullable().optional(),
};
const status = z.object(statusShape);
const time = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) {
      ctx.addIssue({ code: "custom", message: "time" });
      return z.NEVER;
    }
    return at;
  });
const scope = z
  .string()
  .max(80)
  .refine((value) => isMemoryScope(value));
const doc = z.object({
  scope,
  content: z.string().max(1_000_000).nullable(),
  readable: z.boolean().optional(),
  revision: z.number().int().nonnegative(),
  source: z.enum(["generated", "user", "import"]),
  generated_at: time.nullable().optional(),
  updated_at: time,
  created_at: time.optional(),
});
const edit = z.object({
  id: z.number().int().positive(),
  scope,
  text: z.string().max(100_000).nullable(),
  readable: z.boolean().optional(),
  created_at: time,
});
const limits = z.object({
  doc_bytes: z.number().int().positive(),
  edits_per_scope: z.number().int().positive(),
  edit_chars: z.number().int().positive(),
  scopes: z.number().int().positive(),
});
const view = z.object({
  ...statusShape,
  limits: limits.optional(),
  docs: z.array(doc).max(1000),
  edits: z.array(edit).max(10_000),
});
const bootstrapSection = z.object({
  ...statusShape,
  revision_by_scope: z.record(z.string(), z.number().int()).nullable(),
});

/** The service's status part of an answer, in the client's names. */
export interface MemoryServiceStatus {
  available: boolean;
  reason?: "policy" | "server";
  allowed: MemoryPrefs;
  prefs: MemoryPrefs;
  model: string | null;
}

/** The bootstrap's `memory` section: the switches and each scope's revision. */
export interface MemoryBootstrap extends MemoryServiceStatus {
  revisions: Record<string, number>;
}

function prefsOf(value: z.infer<typeof switches>): MemoryPrefs {
  return { searchChats: value.search_chats, generate: value.generate };
}

function statusOf(value: z.infer<typeof status>): MemoryServiceStatus {
  const reason =
    value.reason === "policy" || value.reason === "server"
      ? value.reason
      : undefined;
  return {
    available: value.available,
    ...(reason ? { reason } : {}),
    allowed: prefsOf(value.allowed),
    prefs: prefsOf(value.prefs),
    model: value.model ?? null,
  };
}

function limitsOf(value: z.infer<typeof limits> | undefined): MemoryLimits {
  if (!value) return memoryLimits;
  return {
    docBytes: Math.min(value.doc_bytes, memoryLimits.docBytes),
    editsPerScope: value.edits_per_scope,
    editChars: Math.min(value.edit_chars, memoryLimits.editChars),
    scopes: value.scopes,
  };
}

function docOf(value: z.infer<typeof doc>): MemoryDocRecord {
  return {
    scope: value.scope as MemoryScope,
    content: value.readable === false ? null : value.content,
    revision: value.revision,
    source: value.source as MemorySource,
    ...(typeof value.generated_at === "number"
      ? { generatedAt: value.generated_at }
      : {}),
    updatedAt: value.updated_at,
    createdAt: value.created_at ?? value.updated_at,
  };
}

function editOf(value: z.infer<typeof edit>): MemoryEditRecord {
  return {
    id: String(value.id),
    scope: value.scope as MemoryScope,
    text: value.readable === false ? null : value.text,
    createdAt: value.created_at,
  };
}

function malformed(): never {
  throw new Sub2ApiError(
    502,
    "MALFORMED_RESPONSE",
    "The Claudex service sent an unexpected response.",
  );
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  return result.success ? result.data : malformed();
}

/** GET /claudex/memory as the store keeps it. */
export function parseMemoryView(data: unknown): MemorySnapshot {
  const value = parse(view, data);
  const service = statusOf(value);
  return {
    available: service.available,
    ...(service.reason ? { reason: service.reason } : {}),
    allowed: service.allowed,
    prefs: service.prefs,
    model: service.model,
    limits: limitsOf(value.limits),
    docs: value.docs.map(docOf),
    edits: value.edits.map(editOf),
  };
}

/** The bootstrap's `memory` section; undefined when absent or not as documented. */
export function parseMemoryBootstrap(
  data: unknown,
): MemoryBootstrap | undefined {
  const result = bootstrapSection.safeParse(data);
  if (!result.success) return undefined;
  return {
    ...statusOf(result.data),
    revisions: { ...(result.data.revision_by_scope ?? {}) },
  };
}

/** Whether an error means the service has no memory at all (an older service). */
export function memoryMissing(error: unknown) {
  return (
    error instanceof Sub2ApiError &&
    error.status === 404 &&
    !error.code.startsWith("CLAUDEX_")
  );
}

export class ClaudexMemory {
  constructor(
    /** The service this account signed in to, e.g. `https://claudex.example`. */
    readonly baseUrl: string,
    /** This installation's id; the service records which device wrote an edit. */
    private deviceId?: string,
    private fetchImpl: Fetch = fetch,
  ) {}
  private call(
    token: string,
    route: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    return requestJson(this.fetchImpl, `${this.baseUrl}/api/v1${route}`, {
      ...init,
      token,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
    });
  }
  async get(token: string): Promise<MemorySnapshot> {
    return parseMemoryView(await this.call(token, "/claudex/memory"));
  }
  async setPrefs(
    token: string,
    prefs: Partial<MemoryPrefs>,
  ): Promise<MemoryServiceStatus> {
    const body: Record<string, boolean> = {};
    if (prefs.searchChats !== undefined) body.search_chats = prefs.searchChats;
    if (prefs.generate !== undefined) body.generate = prefs.generate;
    return statusOf(
      parse(
        status,
        await this.call(token, "/claudex/memory/prefs", {
          method: "PUT",
          body,
        }),
      ),
    );
  }
  async saveDoc(
    token: string,
    scope: MemoryScope,
    input: {
      content: string;
      source: MemorySource;
      baseRevision: number;
      editsUpto?: number;
    },
  ): Promise<MemoryDocRecord> {
    return docOf(
      parse(
        doc,
        await this.call(
          token,
          `/claudex/memory/docs/${encodeURIComponent(scope)}`,
          {
            method: "PUT",
            body: {
              content: input.content,
              source: input.source,
              base_revision: input.baseRevision,
              ...(input.editsUpto !== undefined
                ? { edits_upto: input.editsUpto }
                : {}),
            },
          },
        ),
      ),
    );
  }
  async deleteDoc(token: string, scope: MemoryScope) {
    await this.call(
      token,
      `/claudex/memory/docs/${encodeURIComponent(scope)}`,
      {
        method: "DELETE",
      },
    );
  }
  async deleteAll(token: string) {
    await this.call(token, "/claudex/memory", { method: "DELETE" });
  }
  async addEdit(
    token: string,
    scope: MemoryScope,
    text: string,
  ): Promise<MemoryEditRecord> {
    return editOf(
      parse(
        edit,
        await this.call(token, "/claudex/memory/edits", {
          method: "POST",
          body: { scope, text },
        }),
      ),
    );
  }
  /** Removing an edit that is already gone is not an error. */
  async removeEdit(token: string, id: string) {
    if (!/^[1-9]\d{0,18}$/.test(id)) return;
    try {
      await this.call(token, `/claudex/memory/edits/${id}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (
        error instanceof Sub2ApiError &&
        error.code === memoryErrorCodes.editNotFound
      )
        return;
      throw error;
    }
  }
}
