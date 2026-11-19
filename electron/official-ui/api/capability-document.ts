/** Trusted host facts only. This document is NOT an official feature-flag patch,
 * policy grant, UI permission override, or a live service call. */
import { randomUUID } from "node:crypto";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { HostInfo } from "../../../shared/host";
import type { MemoryStatus } from "../../../shared/memory-api";

export type CapabilitySource<T> =
  | { state: "ready"; value: T }
  | { state: "absent" }
  | { state: "error" }
  | { state: "pending" };
export type CapabilityState =
  "allowed" | "denied" | "unavailable" | "unknown" | "read_only";
export interface CapabilityFact {
  state: CapabilityState;
  reason: string;
  enabled?: boolean;
}
export interface CapabilityInputs {
  host: CapabilitySource<HostInfo>;
  policy: CapabilitySource<ClientPolicy>;
  memory: CapabilitySource<MemoryStatus>;
  /** The selected model's actual provider route + real catalog metadata. */
  searchModel: CapabilitySource<{
    modelId: string;
    protocol: "responses" | "chat";
    webSearch?: "native" | "none";
  }>;
  /** Explicit adapter wiring, not inferred from allowTextActions or UI gates. */
  adapter: CapabilitySource<{
    execution: "enabled" | "read_only" | "unavailable";
    modes: readonly (
      "chat" | "code.native" | "code.cloud" | "cowork.native" | "cowork.cloud"
    )[];
    memoryRead: boolean;
    memoryWrite: boolean;
    /** No HostCapabilities.localCowork exists; caller must supply proven fact. */
    nativeCowork?: boolean;
  }>;
}
export interface CapabilityDocument {
  version: 1;
  subject: { accountId: string; activationId: string };
  sources: Record<
    keyof CapabilityInputs,
    "ready" | "absent" | "error" | "pending"
  >;
  capabilities: Record<
    | "chat.web_search"
    | "memory.read"
    | "memory.generation_control"
    | "memory.chat_search_control"
    | "code.native"
    | "code.cloud"
    | "cowork.native"
    | "cowork.cloud",
    CapabilityFact
  >;
}
const fact = (state: CapabilityState, reason: string): CapabilityFact => ({
  state,
  reason,
});
function source<T>(
  s: CapabilitySource<T>,
  name: string,
): CapabilityFact | undefined {
  return s.state === "pending"
    ? fact("unknown", name + "_pending")
    : s.state === "absent"
      ? fact("unknown", name + "_absent")
      : s.state === "error"
        ? fact("unavailable", name + "_error")
        : undefined;
}
const booleanFact = (
  value: unknown,
  name: string,
): CapabilityFact | undefined =>
  typeof value === "boolean" ? undefined : fact("unknown", name + "_invalid");

