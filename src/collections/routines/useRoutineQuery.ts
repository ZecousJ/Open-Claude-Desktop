import { useCallback, useEffect, useRef, useState } from "react";
import {
  routineReadFailure,
  validRoutineListResult,
  type RoutineDetailResult,
  type RoutineListResult,
} from "../../../shared/routines";

type Bridge = Window["desktop"];
type Owner = unknown;
type ListState = RoutineListResult & {
  loading: boolean;
  retrying: boolean;
  owner: Owner;
  bridge: Bridge;
};

/** New builds retain per-source outcomes. Old bridges keep their real array
 * API; a rejection is never converted into an empty successful list. */
export async function readRoutineList(
  bridge: Bridge,
  remote: boolean,
): Promise<RoutineListResult> {
  if (typeof bridge.querySchedules === "function") {
    const value = await bridge.querySchedules();
    if (!validRoutineListResult(value))
      throw new Error("Couldn’t load scheduled tasks");
    return value;
  }
  const tasks = await bridge.listSchedules();
  if (!Array.isArray(tasks)) throw new Error("Couldn’t load scheduled tasks");
  return {
    tasks,
    sources: [{ source: remote ? "remote" : "local", status: "ready" }],
  };
}

export function useRoutineQuery(
  enabled: boolean,
  owner: Owner,
  remote: boolean,
) {
  const bridge = window.desktop;
  const live = useRef({ owner, bridge, generation: 0, mounted: true });
  if (live.current.owner !== owner || live.current.bridge !== bridge) {
    live.current = {
      owner,
      bridge,
      generation: live.current.generation + 1,
      mounted: true,
    };
  }
  const [state, setState] = useState<ListState>({
    owner,
    bridge,
    tasks: [],
    sources: [],
    loading: enabled,
    retrying: false,
  });
  const inFlight = useRef<
    | { owner: Owner; bridge: Bridge; promise: Promise<void>; dirty?: boolean }
    | undefined
  >(undefined);
  const refresh: () => Promise<void> = useCallback((): Promise<void> => {
    if (
      !enabled ||
      !live.current.mounted ||
      live.current.owner !== owner ||
      live.current.bridge !== bridge
    )
      return Promise.resolve();
    if (
      inFlight.current &&
      inFlight.current.owner === owner &&
      inFlight.current.bridge === bridge
    )
      return inFlight.current.promise;
    const generation = live.current.generation;
    const valid = () =>
      live.current.mounted &&
      live.current.owner === owner &&
      live.current.bridge === bridge &&
      live.current.generation === generation &&
      window.desktop === bridge;
    setState((previous) => ({
      ...(previous.owner === owner && previous.bridge === bridge
        ? previous
        : { owner, bridge, tasks: [], sources: [], loading: true }),
      retrying: true,
    }));
    const promise = readRoutineList(bridge, remote)
      .then(
        (result) => {
          if (valid())
            setState({
              ...result,
              owner,
              bridge,
              loading: false,
              retrying: false,
            });
        },
        (error) => {
          if (valid())
            setState((previous) => ({
              ...previous,
              loading: false,
              retrying: false,
              sources: (previous.sources.length
                ? previous.sources
                : [
                    {
                      source: remote ? ("remote" as const) : ("local" as const),
                      status: "ready" as const,
                    },
                  ]
              ).map((source) => ({
                ...source,
                status: routineReadFailure(error),
                message: error instanceof Error ? error.message : undefined,
              })),
            }));
        },
      )
      .finally(() => {
        if (inFlight.current?.promise === promise) {
          const dirty = inFlight.current.dirty;
          inFlight.current = undefined;
          if (dirty && valid()) void refresh();
        }
      });
    inFlight.current = { owner, bridge, promise };
    return promise;
  }, [enabled, owner, bridge, remote]);
  useEffect(() => {
    live.current.mounted = true;
    void refresh();
    const stop = enabled
      ? bridge.onEvent((event) => {
          if (
            [
              "schedules",
              "conversation",
              "approval",
              "approval-resolved",
              "resync",
            ].includes(event.type)
          ) {
            if (
              inFlight.current &&
              inFlight.current.owner === owner &&
              inFlight.current.bridge === bridge
            )
              inFlight.current.dirty = true;
            else void refresh();
          }
        })
      : undefined;
    return () => {
      live.current.mounted = false;
      live.current.generation++;
      if (
        inFlight.current &&
        inFlight.current.owner === owner &&
        inFlight.current.bridge === bridge
      )
        inFlight.current = undefined;
      stop?.();
    };
  }, [refresh]);
  const visible =
    enabled && state.owner === owner && state.bridge === bridge
      ? state
      : {
          owner,
          bridge,
          tasks: [],
          sources: [],
          loading: enabled,
          retrying: false,
        };
  return { ...visible, refresh };
}

type DetailState = {
  owner: Owner;
  bridge: Bridge;
  id?: string;
  value: RoutineDetailResult | { status: "loading" };
};
export function useRoutineDetail(id: string | undefined, owner: Owner) {
  const bridge = window.desktop;
  const live = useRef({ owner, bridge, id, revision: 0, mounted: true });
  if (
    live.current.owner !== owner ||
    live.current.bridge !== bridge ||
    live.current.id !== id
  )
    live.current = {
      owner,
      bridge,
      id,
      revision: live.current.revision + 1,
      mounted: true,
    };
  const [state, setState] = useState<DetailState>({
    owner,
    bridge,
    id,
    value: { status: "loading" },
  });
  const refresh = useCallback(async () => {
    if (
      !id ||
      live.current.owner !== owner ||
      live.current.bridge !== bridge ||
      live.current.id !== id ||
      !live.current.mounted
    )
      return;
    const revision = ++live.current.revision;
    const valid = () =>
      live.current.mounted &&
      live.current.owner === owner &&
      live.current.bridge === bridge &&
      live.current.id === id &&
      live.current.revision === revision &&
      window.desktop === bridge;
    // A background refresh after an edit/toggle keeps its loaded surface;
    // only a new route or a failed read's explicit retry needs the loader.
    setState((previous) =>
      previous.owner === owner &&
      previous.bridge === bridge &&
      previous.id === id &&
      previous.value.status === "ready"
        ? previous
        : { owner, bridge, id, value: { status: "loading" } },
    );
    let value: RoutineDetailResult;
    try {
      if (typeof bridge.readSchedule === "function")
        value = await bridge.readSchedule(id);
      else {
        const tasks = await bridge.listSchedules();
        if (!Array.isArray(tasks))
          throw new Error("Couldn’t load scheduled tasks");
        const task = tasks.find((task) => task.id === id);
        value = task ? { status: "ready", task } : { status: "missing" };
      }
      if (
        !value ||
        !["ready", "missing", "refused", "error"].includes(value.status) ||
        (value.status === "ready" && value.task?.id !== id)
      )
        throw new Error("Couldn’t load scheduled tasks");
    } catch (error) {
      value = {
        status: routineReadFailure(error),
        message: error instanceof Error ? error.message : undefined,
      };
    }
    if (valid()) setState({ owner, bridge, id, value });
  }, [id, owner, bridge]);
  useEffect(() => {
    live.current.mounted = true;
    void refresh();
    return () => {
      live.current.mounted = false;
      live.current.revision++;
    };
  }, [refresh]);
  const visible =
    state.owner === owner && state.bridge === bridge && state.id === id
      ? state.value
      : { status: "loading" as const };
  return { ...visible, refresh };
}
