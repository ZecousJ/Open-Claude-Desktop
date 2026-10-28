import { t, useLocale } from "../../i18n";
import { fullTime } from "../../ui/RelativeTime";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import { Menu } from "../../ui/Menu";
import { type Routine, type RoutineRunPage } from "../../../shared/routines";
import { type RoutineRun } from "../../../shared/routine-labels";
import { useHost } from "../../host/HostContext";
import { AppContext } from "../../app/AppContext";
import { cardRunTime } from "./routine-list";
import {
  acknowledgeRoutineRun,
  onRoutineReadUpdate,
} from "./routine-read-receipts";
import "./routine-history.css";
import { RoutineRunRow, validRoutineRunPage } from "./RoutineRunRow";

export const skippedRunReason = (run: RoutineRun) =>
  run.skipReason === "in_progress"
    ? "The previous run was still in progress."
    : run.skipReason === "sign_in"
      ? "You needed to sign in again."
      : run.skipReason === "busy"
        ? "Other scheduled tasks were already running."
        : "Scheduled tasks only run while your computer is awake and online.";

/**
 * A run's valid destination remains usable when its read receipt fails. The
 * official row has an href plus a separate onSessionOpen callback.
 */
export function openRoutineRun(
  routineId: string,
  run: RoutineRun,
  onOpen: (id: string) => void,
  acknowledge: (routineId: string, runId: string) => Promise<void>,
  onRead: () => void,
  onError: (reason: unknown) => void,
) {
  if (!run.conversationId) return Promise.resolve();
  onOpen(run.conversationId);
  // Opening a still-running run cannot pre-read its eventual completion.
  if (run.status !== "completed" || run.readAt) return Promise.resolve();
  return acknowledgeRoutineRun(routineId, run.id, acknowledge).then(
    onRead,
    onError,
  );
}

export function HistoryTime({ startedAt }: { startedAt: number }) {
  useLocale();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (
    !Number.isFinite(startedAt) ||
    Number.isNaN(new Date(startedAt).getTime())
  )
    return null;
  return (
    <time
      dateTime={new Date(startedAt).toISOString()}
      title={fullTime(startedAt)}
    >
      {cardRunTime(startedAt, now, false, "past")}
    </time>
  );
}

