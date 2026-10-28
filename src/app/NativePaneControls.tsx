import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { arrangePane, dockCardClass } from "./pane-expand";
import type { DockPanel } from "./useToolPanels";
import {
  codeEdgeTarget,
  type CodeLayout,
  type CodeEdge,
} from "./code-pane-layout-model";
import { useApp } from "./AppContext";
import { paneHandoffKey, savePaneHandoff } from "./pane-handoff";
import { t } from "../i18n";
import { deferFileTransition } from "../files/file-transitions";
import { AppIcon } from "../ui/app-icon";

const moveLabels: Record<CodeEdge, string> = {
  left: "Move to left",
  right: "Move to right",
  top: "Move to top",
  bottom: "Move to bottom",
};
const edges = ["left", "right", "top", "bottom"] as const;
/** Exact custom 16px icon paths in c4db265df:86-134 (PaneLayout*). */
const outline =
  "M12.2041 2.01074C13.2128 2.113 14 2.96435 14 4V12L13.9893 12.2041C13.8938 13.1457 13.1457 13.8938 12.2041 13.9893L12 14H4C2.96435 14 2.113 13.2128 2.01074 12.2041L2 12V4C2 2.89543 2.89543 2 4 2H12L12.2041 2.01074ZM4 3C3.44772 3 3 3.44772 3 4V12C3 12.5523 3.44772 13 4 13H12C12.5523 13 13 12.5523 13 12V4C13 3.44772 12.5523 3 12 3H4Z";
function LayoutIcon({ kind }: { kind: CodeEdge | "fill" | "split" }) {
  const box =
    kind === "left"
      ? [4, 4, 4, 8]
      : kind === "right"
        ? [8, 4, 4, 8]
        : kind === "top"
          ? [4, 4, 8, 4]
          : kind === "bottom"
            ? [4, 8, 8, 4]
            : kind === "split"
              ? [8.5, 4, 3.5, 8]
              : [4, 4, 8, 8];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={outline} />
      <rect x={box[0]} y={box[1]} width={box[2]} height={box[3]} rx=".5" />
      {kind === "split" && (
        <rect x="4" y="4" width="3.5" height="8" rx=".5" opacity=".5" />
      )}
    </svg>
  );
}

/** Expand remains the card's own button. Its context menu and ArrowDown open
 * the current source layout grid, rather than adding a second ellipsis menu. */
