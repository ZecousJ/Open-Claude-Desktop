import { isChunkLoadError } from "./load-failure";
import {
  assetVerdict,
  failedScriptUrl,
  isStylesheetFailure,
  type AssetVerdict,
} from "./chunk-status";

/**
 * How one lazily loaded piece recovers when its script does not arrive, after
 * the original's inline chunk recovery:
 *
 * - the first failure retries once on its own, quietly (the piece's loading
 *   state stays), waiting for the network to come back and the window to be
 *   visible, and at least 3 s after either;
 * - when that retry fails, or is still out after 3 s, the piece says "Couldn’t
 *   load this." with Retry; a retry that fails too says "Couldn’t load this.
 *   Reload the page to continue." with Reload;
 * - a file a newer build removed says "Claude was updated. Reload to continue."
 *   with Reload; a stylesheet, or something the script needs, that failed goes
 *   straight to Reload (a retry would fail the same way);
 * - offline for 2 s while waiting, it says "You’re offline." and carries on by
 *   itself once the network is back;
 * - a failure that is not a load failure (the piece's own code threw) is not
 *   this piece's to recover: it goes to the nearest error boundary.
 *
 * A retry first asks for the script again; a browser that remembers the failed
 * import is then sent the same file under a fresh address (`?cb=r1`), as the
 * original does, and the piece is taken from it only when it has the expected
 * export.
 */

export type PiecePhase =
  /** Not asked for yet. */
  | "idle"
  /** Quiet: the first load, or a retry the piece started on its own. */
  | "loading"
  | "auto_retry"
  /** Quiet: a retry the person asked for. */
  | "retrying"
  | "loaded"
  /** "Couldn’t load this." + Retry. */
  | "show_retry"
  /** "You’re offline." + Retry (or Reload, when a reload is waiting). */
  | "waiting"
  /** Reload is the way on. */
  | "reload_only"
  /** Reload pressed; the page is reloading. */
  | "reloading"
  /** Not a load failure: thrown to the nearest boundary. */
  | "declined";

export interface PieceSnapshot {
  phase: PiecePhase;
  /** For reload_only and reloading: a newer build, or a failure to load. */
  reason?: "updated" | "couldnt_load";
  /** For waiting: what happens when the network is back. */
  waitingFor?: "retry" | "reload";
  /** For declined: the error the piece's code threw. */
  error?: unknown;
}

/** The four in-place states of the original's error view. */
export type ChunkErrorState =
  "retry" | "waiting" | "waiting-reload" | "updated" | "reload";

/** Phases that keep the piece's loading state (its Suspense fallback). */
export function isQuietPhase(phase: PiecePhase): boolean {
  return (
    phase === "idle" ||
    phase === "loading" ||
    phase === "auto_retry" ||
    phase === "retrying"
  );
}

/** Which in-place view a failed piece shows (the original's renderPhase). */
export function errorStateOf(
  snapshot: PieceSnapshot,
): ChunkErrorState | undefined {
  switch (snapshot.phase) {
    case "waiting":
      return snapshot.waitingFor === "reload" ? "waiting-reload" : "waiting";
    case "show_retry":
      return "retry";
    case "reload_only":
    case "reloading":
      return snapshot.reason === "updated" ? "updated" : "reload";
    default:
      return undefined;
  }
}

/** States whose button reloads the page rather than retrying the piece. */
export function reloadsPage(state: ChunkErrorState): boolean {
  return (
    state === "reload" || state === "updated" || state === "waiting-reload"
  );
}

/** Timings from the original. */
export const RECOVERY_TIMINGS = {
  /** A retry still out after this shows Retry. */
  showRetryMs: 3000,
  /** Offline this long while waiting shows "You’re offline.". */
  offlineGraceMs: 2000,
  /** A retry waits this long after the network or the window comes back. */
  settleMs: 3000,
  /** A retry that has not answered by now is given up as a network failure. */
  attemptTimeoutMs: 3500,
  /** A failure that came this quickly waits this long before its retry. */
  quickFailureMs: 400,
  /** At most this many retries before Reload is the only way on. */
  maxRetries: 2,
} as const;

/** What the store needs from the window, swapped out in tests. */
export interface RecoveryEnv {
  online(): boolean;
  hidden(): boolean;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** Calls `run` once when the network is back; returns a cancel. */
  whenOnline(run: () => void): () => void;
  /** Calls `run` once when the window is visible again; returns a cancel. */
  whenVisible(run: () => void): () => void;
  /** The last time the network or the window came back (ms, `now()` clock). */
  lastResume(): number;
  /** Imports a script by address (a cache-busted retry). */
  importUrl(url: string): Promise<unknown>;
  /** Asks the server about the file a failure names. */
  verdict(error: unknown): Promise<AssetVerdict>;
  reload(): void;
}

let lastResume = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("online", () => {
    lastResume = performance.now();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") lastResume = performance.now();
  });
}

