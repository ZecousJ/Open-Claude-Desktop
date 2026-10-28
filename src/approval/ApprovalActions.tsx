import { useEffect, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, ChevronDown } from "../ui/glyphs";
import { useKeyGuard } from "./key-guard";
import { Menu, type MenuPosition } from "../ui/Menu";
import { ReasonTooltip } from "../ui/Tooltip";
import { t } from "../i18n";

type Key = "1" | "2" | "3" | "4" | "esc" | "shift" | "mod" | "enter";

// Modifier keys are text: ⇧ and ⌘ on Mac, "Shift" and "Ctrl" elsewhere.
export function Keycap({ k, mac }: { k: Key; mac: boolean }) {
  const icon = { size: 11, strokeWidth: 1.75, "aria-hidden": true } as const;
  return (
    <kbd className="approval-key" data-key={k}>
      {k === "shift" ? (
        mac ? (
          "\u21E7"
        ) : (
          "Shift"
        )
      ) : k === "mod" ? (
        mac ? (
          "\u2318"
        ) : (
          "Ctrl"
        )
      ) : k === "enter" ? (
        <CornerDownLeft {...icon} />
      ) : k === "esc" ? (
        "Esc"
      ) : (
        k
      )}
    </kbd>
  );
}

/** A labelled button followed by its keycap groups, 8px apart. */
export function ActionButton({
  label,
  icon,
  keys,
  primary,
  disabled,
  reason,
  mac,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  keys: Key[][];
  primary?: boolean;
  disabled?: boolean;
  /** Why it is greyed, in a tooltip. */
  reason?: string;
  mac: boolean;
  onClick: () => void;
}) {
  return (
    <ReasonTooltip reason={disabled ? reason : undefined} placement="above">
      {(tip) => (
        <button
          {...tip}
          type="button"
          className="approval-button"
          data-primary={primary || undefined}
          disabled={disabled}
          onClick={onClick}
        >
          <span className="approval-button-label">
            {label}
            {icon}
          </span>
          {keys.map((group, i) => (
            <span className="approval-keys" key={i}>
              {group.map((k) => (
                <Keycap key={k} k={k} mac={mac} />
              ))}
            </span>
          ))}
        </button>
      )}
    </ReasonTooltip>
  );
}

function editable(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return Boolean(
    el &&
    (el.isContentEditable ||
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT"),
  );
}
/** An empty composer: Esc there denies; other fields (search, rename) keep Esc for themselves. */
function emptyComposer(target: EventTarget | null) {
  const el = target as HTMLTextAreaElement | null;
  return Boolean(el?.closest?.(".composer-wrap") && "value" in el && !el.value);
}

/** Menus, popovers, dialogs and the slash-command palette or token keep their own keys. */
function overlayOpen() {
  return Boolean(
    document.querySelector(
      '[role="menu"], [aria-modal="true"], [role="listbox"], .popover, .code-slash-palette, .code-slash-token',
    ),
  );
}

export interface ApprovalHandlers {
  deny?: () => void;
  always?: () => void;
  once: () => void;
  /** Always allow shown greyed with this reason, when there is no `always`. */
  alwaysDisabledReason?: string;
  /**
   * More allow options ▸ Allow and switch to Auto: allows once and puts the
   * session in Auto. Absent: no menu.
   */
  switchToAuto?: () => void;
  /** False for a card whose buttons carry no 1-2-3 keycaps (the plan card). */
  digits?: boolean;
}

/** The card action a key press answers with, if any (see useApprovalShortcuts). */
export function approvalShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target"
  >,
  handlers: ApprovalHandlers,
  mac: boolean,
): (() => void) | undefined {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const { deny, always, once } = handlers;
  if (event.key === "Enter" && mod && !event.altKey)
    return event.shiftKey ? always : once;
  if (
    event.key === "Escape" &&
    !event.shiftKey &&
    !mod &&
    (!editable(event.target) || emptyComposer(event.target))
  )
    return deny;
  if (
    handlers.digits !== false &&
    !editable(event.target) &&
    !mod &&
    !event.altKey &&
    !event.shiftKey &&
    ["1", "2", "3"].includes(event.key)
  )
    return event.key === "1" ? deny : event.key === "2" ? always : once;
  return undefined;
}

