import { randomUUID } from "node:crypto";
import { officialResponseChunkBytes } from "../../shared/official-response-transfer";
import type {
  OfficialUiReadResponse,
  OfficialUiWireResponse,
} from "../../shared/official-ui-web";
import type { WebAppContext } from "./web-app-context";

const byteLimit = 256 * 1024 * 1024;
const idleMs = 5 * 60_000;
const completedMs = 30_000;

type Transfer = {
  body: Uint8Array;
  nextOffset: number;
  expiresAt: number;
  timer?: NodeJS.Timeout;
};

class OfficialResponseTransfers {
  private entries = new Map<string, Transfer>();

  constructor(readonly identity: unknown) {}

  private remove(id: string, transfer: Transfer) {
    clearTimeout(transfer.timer);
    this.entries.delete(id);
  }

  clear() {
    for (const [id, transfer] of this.entries) this.remove(id, transfer);
  }

  private expireAfter(
    id: string,
    transfer: Transfer,
    now: number,
    delay: number,
  ) {
    clearTimeout(transfer.timer);
    transfer.expiresAt = now + delay;
    transfer.timer = setTimeout(() => this.entries.delete(id), delay).unref();
  }

  start(
    answer: OfficialUiReadResponse,
    now: number,
  ): OfficialUiWireResponse | undefined {
    const totalBytes = answer.body.byteLength;
    let remaining = byteLimit;
    for (const [id, transfer] of this.entries) {
      if (transfer.expiresAt <= now) this.remove(id, transfer);
      else remaining -= transfer.body.byteLength;
    }
    for (const [id, transfer] of this.entries) {
      if (totalBytes <= remaining) break;
      if (transfer.nextOffset !== transfer.body.byteLength) continue;
      this.remove(id, transfer);
      remaining += transfer.body.byteLength;
    }
    if (totalBytes > remaining) return undefined;
    const id = randomUUID();
    const transfer = {
      body: answer.body,
      nextOffset: officialResponseChunkBytes,
      expiresAt: 0,
    };
    this.entries.set(id, transfer);
    this.expireAfter(id, transfer, now, idleMs);
    return {
      ...answer,
      body: answer.body.subarray(0, officialResponseChunkBytes),
      responseTransfer: { id, totalBytes },
    };
  }

  read(
    { id, offset }: { id: string; offset: number },
    now: number,
  ): OfficialUiWireResponse | null | undefined {
    const transfer = this.entries.get(id);
    if (!transfer) return undefined;
    if (transfer.expiresAt <= now) {
      this.remove(id, transfer);
      return undefined;
    }
    if (
      offset % officialResponseChunkBytes !== 0 ||
      offset > transfer.nextOffset ||
      offset >= transfer.body.byteLength
    )
      return null;
    const end = Math.min(
      offset + officialResponseChunkBytes,
      transfer.body.byteLength,
    );
    if (transfer.nextOffset < transfer.body.byteLength) {
      transfer.nextOffset = Math.max(transfer.nextOffset, end);
      this.expireAfter(
        id,
        transfer,
        now,
        end === transfer.body.byteLength ? completedMs : idleMs,
      );
    }
    return {
      status: 200,
      contentType: "application/octet-stream",
      body: transfer.body.subarray(offset, end),
      responseOffset: offset,
    };
  }
}

const byContext = new WeakMap<WebAppContext, OfficialResponseTransfers>();

export function officialResponseTransfers(ctx: WebAppContext) {
  const identity = ctx.officialSessionIdentity();
  const existing = byContext.get(ctx);
  if (existing && existing.identity === identity) return existing;
  existing?.clear();
  const transfers = new OfficialResponseTransfers(identity);
  byContext.set(ctx, transfers);
  return transfers;
}
