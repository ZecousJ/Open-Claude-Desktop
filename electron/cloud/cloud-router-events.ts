import type { AppEvent, Snapshot } from "../../shared/types";
import { cloudApprovalId } from "./cloud-router-support";
import { cloudApproval } from "./cloud-router-support";
import { mergedSnapshot } from "./cloud-router-support";
import { cloudSnapshotTimeoutMs } from "./cloud-router-support";
import { retryMinMs } from "./cloud-router-support";
import { retryMaxMs } from "./cloud-router-support";
import type { CloudRouter } from "./cloud-router";
import type { CloudCalls } from "./cloud-router";

/**
 * Claims a crash left between the cloud's export and the import here: a
 * task that arrived is kept, any other is released back to the cloud.
 */
export async function recoverClaims(
  this: CloudRouter,
  client: CloudCalls,
  local: Snapshot,
  current: () => boolean,
) {
  if (!current()) return;
  for (const id of this.deps.claims?.list() ?? []) {
    if (!current()) return;
    if (local.conversations.some((c) => c.id === id)) {
      this.deps.claims?.remove(id);
      continue;
    }
    try {
      await client.call("releaseCoworkTask", [id]);
      if (!current()) return;
      this.deps.claims?.remove(id);
    } catch {
      if (!current()) return;
      // Tried again with the next snapshot.
    }
  }
}

/** The local snapshot plus the cloud's part. */
export async function merge(
  this: CloudRouter,
  local: Snapshot,
): Promise<Snapshot> {
  // The production getter may synchronously reset while changing accounts.
  const client = this.deps.client();
  const generation = this.snapshotGeneration;
  const request = ++this.snapshotRead;
  this.localTasks = new Set(
    local.conversations.filter((c) => c.linkedToComputer).map((c) => c.id),
  );
  if (!client) return local;
  const inScope = () => {
    const active = this.deps.client();
    return generation === this.snapshotGeneration && active === client;
  };
  const current = () => inScope() && request === this.snapshotRead;
  try {
    const cloud = await this.withTimeout(client.snapshot());
    // An old caller receives only its own local state, never another
    // account's cache. Its renderer also retires its pending snapshot.
    if (!inScope()) return local;
    // Another window may have read more recently. Return this caller's
    // real cloud result, while only the newest read may change shared state.
    if (request !== this.snapshotRead)
      return mergedSnapshot(local, cloud, false);
    this.timers.clear(this.retryTimer);
    this.retryTimer = undefined;
    this.retryMs = retryMinMs;
    this.last = cloud;
    this.conversations = new Set(cloud.conversations.map((c) => c.id));
    this.projects = new Set((cloud.projects ?? []).map((p) => p.id));
    this.deps.onCloudSnapshot?.();
    if (!inScope()) return local;
    if (request !== this.snapshotRead)
      return mergedSnapshot(local, cloud, false);
    await this.recoverClaims(client, local, current);
    if (!inScope()) return local;
    if (request !== this.snapshotRead)
      return mergedSnapshot(local, cloud, false);
    return mergedSnapshot(local, this.last, false);
  } catch (error) {
    if (!inScope()) return local;
    if (request !== this.snapshotRead)
      return mergedSnapshot(local, this.last, true);
    console.error(
      "Cloud conversations:",
      error instanceof Error ? error.message : String(error),
    );
    this.retryLater(generation, client);
    // The cloud's last answer stays listed while it is away.
    return mergedSnapshot(local, this.last, true);
  }
}

export async function withTimeout<T>(
  this: CloudRouter,
  promise: Promise<{ snapshot: T }>,
) {
  let timer: unknown;
  try {
    return await Promise.race([
      promise.then((value) => value.snapshot),
      new Promise<never>((_, reject) => {
        timer = this.timers.set(
          () => reject(new Error("The cloud did not answer in time.")),
          cloudSnapshotTimeoutMs,
        );
      }),
    ]);
  } finally {
    this.timers.clear(timer);
  }
}

/** The window reads the snapshot again later, while the cloud is away. */
export function retryLater(
  this: CloudRouter,
  generation: number,
  client: CloudCalls,
) {
  if (this.retryTimer !== undefined) return;
  const delay = this.retryMs;
  this.retryMs = Math.min(retryMaxMs, this.retryMs * 2);
  const timer = this.timers.set(() => {
    if (this.retryTimer !== timer) return;
    const active = this.deps.client();
    if (
      generation !== this.snapshotGeneration ||
      active !== client ||
      this.retryTimer !== timer
    )
      return;
    this.retryTimer = undefined;
    this.deps.push({ type: "resync" });
  }, delay);
  this.retryTimer = timer;
}

/** An event of the cloud's stream: what concerns the window goes on. */
export function cloudEvent(this: CloudRouter, event: AppEvent) {
  switch (event.type) {
    case "schedules":
      this.deps.push({
        ...event,
        schedules: this.routines.update(event.schedules, "remote"),
      });
      return;
    case "conversation": {
      const conversation = { ...event.conversation, cloudHosted: true };
      if (this.localTasks.has(conversation.id)) return;
      this.conversations.add(conversation.id);
      if (this.last)
        this.last = {
          ...this.last,
          conversations: [
            ...this.last.conversations.filter((c) => c.id !== conversation.id),
            conversation,
          ],
        };
      this.deps.push({ ...event, conversation });
      return;
    }
    case "conversation-turn":
      if (this.localTasks.has(event.conversationId)) return;
      this.deps.push(event);
      return;
    case "side-chat-text":
      // The answer a cloud conversation's side chat is writing.
      this.deps.push(event);
      return;
    case "approval":
      this.deps.push({ ...event, approval: cloudApproval(event.approval) });
      return;
    case "approval-resolved":
      this.deps.push({ ...event, id: cloudApprovalId(event.id) });
      return;
    case "resync":
      this.deps.push(event);
      return;
    case "stream-connection":
      // Back after a gap: read the cloud's state again.
      if (event.connected) this.deps.push({ type: "resync" });
      return;
    default:
      // Settings, policy, usage and the rest are this app's own.
      return;
  }
}
