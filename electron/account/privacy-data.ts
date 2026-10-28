import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FeedbackHistoryPage,
  PrivacyDataAPI,
  PrivacyDataStatus,
  UploadedFilesPage,
} from "../../shared/privacy-data-api";

/** request returns the existing authenticated requestJson response data. */
export interface PrivacyFeedbackTransport {
  request(method: "GET" | "DELETE", route: string): Promise<unknown>;
}
export interface PrivacyDataDependencies {
  /** Stable account + store + remote/engine lease identity; replaced on retirement. */
  owner(): object;
  feedback(): PrivacyFeedbackTransport | undefined;
  readUploads?: () => Promise<Omit<UploadedFilesPage, "nextCursor">>;
  deleteUpload?: (id: string) => Promise<void>;
  now?: () => number;
}
const inputSchema = z
  .object({ cursor: z.string().min(1).max(4096).optional() })
  .strict()
  .optional();
const historySchema = z.object({
  version: z.literal(1),
  items: z
    .array(
      z.object({
        id: z.uuid(),
        createdAt: z.iso.datetime({ offset: true }),
        rating: z.enum(["up", "down"]),
        categories: z.array(z.string().max(32)).max(10),
        comment: z.string().refine((value) => Array.from(value).length <= 4000),
        hasExcerpt: z.boolean(),
      }),
    )
    .max(100),
  nextCursor: z.string().min(1).max(512).optional(),
});
const uploadSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        name: z.string().min(1).max(500),
        bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        uploadedAt: z.number().finite().nonnegative().nullable(),
        surface: z.enum(["chat", "code"]),
        locations: z
          .array(
            z.object({
              conversationId: z.string().min(1).max(500),
              title: z.string().max(2000),
            }),
          )
          .max(1000),
        storage: z.literal("managed-attachment"),
      }),
    )
    .max(1000),
  complete: z.literal(false),
  scope: z.literal("managed-attachments"),
  skipped: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
type CursorValue = { owner: object } & (
  | { kind: "feedback"; next: string }
  | {
      kind: "uploads";
      page: Omit<UploadedFilesPage, "nextCursor">;
      offset: number;
    }
);
type Cursor = CursorValue & { expires: number };
const ttl = 5 * 60_000;
const pageSize = 50;
export class PrivacyDataService implements PrivacyDataAPI {
  private cursors = new Map<string, Cursor>();
  constructor(private deps: PrivacyDataDependencies) {}
  private current(owner: object) {
    if (this.deps.owner() !== owner)
      throw Error(
        "This privacy request belongs to a retired account. Open Privacy again.",
      );
  }
  private async owned<T>(owner: object, read: () => Promise<T>): Promise<T> {
    try {
      const result = await read();
      this.current(owner);
      return result;
    } catch (error) {
      this.current(owner);
      throw error;
    }
  }
  private remember(cursor: CursorValue): string {
    const now = this.deps.now?.() ?? Date.now();
    for (const [key, value] of this.cursors)
      if (value.expires <= now || value.owner !== this.deps.owner())
        this.cursors.delete(key);
    while (this.cursors.size >= 64)
      this.cursors.delete(this.cursors.keys().next().value!);
    const key = randomUUID();
    this.cursors.set(key, { ...cursor, expires: now + ttl } as Cursor);
    return key;
  }
  private cursor(raw: string, owner: object, kind: Cursor["kind"]): Cursor {
    const found = this.cursors.get(raw);
    if (
      !found ||
      found.owner !== owner ||
      found.kind !== kind ||
      found.expires <= (this.deps.now?.() ?? Date.now())
    )
      throw Error(
        "This page has expired or belongs to another account. Refresh the list.",
      );
    return found;
  }
  async privacyDataStatus(): Promise<PrivacyDataStatus> {
    const owner = this.deps.owner();
    const transport = this.deps.feedback();
    const uploads = this.deps.readUploads
      ? { supported: true as const }
      : { supported: false as const, reason: "unsupported-host" as const };
    if (!transport)
      return {
        uploads,
        feedback: { supported: false, reason: "local-account" },
      };
    try {
      historySchema.parse(
        await transport.request("GET", "feedback/history?limit=1"),
      );
      this.current(owner);
      return { uploads, feedback: { supported: true } };
    } catch (error) {
      this.current(owner);
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 404 || status === 405)
        return {
          uploads,
          feedback: { supported: false, reason: "unsupported-service" },
        };
      throw error;
    }
  }
  async feedbackHistory(raw?: {
    cursor?: string;
  }): Promise<FeedbackHistoryPage> {
    const input = inputSchema.parse(raw);
    const owner = this.deps.owner();
    const transport = this.deps.feedback();
    if (!transport)
      throw Error("This account has no feedback collection service.");
    let next: string | undefined;
    if (input?.cursor) {
      const cursor = this.cursor(input.cursor, owner, "feedback");
      if (cursor.kind === "feedback") next = cursor.next;
    }
    const page = historySchema.parse(
      await this.owned(owner, () =>
        transport.request(
          "GET",
          `feedback/history?limit=${pageSize}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        ),
      ),
    );
    this.current(owner);
    return {
      items: page.items,
      ...(page.nextCursor
        ? {
            nextCursor: this.remember({
              owner,
              kind: "feedback",
              next: page.nextCursor,
            }),
          }
        : {}),
    };
  }
  async withdrawFeedback(raw: string): Promise<{ withdrawn: true }> {
    const id = z.uuid().parse(raw);
    const owner = this.deps.owner();
    const transport = this.deps.feedback();
    if (!transport)
      throw Error("This account has no feedback collection service.");
    const result = z
      .object({ withdrawn: z.literal(true) })
      .parse(
        await this.owned(owner, () =>
          transport.request(
            "DELETE",
            `feedback/history/${encodeURIComponent(id)}`,
          ),
        ),
      );
    this.current(owner);
    return result;
  }
  async uploadedFiles(raw?: { cursor?: string }): Promise<UploadedFilesPage> {
    const input = inputSchema.parse(raw);
    const owner = this.deps.owner();
    if (!this.deps.readUploads)
      throw Error("This host cannot list stored attachment copies.");
    let page: Omit<UploadedFilesPage, "nextCursor">,
      offset = 0;
    if (input?.cursor) {
      const cursor = this.cursor(input.cursor, owner, "uploads");
      if (cursor.kind !== "uploads") throw Error("Invalid page.");
      page = cursor.page;
      offset = cursor.offset;
    } else
      page = uploadSchema.parse(await this.owned(owner, this.deps.readUploads));
    this.current(owner);
    return {
      ...page,
      items: page.items.slice(offset, offset + pageSize),
      ...(offset + pageSize < page.items.length
        ? {
            nextCursor: this.remember({
              owner,
              kind: "uploads",
              page,
              offset: offset + pageSize,
            }),
          }
        : {}),
    };
  }
  async deleteUploadedFile(raw: string): Promise<{ deleted: true }> {
    const id = z.string().min(1).max(512).parse(raw);
    const owner = this.deps.owner();
    if (!this.deps.deleteUpload)
      throw Error("This host cannot delete stored attachment copies.");
    await this.owned(owner, () => this.deps.deleteUpload!(id));
    // Pages read before the deletion would list it again.
    for (const [key, value] of this.cursors)
      if (value.kind === "uploads") this.cursors.delete(key);
    return { deleted: true };
  }
}
