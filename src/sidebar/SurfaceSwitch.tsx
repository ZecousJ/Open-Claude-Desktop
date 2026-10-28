import { useContext, useEffect, useRef } from "react";
import type { Conversation, Mode } from "../../shared/types";
import { formatText, useT } from "../i18n";
import { ChatsIcon, CodeIcon } from "../ui/icons";
import { ShortcutPlatform, WithTooltip } from "../ui/Tooltip";
import {
  sidebarTabShortcut,
  sidebarTabStep,
  sidebarTabTarget,
} from "./sidebar-tab-keys";

const tabs = ["chat", "code"] as const;
type Tab = (typeof tabs)[number];

const running = (c: Conversation) =>
  !c.archived && c.turns.some((t) => t.status === "inProgress");

/** What the dot on a segment says about its surface's conversations. */
type SegmentDot = "attention" | "busy" | "unread" | "";

/**
 * Chat and Cowork | Code switch in the sidebar's title bar. The surface not
 * shown gets a dot while one of its conversations is running and, as the rows
 * do, an amber one while a request waits and a blue one for an unread reply.
 * Each segment names its surface in a tooltip. With `tabKeys` (the desktop) ⌘⌥→
 * and ⌘⌥← move to the next and previous segment and the other segment's tooltip
 * shows its key.
 */
export function SurfaceSwitch({
  mode,
  conversations,
  approvalIds,
  onSwitch,
  codeUnavailable,
  tabKeys = false,
}: {
  /** ⌘⌥← / ⌘⌥→ switch the segments (the desktop's Next / Previous sidebar tab). */
  tabKeys?: boolean;
  mode: Mode;
  conversations: Conversation[];
  /** Conversations with a request waiting for approval. */
  approvalIds?: ReadonlySet<string>;
  onSwitch: (mode: Mode) => void;
  /** Why Code can't open here (the web without cloud Code): greyed, said in its tooltip. */
  codeUnavailable?: string;
}) {
  const t = useT();
  const code = mode === "code";
  const current: Tab = code ? "code" : "chat";
  const mac = useContext(ShortcutPlatform) === "darwin";
  const latest = useRef({ current, onSwitch, codeUnavailable });
  latest.current = { current, onSwitch, codeUnavailable };
  useEffect(() => {
    if (!tabKeys) return;
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = sidebarTabStep(event, mac);
      if (!step) return;
      const { current, onSwitch, codeUnavailable } = latest.current;
      const target = sidebarTabTarget(tabs, current, step);
      event.preventDefault();
      if (event.repeat || !target) return;
      if (target === "code" && codeUnavailable) return;
      onSwitch(target);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [tabKeys, mac]);
  const keysOf = (tab: Tab) =>
    tabKeys ? sidebarTabShortcut(tabs, tab, current) : undefined;
  const dot = (surface: "chat" | "code"): SegmentDot => {
    const own = conversations.filter(
      (c) =>
        !c.archived &&
        !c.incognito &&
        (c.mode === "code") === (surface === "code"),
    );
    if (own.some((c) => approvalIds?.has(c.id))) return "attention";
    if (own.some(running)) return "busy";
    return own.some((c) => c.unread) ? "unread" : "";
  };
  return (
    <div
      className="surface-switch"
      data-active={code ? "code" : "chat"}
      role="radiogroup"
      aria-label="Mode"
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const next =
          event.key === "Home"
            ? false
            : event.key === "End"
              ? true
              : /^Arrow(Left|Right|Up|Down)$/.test(event.key)
                ? !code
                : undefined;
        if (next === undefined) return;
        event.preventDefault();
        if (next && codeUnavailable) return;
        onSwitch(next ? "code" : "chat");
        event.currentTarget
          .querySelectorAll<HTMLButtonElement>("button")
          [Number(next)]?.focus();
      }}
    >
      {tabs.map((tab) => {
        const selected = tab === current;
        const unavailable = tab === "code" ? codeUnavailable : undefined;
        const indicator = selected ? "" : dot(tab);
        // The live frame annotates only the inactive, available surface, also
        // observed in native Code.
        const state = !unavailable ? indicator : "";
        const baseLabel = t(tab === "code" ? "Code" : "Claudex");
        const label = state
          ? formatText(
              state === "busy"
                ? "{tab}, working"
                : state === "attention"
                  ? "{tab}, awaiting your input"
                  : "{tab}, unread activity",
              { tab: baseLabel },
            )
          : baseLabel;
        return (
          <WithTooltip
            key={tab}
            label={unavailable ?? label}
            shortcut={unavailable ? undefined : keysOf(tab)}
          >
            {(props) => (
              <button
                {...props}
                role="radio"
                aria-label={label}
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                aria-disabled={unavailable ? true : undefined}
                className={`${selected ? "selected" : indicator} ${unavailable ? "unavailable" : ""}`}
                onClick={() => {
                  if (!unavailable) onSwitch(tab);
                }}
              >
                {tab === "code" ? <CodeIcon /> : <ChatsIcon />}
              </button>
            )}
          </WithTooltip>
        );
      })}
    </div>
  );
}
