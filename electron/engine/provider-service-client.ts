import { fork, type ChildProcess } from "node:child_process";
import type { Provider, UsageSummary } from "../../shared/types";
import type { RequestLimits } from "../../server/operator-limits";
import type { AgentPromptEvent } from "../../server/agent-prompt-observer";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import {
  gatewayRefusalDetails,
  type GatewayRefusalDetails,
} from "../../shared/claudex-contract";
import { claudexClientInfo } from "../sub2api/http";
import type { GatewayObservers } from "./gateway";
import { parseGeneratedImageSignal } from "../../server/image-observer";
import { parseToolStartSignal } from "../../shared/tool-start";
import {
  parseToolDescriptionSignal,
  parseWebSourcesSignal,
  type GatewayRequestOptions,
} from "../../shared/gateway-signals";

/** Plan-state reasons the usage banner knows (`LimitReason`); longer or odd values are dropped. */
const refusalReason = /^[a-z][a-z0-9-]{0,39}$/;

/** A gateway GET result; the body is redacted of the key. */
export interface RemoteReply {
  ok: boolean;
  status: number;
  body?: string;
  models?: string[];
}

const unconfirmedWrites = new WeakSet<object>();
function unconfirmedWrite(message: string) {
  const error = Error(message); unconfirmedWrites.add(error); return error;
}
/** Identity-based main-process classification, never provider-supplied text. */
export function isUnconfirmedProviderWrite(error: unknown): boolean {
  return typeof error === "object" && error !== null && unconfirmedWrites.has(error);
}

