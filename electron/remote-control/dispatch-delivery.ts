import fs from "node:fs";
import path from "node:path";

export interface DispatchDelivery {
  id: string;
  deviceId: string;
  method: "newSession" | "send";
  args: unknown[];
}

export function readDeliveries(root: string): DispatchDelivery[] {
  try {
    const deliveries = JSON.parse(
      fs.readFileSync(path.join(root, "dispatch-outbox.json"), "utf8"),
    );
    return Array.isArray(deliveries)
      ? deliveries.filter(
          (item) =>
            typeof item?.id === "string" &&
            typeof item.deviceId === "string" &&
            (item.method === "newSession" || item.method === "send") &&
            Array.isArray(item.args) &&
            typeof item.args[0]?.text === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export function writeDeliveries(root: string, deliveries: DispatchDelivery[]) {
  const file = path.join(root, "dispatch-outbox.json");
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(deliveries), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export class DispatchReceipts {
  private pending = new Map<string, Promise<unknown>>();

  constructor(private root: () => string) {}

  async run(id: string, execute: () => Promise<unknown>) {
    const root = this.root();
    const key = `${root}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const file = path.join(root, "dispatch-receipts.json");
    let receipts: Record<string, unknown> = {};
    try {
      receipts = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    if (Object.hasOwn(receipts, id)) return receipts[id];
    const promise = execute()
      .then((result) => {
        try {
          receipts = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        receipts[id] = result ?? null;
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(receipts), {
          mode: 0o600,
        });
        fs.renameSync(`${file}.tmp`, file);
        return result;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