/** Pure mapping: no defaults borrowed from another platform/account. */
export function resolveCapabilityDocument(
  subject: CapabilityDocument["subject"],
  input: CapabilityInputs,
): CapabilityDocument {
  if (
    !subject.accountId ||
    subject.accountId.length > 512 ||
    !subject.activationId ||
    subject.activationId.length > 128
  )
    throw Error("Invalid capability subject");
  const adapter = () => source(input.adapter, "adapter");
  const execution = (
    mode:
      "chat" | "code.native" | "code.cloud" | "cowork.native" | "cowork.cloud",
  ): CapabilityFact | undefined => {
    const missing = adapter();
    if (missing) return missing;
    if (input.adapter.state !== "ready") throw Error("Unreachable");
    const a = input.adapter.value;
    if (
      !a ||
      !Array.isArray(a.modes) ||
      !["enabled", "read_only", "unavailable"].includes(a.execution)
    )
      return fact("unknown", "adapter_invalid");
    if (!a.modes.includes(mode) || a.execution === "unavailable")
      return fact("unavailable", "adapter_mode_unavailable");
    if (a.execution === "read_only")
      return fact("read_only", "adapter_execution_read_only");
  };
  const mode = (
    kind: "code" | "cowork",
    location: "native" | "cloud",
  ): CapabilityFact => {
    const missing = source(input.host, "host");
    if (missing) return missing;
    if (input.host.state !== "ready") throw Error("Unreachable");
    const h = input.host.value;
    if (!h || !h.capabilities || !["desktop", "web"].includes(h.kind))
      return fact("unknown", "host_invalid");
    if (location === "native" && h.kind !== "desktop")
      return fact("unavailable", "native_host_required");
    if (kind === "cowork" && location === "native") {
      const missing = adapter();
      if (missing) return missing;
    }
    let value: unknown =
      kind === "code"
        ? location === "native"
          ? h.capabilities.localCode
          : h.capabilities.cloudCode
        : location === "cloud"
          ? h.capabilities.cloudCowork
          : input.adapter.state === "ready"
            ? input.adapter.value?.nativeCowork
            : undefined;
    if (typeof value !== "boolean")
      return fact("unknown", kind + "_" + location + "_not_reported");
    if (!value)
      return fact("unavailable", kind + "_" + location + "_not_supported");
    return (
      execution(`${kind}.${location}`) ??
      fact("allowed", "host_and_adapter_supported")
    );
  };
  const search = (): CapabilityFact => {
    const p = source(input.policy, "policy");
    if (p) return p;
    if (input.policy.state !== "ready") throw Error("Unreachable");
    const value = input.policy.value?.webSearch;
    const invalid = booleanFact(value, "policy_web_search");
    if (invalid) return invalid;
    if (!value) return fact("denied", "policy_web_search_disabled");
    const model = source(input.searchModel, "search_model");
    if (model) return model;
    if (input.searchModel.state !== "ready") throw Error("Unreachable");
    const m = input.searchModel.value;
    if (m && m.webSearch === undefined)
      return fact("unknown", "search_model_metadata_absent");
    if (
      !m ||
      typeof m.modelId !== "string" ||
      !m.modelId ||
      !["responses", "chat"].includes(m.protocol) ||
      !["native", "none"].includes(m.webSearch!)
    )
      return fact("unknown", "search_model_invalid");
    if (m.protocol !== "responses" || m.webSearch !== "native")
      return fact("unavailable", "selected_model_native_search_unavailable");
    return (
      execution("chat") ?? fact("allowed", "policy_model_and_adapter_supported")
    );
  };
  const memory = (
    operation: "read" | "generate" | "searchChats",
  ): CapabilityFact => {
    const missing = source(input.memory, "memory");
    if (missing) return missing;
    if (input.memory.state !== "ready") throw Error("Unreachable");
    const m = input.memory.value;
    if (
      !m ||
      typeof m.available !== "boolean" ||
      !m.allowed ||
      !m.prefs ||
      [
        m.allowed.generate,
        m.allowed.searchChats,
        m.prefs.generate,
        m.prefs.searchChats,
      ].some((v) => typeof v !== "boolean")
    )
      return fact("unknown", "memory_invalid");
    if (!m.available && operation === "read" && m.reason === "policy")
      return fact("unknown", "memory_read_policy_unresolved");
    if (!m.available)
      return fact(
        m.reason === "policy" ? "denied" : "unavailable",
        m.reason === "policy"
          ? "memory_policy_disabled"
          : m.reason === "offline"
            ? "memory_offline"
            : "memory_service_unavailable",
      );
    if (operation !== "read" && !m.allowed[operation])
      return fact("denied", "memory_policy_" + operation + "_disabled");
    const a = adapter();
    if (a) return a;
    if (input.adapter.state !== "ready") throw Error("Unreachable");
    const config = input.adapter.value;
    if (
      !config ||
      typeof config.memoryRead !== "boolean" ||
      typeof config.memoryWrite !== "boolean"
    )
      return fact("unknown", "adapter_memory_invalid");
    if (!config.memoryRead)
      return fact("unavailable", "adapter_memory_read_unavailable");
    if (operation === "read") return fact("allowed", "memory_read_supported");
    // Controls and preferences are independent of ordinary text action authority.
    return {
      ...fact(
        config.memoryWrite ? "allowed" : "read_only",
        config.memoryWrite
          ? "memory_control_supported"
          : "adapter_memory_controls_read_only",
      ),
      enabled: m.prefs[operation],
    };
  };
  return {
    version: 1,
    subject: { ...subject },
    sources: {
      host: input.host.state,
      policy: input.policy.state,
      memory: input.memory.state,
      searchModel: input.searchModel.state,
      adapter: input.adapter.state,
    },
    capabilities: {
      "chat.web_search": search(),
      "memory.read": memory("read"),
      "memory.generation_control": memory("generate"),
      "memory.chat_search_control": memory("searchChats"),
      "code.native": mode("code", "native"),
      "code.cloud": mode("code", "cloud"),
      "cowork.native": mode("cowork", "native"),
      "cowork.cloud": mode("cowork", "cloud"),
    },
  };
}
export type CapabilityReadResult =
  | { status: 200; document: CapabilityDocument }
  | {
      status: 401 | 409 | 503;
      error: "signed_out" | "activation_changed" | "facts_unavailable";
    };
/** Lifetime-bound reader. The host supplies its already authorized source reads.
 * Raw session identities/tokens are never serialized into the document. */
export function createCapabilityDocumentReader(
  lease: {
    accountId: () => string | undefined;
    sessionIdentity: () => unknown;
    isCurrent?: () => boolean;
  },
  load: () => Promise<CapabilityInputs>,
) {
  const owner = lease.accountId(),
    activation = lease.sessionIdentity(),
    activationId = randomUUID();
  const current = () =>
    !!owner &&
    lease.accountId() === owner &&
    lease.sessionIdentity() === activation &&
    lease.isCurrent?.() !== false;
  let retired = false;
  return async (): Promise<CapabilityReadResult> => {
    if (!owner) return { status: 401, error: "signed_out" };
    if (retired || !current()) {
      retired = true;
      return { status: 409, error: "activation_changed" };
    }
    try {
      const input = await load();
      if (retired || !current()) {
        retired = true;
        return { status: 409, error: "activation_changed" };
      }
      return {
        status: 200,
        document: resolveCapabilityDocument(
          { accountId: owner, activationId },
          input,
        ),
      };
    } catch {
      if (retired || !current()) {
        retired = true;
        return { status: 409, error: "activation_changed" };
      }
      return { status: 503, error: "facts_unavailable" };
    }
  };
}
