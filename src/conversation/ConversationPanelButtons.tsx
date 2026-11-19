import { useEffect, useRef, useState } from "react";
import { PanelRight } from "../ui/glyphs";
import type { Conversation, Mode } from "../../shared/types";
import type { SidePanel } from "./ToolSidePanel";
import { IconButton } from "../ui/Controls";
import { Anthropicon } from "../ui/anthropicons";
import { useRailToggle } from "../session-rail/rail-store";
import { useCodePanes, type PaneSpec } from "../header/code-panes";
import { useHost } from "../host/HostContext";
import { WithTooltip } from "../ui/Tooltip";
import { useT } from "../i18n";

/**
 * Show / Hide session rail, first in a Code session's bar and set off from
 * the panel toggles by a rule (live claude.ai bundle, 2026-10-14: the
 * ListCard ghost button, its tooltip below, then "h-4 w-px shrink-0
 * bg-border").
 */
function SessionRailToggle({ sessionId }: { sessionId: string }) {
  const { onScreen, toggle } = useRailToggle(sessionId);
  return (
    <>
      <IconButton
        label={onScreen ? "Hide session rail" : "Show session rail"}
        name="Session rail"
        pressed={onScreen}
        className="panel-toggle"
        active={onScreen}
        placement="below"
        onClick={toggle}
      >
        <Anthropicon name="ListCard" />
      </IconButton>
      <span className="panel-toggle-rule" aria-hidden="true" />
    </>
  );
}

/** A pane's ghost icon button, pressed while the pane is open. */
function PaneButton({ pane }: { pane: PaneSpec }) {
  return (
    <IconButton
      label={pane.label}
      className="panel-toggle"
      active={pane.active}
      pressed={pane.active}
      disabled={pane.disabled}
      title={pane.reason}
      shortcut={pane.shortcut}
      placement="below"
      onClick={pane.toggle}
    >
      {pane.icon}
    </IconButton>
  );
}

/** The shown/hidden strings are current source shared-16:8170–8181.
 * Observe committed panel state, so dismissed panels and external toggles
 * announce the result, not an optimistic click. */
function ActivityToggle({
  conversationId,
  mode,
  panel,
  onToggle,
}: {
  conversationId: string;
  mode: Mode;
  panel: SidePanel | null;
  onToggle: () => void;
}) {
  const web = useHost().kind === "web";
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const expanded = panel === "progress";
  const previous = useRef({ conversationId, expanded });
  const focusedInPanel = useRef<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const before = previous.current;
    previous.current = { conversationId, expanded };
    if (before.conversationId !== conversationId) {
      setAnnouncement("");
    } else if (before.expanded !== expanded) {
      setAnnouncement(
        expanded ? "Activity panel shown" : "Activity panel hidden",
      );
      // A panel's close button disappears with it. Return only that lost
      // focus; a replacement viewer, another focused control or a new
      // conversation owns its own focus.
      const focused = focusedInPanel.current;
      const document = button.current?.ownerDocument;
      if (
        !expanded &&
        panel === null &&
        focused &&
        !focused.isConnected &&
        document &&
        document.activeElement === document.body
      )
        button.current?.focus();
    }
    focusedInPanel.current = null;
  }, [conversationId, expanded, panel]);

  useEffect(() => {
    if (!expanded) return;
    const workspace = button.current?.closest(".workspace");
    const document = button.current?.ownerDocument;
    if (!workspace || !document) return;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      const activity = workspace.querySelector(
        ".chat-layout > aside.session-activity-panel, .chat-layout > aside.progress-panel",
      );
      focusedInPanel.current =
        target instanceof HTMLElement && activity?.contains(target)
          ? target
          : null;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [conversationId, expanded]);

  return (
    <>
      <WithTooltip label="Activity panel" placement="below">
        {(tooltip) => (
          <button
            {...tooltip}
            ref={button}
            type="button"
            aria-label="Activity panel"
            aria-pressed={expanded}
            aria-expanded={expanded}
            className={`icon-button ${expanded ? "active" : ""} panel-toggle session-activity-toggle`}
            onClick={onToggle}
          >
            {web || mode === "chat" ? (
              <Anthropicon name="File" size={18} />
            ) : (
              <PanelRight size={16} strokeWidth={1.6} />
            )}
          </button>
        )}
      </WithTooltip>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{ top: 0, insetInlineStart: 0 }}
      >
        {t(announcement)}
      </span>
    </>
  );
}

/**
 * The conversation title bar's panel toggles. Code (live claude.ai bundle,
 * 2026-10-14, the title bar): Show / Hide session rail and a rule, then the
 * panes as ghost icon buttons with their shortcuts in the tooltips:
 * Terminal, Changes, Browser and the simulators. `panes` are the ones still
 * in the bar when it is narrow (ConversationHeader folds the rest into View
 * options); `railFolded` when the rail toggle went there too. Cowork has
 * the Progress toggle (S-0008); unified Chat has Activity on both hosts.
 */
export function ConversationPanelButtons({
  conversation,
  mode,
  panel,
  onTogglePanel,
  panes,
  railFolded = false,
}: {
  conversation: Conversation;
  mode: Mode;
  panel: SidePanel | null;
  onTogglePanel: (value: SidePanel) => void;
  panes?: PaneSpec[];
  railFolded?: boolean;
}) {
  const own = useCodePanes(conversation, mode, { panel, onTogglePanel });
  if (mode === "cowork" || mode === "chat")
    return (
      <>
        {own
          .filter((pane) => pane.id === "browser")
          .map((pane) => (
            <PaneButton key={pane.id} pane={pane} />
          ))}
        <ActivityToggle
          conversationId={conversation.id}
          mode={mode}
          panel={panel}
          onToggle={() => onTogglePanel("progress")}
        />
      </>
    );
  if (mode !== "code") return null;
  const shown = panes ?? own;
  return (
    <>
      {!railFolded && <SessionRailToggle sessionId={conversation.id} />}
      {shown.map((pane) => (
        <PaneButton key={pane.id} pane={pane} />
      ))}
    </>
  );
}
