import {
  createElement,
  useEffect,
  useId,
  useSyncExternalStore,
  type ComponentType,
} from "react";
import {
  createPieceStore,
  errorStateOf,
  isQuietPhase,
  reloadsPage,
  type ChunkErrorState,
  type PieceStore,
  type RecoveryEnv,
} from "../app/chunk-recovery";

/**
 * A lazily loaded piece of the interface that shows its own load failure in its
 * place, as each lazily loaded component does in the original: "Couldn’t load
 * this." with Retry, "Claudex was updated. Reload to continue." when a newer
 * build replaced its script, "Couldn’t load this. Reload the page to continue."
 * with Reload once retrying cannot help, and "You’re offline." while the
 * network is gone. While it loads or retries on its own it suspends, so the
 * caller's Suspense fallback shows, as React.lazy does. A failure that is not a
 * load failure goes to the nearest error boundary.
 *
 * `lazyPiece( => import("./Thing"))` takes the default export; `lazyPiece( =>
 * import("./things"), "Thing")` a named one.
 */
export interface LazyPieceOptions {
  /**
   * The piece is invisible decoration (an overlay, a mirror, a host for
   * menus): a failure leaves it out instead of putting words in its place
   * (the original's noFallback pieces).
   */
  silent?: boolean;
  /** For tests. */
  env?: RecoveryEnv;
}

export function lazyPiece<M, K extends keyof M = "default" & keyof M>(
  load: () => Promise<M>,
  name?: K,
  options: LazyPieceOptions = {},
): M[K] {
  const key = (name ?? "default") as K;
  const store = createPieceStore<ComponentType<object>>(
    load,
    (module) => {
      const found =
        module && typeof module === "object"
          ? (module as Record<PropertyKey, unknown>)[key as PropertyKey]
          : undefined;
      return typeof found === "function" ||
        (typeof found === "object" && found !== null)
        ? (found as ComponentType<object>)
        : undefined;
    },
    options.env,
  );
  function LazyPiece(props: object) {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.snapshot,
      store.snapshot,
    );
    const loaded = store.loaded();
    if (snapshot.phase === "loaded" && loaded)
      return createElement(loaded, props);
    if (snapshot.phase === "declined") throw snapshot.error;
    if (isQuietPhase(snapshot.phase)) {
      store.start();
      throw store.settled();
    }
    return options.silent ? null : <PieceError store={store} />;
  }
  LazyPiece.displayName = `LazyPiece(${String(key)})`;
  LazyPiece.preload = () => {
    store.start();
    return store.settled();
  };
  return LazyPiece as M[K];
}

/** Starts loading a lazyPiece ahead of its first render; settles once it is in. */
export function preloadPiece(piece: unknown): Promise<unknown> {
  const preload = (piece as { preload?: () => Promise<unknown> }).preload;
  return preload ? preload() : Promise.resolve();
}

function PieceError({ store }: { store: PieceStore<unknown> }) {
  const id = useId();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const announcer = useSyncExternalStore(
    store.subscribe,
    store.announcer,
    store.announcer,
  );
  // One rendering of a piece shown in several places announces it.
  useEffect(() => {
    store.claimAnnouncer(id);
    return () => store.releaseAnnouncer(id);
  }, [store, id]);
  const state = errorStateOf(snapshot);
  if (!state) return null;
  return (
    <ChunkErrorView
      state={state}
      busy={snapshot.phase === "reloading"}
      announce={announcer === id}
      onRetry={store.retry}
      onReload={store.reload}
    />
  );
}

const copy: Record<ChunkErrorState, string> = {
  retry: "Couldn’t load this.",
  waiting: "You’re offline.",
  "waiting-reload": "You’re offline.",
  updated: "Claudex was updated. Reload to continue.",
  reload: "Couldn’t load this. Reload the page to continue.",
};

/**
 * The in-place view (live: `PV` without a placeholder): a centred row that
 * wraps, the sentence in the muted body text and a small secondary button,
 * Reload or Retry. The sentence is a polite live region on the one
 * rendering that announces.
 */
export function ChunkErrorView({
  state,
  busy = false,
  announce = true,
  onRetry,
  onReload,
}: {
  state: ChunkErrorState;
  busy?: boolean;
  announce?: boolean;
  onRetry: () => void;
  onReload: () => void;
}) {
  const reload = reloadsPage(state);
  return (
    <div className="chunk-error" data-chunk-error={state}>
      <span
        key={announce ? "live" : "quiet"}
        role={announce ? "status" : undefined}
      >
        {copy[state]}
      </span>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={reload ? onReload : onRetry}
      >
        {reload ? "Reload" : "Retry"}
      </button>
    </div>
  );
}
