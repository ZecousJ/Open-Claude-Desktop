import { createHash } from "node:crypto";
import { z } from "zod";
import { coworkMemoryIfMatch, coworkMemoryMaxRequestBytes, coworkMemoryRevision, type officialCoworkMemory } from "../../shared/official-cowork-memory";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { CoworkAccountMemory } from "../../electron/memory/inject";

const snapshotSchema = z.object({
  revision: z.string().regex(coworkMemoryRevision),
  epoch: z.string().regex(coworkMemoryRevision),
  updated_at: z.string().nullable(),
  entries: z.record(z.string(), z.string()),
});
const mutationSchema = z.strictObject({
  entries: z.record(z.string(), z.string()).optional(),
  soft_delete_keys: z.array(z.string()).optional(),
}).refine((value) => !!Object.keys(value.entries ?? {}).length || !!value.soft_delete_keys?.length);
const json = (status: number, body: unknown): OfficialUiReadResponse => ({
  status, contentType: "application/json", body: Buffer.from(JSON.stringify(body)),
});

export class CoworkMemoryServiceError extends Error {
  constructor(readonly status: number) {
    super("Cowork memory request could not be completed.");
  }
}

export function coworkMemoryService(base: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL("/api/v1/claudex/memory/cowork", base);
  return async (token: string, method: "GET" | "PUT" | "DELETE", body?: object, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body && JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CoworkMemoryServiceError(response.status);
    }
    const payload: unknown = await response.json();
    const snapshot = z.object({ code: z.literal(0), data: snapshotSchema }).parse(payload).data;
    return { revision: snapshot.revision, epoch: snapshot.epoch, updatedAt: snapshot.updated_at, entries: snapshot.entries };
  };
}

export function engineCoworkMemory(
  service: ReturnType<typeof coworkMemoryService>,
  authorized: <T>(call: (token: string) => Promise<T>) => Promise<T>,
): CoworkAccountMemory {
  return {
    read: () => authorized((token) => service(token, "GET")),
    patch: ({ entries, deleteKeys, expectedRevision, expectedEpoch }) => authorized((token) => service(token, "PUT", {
      expected_revision: expectedRevision, expected_epoch: expectedEpoch,
      ...(entries && { entries }), ...(deleteKeys && { delete_keys: deleteKeys }),
    })),
  };
}

export async function officialCoworkMemoryResponse(
  route: NonNullable<ReturnType<typeof officialCoworkMemory>>,
  request: Record<string, unknown>,
  service: ReturnType<typeof coworkMemoryService>,
  token: string,
  current: () => boolean,
  signal?: AbortSignal,
): Promise<OfficialUiReadResponse> {
  const { body, contentType, coworkMemoryIfMatch: conditional, coworkMemoryEpoch: epoch } = request;
  let method: "GET" | "PUT" | "DELETE";
  let input: object | undefined;
  if (route.operation === "read") {
    if (body !== undefined || contentType !== undefined) return json(400, { error: "Invalid Cowork memory read." });
    method = "GET";
  } else {
    if (typeof epoch !== "string" || !coworkMemoryRevision.test(epoch))
      return json(409, { error: "Read Cowork memory before changing it." });
    if (route.operation === "reset") {
      if (body !== undefined && (!(body instanceof Uint8Array) || body.byteLength !== 0))
        return json(400, { error: "Invalid Cowork memory reset." });
      method = "DELETE";
      input = { expected_epoch: epoch };
    } else {
      if (!(body instanceof Uint8Array) || body.byteLength > coworkMemoryMaxRequestBytes ||
          typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(contentType))
        return json(400, { error: "Invalid Cowork memory update." });
      const match = typeof conditional === "string" ? coworkMemoryIfMatch.exec(conditional) : null;
      if (conditional !== undefined && !match) return json(400, { error: "Invalid Cowork memory checksum." });
      try {
        const parsed = mutationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
        input = {
          expected_epoch: epoch,
          ...(match && { expected_revision: match[1] }),
          ...(parsed.entries && { entries: parsed.entries }),
          ...(parsed.soft_delete_keys && { delete_keys: parsed.soft_delete_keys }),
        };
      } catch {
        return json(400, { error: "Invalid Cowork memory update." });
      }
      method = "PUT";
    }
  }
  if (!current()) return json(409, { error: "The account activation changed." });
  try {
    const snapshot = await service(token, method, input, signal);
    if (!current()) return json(409, { error: "The account activation changed." });
    if (method !== "GET")
      return json(200, { checksum: snapshot.revision, lastModified: snapshot.updatedAt });
    return json(200, {
      repo: "cowork", checksum: snapshot.revision, lastModified: snapshot.updatedAt,
      claudex_epoch: snapshot.epoch,
      content: {
        entries: snapshot.entries,
        entryChecksums: Object.fromEntries(Object.entries(snapshot.entries).map(([name, content]) =>
          [name, createHash("sha256").update(content).digest("hex")],
        )),
      },
    });
  } catch (error) {
    if (!current()) return json(409, { error: "The account activation changed." });
    const status = error instanceof CoworkMemoryServiceError ? error.status : 503;
    return json(status, { error: "Cowork memory request could not be completed." });
  }
}
