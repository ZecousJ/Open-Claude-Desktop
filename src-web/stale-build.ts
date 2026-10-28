import { buildReplaced } from "../src/app/chunk-status";

/**
 * A page left open across a deploy still names the previous build's chunks;
 * when one it has not loaded yet is gone (404 or 410), Vite reports the failed
 * import as `vite:preloadError`, and reloading picks up the new build at the
 * same address. At most once in 30 s, so a chunk that really is missing shows
 * "Claudex was updated. Reload to continue." in the piece's place
 * (src/ui/lazy-piece.tsx) instead of reloading forever.
 *
 * Any other failure is not a reason to reload: the failed import reaches the
 * piece, which retries and says so. Offline the chunk is only out of reach, and
 * reloading would put the browser's own offline page in place of the app.
 */
const key = "claudex.staleBuildReload";

function mayReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(key)) || 0;
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

addEventListener("vite:preloadError", (event) => {
  if (navigator.onLine === false) return;
  const failure = (event as Event & { payload?: unknown }).payload;
  void buildReplaced(failure).then((replaced) => {
    if (replaced && mayReload()) location.reload();
  });
});
