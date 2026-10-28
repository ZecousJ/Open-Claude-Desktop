import { modelProtocol } from "../../shared/provider-routes";
import { applyUsageHold } from "../../shared/usage-hold";
import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";
import type { Conversation, Provider, Turn } from "../../shared/types";
import type { GatewayRequestOptions } from "../../shared/gateway-signals";
import { isOutboxTurn } from "../ssh/outbox";
import { grokModel } from "./engine-support";
import type {} from "./engine-method-types";
import type { Engine } from "./engine";

/** The thread of this engine's one running turn; undefined for none or several. */
export function runningThread(this: Engine): string | undefined {
  const running = [...this.routes.entries()].filter(([threadId, id]) =>
    this.store.conversations.some(
      (c) =>
        c.id === id &&
        c.threadId === threadId &&
        c.turns.at(-1)?.status === "inProgress",
    ),
  );
  return running.length === 1 ? running[0]![0] : undefined;
}

/** Whether the administrator's policy leaves grok's X search on (default: yes). */
export function xSearchAllowed(this: Engine) {
  const policy = this.policy();
  if (!policy.webSearch) return false;
  const research = (policy as { research?: unknown }).research;
  if (!research || typeof research !== "object") return true;
  const fields = research as Record<string, unknown>;
  return fields.xSearch !== false && fields.x_search !== false;
}

/**
 * The gateway's request options for a model service: shell descriptions
 * (R7), and the models that may also search X (R45). Without a catalog
 * entry, a grok model of the Claudex service counts.
 */
export function requestOptions(
  this: Engine,
  provider: Provider,
): GatewayRequestOptions {
  const models = [...new Set([provider.model, ...provider.models])].filter(
    Boolean,
  );
  return {
    describeTools: this.describeTools,
    xSearchModels: this.xSearchAllowed()
      ? models.filter((model) => {
          // With several service groups, each model has its own protocol (MG).
          if (modelProtocol(provider, model) !== "responses") return false;
          const known = this.searchCapabilities(provider.id, model)?.xSearch;
          return (
            known ?? (provider.backend === "sub2api" && grokModel.test(model))
          );
        })
      : [],
    ...(this.imageModel() ? { imageModel: this.imageModel() } : {}),
  };
}

/** Sends changed request options to the running gateway. */
export async function syncRequestOptions(this: Engine, provider: Provider) {
  const options = this.requestOptions(provider);
  const key = JSON.stringify(options);
  if (!this.gateway || key === this.sentRequestOptions) return;
  try {
    await this.gateway.setRequestOptions(options);
    this.sentRequestOptions = key;
  } catch {
    // The gateway keeps its previous options; the next send tries again.
  }
}

export function changed(this: Engine, c: Conversation, immediate = false) {
  this.store.schedule();
  if (immediate) {
    clearTimeout(this.notificationTimer.get(c.id));
    this.notificationTimer.delete(c.id);
    this.emit({ type: "conversation", conversation: structuredClone(c) });
  } else if (!this.notificationTimer.has(c.id))
    this.notificationTimer.set(
      c.id,
      setTimeout(() => {
        this.notificationTimer.delete(c.id);
        this.emit({ type: "conversation", conversation: structuredClone(c) });
      }, 35),
    );
}

/** A turn of the account runs, on this engine or another one (R9). */
export function isBusy(this: Engine) {
  return (
    this.ownBusy() ||
    (this.peers?.all() ?? []).some((peer) => peer !== this && peer.ownBusy())
  );
}

/**
 * This engine is creating a task or runs a turn. A message waiting for
 * its SSH host (outbox) doesn't count: nothing runs yet.
 */
export function ownBusy(this: Engine) {
  return (
    (this.pendingSend && !this.earlyTurn) ||
    this.store.conversations.some(
      (c) =>
        this.owns(c) &&
        c.turns.some(
          (t) =>
            t.status === "inProgress" &&
            !isOutboxTurn(t) &&
            t !== this.earlyTurn,
        ),
    )
  );
}

/**
 * This computer's gateway address and token while the agent runs. The
 * memory summary sends its requests through it, so the account's key,
 * model list and limits apply to them as to any chat.
 */
export function gatewayEndpoint(
  this: Engine,
): { url: string; token: string } | undefined {
  const gateway = this.gateway;
  return gateway?.url ? { url: gateway.url, token: gateway.token } : undefined;
}

export function assertMcpAvailable(this: Engine) {
  if (this.mcpMaintenance?.())
    throw Error("Wait for extension maintenance to finish.");
}

export async function quiesceMcp(this: Engine) {
  if (this.starting) await this.starting.catch(() => {});
  await this.stop();
}

export function clearApprovals(this: Engine, conversationId?: string) {
  for (const a of [...this.ownApprovals])
    if (!conversationId || a.conversationId === conversationId) {
      this.ownApprovals = this.ownApprovals.filter((v) => v.id !== a.id);
      if (typeof a.id === "string") this.requestIds.delete(a.id);
      this.appApprovals.get(a.id)?.(undefined);
      this.appApprovals.delete(a.id);
      this.emit({ type: "approval-resolved", id: a.id });
    }
}

/** A failed turn's error, in the service's own words when it refused the request during this turn. */
export function refusalText(
  this: Engine,
  turn: Turn,
  error: string | undefined,
) {
  if (isStorageFullError(error)) return storageFullMessage;
  const refusal = this.lastRefusal;
  if (error && refusal && refusal.at >= turn.createdAt)
    applyUsageHold(turn, refusal);
  return error && refusal && refusal.at >= turn.createdAt
    ? refusal.message
    : error;
}
