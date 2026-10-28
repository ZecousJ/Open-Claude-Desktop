import { Fragment, useRef, useState, type ReactNode } from "react";
import { Menu, type MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import { ReplyToolbarButton } from "./ReplyToolbarButton";

export interface MessageAction {
  id: string;
  content: ReactNode;
  kind?: "copy" | "edit" | "retry" | "action" | "speak";
  label?: string;
  pinned?: boolean;
  pressed?: boolean;
  "aria-pressed"?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onSelect?: () => void;
}

/** Keep the first eligible action. */
export function overflowActions(actions: MessageAction[], floating: boolean) {
  const extras = actions
    .filter(
      (action) =>
        action.kind &&
        action.kind !== "speak" &&
        !action.pinned &&
        action.pressed === undefined &&
        action["aria-pressed"] === undefined,
    )
    .slice(1);
  return floating && actions.length > 3 && extras.length >= 2 ? extras : [];
}

export function MessageActions({
  actions,
  floating = false,
}: {
  actions: MessageAction[];
  floating?: boolean;
}) {
  const extras = overflowActions(actions, floating);
  const trigger = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  return actions.map((action) => {
    if (!extras.includes(action))
      return <Fragment key={action.id}>{action.content}</Fragment>;
    if (action !== extras[0]) return null;
    return (
      <span key="overflow" ref={trigger} className="reply-more">
        <ReplyToolbarButton
          label="More options"
          pressed={menu ? true : undefined}
          onClick={() => {
            const rect = trigger.current?.getBoundingClientRect();
            setMenu(
              rect && !menu
                ? { top: rect.bottom + 4, left: rect.left }
                : undefined,
            );
          }}
        >
          <AppIcon name="DotsHorizontal" />
        </ReplyToolbarButton>
        {menu && (
          <Menu
            label="More options"
            width={128}
            position={menu}
            anchors={[trigger]}
            entries={extras.map((extra) => ({
              label:
                extra.label ??
                (extra.kind === "copy"
                  ? "Copy"
                  : extra.kind === "edit"
                    ? "Edit"
                    : "Retry"),
              disabled: extra.disabled || extra.busy,
              onSelect: extra.onSelect,
            }))}
            onClose={() => setMenu(undefined)}
          />
        )}
      </span>
    );
  });
}
