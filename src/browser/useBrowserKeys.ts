import { useEffect, useRef, type RefObject } from "react";
import type { BrowserState } from "../../shared/browser";
import {
  browserCommandEvent,
  browserTabFor,
  type BrowserCommandDetail,
} from "../app/shell-menu";
import type { BrowserBridge } from "./useBrowserState";

/** How many closed tabs ⇧⌘T can bring back. */
const closedTabLimit = 10;

/**
 * The Browser panel's keyboard commands. The window sends them as
 * `claudex:browser-command` events (ShellMenuHost.tsx); the panel marks the
 * ones it acted on. Tabs that close are remembered by address for the reopen
 * key.
 */
export function useBrowserKeys({
  conversationId,
  state,
  bridge,
  address,
  run,
  onSelectElement,
  onSketch,
}: {
  conversationId: string;
  state: BrowserState | undefined;
  bridge: BrowserBridge | undefined;
  address: RefObject<HTMLInputElement | null>;
  run: (work: () => Promise<unknown> | undefined) => void;
  /** ⇧⌘S: Select element, as its button (it starts or stops picking). */
  onSelectElement?: () => void;
  /** ⇧⌘X: sketch mode starts, or asks to end. */
  onSketch?: () => void;
}) {
  const closed = useRef<string[]>([]);
  const known = useRef(new Map<string, string>());
  useEffect(() => {
    if (!state) return;
    const now = new Map(state.tabs.map((tab) => [tab.id, tab.url]));
    for (const [id, url] of known.current)
      if (!now.has(id) && url)
        closed.current = [...closed.current, url].slice(-closedTabLimit);
    known.current = now;
  }, [state?.tabs]);

  const latest = useRef({
    state,
    bridge,
    run,
    conversationId,
    onSelectElement,
    onSketch,
  });
  latest.current = {
    state,
    bridge,
    run,
    conversationId,
    onSelectElement,
    onSketch,
  };
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<BrowserCommandDetail>).detail;
      const { state, bridge, run, conversationId } = latest.current;
      if (!detail || !state || !bridge) return;
      const { command } = detail;
      if (command === "new-tab") {
        detail.handled = true;
        run(async () => {
          await bridge.browserNewTab(conversationId);
          address.current?.focus();
        });
      } else if (command === "select-element") {
        if (!latest.current.onSelectElement) return;
        detail.handled = true;
        latest.current.onSelectElement();
      } else if (command === "sketch") {
        if (!latest.current.onSketch) return;
        detail.handled = true;
        latest.current.onSketch();
      } else if (command === "focus-address") {
        detail.handled = true;
        address.current?.focus();
        address.current?.select();
      } else if (command === "reopen-tab") {
        const url = closed.current.pop();
        if (!url) return;
        detail.handled = true;
        run(() => bridge.browserNewTab(conversationId, url));
      } else {
        const target = browserTabFor(
          command,
          state.tabs.map((tab) => tab.id),
          state.activeTabId,
        );
        // A number past the last tab is a key that does nothing.
        detail.handled = true;
        if (target && target !== state.activeTabId)
          run(() => bridge.browserSelectTab(conversationId, target));
      }
    };
    window.addEventListener(browserCommandEvent, listener);
    return () => window.removeEventListener(browserCommandEvent, listener);
  }, []);
}