/**
 * Shortcuts shown on the card: 1 or Esc denies, 2 or ⇧⌘↩ always allows,
 * 3 or ⌘↩ allows once. Digits are ignored while typing in a field so a draft in the composer never
 * answers the card; in a field, Esc only acts on an empty composer. Only
 * the frontmost card listens. A key that would answer is swallowed, not
 * acted on, while it is held, within 400ms of the card appearing, and (⌘↩)
 * right after typing or from a field outside the card (key-guard.ts).
 */
export function useApprovalShortcuts(
  enabled: boolean,
  handlers: ApprovalHandlers,
  mac: boolean,
) {
  const current = useRef(handlers);
  current.current = handlers;
  const guard = useKeyGuard(enabled);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || overlayOpen()) return;
      const action = approvalShortcut(event, current.current, mac);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (guard(event) === "act") action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, mac, guard]);
}

export function ApprovalActions({
  handlers,
  onceLabel = "Allow once",
  onceIcon,
  denyLabel = "Deny",
  alwaysLabel = "Always allow",
  busy,
  mac,
  onceDisabled,
}: {
  handlers: ApprovalHandlers;
  onceLabel?: string;
  onceIcon?: ReactNode;
  denyLabel?: string;
  alwaysLabel?: string;
  busy: boolean;
  mac: boolean;
  onceDisabled?: boolean;
}) {
  return (
    <>
      <ApprovalButtons
        handlers={handlers}
        onceLabel={onceLabel}
        onceIcon={onceIcon}
        denyLabel={denyLabel}
        alwaysLabel={alwaysLabel}
        busy={busy}
        mac={mac}
        onceDisabled={onceDisabled}
      />
    </>
  );
}

function ApprovalButtons({
  handlers,
  onceLabel,
  onceIcon,
  denyLabel,
  alwaysLabel,
  busy,
  mac,
  onceDisabled,
}: {
  handlers: ApprovalHandlers;
  onceLabel: string;
  onceIcon?: ReactNode;
  denyLabel: string;
  alwaysLabel: string;
  busy: boolean;
  mac: boolean;
  onceDisabled?: boolean;
}) {
  return (
    <div className="approval-actions">
      {handlers.deny && (
        <ActionButton
          label={denyLabel}
          keys={[["1"], ["esc"]]}
          disabled={busy}
          mac={mac}
          onClick={handlers.deny}
        />
      )}
      <span className="approval-actions-gap" />
      <ActionButton
        label={onceLabel}
        icon={onceIcon}
        keys={[["3"], ["mod", "enter"]]}
        primary
        disabled={busy || onceDisabled}
        mac={mac}
        onClick={handlers.once}
      />
      {(handlers.always ||
        handlers.alwaysDisabledReason ||
        handlers.switchToAuto) && (
        <MoreAllowOptions
          busy={busy}
          alwaysLabel={alwaysLabel}
          onAlways={handlers.always}
          alwaysReason={
            handlers.always ? undefined : handlers.alwaysDisabledReason
          }
          onSwitch={handlers.switchToAuto}
        />
      )}
    </div>
  );
}

/** The split half after Allow once and its menu. */
function MoreAllowOptions({
  busy,
  alwaysLabel,
  onAlways,
  alwaysReason,
  onSwitch,
}: {
  busy: boolean;
  alwaysLabel: string;
  onAlways?: () => void;
  /** Why the always choice is greyed (the policy, or the tool). */
  alwaysReason?: string;
  onSwitch?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="approval-button approval-once-more"
        data-primary
        aria-label={t("More allow options")}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={busy}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = trigger.current!.getBoundingClientRect();
          setMenu({
            right: window.innerWidth - box.right,
            bottom: window.innerHeight - box.top + 4,
          });
        }}
      >
        <ChevronDown size={13} strokeWidth={1.75} />
      </button>
      {menu && (
        <Menu
          label="More allow options"
          entries={[
            ...(onAlways || alwaysReason
              ? [
                  {
                    label: alwaysLabel,
                    shortcut: ["shift", "mod", "enter"],
                    disabled: !onAlways,
                    title: alwaysReason,
                    onSelect: onAlways,
                  },
                ]
              : []),
            ...(onSwitch
              ? [
                  {
                    label: "Allow and switch to Auto",
                    description: "Auto reviews the rest of this session.",
                    onSelect: onSwitch,
                  },
                ]
              : []),
          ]}
          position={menu}
          width={240}
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
