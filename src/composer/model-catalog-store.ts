import type { ModelCatalog } from "../../shared/model-catalog-api";

export type ModelCatalogReadState = {
  status: "pending" | "ready" | "error";
  /** undefined has never succeeded; null is a successful no-catalog result. */
  value: ModelCatalog | null | undefined;
};

type Bridge = Pick<Window["desktop"], "modelCatalog" | "onEvent">;
const pending: ModelCatalogReadState = { status: "pending", value: undefined };

/** One account's read; replies from superseded reads or detached hosts cannot
 * update either its visible state or its cache. */
export function createModelCatalogStore(bridge: Bridge | undefined) {
  let state = pending;
  let generation = 0;
  let off: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ModelCatalogReadState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const retry = () => {
    if (!bridge || !listeners.size) return;
    const request = ++generation;
    if (state.status !== "pending")
      publish({ status: "pending", value: state.value });
    void Promise.resolve()
      .then(() => bridge.modelCatalog())
      .then(
        (value) => {
          if (request === generation && listeners.size)
            publish({ status: "ready", value });
        },
        () => {
          if (request === generation && listeners.size)
            publish({ status: "error", value: state.value });
        },
      );
  };
  return {
    snapshot: () => state,
    serverSnapshot: () => pending,
    retry,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        off = bridge?.onEvent?.((event) => {
          if (
            event.type === "settings" ||
            event.type === "policy" ||
            event.type === "service-changed"
          )
            retry();
        });
        retry();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++;
          off?.();
          off = undefined;
        }
      };
    },
  };
}

const stores = new WeakMap<
  Bridge,
  Map<string, ReturnType<typeof createModelCatalogStore>>
>();
const server = createModelCatalogStore(undefined);
export function modelCatalogStore(
  bridge: Bridge | undefined,
  accountId: string,
) {
  if (!bridge) return server;
  let accounts = stores.get(bridge);
  if (!accounts) stores.set(bridge, (accounts = new Map()));
  let store = accounts.get(accountId);
  if (!store)
    accounts.set(accountId, (store = createModelCatalogStore(bridge)));
  return store;
}
