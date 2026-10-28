/**
 * Installs the web bridge as `window.desktop`. Imported by src-web/main.tsx
 * before the renderer, so `window.desktop` exists when src/main.tsx runs.
 */
import { affiliateKey } from "./auth-support";
import { browserEnv } from "./browser-env";
import { createWebBridge } from "./index";

/** Keeps a `?aff=` code of a registration link for this tab's session. */
function rememberAffiliate() {
  try {
    const aff = new URLSearchParams(location.search).get("aff")?.trim();
    if (aff && /^[A-Za-z0-9_-]{1,64}$/.test(aff))
      sessionStorage.setItem(affiliateKey, aff);
  } catch {
    /* storage blocked: registration works without the code */
  }
}

rememberAffiliate();
const bridge = createWebBridge(browserEnv());
Object.defineProperty(window, "desktop", {
  value: bridge.api,
  writable: false,
  configurable: false,
});
// The session is restored now, while the renderer loads its language and
// slot modules: the sign-in gate's own call then finds it (refreshes share
// one request), and the first snapshot starts with it.
bridge.api.authStatus().catch(() => {});
