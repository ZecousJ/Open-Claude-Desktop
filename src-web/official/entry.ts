/** Thin entry is also the SPA fallback for a reloaded official child route. */
if (window.parent !== window) {
  void import("./frame-entry")
    .then((module) => module.startOfficialFrame())
    .catch(() => {
      window.parent.postMessage("claudex:official-frame-load-failed", location.origin);
    });
} else {
  void import("./main");
}
