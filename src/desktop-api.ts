import type { DesktopAPI } from "../shared/types";
import { withActionVerification } from "./auth/action-verification-store";

/**
 * `window.desktop`, read when a call is made rather than when a module
 * loads. The web build can split a module into a chunk that runs before
 * the web bridge installs `window.desktop`; a module-level
 * `const api = window.desktop` there would hold `undefined` for good.
 */
export const api: DesktopAPI = withActionVerification(
  new Proxy({} as DesktopAPI, {
    get(_target, key) {
      const desktop = window.desktop as unknown as Record<PropertyKey, unknown>;
      const value = desktop[key];
      return typeof value === "function" ? value.bind(desktop) : value;
    },
  }),
);
