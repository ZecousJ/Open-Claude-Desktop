import {
  Suspense,
  useContext,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { AppContext } from "../app/AppContext";
import {
  preference,
  taskPermissions,
  type SettingsPreferences,
  type TaskPermission,
} from "../../shared/settings-extras";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { useTooltip } from "../ui/Tooltip";
import { AppIcon, type AppIconName } from "../ui/app-icon";
import { lazyPiece } from "../ui/lazy-piece";
import { useDismiss } from "../ui/useDismiss";

const TaskPermissionMenu = lazyPiece(
  () => import("./TaskPermissionMenu"),
  "TaskPermissionMenu",
);

/** The lazy menu and any chunk error stay out of the composer's flow. */
function WebPermissionPopup(props: ComponentProps<typeof Menu>) {
  const pending = useRef<HTMLDivElement>(null);
  const loaded = useRef<HTMLDivElement>(null);
  useDismiss([pending, loaded, ...(props.anchors ?? [])], true, props.onClose);
  return createPortal(
    <div
      ref={pending}
      style={{
        position: "fixed",
        zIndex: 200,
        width: props.width,
        ...props.position,
      }}
    >
      <Suspense fallback={null}>
        <TaskPermissionMenu {...props} frameRef={loaded} />
      </Suspense>
    </div>,
    document.body,
  );
}

const SkipAllApprovalsDialog = lazyPiece(
  () => import("./SkipAllApprovalsDialogImpl"),
  "SkipAllApprovalsDialog",
);

/**
 * A task's permission modes as the official unified home names them. Full
 * access is the official "Skip all approvals", which the owner kept for
 * native/task callers; the captured web Chat presentation offers only Manual
 * and Auto.
 */
export const taskPermissionText: Record<
  TaskPermission,
  { label: string; trigger: string; description: string }
> = {
  default: {
    label: "Manual",
    trigger: "Manual",
    description: "Claudex asks before using new tools or opening new sites.",
  },
  auto: {
    label: "Auto",
    trigger: "Auto",
    description:
      "Claudex runs on its own and pauses to ask if anything looks unsafe.",
  },
  bypass: {
    label: "Skip all approvals",
    // The official compact trigger says "Skip", which reads as nothing on its
    // own: the trigger names the mode in full.
    trigger: "Skip all approvals",
    description: "Claudex never pauses, even for unsafe actions.",
  },
};

/**
 * The same modes as a new task's composer in a task window names them, each
 * with the glyph its icon-only trigger shows.
 */
export const windowPermissionText: Record<
  TaskPermission,
  { label: string; description: string; glyph: AppIconName }
> = {
  default: {
    label: "Manually approve",
    description: "Claudex pauses so you can approve each action.",
    glyph: "Hand",
  },
  auto: {
    label: "Automatically approve",
    description: taskPermissionText.auto.description,
    glyph: "Fastforward",
  },
  bypass: {
    label: "Skip all approvals",
    description: taskPermissionText.bypass.description,
    glyph: "Warning",
  },
};

// An unbound session uses Cowork copy; a bound hub session uses the shorter
// labels.
export const coworkPermissionText = {
  default: { ...taskPermissionText.default, ...windowPermissionText.default },
  auto: { ...taskPermissionText.auto, ...windowPermissionText.auto },
  bypass: { ...taskPermissionText.bypass, ...windowPermissionText.bypass },
};

/** The picker's rows: a "Permission mode" label over the modes, each with its description. */
export function taskPermissionEntries(
  value: TaskPermission,
  onChange: (mode: TaskPermission) => void,
  text: Record<
    TaskPermission,
    { label: string; description: string }
  > = taskPermissionText,
  cloud = false,
  supportedModes?: readonly string[],
  presentation: "web-chat" | "legacy" = "legacy",
  tooltips = false,
): MenuEntry[] {
  return [
    // Without inline descriptions the popup has no "Permission mode" label, and
    // each row is its 20px glyph and name with the description as a tooltip at
    // the row's end.
    ...(tooltips ? [] : [{ heading: "Permission mode" }]),
    ...taskPermissions
      .filter((mode) => presentation !== "web-chat" || mode !== "bypass")
      .map((mode) => ({
        label: text[mode].label,
        ...(tooltips
          ? {
              icon: (
                <AppIcon name={windowPermissionText[mode].glyph} size={20} />
              ),
              tooltip: text[mode].description,
            }
          : { description: text[mode].description, descriptionWraps: true }),
        checked: mode === value,
        ...(presentation === "web-chat"
          ? { checkedRole: "radio" as const }
          : {}),
        ...(cloud &&
        mode !== "default" &&
        mode !== value &&
        !supportedModes?.includes(mode)
          ? {
              disabled: true,
              title:
                mode === "auto"
                  ? "Auto only runs locally"
                  : "Skip all approvals only runs locally",
            }
          : {}),
        onSelect: () => onChange(mode),
      })),
  ];
}

/** The menu's width: the official popup's widest (max-w-[288px] with inline descriptions). */
const menuWidth = 288;
/** About the menu's height: three rows with wrapped descriptions and the label. */
const menuRoom = 220;

/**
 * The permission picker under a task's composer: its trigger is the mode's name
 * only (no glyph, no caret), its description the tooltip, and the menu opens
 * below it with each mode's description under its name.
 */
export function TaskPermissionPicker({
  settings,
  onChange,
  align = "end",
  iconOnly = false,
  sessionType = "hub",
  cloud = false,
  supportedModes,
  presentation = "legacy",
}: {
  settings: SettingsPreferences;
  onChange: (mode: TaskPermission) => void;
  /**
   * Where the menu lines up with the trigger: its end with the trigger's end,
   * opening leftwards.
   */
  align?: "start" | "end";
  /**
   * A task window's composer: the mode's glyph only, its name for screen
   * readers and its description as the tooltip; the menu opens above, lined up
   * with the trigger's end.
   */
  iconOnly?: boolean;
  sessionType?: "hub" | "cowork";
  cloud?: boolean;
  supportedModes?: readonly string[];
  /** Current web Chat offers Manual and Auto; task windows keep their modes. */
  presentation?: "web-chat" | "legacy";
}) {
  const value = preference(settings, "taskPermission");
  const app = useContext(AppContext);
  const labels =
    sessionType === "cowork" ? coworkPermissionText : taskPermissionText;
  const text = iconOnly ? windowPermissionText[value] : labels[value];
  const [position, setPosition] = useState<MenuPosition>();
  const [confirmingBypass, setConfirmingBypass] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useTooltip(text.description, {
    disabled: Boolean(position),
    size: "wrap",
  });
  const select = (mode: TaskPermission) => {
    setPosition(undefined);
    if (mode === "bypass") return setConfirmingBypass(true);
    onChange(mode);
  };
  const popup = position && {
    label: "Permission mode",
    entries: taskPermissionEntries(
      value,
      select,
      iconOnly ? windowPermissionText : labels,
      cloud,
      supportedModes,
      presentation,
      iconOnly,
    ),
    position,
    // A task window's popup has no inline descriptions: min-w-[200px]
    // max-w-[360px], as wide as its rows (shared-8 NQ).
    width: iconOnly ? ("max-content" as const) : menuWidth,
    ...(iconOnly ? { className: "task-permission-window" } : {}),
    anchors: [anchor],
    onClose: () => setPosition(undefined),
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        {...tip.props}
        className={`task-permission-trigger mode-${value}${position ? " open" : ""}${iconOnly ? " icon-only" : ""}`}
        aria-label={text.label}
        aria-haspopup="menu"
        aria-expanded={Boolean(position)}
        onClick={(event) => {
          if (position) return setPosition(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          // A task window's menu opens above, lined up with the trigger's end.
          if (iconOnly)
            return setPosition({
              right: Math.max(8, innerWidth - box.right),
              bottom: innerHeight - box.top + 4,
            });
          const left = align === "start" ? box.left : box.right - menuWidth;
          // Below the trigger where it fits (the official side "bottom"),
          // else above it, as the official popup flips; shifted back inside
          // the window sideways.
          const below = innerHeight - box.bottom >= menuRoom;
          setPosition({
            left: Math.max(8, Math.min(left, innerWidth - menuWidth - 8)),
            ...(below
              ? { top: box.bottom + 4 }
              : { bottom: innerHeight - box.top + 4 }),
          });
        }}
      >
        {iconOnly ? (
          <AppIcon name={windowPermissionText[value].glyph} />
        ) : (
          <>
            <span className="task-permission-label">
              {labels[value].trigger}
            </span>
            <AppIcon
              className="task-permission-mobile-icon"
              name={windowPermissionText[value].glyph}
              size={16}
            />
          </>
        )}
      </button>
      {tip.tooltip}
      {popup &&
        (presentation === "web-chat" ? (
          <WebPermissionPopup {...popup} />
        ) : (
          <Menu {...popup} />
        ))}
      {confirmingBypass && (
        <Suspense fallback={null}>
          <SkipAllApprovalsDialog
            connectors={Object.entries(app?.snapshot?.settings.mcpServers ?? {})
              .filter(
                ([, config]) =>
                  !(
                    config &&
                    typeof config === "object" &&
                    "enabled" in config &&
                    config.enabled === false
                  ),
              )
              .map(([name]) => name)}
            onCancel={() => setConfirmingBypass(false)}
            onConfirm={() => {
              setConfirmingBypass(false);
              onChange("bypass");
            }}
          />
        </Suspense>
      )}
    </>
  );
}
