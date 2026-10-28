import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppContext } from "../app/AppContext";
import type { PluginCatalog, PluginCopy } from "../../shared/collections-api";
import { officialMarketplace, pluginErrorText } from "./plugin-model";

export interface PluginsState {
  catalog?: PluginCatalog;
  loading: boolean;
  /** What went wrong loading the list; the runtime's own words. */
  failure?: string;
  /** The plugin id, or "marketplace", an action is running for. */
  busy?: string;
  reload: () => Promise<void>;
  install: (id: string) => Promise<string[]>;
  uninstall: (id: string) => Promise<void>;
  addMarketplace: (source: string) => Promise<void>;
  addOfficial: () => Promise<void>;
  removeMarketplace: (name: string) => Promise<void>;
  upgradeMarketplaces: (name?: string) => Promise<void>;
  setAutoSync: (name: string, enabled: boolean) => Promise<void>;
  /** Duplicate plugin (desktop): the copy's id and the apps it needs signed in. */
  duplicate?: (
    id: string,
    copy: PluginCopy,
  ) => Promise<{ id: string; appsNeedingAuth: string[] }>;
  /** Rename plugin (desktop, the person's own plugins): the new id. */
  rename?: (
    id: string,
    to: PluginCopy,
  ) => Promise<{ id: string; appsNeedingAuth: string[] }>;
}

/** Captures the authority of this render, including a controller that can retire without rendering. */
export function usePluginOwner() {
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = useMemo(
    () => ({
      bridge,
      account: app?.accountId,
      controller: app?.controllerScope,
      ref: app?.currentController,
    }),
    [bridge, app?.accountId, app?.controllerScope, app?.currentController],
  );
  const latest = useRef(scope);
  latest.current = scope;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ownsAccount = useCallback(() => {
    const controller = scope.ref?.current;
    return (
      latest.current === scope &&
      Boolean(bridge) &&
      typeof window !== "undefined" &&
      window.desktop === bridge &&
      (!scope.ref ||
        Boolean(
          controller &&
          controller.accountId === scope.account &&
          controller.controllerScope === scope.controller,
        ))
    );
  }, [bridge, scope]);
  const current = useCallback(
    () => mounted.current && ownsAccount(),
    [ownsAccount],
  );
  return { scope, bridge, current, ownsAccount };
}

export class PluginOperationRetired extends Error {
  readonly code = "PLUGIN_OPERATION_RETIRED";
  constructor() {
    super("Plugin operation no longer belongs to the current account.");
    this.name = "PluginOperationRetired";
  }
}
export function isPluginOperationRetired(
  error: unknown,
): error is PluginOperationRetired {
  return error instanceof PluginOperationRetired;
}

/** Async UI callbacks must check their own owner before reporting an operation's result. */
export function usePluginErrorReporter(onError: (error: unknown) => void) {
  const { current } = usePluginOwner();
  return (error: unknown) => {
    if (current() && !isPluginOperationRetired(error)) onError(error);
  };
}

/** Plugin reads and writes belong to the bridge/account/controller that initiated them. */
export function usePlugins(enabled = true): PluginsState {
  const owner = usePluginOwner();
  const { scope, bridge, current } = owner;
  type State = {
    scope: typeof scope;
    catalog?: PluginCatalog;
    loading: boolean;
    failure?: string;
    busy?: string;
  };
  const [state, setState] = useState<State>({ scope, loading: false });
  const loaded = useRef<typeof scope | undefined>(undefined);
  const listGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const load = useCallback(async () => {
    if (!current() || !bridge) return;
    const generation = ++listGeneration.current;
    const valid = () => current() && generation === listGeneration.current;
    setState((previous) => ({
      ...(previous.scope === scope ? previous : { scope }),
      loading: true,
    }));
    try {
      const catalog = await bridge.listPlugins();
      if (valid())
        setState((previous) => ({
          ...previous,
          scope,
          catalog,
          failure: undefined,
        }));
    } catch (error) {
      if (valid())
        setState((previous) => ({
          ...previous,
          scope,
          failure: pluginErrorText(error),
        }));
    } finally {
      if (valid()) setState((previous) => ({ ...previous, loading: false }));
    }
  }, [bridge, scope, current]);
  useEffect(() => {
    if (enabled && loaded.current !== scope && current()) {
      loaded.current = scope;
      void load();
    }
  }, [enabled, scope, current, load]);
  const run = useCallback(
    async <T>(
      key: string,
      action: (api: NonNullable<typeof bridge>) => Promise<T>,
    ): Promise<T> => {
      if (!current() || !bridge) throw new PluginOperationRetired();
      const generation = ++actionGeneration.current;
      setState((previous) => ({
        ...(previous.scope === scope ? previous : { scope, loading: false }),
        busy: key,
      }));
      try {
        const result = await action(bridge);
        if (!current()) throw new PluginOperationRetired();
        await load();
        if (!current()) throw new PluginOperationRetired();
        return result;
      } catch (error) {
        if (!current()) throw new PluginOperationRetired();
        await load();
        if (!current()) throw new PluginOperationRetired();
        throw error;
      } finally {
        if (current() && generation === actionGeneration.current)
          setState((previous) => ({ ...previous, busy: undefined }));
      }
    },
    [bridge, scope, current, load],
  );
  const visible =
    state.scope === scope && current() ? state : { loading: enabled };
  return {
    ...visible,
    reload: load,
    install: (id) =>
      run(id, async (api) => (await api.installPlugin(id)).appsNeedingAuth),
    uninstall: (id) => run(id, (api) => api.uninstallPlugin(id)),
    addMarketplace: (source) =>
      run("marketplace", (api) => api.addPluginMarketplace(source)),
    addOfficial: () =>
      run("marketplace", (api) =>
        api.addPluginMarketplace(officialMarketplace.source),
      ),
    removeMarketplace: (name) =>
      run("marketplace", (api) => api.removePluginMarketplace(name)),
    upgradeMarketplaces: (name) =>
      run(name ?? "marketplace", (api) => api.upgradePluginMarketplaces(name)),
    setAutoSync: (name, enabled) =>
      run(name, (api) => api.setPluginMarketplaceAutoSync(name, enabled)),
    duplicate:
      typeof bridge?.duplicatePlugin === "function"
        ? (id, copy) => run(id, (api) => api.duplicatePlugin(id, copy))
        : undefined,
    rename:
      typeof bridge?.renamePlugin === "function"
        ? (id, to) => run(id, (api) => api.renamePlugin(id, to))
        : undefined,
  };
}