export function NativePaneControls({
  pane,
  root,
  layout,
  filled,
  onMove,
  moveHandlers,
}: {
  pane: DockPanel;
  root: HTMLDivElement | null;
  layout: CodeLayout;
  filled: boolean;
  onMove: (edge: CodeEdge) => void;
  moveHandlers: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const app = useApp();
  const currentSession = useRef({ account: app.accountId, id: app.active?.id });
  currentSession.current = { account: app.accountId, id: app.active?.id };
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const restoreFocus = useRef(false);
  const hoverOpen = useRef(false);
  const suppressHover = useRef(false);
  useLayoutEffect(() => {
    if (!root) return;
    const find = () => {
      const panel = root.querySelector(`.${dockCardClass[pane]}`);
      const button =
        [
          ...(panel?.querySelectorAll<HTMLButtonElement>(
            ":scope > header button",
          ) ?? []),
        ].find((button) => {
          const label = button.getAttribute("aria-label") ?? "";
          return [
            t("Expand"),
            t("Collapse"),
            t("Fill"),
            t("Tile"),
            "Restore",
            "Expand",
            "Collapse",
          ].some((word) => label === word || label.startsWith(`${word} `));
        }) ?? null;
      setTrigger(button);
    };
    find();
    const observer = new MutationObserver(find);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-label"],
    });
    return () => observer.disconnect();
  }, [root, pane]);
  useEffect(() => {
    if (!trigger) return;
    const show = (keyboard = false) => {
      hoverOpen.current = false;
      restoreFocus.current = keyboard;
      setOpen(true);
    };
    // Base UI Popover Trigger default restMs300 (vendor-frame/rg:23925),
    // plus Je's500ms touch hold with a10px cancellation threshold.
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let touch:
      | { x: number; y: number; timer: ReturnType<typeof setTimeout> }
      | undefined;
    let longPressed = false;
    const clearHover = () => {
      clearTimeout(hoverTimer);
      hoverTimer = undefined;
    };
    const clearTouch = () => {
      if (touch) clearTimeout(touch.timer);
      touch = undefined;
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || suppressHover.current) return;
      clearHover();
      hoverTimer = setTimeout(() => {
        hoverOpen.current = true;
        restoreFocus.current = false;
        setOpen(true);
      }, 300);
    };
    const leave = () => {
      clearHover();
      clearTouch();
      suppressHover.current = false;
    };
    const down = (event: PointerEvent) => {
      clearHover();
      clearTouch();
      longPressed = false;
      if (event.pointerType === "mouse") return;
      touch = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          touch = undefined;
          longPressed = true;
          show();
        }, 500),
      };
    };
    const move = (event: PointerEvent) => {
      if (
        touch &&
        (Math.abs(event.clientX - touch.x) > 10 ||
          Math.abs(event.clientY - touch.y) > 10)
      )
        clearTouch();
    };
    const click = (event: MouseEvent) => {
      clearHover();
      clearTouch();
      suppressHover.current = true;
      hoverOpen.current = false;
      if (longPressed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        longPressed = false;
        return;
      }
      setOpen(false);
    };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      show(event.detail === 0);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowDown" ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      show(true);
    };
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.addEventListener("contextmenu", context);
    trigger.addEventListener("keydown", key);
    trigger.addEventListener("pointerenter", enter);
    trigger.addEventListener("pointerleave", leave);
    trigger.addEventListener("pointerdown", down);
    trigger.addEventListener("pointermove", move);
    trigger.addEventListener("pointerup", clearTouch);
    trigger.addEventListener("pointercancel", clearTouch);
    trigger.addEventListener("click", click, true);
    return () => {
      clearHover();
      clearTouch();
      trigger.removeAttribute("aria-haspopup");
      trigger.removeEventListener("contextmenu", context);
      trigger.removeEventListener("keydown", key);
      trigger.removeEventListener("pointerenter", enter);
      trigger.removeEventListener("pointerleave", leave);
      trigger.removeEventListener("pointerdown", down);
      trigger.removeEventListener("pointermove", move);
      trigger.removeEventListener("pointerup", clearTouch);
      trigger.removeEventListener("pointercancel", clearTouch);
      trigger.removeEventListener("click", click, true);
    };
  }, [trigger]);
  useLayoutEffect(() => {
    if (!open || !trigger) return;
    const box = trigger.getBoundingClientRect();
    const node = popup.current!;
    setPosition({
      left: Math.max(
        8,
        Math.min(
          innerWidth - (node.offsetWidth || 176) - 8,
          box.right - (node.offsetWidth || 176),
        ),
      ),
      top: Math.max(
        8,
        Math.min(innerHeight - (node.offsetHeight || 180) - 8, box.bottom + 4),
      ),
    });
    if (restoreFocus.current) node.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (
        !node.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        setOpen(false);
    };
    const hoverOutside = (event: PointerEvent) => {
      if (
        !hoverOpen.current ||
        node.contains(event.target as Node) ||
        trigger.contains(event.target as Node)
      )
        return;
      const anchor = trigger.getBoundingClientRect(),
        box = node.getBoundingClientRect();
      // Keep the4px travel corridor to the end-aligned popup interactive.
      if (
        event.clientX >= Math.min(anchor.left, box.left) &&
        event.clientX <= Math.max(anchor.right, box.right) &&
        event.clientY >= Math.min(anchor.top, box.top) &&
        event.clientY <= Math.max(anchor.bottom, box.bottom)
      )
        return;
      setOpen(false);
      hoverOpen.current = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("pointermove", hoverOutside, true);
    document.addEventListener("keydown", escape, true);
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("pointermove", hoverOutside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
    };
  }, [open, trigger]);
  useEffect(() => {
    if (!trigger) setOpen(false);
  }, [trigger]);
  const picked = () => {
    setOpen(false);
    if (restoreFocus.current) trigger?.focus({ preventScroll: true });
  };
  const popOut = async () => {
    const conversation = app.active;
    if (!conversation) return;
    const account = app.accountId;
    const valid = () =>
      currentSession.current.account === account &&
      currentSession.current.id === conversation.id;
    const perform = async () => {
      if (!valid()) return;
      savePaneHandoff(
        localStorage,
        paneHandoffKey(app.accountId, conversation.id, pane),
        {
          sessionId: app.toolPanels.sessionId,
          widgetId: app.toolPanels.widgetId,
          agent: app.toolPanels.agent,
          artifact: pane === "artifact" ? app.artifact : undefined,
        },
      );
      // Close only after the native host acknowledges creating its new window.
      await window.desktop.openToolPaneWindow(conversation.id, pane);
      if (!valid()) return;
      if (pane === "artifact") app.setArtifact(undefined);
      app.toolPanels.close(pane);
    };
    if (
      pane === "files" &&
      deferFileTransition(() => void perform().catch(app.report), "pane")
    )
      return;
    await perform();
  };
  return (
    <>
      <PaneMoveButton {...moveHandlers} />
      {open && trigger
        ? createPortal(
            <div
              ref={popup}
              className="code-pane-layout-popup"
              role="dialog"
              aria-label={t("Fill and arrange")}
              tabIndex={-1}
              style={position}
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  const buttons = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button",
                    ),
                  ];
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (event.shiftKey && index <= 0) {
                    event.preventDefault();
                    buttons.at(-1)?.focus();
                  } else if (!event.shiftKey && index === buttons.length - 1) {
                    event.preventDefault();
                    buttons[0]?.focus();
                  }
                }
              }}
            >
              <div className="code-layout-group">
                <div role="presentation">{t("Move")}</div>
                <div role="group" aria-label={t("Move")}>
                  {edges.map((edge) => {
                    const active =
                      !filled &&
                      codeEdgeTarget(layout, pane, edge) === "at-edge";
                    return (
                      <button
                        key={edge}
                        type="button"
                        aria-label={t(moveLabels[edge])}
                        aria-pressed={active}
                        onClick={
                          active
                            ? undefined
                            : () => {
                                onMove(edge);
                                picked();
                              }
                        }
                      >
                        <LayoutIcon kind={edge} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="code-layout-group">
                <div role="presentation">{t("Fill and arrange")}</div>
                <div role="group" aria-label={t("Fill and arrange")}>
                  <button
                    type="button"
                    aria-label={t("Fill")}
                    aria-pressed={filled}
                    onClick={
                      filled
                        ? undefined
                        : () => {
                            arrangePane(pane, true);
                            picked();
                          }
                    }
                  >
                    <LayoutIcon kind="fill" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("Tile")}
                    aria-pressed={!filled}
                    onClick={
                      !filled
                        ? undefined
                        : () => {
                            arrangePane(pane, false);
                            picked();
                          }
                    }
                  >
                    <LayoutIcon kind="split" />
                  </button>
                </div>
              </div>
              {!(
                app.windowRole.kind === "conversation" && app.windowRole.pane
              ) && (
                <>
                  <hr />
                  <button
                    type="button"
                    className="code-layout-new-window"
                    onClick={() => {
                      picked();
                      void popOut().catch(app.report);
                    }}
                  >
                    <AppIcon name="WindowNew" size={16} />
                    <span>{t("Open in new window")}</span>
                  </button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** ca67f2c9d/Dt and Qe.dragHandle: the top-centred pill, not a toolbar icon. */
export function PaneMoveButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="code-pane-move"
      aria-label={t("Move")}
      {...props}
    >
      <span aria-hidden="true" />
    </button>
  );
}
