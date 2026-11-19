import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  dispatchDeliveryResponseSchema,
  dispatchDeliveryValueSchema,
  type DispatchDeliveryResponse,
} from "../../shared/dispatch-api";
import type { Conversation } from "../../shared/types";

const dispatchMethods = z.enum(["newSession", "send"]);
const newSessionRequest = z.object({
  id: z.uuid(),
  method: z.literal("newSession"),
  args: z.tuple([z.object({ text: z.string() }).loose()]),
});
const followUpRequest = z.object({
  id: z.uuid(),
  method: z.literal("send"),
  args: z.tuple([
    z
      .object({ conversationId: z.string().min(1).max(500), text: z.string() })
      .loose(),
  ]),
});
export const dispatchDeliveryInput = z.discriminatedUnion("method", [
  newSessionRequest,
  followUpRequest,
]);

const dispatchDelivery = z.object({
  id: z.uuid(),
  attemptId: z.uuid().optional(),
  method: dispatchMethods,
  args: z.tuple([z.object({ text: z.string() }).loose()]),
  deviceId: z.string(),
  failure: z
    .object({
      state: z.enum(["failed", "unknown"]),
      message: z.string(),
      rejected: z.literal(true).optional(),
    })
    .optional(),
});

export type DispatchDeliveryInput = z.infer<typeof dispatchDeliveryInput>;
export type DispatchDelivery = z.infer<typeof dispatchDelivery>;

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function readDeliveries(root: string): DispatchDelivery[] {
  const deliveries = readJson(path.join(root, "dispatch-outbox.json"));
  if (deliveries === undefined) return [];
  return z.array(dispatchDelivery).parse(deliveries);
}

export function writeDeliveries(root: string, deliveries: DispatchDelivery[]) {
  writeJson(path.join(root, "dispatch-outbox.json"), deliveries);
}

export const dispatchReceiptUnavailable =
  "CLAUDEX_DISPATCH_RECEIPT_UNAVAILABLE";

export class DispatchReceiptUnavailable extends Error {
  constructor(cause: unknown) {
    super(
      "The computer could not read or save this delivery's receipt. Try again.",
      { cause },
    );
  }
}

export class DispatchRejection extends Error {
  constructor(
    readonly code: "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

const reservedReceipt = z.object({
  status: z.literal("reserved"),
  method: dispatchMethods,
  conversationId: z.string(),
});
type ReservedReceipt = z.infer<typeof reservedReceipt>;

const receiptFile = z.record(
  z.string(),
  z.union([
    reservedReceipt,
    dispatchDeliveryResponseSchema,
    dispatchDeliveryValueSchema,
  ]),
);

const unknownOutcome: DispatchDeliveryResponse = {
  status: "unknown",
  message:
    "The computer could not confirm this delivery. Check its tasks before sending again.",
};

function recover(
  root: string,
  id: string,
  { conversationId, method }: ReservedReceipt,
): DispatchDeliveryResponse | undefined {
  const rows = readJson(path.join(root, "conversations.json"));
  if (!Array.isArray(rows)) return;
  const conversation = (rows as Conversation[]).find(
    (row) => row.id === conversationId,
  );
  if (!conversation) return;
  const hasReceipt = (turn: { dispatchDeliveryId?: string }) =>
    turn.dispatchDeliveryId === id;
  if (
    conversation.turns.some(hasReceipt) ||
    conversation.savedBranches?.some((branch) =>
      branch.turns.some(hasReceipt),
    ) ||
    conversation.rewind?.turns.some(hasReceipt)
  )
    return {
      status: "accepted",
      value: method === "newSession" ? { conversationId } : null,
    };
}

export class DispatchReceipts {
  private readonly pending = new Map<
    string,
    Promise<DispatchDeliveryResponse>
  >();

  constructor(private root: () => string) {}

  async run(
    { id, method, args }: DispatchDeliveryInput,
    execute: () => Promise<{ conversationId: string } | null>,
  ): Promise<DispatchDeliveryResponse> {
    const root = this.root();
    const key = `${root}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const file = path.join(root, "dispatch-receipts.json");
    const read = () => receiptFile.parse(readJson(file) ?? {});
    const reservation: ReservedReceipt = {
      status: "reserved",
      method,
      conversationId: method === "newSession" ? id : args[0].conversationId,
    };
    try {
      return await this.reserve(
        root,
        id,
        key,
        file,
        read,
        reservation,
        execute,
      );
    } catch (error) {
      throw new DispatchReceiptUnavailable(error);
    }
  }

  private async reserve(
    root: string,
    id: string,
    key: string,
    file: string,
    read: () => z.infer<typeof receiptFile>,
    reservation: ReservedReceipt,
    execute: () => Promise<{ conversationId: string } | null>,
  ): Promise<DispatchDeliveryResponse> {
    const receipts = read();
    const stored = receipts[id];
    if (stored !== undefined) {
      if (stored === null || !("status" in stored))
        return { status: "accepted", value: stored };
      if (stored.status !== "reserved") return stored;
      const outcome = recover(root, id, stored);
      if (!outcome) return unknownOutcome;
      writeJson(file, { ...receipts, [id]: outcome });
      return outcome;
    }
    writeJson(file, { ...receipts, [id]: reservation });
    const promise = execute()
      .then(
        (value): DispatchDeliveryResponse => ({ status: "accepted", value }),
        (error): DispatchDeliveryResponse => {
          const accepted = recover(root, id, reservation);
          return (
            accepted ?? {
              status: "rejected",
              code:
                error instanceof DispatchRejection ? error.code : "unavailable",
              message:
                error instanceof Error
                  ? error.message
                  : "The computer couldn't do that.",
            }
          );
        },
      )
      .then((receipt) => {
        writeJson(file, { ...read(), [id]: receipt });
        return receipt;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