export function RoutineHistory({
  routine,
  onOpenConversation,
  emptyRunAction,
}: {
  routine: Routine;
  onOpenConversation: (id: string) => void;
  /** Source ccd3f68fe:3040–3068: only an eligible unified empty history
   * without a primary frame-header action receives this callback. */
  emptyRunAction?: {
    onRun: () => void;
    running: boolean;
    disabled: boolean;
    reason?: string;
  };
}) {
  useLocale();
  const host = useHost();
  const web = host.kind === "web";
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  // Task IDs are only unique inside the current account/backend. A same-ID
  // replacement must load its own history and cannot reuse old callbacks.
  const scope = useMemo(
    () => ({}),
    [
      routine.id,
      routine.executionLocation,
      routine.mode,
      routine.environment?.kind,
      routine.environment?.kind === "ssh"
        ? routine.environment.hostId
        : undefined,
      app?.accountId,
      app?.controllerScope,
      bridge,
      host.kind,
    ],
  );
  const latest = useRef(scope);
  const active = useRef(false);
  const latestRunAction = useRef(emptyRunAction);
  latestRunAction.current = emptyRunAction;
  latest.current = scope;
  const valid = () =>
    active.current &&
    latest.current === scope &&
    typeof window !== "undefined" &&
    window.desktop === bridge &&
    (!app?.currentController ||
      (app.currentController.current?.accountId === app.accountId &&
        app.currentController.current.controllerScope === app.controllerScope &&
        app.currentController.current.page === app.page));
  const [runs, setRuns] = useState<RoutineRun[]>();
  const [loadError, setLoadError] = useState("");
  const [receiptError, setReceiptError] = useState<{
    runId: string;
    message: string;
  }>();
  const [pageError, setPageError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paged, setPaged] = useState(false);
  const actions = useRef<
    { load(): Promise<void>; more(): Promise<void> } | undefined
  >(undefined);
  const owner = useRef(scope);
  const shownRuns = owner.current === scope ? runs : undefined;
  const error =
    owner.current === scope
      ? loadError || pageError || receiptError?.message || ""
      : "";
  const [shown, setShown] = useState(100);
  const [filterMenu, setFilterMenu] = useState<{
    scope: object;
    rect: DOMRect;
  }>();
  const filterButton = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<{
    scope: object;
    trigger: "all" | RoutineRun["trigger"];
    status: "all" | "running" | "completed" | "failed" | "skipped";
  }>({ scope, trigger: "all", status: "all" });
  const currentFilter =
    filter.scope === scope && routine.mode === "code"
      ? filter
      : { scope, trigger: "all" as const, status: "all" as const };
  const filtered =
    currentFilter.trigger !== "all" || currentFilter.status !== "all";
  const visibleRuns = shownRuns?.filter(
    (run) =>
      (currentFilter.trigger === "all" ||
        currentFilter.trigger === run.trigger) &&
      (currentFilter.status === "all" ||
        currentFilter.status === run.status ||
        (currentFilter.status === "running" && run.status === "starting") ||
        (currentFilter.status === "failed" && run.status === "interrupted")),
  );
  const closeFilter = () => {
    setFilterMenu(undefined);
    filterButton.current?.focus();
  };
  const optimisticReads = useRef(new Map<string, number>());
  const confirmedReads = useRef(new Map<string, number>());
  useEffect(() => {
    if (!bridge) return;
    active.current = true;
    let live = true;
    let loadGeneration = 0;
    let loadedPages = 1;
    let nextCursor: string | undefined;
    let morePending = false;
    let refreshPending = false;
    let loadedCursors = new Set<string>();
    const current = () => live && valid();
    const pageApi = typeof bridge.routineRunsPage === "function";
    owner.current = scope;
    optimisticReads.current.clear();
    confirmedReads.current.clear();
    setRuns(undefined);
    setLoadError("");
    setReceiptError(undefined);
    setShown(100);
    setPageError("");
    setHasMore(false);
    setLoadingMore(false);
    setPaged(pageApi);
    const reconcile = (value: RoutineRun[]) =>
      value.map((run) => {
        if (run.readAt) {
          confirmedReads.current.set(run.id, run.readAt);
          optimisticReads.current.delete(run.id);
          return run;
        }
        const readAt =
          confirmedReads.current.get(run.id) ??
          optimisticReads.current.get(run.id);
        return readAt && run.status === "completed" ? { ...run, readAt } : run;
      });
    const page = async (
      cursor: string | undefined,
      generation: number,
    ): Promise<RoutineRunPage> => {
      const value: unknown = await bridge.routineRunsPage(routine.id, {
        cursor,
        limit: 100,
      });
      if (!current() || generation !== loadGeneration) return { runs: [] };
      if (
        !validRoutineRunPage(value) ||
        (cursor && value.nextCursor === cursor)
      )
        throw new Error(t("Couldn’t load runs. Try again."));
      return value;
    };
    const load = async (force = true) => {
      if (!current() || (!force && refreshPending)) return;
      const generation = ++loadGeneration;
      refreshPending = true;
      setRefreshing(true);
      morePending = false;
      setLoadingMore(false);
      try {
        let value: RoutineRun[];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        if (pageApi) {
          value = [];
          for (let index = 0; index < loadedPages; index++) {
            if (!current() || generation !== loadGeneration) return;
            const result = await page(cursor, generation);
            if (result.nextCursor && cursors.has(result.nextCursor))
              throw new Error(t("Couldn’t load runs. Try again."));
            if (result.nextCursor) cursors.add(result.nextCursor);
            value = mergeRuns(value, result.runs);
            cursor = result.nextCursor;
            if (!cursor) break;
          }
        } else value = await bridge.routineRuns(routine.id);
        if (current() && generation === loadGeneration) {
          nextCursor = cursor;
          setRuns(reconcile(value));
          setLoadError("");
          setPageError("");
          setHasMore(Boolean(cursor));
          loadedCursors = cursors;
        }
      } catch (reason) {
        if (current() && generation === loadGeneration) {
          setRuns((previous) => previous ?? []);
          setLoadError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      } finally {
        if (current() && generation === loadGeneration) {
          refreshPending = false;
          setRefreshing(false);
        }
      }
    };
    const more = async () => {
      if (
        !current() ||
        !pageApi ||
        morePending ||
        refreshPending ||
        !nextCursor
      )
        return;
      morePending = true;
      const generation = ++loadGeneration;
      const cursor = nextCursor;
      setLoadingMore(true);
      setPageError("");
      try {
        const value = await page(cursor, generation);
        if (value.nextCursor && loadedCursors.has(value.nextCursor))
          throw new Error(t("Couldn’t load runs. Try again."));
        if (!current() || generation !== loadGeneration) return;
        const runs = reconcile(value.runs);
        setRuns((previous) => mergeRuns(previous ?? [], runs));
        nextCursor = value.nextCursor;
        if (nextCursor) loadedCursors.add(nextCursor);
        loadedPages++;
        setHasMore(Boolean(nextCursor));
      } catch (reason) {
        if (current() && generation === loadGeneration)
          setPageError(
            reason instanceof Error ? reason.message : String(reason),
          );
      } finally {
        if (current() && generation === loadGeneration) {
          morePending = false;
          setLoadingMore(false);
        }
      }
    };
    const activeActions = { load: () => load(false), more };
    actions.current = activeActions;
    void load();
    const off = bridge.onEvent((event) => {
      if (event.type === "schedules") void load();
    });
    const offRead = onRoutineReadUpdate(routine.id, (update) => {
      if (!current()) return;
      const optimistic = optimisticReads.current.get(update.runId);
      optimisticReads.current.delete(update.runId);
      if ("readAt" in update) {
        const readAt =
          confirmedReads.current.get(update.runId) ?? update.readAt;
        confirmedReads.current.set(update.runId, readAt);
        setRuns((values) =>
          values?.map((run) =>
            run.id === update.runId && run.status === "completed"
              ? { ...run, readAt }
              : run,
          ),
        );
        setReceiptError((value) =>
          value?.runId === update.runId ? undefined : value,
        );
      } else {
        setRuns((values) =>
          values?.map((run) =>
            run.id === update.runId &&
            optimistic &&
            run.readAt === optimistic &&
            !confirmedReads.current.has(run.id)
              ? { ...run, readAt: undefined }
              : run,
          ),
        );
        setReceiptError({
          runId: update.runId,
          message:
            update.error instanceof Error
              ? update.error.message
              : String(update.error),
        });
      }
    });
    return () => {
      active.current = false;
      live = false;
      loadGeneration++;
      if (actions.current === activeActions) actions.current = undefined;
      off();
      offRead();
    };
  }, [scope]);
  const open = (run: RoutineRun) => {
    if (!bridge || !valid() || owner.current !== scope) return;
    if (run.status === "completed" && !run.readAt) {
      const stamp = Date.now();
      optimisticReads.current.set(run.id, stamp);
      setRuns((values) =>
        values?.map((value) =>
          value.id === run.id ? { ...value, readAt: stamp } : value,
        ),
      );
    }
    return openRoutineRun(
      routine.id,
      run,
      onOpenConversation,
      (id, runId) => bridge.markRoutineRunRead(id, runId),
      () => {},
      () => {},
    );
  };
  return (
    <div className={`routine-history${web ? " routine-history-web" : ""}`}>
      {error && (
        <p className="routine-error" role="alert">
          {error}
          {loadError && (
            <>
              {" "}
              <button
                type="button"
                className="secondary"
                disabled={refreshing}
                onClick={() => void actions.current?.load()}
              >
                {t("Retry")}
              </button>
            </>
          )}
          {!loadError && pageError && (
            <>
              {" "}
              <button
                type="button"
                className="secondary"
                disabled={refreshing}
                onClick={() => void actions.current?.load()}
              >
                {t("Refresh")}
              </button>
            </>
          )}
        </p>
      )}
      {shownRuns === undefined ? (
        <div className="routine-history-loading" aria-label="Loading runs">
          <Spinner inheritColor size={16} className="spin" />
        </div>
      ) : shownRuns.length ? (
        <>
          {routine.mode === "code" && (
            <div className="routine-history-toolbar">
              <button
                ref={filterButton}
                type="button"
                className="ghost"
                aria-label={t("Filter runs")}
                aria-haspopup="menu"
                aria-expanded={filterMenu?.scope === scope}
                aria-pressed={filtered}
                onClick={(event) =>
                  setFilterMenu({
                    scope,
                    rect: event.currentTarget.getBoundingClientRect(),
                  })
                }
              >
                <AppIcon name="Filter" size={16} />
              </button>
            </div>
          )}
          {visibleRuns?.length === 0 ? (
            <p className="routine-history-no-results" role="status">
              {t("No loaded runs match these filters.")}{" "}
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setFilter({ scope, trigger: "all", status: "all" })
                }
              >
                {t("Clear filters")}
              </button>
            </p>
          ) : (
            <ul className="routine-history-list">
              {(paged ? visibleRuns! : visibleRuns!.slice(0, shown)).map(
                (run) => (
                  <RoutineRunRow
                    key={run.id}
                    run={run}
                    href={
                      run.conversationId
                        ? `${routine.mode === "code" ? "/code" : "/chat"}/${encodeURIComponent(run.conversationId)}`
                        : undefined
                    }
                    local={
                      web
                        ? routine.executionLocation === "local"
                        : routine.executionLocation !== "remote"
                    }
                    onOpen={(value) => void open(value)}
                  />
                ),
              )}
            </ul>
          )}
          {(paged ? hasMore : visibleRuns!.length > shown) && (
            <button
              className="routine-history-more"
              disabled={loadingMore || refreshing || Boolean(loadError)}
              onClick={() =>
                paged ? void actions.current?.more() : setShown(shown + 100)
              }
            >
              {loadingMore
                ? t("Loading more runs…")
                : pageError
                  ? t("Retry")
                  : t("Show more")}
            </button>
          )}
        </>
      ) : (
        !error && (
          <div
            className="routine-history-empty"
            data-testid="routine-history-empty"
          >
            <p>{t(routine.lastRunAt ? "No runs to show" : "No runs yet")}</p>
            {emptyRunAction && (
              <button
                type="button"
                className="secondary routine-history-run"
                disabled={emptyRunAction.disabled || emptyRunAction.running}
                aria-busy={emptyRunAction.running || undefined}
                title={emptyRunAction.reason}
                onClick={() => {
                  if (
                    valid() &&
                    latestRunAction.current === emptyRunAction &&
                    !emptyRunAction.disabled &&
                    !emptyRunAction.running
                  )
                    emptyRunAction.onRun();
                }}
              >
                {emptyRunAction.running ? (
                  <Spinner inheritColor size={16} className="spin" />
                ) : (
                  <AppIcon name="Play" size={16} />
                )}
                {t("Run now")}
              </button>
            )}
          </div>
        )
      )}
      {filterMenu?.scope === scope && (
        <Menu
          label={t("Filter runs")}
          width={180}
          anchors={[filterButton]}
          position={{
            left: Math.max(8, filterMenu.rect.right - 180),
            top: filterMenu.rect.bottom + 6,
          }}
          onClose={closeFilter}
          entries={[
            {
              label: "Trigger",
              submenu: (["all", "schedule", "manual"] as const).map(
                (trigger) => ({
                  label:
                    trigger === "all"
                      ? "All"
                      : trigger === "schedule"
                        ? "Scheduled"
                        : "Manual",
                  checked: currentFilter.trigger === trigger,
                  checkedRole: "radio" as const,
                  onSelect: () => {
                    if (valid()) setFilter({ ...currentFilter, trigger });
                  },
                }),
              ),
            },
            { separator: true },
            {
              label: "Status",
              submenu: (
                ["all", "running", "completed", "failed", "skipped"] as const
              ).map((status) => ({
                label:
                  status === "all"
                    ? "All"
                    : status === "running"
                      ? "Running"
                      : status === "completed"
                        ? "Completed"
                        : status === "failed"
                          ? "Failed"
                          : "Skipped",
                checked: currentFilter.status === status,
                checkedRole: "radio" as const,
                onSelect: () => {
                  if (valid()) setFilter({ ...currentFilter, status });
                },
              })),
            },
          ]}
        />
      )}
    </div>
  );
}

function mergeRuns(previous: RoutineRun[], next: RoutineRun[]) {
  const runs = new Map(previous.map((run) => [run.id, run]));
  for (const run of next) runs.set(run.id, run);
  return [...runs.values()];
}
