import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  openPolicy,
  pendingPolicy,
  type ClientPolicy,
} from "../../shared/client-policy";
import type { DesktopAPI } from "../../shared/types";
import { surface } from "../../shared/host";
import { WebBoot } from "../boot/BootShell";

const Policy = createContext<ClientPolicy>(openPolicy);
/** What the administrator allows; the main process enforces the same policy. */
export const usePolicy = () => useContext(Policy);

/** Asked again when the window regains focus, at most every 30 s. */
const refreshMs = 30_000;

type PolicyBridge = Partial<Pick<DesktopAPI, "clientPolicy" | "onEvent">>;

/**
 * Follows the account's policy: asks once at the start and again on window
 * focus (at most every 30 s), and takes every "policy" event the main
 * process sends when the service's policy changes. A bridge without the
 * call (an older build) leaves everything allowed. Returns the unsubscribe.
 */
export function followPolicy(
  bridge: PolicyBridge | undefined,
  set: (update: (current: ClientPolicy) => ClientPolicy) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  now: () => number = Date.now,
) {
  let live = true;
  let loadedAt = 0;
  const load = () => {
    loadedAt = now();
    Promise.resolve(bridge?.clientPolicy?.())
      .then((value) => live && set(() => value ?? openPolicy))
      .catch(() => live && set((current) => current));
  };
  load();
  const unsubscribe = bridge?.onEvent?.((event) => {
    if (live && event.type === "policy") set(() => event.policy);
  });
  const focus = () => {
    if (now() - loadedAt >= refreshMs) load();
  };
  target.addEventListener("focus", focus);
  return () => {
    live = false;
    unsubscribe?.();
    target.removeEventListener("focus", focus);
  };
}

/** How long the window waits for the first answer before it shows the app anyway. */
export const firstAnswerMs = 250;

/**
 * The signed-in account's policy for the window. The main process answers
 * without waiting for the network, so the app normally starts with the
 * account's own policy (new chats take their defaults from it). Should the
 * answer not come within a moment, the app shows anyway with the pending
 * policy, which holds back only high-risk items (changing MCP servers), and
 * the answer replaces it when it comes; later changes arrive as "policy"
 * events. The window is never held blank.
 */
export function PolicyProvider({ children }: { children: ReactNode }) {
  const [policy, setPolicy] = useState<ClientPolicy>();
  useEffect(() => {
    const stop = followPolicy(window.desktop, (update) =>
      setPolicy((current) => update(current ?? pendingPolicy)),
    );
    const timer = setTimeout(
      () => setPolicy((current) => current ?? pendingPolicy),
      firstAnswerMs,
    );
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);
  // The web app keeps its first paint while the policy loads (src/boot).
  if (!policy) return surface === "web" ? <WebBoot /> : null;
  return <Policy.Provider value={policy}>{children}</Policy.Provider>;
}
