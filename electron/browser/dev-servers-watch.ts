import { spawnSync } from "node:child_process";
import { localUrlsIn } from "../../shared/launch-config";
import type { AppEvent } from "../../shared/types";
import type { DevServers } from "./dev-servers";

/** Stops every server of a conversation and forgets its approvals. */
export async function closeConversation(
  this: DevServers,
  conversationId: string,
) {
  const records = this.records.get(conversationId);
  await Promise.all(
    [...(records?.values() ?? [])].map((record) => this.stopRecord(record)),
  );
  this.records.delete(conversationId);
  this.approvals.delete(conversationId);
  this.detected.delete(conversationId);
  this.asked.delete(conversationId);
}

export function sweep(this: DevServers) {
  const ids = new Set([
    ...this.records.keys(),
    ...this.approvals.keys(),
    ...this.detected.keys(),
    ...this.asked,
  ]);
  for (const id of ids)
    if (!this.deps.conversation(id)) void this.closeConversation(id);
}

// ---- Addresses printed in the Terminal panel ----

export function observe(this: DevServers, event: AppEvent) {
  if (event.type === "terminal-reset") {
    const ids = [...this.detected.keys()];
    this.detected.clear();
    this.terminalTail.clear();
    for (const id of ids) this.emit(id);
    return;
  }
  if (event.type === "terminal-exit") {
    this.terminalTail.delete(event.id);
    const map = this.detected.get(event.conversationId);
    if (!map) return;
    let changed = false;
    for (const [key, item] of map) {
      item.terminals.delete(event.id);
      if (!item.terminals.size) {
        map.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit(event.conversationId);
    return;
  }
  if (event.type !== "terminal-output") return;
  let text: string;
  try {
    text = Buffer.from(event.deltaBase64, "base64").toString("utf8");
  } catch {
    return;
  }
  // An address split across two chunks is still found.
  const joined = (this.terminalTail.get(event.id) ?? "") + text;
  this.terminalTail.set(event.id, joined.slice(-256));
  const urls = localUrlsIn(joined);
  if (!urls.length) return;
  let map = this.detected.get(event.conversationId);
  if (!map) this.detected.set(event.conversationId, (map = new Map()));
  for (const url of urls) {
    const port = Number(new URL(url).port);
    const key = String(port);
    const item = map.get(key);
    if (item) {
      item.terminals.add(event.id);
      continue;
    }
    if (map.size >= 20) break;
    map.set(key, { url, port, terminals: new Set([event.id]), open: false });
    void this.probeDetected(event.conversationId);
  }
  this.scheduleRecheck();
}

export async function probeDetected(this: DevServers, conversationId: string) {
  const map = this.detected.get(conversationId);
  if (!map) return;
  let changed = false;
  await Promise.all(
    [...map.values()].map(async (item) => {
      const open = await this.portOpen(item.port);
      if (open !== item.open) {
        item.open = open;
        changed = true;
      }
    }),
  );
  if (changed) this.emit(conversationId);
}

export function scheduleRecheck(this: DevServers) {
  if (this.recheck || this.disposed) return;
  this.recheck = setInterval(() => {
    if (![...this.detected.values()].some((map) => map.size)) {
      clearInterval(this.recheck);
      this.recheck = undefined;
      return;
    }
    for (const id of this.detected.keys()) void this.probeDetected(id);
  }, this.timing.detectedRecheckMs);
  this.recheck.unref?.();
}

// ---- Closing ----

/** Sync: the app is exiting and can't wait. */
export function killAllNow(this: DevServers) {
  for (const records of this.records.values())
    for (const record of records.values())
      if (record.child?.pid) {
        record.stopping = true;
        if (this.platform === "win32" && !this.deps.kill)
          try {
            spawnSync(
              "taskkill",
              ["/pid", String(record.child.pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore", timeout: 2_000 },
            );
          } catch {
            // Already gone.
          }
        else this.kill(record.child.pid, "SIGTERM");
      }
}
