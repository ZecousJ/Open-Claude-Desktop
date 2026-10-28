import { useEffect, useState } from "react";
import type { BrowserState } from "../../shared/browser";
import type { PanelsAPI } from "../../shared/panels-api";
import type { DesktopAPI } from "../../shared/types";
import type { ChromeImportAPI } from "../../shared/chrome-import";
import type { PreviewOriginAPI } from "../../shared/preview-origin";

/** The bridge calls the Browser panel uses. */
export type BrowserBridge = Pick<
  DesktopAPI,
  | "onEvent"
  | keyof ChromeImportAPI
  | keyof PreviewOriginAPI
  | Extract<keyof PanelsAPI, `browser${string}` | `devServers${string}`>
>;

/** The window's bridge (absent in node tests and before the preload ran). */
export const windowBridge = (): BrowserBridge | undefined =>
  typeof window === "undefined" ? undefined : window.desktop;

export const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      )
    : String(error);

/**
 * The Browser state of one Code conversation. Opening the panel tells the
 * main process to show the page in this window (`browserOpen`); closing it
 * (unmount) hides the page again, while its tabs stay open for Claude.
 * Later changes arrive as "browser" events; an older version is ignored.
 */
export function useBrowserState(
  conversationId: string,
  bridge: BrowserBridge | undefined,
) {
  const [state, setState] = useState<BrowserState>();
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    setState(undefined);
    setFailure(undefined);
    const take = (next: BrowserState) =>
      setState((current) =>
        !current ||
        current.conversationId !== next.conversationId ||
        next.version >= current.version
          ? next
          : current,
      );
    const off = bridge.onEvent((event) => {
      if (
        event.type === "browser" &&
        event.state.conversationId === conversationId
      )
        take(event.state as BrowserState);
    });
    bridge.browserOpen(conversationId).then(
      (opened) => alive && take(opened),
      (error) => alive && setFailure(errorText(error)),
    );
    return () => {
      alive = false;
      off();
      void bridge.browserHide(conversationId).catch(() => {});
    };
  }, [conversationId, bridge]);
  return { state, failure };
}