function once(
  target: EventTarget | undefined,
  type: string,
  ready: () => boolean,
  run: () => void,
): () => void {
  if (!target) return () => undefined;
  const listener = () => {
    if (!ready()) return;
    target.removeEventListener(type, listener);
    run();
  };
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

export const browserEnv: RecoveryEnv = {
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  hidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  whenOnline: (run) =>
    once(
      typeof window === "undefined" ? undefined : window,
      "online",
      () => navigator.onLine !== false,
      run,
    ),
  whenVisible: (run) =>
    once(
      typeof document === "undefined" ? undefined : document,
      "visibilitychange",
      () => document.visibilityState !== "hidden",
      run,
    ),
  lastResume: () => lastResume,
  importUrl: (url) => import(/* @vite-ignore */ url),
  verdict: assetVerdict,
  reload: () => location.reload(),
};

/** A loaded module without the piece's export. */
class MissingExport extends Error {
  name = "MissingExport";
}

const TIMED_OUT = "Loading the piece timed out.";

export interface PieceStore<C> {
  snapshot(): PieceSnapshot;
  subscribe(listener: () => void): () => void;
  /** Starts the first load (a no-op once started). */
  start(): void;
  /** Settles when the piece leaves its quiet phases (for Suspense). */
  settled(): Promise<void>;
  /** The loaded piece, once loaded. */
  loaded(): C | undefined;
  retry(): void;
  reload(): void;
  /** The one rendering of the piece that announces its state. */
  announcer(): string | undefined;
  claimAnnouncer(id: string): void;
  releaseAnnouncer(id: string): void;
}

/**
 * The recovery store of one lazily loaded piece. `load` is the piece's own
 * import; `pick` takes the piece from the loaded module (undefined when the
 * module lacks it).
 */
export function createPieceStore<C>(
  load: () => Promise<unknown>,
  pick: (module: unknown) => C | undefined,
  env: RecoveryEnv = browserEnv,
): PieceStore<C> {
  const timings = RECOVERY_TIMINGS;
  let state: PieceSnapshot = { phase: "idle" };
  let piece: C | undefined;
  const listeners = new Set<() => void>();
  let settling: Promise<void> | undefined;
  let settle: (() => void) | undefined;
  /** The retry number of the latest attempt (0 is the first load). */
  let attempts = 0;
  /** The script the failure named, for a cache-busted retry. */
  let scriptUrl: string | undefined;
  /** An attempt in flight, and whether Retry was pressed meanwhile. */
  let inflight: object | undefined;
  let retryAfter = false;
  /** Timers and listeners of the current wait; cleared on every move. */
  let pending: (() => void)[] = [];
  let announcing: string | undefined;

  function clearPending() {
    for (const cancel of pending) cancel();
    pending = [];
  }
  function later(run: () => void, ms: number) {
    const id = env.setTimeout(run, ms);
    pending.push(() => env.clearTimeout(id));
  }
  function set(next: PieceSnapshot) {
    const same =
      next.phase === state.phase &&
      next.reason === state.reason &&
      next.waitingFor === state.waitingFor &&
      next.error === state.error;
    if (same) return;
    const wasQuiet = isQuietPhase(state.phase);
    state = next;
    if (!isQuietPhase(next.phase)) {
      const resolve = settle;
      settling = undefined;
      settle = undefined;
      resolve?.();
    } else if (wasQuiet) {
      // Quiet to quiet: every rendering is still suspended on `settled()`,
      // and the first load starts while rendering, where no other rendering
      // may be told to update.
      return;
    }
    for (const listener of [...listeners]) listener();
  }

  /**
   * Waits for the network before a retry, saying "You’re offline." after
   * 2 s; once it is back, the piece is quiet again and the retry runs 3 s
   * later.
   */
  function whenOnline(run: () => void, quiet: "auto_retry" | "retrying") {
    later(() => {
      if (!env.online()) set({ phase: "waiting", waitingFor: "retry" });
    }, timings.offlineGraceMs);
    pending.push(
      env.whenOnline(() => {
        clearPending();
        set({ phase: quiet });
        later(run, timings.settleMs);
      }),
    );
  }

  function accept(module: unknown): C {
    const found = pick(module);
    if (found === undefined || found === null)
      throw new MissingExport("The loaded script lacks the expected export.");
    return found;
  }

  async function loadOnce(retry: number): Promise<C> {
    try {
      return accept(await load());
    } catch (error) {
      if (retry === 0 || !isChunkLoadError(error) || !scriptUrl) throw error;
    }
    // The browser remembered the failed import: the same file under a
    // fresh address, taken only when it has the expected export.
    return accept(await env.importUrl(`${scriptUrl}?cb=r${retry}`));
  }

  function attempt(retry: number) {
    clearPending();
    attempts = retry;
    const token = {};
    inflight = token;
    const started = env.now();
    if (retry > 0) {
      // Still out after 3 s: Retry shows while it carries on. Given up
      // as a network failure after 3.5 s.
      if (state.phase === "auto_retry")
        later(() => {
          if (inflight === token && state.phase === "auto_retry")
            set({ phase: "show_retry" });
        }, timings.showRetryMs);
      later(() => {
        if (inflight !== token) return;
        inflight = undefined;
        void failed(new TypeError(TIMED_OUT), retry, started);
      }, timings.attemptTimeoutMs);
    }
    loadOnce(retry).then(
      (loaded) => {
        // A late answer still counts, even after it was given up on.
        if (state.phase === "loaded") return;
        inflight = undefined;
        clearPending();
        piece = loaded;
        retryAfter = false;
        set({ phase: "loaded" });
      },
      (error: unknown) => {
        if (inflight !== token) return;
        inflight = undefined;
        void failed(error, retry, started);
      },
    );
  }

  function toReload(reason: "updated" | "couldnt_load") {
    clearPending();
    set({ phase: "reload_only", reason });
  }

  async function failed(error: unknown, retry: number, started: number) {
    clearPending();
    if (error instanceof MissingExport) {
      // The first load's module lacks the export: the piece's own code is
      // wrong, not the network.
      if (retry === 0) set({ phase: "declined", error });
      else toReload("couldnt_load");
      return;
    }
    const timedOut = error instanceof TypeError && error.message === TIMED_OUT;
    if (!timedOut && !isChunkLoadError(error)) {
      if (retry === 0) set({ phase: "declined", error });
      else toReload("couldnt_load");
      return;
    }
    scriptUrl ??= failedScriptUrl(error);
    if (isStylesheetFailure(error)) {
      toReload("couldnt_load");
      return;
    }
    if (env.online() && !timedOut) {
      const verdict = await env.verdict(error);
      // Something else moved on meanwhile (Reload pressed, loaded).
      if (inflight !== undefined || !isFailing(retry)) return;
      if (verdict === "updated") {
        toReload("updated");
        return;
      }
      if (verdict === "dependency") {
        // The script arrived and something it imports failed: retrying the
        // script itself cannot help.
        toReload("couldnt_load");
        return;
      }
    }
    if (retry >= timings.maxRetries) {
      toReload("couldnt_load");
      return;
    }
    if (retry === 0) {
      const quick = env.now() - started <= timings.quickFailureMs;
      autoRetry(quick ? timings.quickFailureMs : 0);
      return;
    }
    if (retryAfter) {
      retryAfter = false;
      startRetry("retrying");
      return;
    }
    set({ phase: "show_retry" });
  }

  /** True while the attempt numbered `retry` is still the latest. */
  function isFailing(retry: number) {
    return (
      attempts === retry &&
      state.phase !== "loaded" &&
      state.phase !== "reloading"
    );
  }

  function autoRetry(delay: number) {
    set({ phase: "auto_retry" });
    // After a wait for the network or the window, only the 3 s since it
    // came back still applies.
    const go = (wait: number) => {
      if (!env.online()) {
        whenOnline(() => go(0), "auto_retry");
        return;
      }
      if (env.hidden()) {
        pending.push(env.whenVisible(() => go(0)));
        return;
      }
      const settle = Math.max(
        0,
        timings.settleMs - (env.now() - env.lastResume()),
      );
      later(
        () => {
          if (state.phase === "auto_retry") attempt(attempts + 1);
        },
        Math.max(wait, settle),
      );
    };
    go(delay);
  }

  function startRetry(phase: "retrying") {
    if (!env.online()) {
      set({ phase });
      whenOnline(() => startRetry(phase), "retrying");
      return;
    }
    set({ phase });
    attempt(attempts + 1);
  }

  const store: PieceStore<C> = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (state.phase !== "idle") return;
      set({ phase: "loading" });
      attempt(0);
    },
    settled() {
      if (!isQuietPhase(state.phase)) return Promise.resolve();
      // One promise per quiet stretch, so React sees the same one.
      settling ??= new Promise<void>((resolve) => {
        settle = resolve;
      });
      return settling;
    },
    loaded: () => piece,
    retry() {
      if (state.phase === "waiting" && state.waitingFor === "reload") {
        store.reload();
        return;
      }
      if (state.phase !== "show_retry" && state.phase !== "waiting") return;
      if (attempts >= timings.maxRetries) {
        toReload("couldnt_load");
        return;
      }
      if (inflight !== undefined) {
        // The retry it started is still out: try again once that one ends.
        retryAfter = true;
        set({ phase: "retrying" });
        return;
      }
      clearPending();
      startRetry("retrying");
    },
    reload() {
      if (state.phase === "reloading") return;
      clearPending();
      if (!env.online()) {
        const reason = state.reason;
        set({ phase: "waiting", waitingFor: "reload", reason });
        pending.push(
          env.whenOnline(() => {
            clearPending();
            set({ phase: "reloading", reason });
            env.reload();
          }),
        );
        return;
      }
      set({ phase: "reloading", reason: state.reason });
      env.reload();
    },
    announcer: () => announcing,
    claimAnnouncer(id) {
      if (announcing !== undefined) return;
      announcing = id;
      for (const listener of [...listeners]) listener();
    },
    releaseAnnouncer(id) {
      if (announcing !== id) return;
      announcing = undefined;
      for (const listener of [...listeners]) listener();
    },
  };
  return store;
}
