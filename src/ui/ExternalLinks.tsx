import {
  hasLocalBrowserExecution,
  type BrowserExecutionConversation,
} from "../../shared/browser-execution-eligibility";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "./Controls";
import { usePolicy } from "../policy/PolicyContext";
import { linkOpens } from "../../shared/external-links";
import { preference } from "../../shared/settings-extras";
import type { ClientPolicy } from "../../shared/client-policy";
import type { Conversation, Settings } from "../../shared/types";
import { AppContext } from "../app/AppContext";
import { useHostCapability } from "../host/HostContext";
import type { SidePanel } from "../conversation/ToolSidePanel";
import { takePromptLink } from "../cowork/prompt-links";

/** Asks before a link from model output or an artifact preview leaves the app. */
export const OpenLink = createContext<(url: string) => void>((url) => {
  void window.desktop?.openExternal(url);
});
export const useOpenLink = () => useContext(OpenLink);

/** Only web links leave the app; anything else is not opened. */
export function externalUrl(href: string | undefined) {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The Browser panel's name in `SidePanel` (package R8-D adds the panel). */
const browserPanel = "browser" as SidePanel;

/**
 * Settings → Claude Code → Browser → Open links in built-in browser (R8):
 * the local Code or Cowork conversation whose Browser panel a link opens in, or undefined
 * when it goes to the default browser. That needs the desktop's Browser
 * panel, the setting on, a local Code or Cowork conversation on screen and the browser not
 * turned off by the administrator. The built-in browser keeps its own rules
 * (blocked domains, allowed addresses; `electron/browser/navigation-guard.ts`),
 * as it does for addresses typed into the panel, so the external-links
 * policy, which is about leaving Claudex, does not apply.
 */
export function builtInBrowserConversation({
  browserPanel: panelAvailable,
  settings,
  active,
  policy,
}: {
  browserPanel: boolean;
  settings: Settings | undefined;
  active: (BrowserExecutionConversation & Pick<Conversation, "id">) | undefined;
  policy: Pick<ClientPolicy, "browser">;
}): string | undefined {
  if (!panelAvailable || !settings || !active) return undefined;
  if (!hasLocalBrowserExecution(active)) return undefined;
  if (policy.browser?.enabled === false) return undefined;
  if (!preference(settings, "browserOpenLinksInApp")) return undefined;
  return active.id;
}

/**
 * How a link opens: straight into the built-in browser, there after a
 * confirmation, or through the external-link confirmation. Links the main
 * process reports (`fromPage`: artifact previews and new windows) can be
 * started by page scripts without a click, so they always ask first.
 */
export function linkRoute(
  conversationId: string | undefined,
  fromPage: boolean,
): "browser" | "confirm-browser" | "confirm" {
  if (!conversationId) return "confirm";
  return fromPage ? "confirm-browser" : "browser";
}

export function ExternalLinks({
  children,
  onError,
}: {
  children: ReactNode;
  onError: (error: unknown) => void;
}) {
  // A link waiting for confirmation, and the Code conversation whose
  // built-in browser it opens in (undefined: the default browser).
  const [pending, setPending] = useState<{
    url: string;
    conversationId?: string;
  }>();
  const policy = usePolicy();
  const app = useContext(AppContext);
  const panelAvailable = useHostCapability("browserPanel");
  // With external links off, pages the administrator named and trusted
  // domains still open (the main process checks the same rule). The
  // built-in browser keeps its own rules instead.
  const allowed =
    pending !== undefined &&
    (pending.conversationId !== undefined || linkOpens(pending.url, policy));
  const conversationId = builtInBrowserConversation({
    browserPanel: panelAvailable,
    settings: app?.snapshot.settings,
    active: app?.active,
    policy,
  });
  // Read when a link is clicked, also by the event listener set up once.
  const latest = useRef({
    conversationId,
    setPanel: app?.setPanel,
    onError,
    app,
  });
  latest.current = { conversationId, setPanel: app?.setPanel, onError, app };
  /** A new foreground tab in the conversation's Browser panel, then the panel. */
  const openInBrowser = (id: string, url: string) => {
    const { setPanel, onError: fail } = latest.current;
    window.desktop
      .browserNewTab(id, url)
      .then(() => setPanel?.(browserPanel))
      .catch(fail);
  };
  const open = (href: string | undefined, fromPage: boolean) => {
    // An artifact's prompt link opens a quick task window on the Cowork page.
    const shell = latest.current.app;
    if (
      fromPage &&
      href &&
      shell &&
      shell.windowRole.kind !== "conversation" &&
      takePromptLink(href, {
        cowork: shell.page === "chat" && shell.mode === "cowork",
        incognito: shell.incognitoShown,
      })
    )
      return;
    const url = externalUrl(href);
    if (!url) return;
    const { conversationId: id, setPanel } = latest.current;
    const route = setPanel ? linkRoute(id, fromPage) : "confirm";
    if (route === "browser" && id) return openInBrowser(id, url);
    setPending(
      route === "confirm-browser" ? { url, conversationId: id } : { url },
    );
  };
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(
    () =>
      window.desktop?.onEvent((event) => {
        if (event.type === "external-link") openRef.current(event.url, true);
      }),
    [],
  );
  return (
    <OpenLink.Provider value={(url) => openRef.current(url, false)}>
      {children}
      {pending && !allowed && (
        <Modal title="Link not opened" onClose={() => setPending(undefined)}>
          <p className="confirm-body">
            Your administrator has turned off links to websites outside Claudex.
          </p>
          <p className="external-link-url mono">{pending.url}</p>
          <div className="button-row">
            <button className="primary" onClick={() => setPending(undefined)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {pending && allowed && (
        <Modal
          title="Open external link?"
          onClose={() => setPending(undefined)}
        >
          <p className="confirm-body">
            {pending.conversationId
              ? "This link goes to a website outside Claudex. It opens in the built-in browser."
              : "This link goes to a website outside Claudex."}
          </p>
          <p className="external-link-url mono">{pending.url}</p>
          <div className="button-row">
            <button className="secondary" onClick={() => setPending(undefined)}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => {
                setPending(undefined);
                if (pending.conversationId)
                  return openInBrowser(pending.conversationId, pending.url);
                void window.desktop.openExternal(pending.url).catch(onError);
              }}
            >
              Open link
            </button>
          </div>
        </Modal>
      )}
    </OpenLink.Provider>
  );
}
