/** Concrete source loader for capability-document. It uses host-injected,
 * already authorized reads; never invokes an IPC name or refresh itself. */
import type { AdapterContext } from "./context";
import {
  pendingPolicy,
  type ClientPolicy,
} from "../../../shared/client-policy";
import type { MemoryStatus } from "../../../shared/memory-api";
import type { HostInfo } from "../../../shared/host";
import { modelProtocol } from "../../../shared/provider-routes";
import {
  createCapabilityDocumentReader,
  type CapabilityInputs,
  type CapabilitySource,
} from "./capability-document";

type CapabilityContext = Pick<
  AdapterContext,
  | "account"
  | "sessionIdentity"
  | "isCurrent"
  | "snapshot"
  | "settings"
  | "modelCatalog"
>;
export interface CapabilityAdapterSources {
  /** These callbacks reuse the host's current authorized read or cached value. */
  readPolicy: () => Promise<ClientPolicy | null | undefined>;
  /** Optional explicit cached-policy provenance; avoids treating a pending/offline fallback as an administrative denial. */
  readPolicySource?: () => Promise<CapabilitySource<ClientPolicy>>;
  readMemory: () => Promise<MemoryStatus | null | undefined>;
  /** Exact current official selector/conversation model, not a guessed default. */
  selectedModel: () => { providerId: string; modelId: string } | null;
  wiring: CapabilityInputs["adapter"];
  /** Only native window construction may supply its proven desktop HostInfo.
   * Never use this to replace a failed snapshot or to default a Web host. */
  nativeHost?: () => HostInfo | null;
}
const capture = async <T>(
  read: () => Promise<T | null | undefined>,
): Promise<CapabilitySource<T>> => {
  try {
    const value = await read();
    return value == null
      ? { state: "absent" }
      : { state: "ready", value: structuredClone(value) };
  } catch {
    return { state: "error" };
  }
};
/** Instantiate per authenticated activation, inside the adapter request scope. */
export function createAdapterCapabilityReader(
  ctx: CapabilityContext,
  sources: CapabilityAdapterSources,
) {
  // Source wiring is immutable for this reader lifetime; no mutable external
  // options may turn readonly facts into a permission grant between reads.
  const wiring = structuredClone(sources.wiring);
  return createCapabilityDocumentReader(
    {
      accountId: () => ctx.account()?.id,
      sessionIdentity: () => ctx.sessionIdentity?.(),
      isCurrent: () => ctx.isCurrent?.() !== false,
    },
    async () => {
      let selected: ReturnType<CapabilityAdapterSources["selectedModel"]> =
        null;
      let provider:
        | ReturnType<CapabilityContext["settings"]>["providers"][number]
        | undefined;
      let selectionFailed = false;
      try {
        const current = sources.selectedModel();
        selected = current ? { ...current } : null;
        const settings = ctx.settings();
        provider = selected
          ? structuredClone(
              settings.providers?.find((p) => p.id === selected!.providerId),
            )
          : undefined;
      } catch {
        selectionFailed = true;
      }
      const [host, policy, memory, catalog] = await Promise.all([
        capture(async () => {
          const snapshot = await ctx.snapshot();
          if (snapshot.host !== undefined) return snapshot.host;
          const native = sources.nativeHost?.();
          // An explicit fallback is only valid for a proven native host.
          if (native && native.kind !== "desktop")
            throw Error("Invalid native host source");
          return native ?? null;
        }),
        (async (): Promise<CapabilitySource<ClientPolicy>> => {
          try {
            if (sources.readPolicySource)
              return structuredClone(await sources.readPolicySource());
            const value = await sources.readPolicy();
            if (value === pendingPolicy) return { state: "pending" };
            return value == null
              ? { state: "absent" }
              : { state: "ready", value: structuredClone(value) };
          } catch {
            return { state: "error" };
          }
        })(),
        capture(sources.readMemory),
        capture(() => ctx.modelCatalog()),
      ]);
      let searchModel: CapabilityInputs["searchModel"];
      let changed = false;
      try {
        const now = sources.selectedModel();
        changed =
          now?.providerId !== selected?.providerId ||
          now?.modelId !== selected?.modelId;
      } catch {
        changed = true;
      }
      if (selectionFailed || changed || catalog.state === "error")
        searchModel = { state: "error" };
      else if (catalog.state === "pending") searchModel = { state: "pending" };
      else if (!selected || !provider || catalog.state === "absent")
        searchModel = { state: "absent" };
      else {
        const item = catalog.value.items?.find(
          (m) => m.id === selected!.modelId,
        );
        // Both the real selected provider and the account catalog must know the
        // model. A catalog entry alone cannot establish which route will execute.
        const listed =
          provider.model === selected.modelId ||
          provider.models?.includes(selected.modelId) ||
          provider.routes?.some((r) => r.models.includes(selected!.modelId));
        if (!item || !listed) searchModel = { state: "absent" };
        else
          searchModel = {
            state: "ready",
            value: {
              modelId: item.id,
              protocol: modelProtocol(provider, item.id),
              webSearch: item.webSearch,
            },
          };
      }
      return {
        host,
        policy,
        memory,
        searchModel,
        adapter: structuredClone(wiring),
      };
    },
  );
}

/** Lifetime reader result type for context/route integration. */
export type AdapterCapabilityReader = ReturnType<
  typeof createAdapterCapabilityReader
>;
