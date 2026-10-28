import type { RefObject } from "react";
import type { Conversation } from "../../shared/types";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import type { PaneSpec } from "../header/code-panes";
import type { SidePanel } from "../conversation/ToolSidePanel";
import { useApp } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import { latestPlan } from "../plan/PlanPanel";
import { tasksFromTurn } from "../../shared/workflow-model";
import { toggleSideChat, useSideChat } from "../side-chat/side-chat-store";
import { sideChatAvailability } from "../side-chat/side-chat-model";
import "./code-view-options.css";

/**
 * View options' own rows: Side chat (⌘;) where the session has one, Background
 * tasks with the running count while any run or it is open, and Plan once the
 * session has a task list or it is open.
 */
function useViewOptionExtras(conversation: Conversation): PaneSpec[] {
  const app = useApp();
  const sideChat = useSideChat(conversation.id);
  const isOpen = (value: SidePanel) => app.toolPanels.isOpen(value);
  const toggle = (value: SidePanel) => () => {
    app.toolPanels.toggle(value);
  };
  const mode = conversation.mode;
  const extras: PaneSpec[] = [];
  extras.push({
    id: "session",
    icon: <AppIcon name="Chats" />,
    label: "Session",
    active: isOpen("session"),
    toggle: toggle("session"),
  });
  if (
    conversation.turns.some((turn) =>
      turn.items.some((item) => item.type === "mcpToolCall"),
    )
  )
    extras.push({
      id: "widget",
      icon: <AppIcon name="Chats" />,
      label: "Widget",
      active: isOpen("widget"),
      toggle: toggle("widget"),
    });
  extras.push({
    id: "pr",
    icon: <AppIcon name="Chats" />,
    label: "Pull request",
    active: isOpen("pr"),
    toggle: toggle("pr"),
  });
  if (sideChatAvailability(conversation, mode).available)
    extras.push({
      id: "side-chat",
      icon: <AppIcon name="Chats" />,
      label: "Side chat",
      shortcut: ["mod", ";"],
      active: Boolean(sideChat?.open),
      toggle: () => toggleSideChat(conversation.id),
    });
  const running =
    app.activeTerminals.filter((t) => t.conversationId === conversation.id)
      .length +
    conversation.turns
      .flatMap((turn) => tasksFromTurn(turn, conversation))
      .filter((task) => task.status === "running").length;
  if (running > 0 || isOpen("background"))
    extras.push({
      id: "background",
      icon: <AppIcon name="AgentsSimple" />,
      label: "Background tasks",
      count: running || undefined,
      active: isOpen("background"),
      toggle: toggle("background"),
    });
  if (latestPlan(conversation)?.length || isOpen("plan"))
    extras.push({
      id: "plan",
      icon: <AppIcon name="Checklist" />,
      label: "Plan",
      active: isOpen("plan"),
      toggle: () => {
        if (isOpen("plan")) app.dismissPlan(conversation.id);
        toggle("plan")();
      },
    });
  extras.push({
    id: "runs",
    icon: <AppIcon name="Clock" />,
    label: "Runs",
    active: isOpen("runs"),
    toggle: toggle("runs"),
  });
  return extras;
}

/**
 * A Code session's View options, the header's ⋮: Show / Hide session rail when
 * it folded in, the panes the narrow bar folded in and View options' own rows
 * (Side chat, Background tasks with its count, Plan), each a check row with its
 * glyph and shortcut; a rule; then Keep computer awake, only for this session,
 * with its switch. Loaded when first opened.
 */
export function viewOptionEntries({
  rail,
  panes,
  keepAwake,
}: {
  rail?: { shown: boolean; onToggle: () => void };
  panes: PaneSpec[];
  keepAwake?: { on: boolean; onToggle: () => void };
}): MenuEntry[] {
  const top: MenuEntry[] = [
    ...(rail
      ? [
          {
            label: rail.shown ? "Hide session rail" : "Show session rail",
            icon: <AppIcon name="ListCard" />,
            onSelect: rail.onToggle,
          },
        ]
      : []),
    ...panes.map((pane): MenuEntry => ({
      label: pane.label,
      icon: pane.icon,
      checked: pane.active,
      shortcut: pane.shortcut,
      disabled: pane.disabled,
      title: pane.reason,
      ...(pane.count ? { value: String(pane.count) } : {}),
      onSelect: pane.toggle,
    })),
  ];
  const bottom: MenuEntry[] = keepAwake
    ? [
        {
          label: "Keep computer awake",
          description: "Only for this session",
          switched: keepAwake.on,
          keepOpen: true,
          onSelect: keepAwake.onToggle,
        },
      ]
    : [];
  return top.length && bottom.length
    ? [...top, { separator: true }, ...bottom]
    : [...top, ...bottom];
}

export default function CodeViewOptions({
  conversation,
  position,
  anchor,
  onClose,
  ...rows
}: Parameters<typeof viewOptionEntries>[0] & {
  conversation: Conversation;
  position: MenuPosition;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const extras = useViewOptionExtras(conversation);
  // The web's View options hold only what the narrow bar folded in.
  const web = useHost().kind === "web";
  return (
    <Menu
      label="View options"
      className="code-view-options"
      entries={viewOptionEntries({
        ...rows,
        panes: web ? rows.panes : [...rows.panes, ...extras],
      })}
      position={position}
      width={224}
      anchors={[anchor]}
      onClose={onClose}
    />
  );
}