type Reply = { id: number; ok: boolean; result?: unknown; error?: string };
export class ProviderServiceClient {
  url = "";
  token = "";
  private child?: ChildProcess;
  private closing?: Promise<void>;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      child: ChildProcess;
      vaultWrite: boolean;
    }
  >();
  constructor(
    private script: string,
    private profileRoot: string,
    private provider: Provider,
    private apiKey: string,
    private vaultKey?: string,
    private vaultRoot = profileRoot,
    private limits?: RequestLimits,
    private onAgentPrompt?: (event: AgentPromptEvent) => void,
    private onRefusal?: (refusal: GatewayRefusal) => void,
    private observers: GatewayObservers = {},
    /** How the gateway rewrites requests from its start (S1). */
    private requestOptions?: GatewayRequestOptions,
  ) {}
  /**
   * Keys of the account's other service groups held in memory only (MG),
   * sent with the start like `apiKey` and then forgotten here.
   */
  sessionGroupKeys: Record<string, string> = {};
  private spawn() {
    if (this.child) return;
    const child = fork(this.script, [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // The gateway names this build to the Claudex service (X-Claudex-Version).
        CLAUDEX_APP_VERSION: claudexClientInfo().version ?? "",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const signal = message as {
        type?: string;
        parentThreadId?: unknown;
        callId?: unknown;
        message?: unknown;
        model?: unknown;
      };
      if (signal.type === "remoteRefusal") {
        // Every field is checked again: the child parsed a network answer.
        const refusal = message as Record<string, unknown>;
        if (
          typeof refusal.message === "string" &&
          refusal.message.length <= 1000 &&
          typeof refusal.code === "string" &&
          refusal.code.length <= 100 &&
          Number.isSafeInteger(refusal.status)
        ) {
          const forwarded: GatewayRefusal & GatewayRefusalDetails = {
            status: refusal.status as number,
            code: refusal.code,
            ...(typeof refusal.threadId === "string" && /^[\w.:-]{1,255}$/.test(refusal.threadId)
              ? { threadId: refusal.threadId } : {}),
            ...(typeof refusal.turnId === "string" && /^[\w.:-]{1,255}$/.test(refusal.turnId)
              ? { turnId: refusal.turnId } : {}),
            ...(typeof refusal.reason === "string" &&
            refusalReason.test(refusal.reason)
              ? { reason: refusal.reason as GatewayRefusal["reason"] }
              : {}),
            exceeded: refusal.exceeded === true,
            invalidKey: refusal.invalidKey === true,
            message: refusal.message,
            ...gatewayRefusalDetails(refusal),
          };
          try {
            this.onRefusal?.(forwarded);
          } catch {}
        }
        return;
      }
      // S1: shell descriptions and web sources, each checked again here.
      if (signal.type === "toolDescription") {
        const event = parseToolDescriptionSignal(message);
        if (event)
          try {
            this.observers.onToolDescription?.(event);
          } catch {}
        return;
      }
      if (signal.type === "webSources") {
        const event = parseWebSourcesSignal(
          (message as { event?: unknown }).event,
        );
        if (event)
          try {
            this.observers.onWebSources?.(event);
          } catch {}
        return;
      }
      if (signal.type === "toolStart") {
        const event = parseToolStartSignal(
          (message as { event?: unknown }).event,
        );
        if (event)
          try {
            this.observers.onToolStart?.(event);
          } catch {}
        return;
      }
      if (signal.type === "generatedImage") {
        const event = parseGeneratedImageSignal(
          (message as { event?: unknown }).event,
        );
        if (event)
          try {
            this.observers.onGeneratedImage?.(event);
          } catch {}
        return;
      }
      if (signal.type === "imageRequest" && this.child === child) {
        const event = (message as { event?: Record<string, unknown> }).event;
        if (event && typeof event.id === "string" &&
          (event.kind === "started" || event.kind === "finished") &&
          (event.threadId === undefined || typeof event.threadId === "string")) {
          this.observers.onImageRequest?.({ id: event.id, kind: event.kind, threadId: event.threadId });
        }
        return;
      }
      if (signal.type === "agentPrompt") {
        if (
          typeof signal.parentThreadId === "string" &&
          typeof signal.callId === "string" &&
          typeof signal.message === "string" &&
          signal.parentThreadId.length <= 500 &&
          signal.callId.length <= 500 &&
          signal.message.length <= 100_000
        )
          try {
            this.onAgentPrompt?.({
              parentThreadId: signal.parentThreadId,
              callId: signal.callId,
              message: signal.message,
              ...(typeof signal.model === "string" && signal.model.length <= 200
                ? { model: signal.model }
                : {}),
            });
          } catch {}
        return;
      }
      const reply = message as Reply,
        request = this.pending.get(reply.id);
      if (!request || request.child !== child) return;
      if (request.vaultWrite && (typeof reply.ok !== "boolean" ||
        (reply.ok && (!reply.result || typeof reply.result !== "object" || Array.isArray(reply.result) ||
          Object.values(reply.result).some(value => typeof value !== "boolean"))))) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.ok) request.resolve(reply.result);
      else request.reject(Error(reply.error ?? "Provider service failed."));
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      for (const [id, request] of this.pending) {
        if (request.child !== child) continue;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.reject(
          Error(`Provider service stopped (${code ?? signal ?? "unknown"}).`),
        );
      }
    });
    child.on("error", error => {
      for (const [id, request] of this.pending) {
        if (request.child !== child) continue;
        this.pending.delete(id); clearTimeout(request.timer);
        request.reject(request.vaultWrite
          ? unconfirmedWrite("The provider credential write process outcome is unknown.") : error);
      }
    });
    child.on("disconnect", () => {
      for (const [id, request] of this.pending) {
        if (request.child !== child || !request.vaultWrite) continue;
        this.pending.delete(id); clearTimeout(request.timer);
        request.reject(unconfirmedWrite("The provider credential write disconnected before its outcome was confirmed."));
      }
    });
  }
  private call<T>(
    type: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 30000,
    vaultWrite = false,
  ): Promise<T> {
    this.spawn();
    const child = this.child!;
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(vaultWrite ? unconfirmedWrite("The provider credential write outcome is unknown.") : Error("Provider service timed out."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child, vaultWrite });
      try { child.send({ id, type, ...extra }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(vaultWrite ? unconfirmedWrite("The provider credential write could not confirm delivery.") : error);
        }
      }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(vaultWrite ? unconfirmedWrite("The provider credential write could not confirm delivery.") : error);
      }
    });
  }
  async start() {
    const result = await this.call<{ url: string; token: string }>("start", {
      profileRoot: this.profileRoot,
      vaultRoot: this.vaultRoot,
      vaultKey: this.vaultKey,
      provider: this.provider,
      apiKey: this.apiKey,
      groupKeys: this.sessionGroupKeys,
      limits: this.limits,
      ...(this.requestOptions ? { options: this.requestOptions } : {}),
    });
    this.apiKey = "";
    this.sessionGroupKeys = {};
    this.url = result.url;
    this.token = result.token;
    return this.url;
  }
  /** Changes how the running gateway rewrites requests (S1). */
  async setRequestOptions(options: GatewayRequestOptions) {
    this.requestOptions = options;
    await this.call("requestOptions", { options }, 5000);
  }
  async setProviderRouting(provider: Provider, refreshedKeys?: {
    apiKey: string;
    groupKeys: Record<string, string>;
  }) {
    if (provider.id !== this.provider.id)
      throw Error("The active model provider changed.");
    if (!this.child?.connected || this.closing)
      throw Error("The model gateway is unavailable.");
    const { id, protocol, model, models, routes } = provider;
    await this.call("providerRouting", {
      routing: { id, protocol, model, models, routes },
      ...(refreshedKeys ? { refreshedKeys, vaultRoot: this.vaultRoot, vaultKey: this.vaultKey } : {}),
    }, 5000);
  }
  /** The product a thread's usage counts under (usage by product). */
  threadProduct(threadId: string, product: "code" | "cowork" | "chat") {
    return this.call("threadProduct", { threadId, product }, 5000);
  }
  async openSidePath(): Promise<string> {
    const pending = this.call<string>("openSidePath", {}, 5000);
    const child = this.child;
    const token = await pending;
    if (!child || this.child !== child || !child.connected || !/^[a-f0-9]{64}$/.test(token))
      throw Error("The side question gateway changed.");
    return token;
  }
  async closeSidePath(token: string): Promise<void> {
    if (!this.child?.connected || this.closing) return;
    await this.call("closeSidePath", { sidePath: token }, 5000);
  }
  abortThread(threadId: string) {
    void this.call("abort", { threadId }, 5000).catch(() => {});
  }
  async usageSummary() {
    return await this.call<UsageSummary>("summary");
  }
  async keyStatus(ids: string[]) {
    return await this.call<Record<string, boolean>>("keyStatus", {
      vaultRoot: this.vaultRoot,
      vaultKey: this.vaultKey,
      allowedIds: ids,
    });
  }
  async setKeys(keys: Record<string, string>, allowedIds: string[]) {
    return await this.call<Record<string, boolean>>("keys", {
      vaultRoot: this.vaultRoot,
      vaultKey: this.vaultKey,
      keys,
      allowedIds,
    });
  }
  /** Used only while the host holds the canonical vault-root write barrier.
   * A timeout/disconnect/send failure is not proof that the child stopped writing. */
  async setKeysConfirmed(keys: Record<string, string>, allowedIds: string[]) {
    return await this.call<Record<string, boolean>>("keys", {
      vaultRoot: this.vaultRoot, vaultKey: this.vaultKey, keys, allowedIds,
    }, 30000, true);
  }
  async testProvider(provider: Provider, apiKey: string) {
    return await this.call<{ models: string[]; message: string }>(
      "test",
      { vaultRoot: this.vaultRoot, vaultKey: this.vaultKey, provider, apiKey },
      25000,
    );
  }
  /** `apiKey` is a key held in memory only; otherwise the vault's key is used. */
  async remoteModels(provider: Provider, apiKey = "") {
    return await this.call<RemoteReply>("remoteModels", {
      vaultRoot: this.vaultRoot,
      vaultKey: this.vaultKey,
      provider,
      apiKey,
    });
  }
  async remoteKeyUsage(provider: Provider, apiKey = "") {
    return await this.call<RemoteReply>("remoteKeyUsage", {
      vaultRoot: this.vaultRoot,
      vaultKey: this.vaultKey,
      provider,
      apiKey,
    });
  }
  /** Replaces the running gateway's in-memory key and its service groups' keys (MG). */
  async setSessionKey(apiKey: string, groupKeys: Record<string, string> = {}) {
    await this.call("sessionKey", { apiKey, groupKeys }, 5000);
  }
  /**
   * Opens a dictation session (package C6) with this client's provider and
   * key: realtime for the Claudex service, one upload for other services.
   * No gateway is started for it.
   */
  async startDictation(
    maxSeconds: number,
    options?: import("../../shared/voice-api").DictationStartOptions,
  ) {
    const result = await this.call<{ streaming: boolean; maxSeconds: number }>(
      "dictationStart",
      {
        profileRoot: this.profileRoot,
        vaultRoot: this.vaultRoot,
        vaultKey: this.vaultKey,
        provider: this.provider,
        apiKey: this.apiKey,
        maxSeconds,
        options,
      },
      20000,
    );
    this.apiKey = "";
    return result;
  }
  /** Sends pcm_s16le audio; resolves to the transcript so far. */
  async dictationAudio(pcm: Uint8Array) {
    return await this.call<{ text: string; partial: string }>(
      "dictationAudio",
      { audioBase64: Buffer.from(pcm).toString("base64") },
      10000,
    );
  }
  /** Ends the recording; resolves to the whole transcript. */
  async finishDictation() {
    const result = await this.call<{ text: string }>(
      "dictationFinish",
      {},
      100000,
    );
    return result.text;
  }
  async cancelDictation() {
    await this.call("dictationCancel", {}, 5000);
  }
  async close() {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.closing = (async () => {
      try {
        try {
          await this.call("stop", {}, 5000);
        } catch {
          /* An exited child is handled below. */
        }
        if (child.connected)
          try {
            child.disconnect();
          } catch {
            /* The exit event remains authoritative. */
          }
        await new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const grace = setTimeout(() => child.kill(), 2000);
          const force = setTimeout(() => child.kill("SIGKILL"), 5000);
          const deadline = setTimeout(
            () => finish(Error("Provider service did not exit.")),
            8000,
          );
          const finish = (error?: Error) => {
            clearTimeout(grace);
            clearTimeout(force);
            clearTimeout(deadline);
            child.off("exit", onExit);
            child.off("error", onError);
            if (error) reject(error);
            else resolve();
          };
          const onExit = () => finish();
          const onError = (error: Error) => finish(error);
          child.once("exit", onExit);
          child.once("error", onError);
        });
      } finally {
        if (this.child === child) this.child = undefined;
        this.apiKey = "";
        this.url = "";
        this.token = "";
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
