/**
 * Settings controls. Published for the other Settings pages: `Section`, `Row`,
 * `Value`, `Toggle`, `Segmented`, `Dropdown` (borderless value and chevron),
 * `SelectField` (bordered), `TextField`, `TextArea`, `Button`, `PageHeader` and
 * `SettingsModal`; `useLoaded` is in `pageControls.tsx`. Sizes and colours are
 * measured from the R-设置-* captures.
 */
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "../ui/glyphs";
import { Modal } from "../ui/Controls";
import { useTooltip } from "../ui/Tooltip";
import { isEditEndKey } from "../ui/ime";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Dropdown } from "./Dropdown";

/** A titled group of rows. */
export function Section({
  title,
  headingLevel = 3,
  note,
  tightNote = false,
  tightAbove = false,
  joinsAbove = false,
  children,
}: {
  title?: string;
  headingLevel?: 2 | 3;
  note?: ReactNode;
  /**
   * The note describes the section and sits right under its title rather than
   * introducing the page (Privacy).
   */
  tightNote?: boolean;
  /** 28px under the section above instead of 39. */
  tightAbove?: boolean;
  /** A row of the section above, drawn as its own block (no gap, no title). */
  joinsAbove?: boolean;
  children?: ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      className={`settings-section ${tightAbove ? "tight-above" : ""} ${joinsAbove ? "joins-above" : ""}`}
    >
      {title && <Heading data-setting={title}>{title}</Heading>}
      {note && (
        <div className={`settings-section-note ${tightNote ? "tight" : ""}`}>
          {note}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Label and optional description on the left, a control on the right;
 * `stacked` puts the control under the text at full width (Instructions).
 * A plain-text label is what Settings search scrolls to.
 */
export function Row({
  label,
  description,
  stacked = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  stacked?: boolean;
  children?: ReactNode;
}) {
  const labelId = useId();
  return (
    <div
      className={`settings-row ${stacked ? "settings-row-stacked" : ""}`}
      data-setting={typeof label === "string" ? label : undefined}
      role="group"
      aria-labelledby={labelId}
    >
      <div className="settings-row-text">
        <div className="settings-row-label" id={labelId}>
          {label}
        </div>
        {description && <p>{description}</p>}
      </div>
      {children !== undefined &&
        (stacked ? (
          children
        ) : (
          <div className="settings-row-control">{children}</div>
        ))}
    </div>
  );
}

/** Plain value text in a row's control slot. */
export function Value({ children }: { children: ReactNode }) {
  return <span className="settings-value">{children}</span>;
}

/** Switch: a 36×20 track with a 16px knob. */
export function Toggle({
  label,
  checked,
  controls,
  describedBy,
  disabled,
  unavailable,
  onChange,
}: {
  label: string;
  checked: boolean;
  controls?: string;
  describedBy?: string;
  disabled?: boolean;
  /**
   * Why the original's switch cannot work in Claudex yet: it is drawn off
   * and disabled, and the reason shows in a tooltip over it.
   */
  unavailable?: string;
  onChange?: (checked: boolean) => void;
}) {
  if (unavailable)
    return <UnavailableToggle label={label} reason={unavailable} />;
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-controls={controls}
      aria-describedby={describedBy}
      disabled={disabled}
      className="settings-toggle"
      onClick={() => onChange?.(!checked)}
    >
      <span />
    </button>
  );
}

/**
 * Wraps a disabled control of the original's that Claudex cannot back yet;
 * the wrapper takes the pointer (a disabled control does not) and shows
 * the reason in a tooltip above it.
 */
export function Unavailable({
  reason,
  children,
}: {
  reason: string;
  children: ReactNode;
}) {
  const { props, tooltip } = useTooltip(reason, {
    placement: "above",
    size: "wrap",
  });
  return (
    <span className="settings-unavailable" {...props}>
      {children}
      {tooltip}
    </span>
  );
}

/** A switch Claudex cannot back yet: off and disabled. */
function UnavailableToggle({
  label,
  reason,
}: {
  label: string;
  reason: string;
}) {
  return (
    <Unavailable reason={reason}>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={false}
        aria-description={reason}
        disabled
        className="settings-toggle"
      >
        <span />
      </button>
    </Unavailable>
  );
}

export type Choice<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  style?: CSSProperties;
  /** An original choice Claudex cannot offer yet: listed, not choosable. */
  unavailable?: string;
  /** A muted line under the label (Capabilities → Tool access mode). */
  description?: string;
  /** A small neutral badge after the label of a choice with a description ("Recommended"). */
  badge?: string;
};

/** Pill segmented control; options with an icon show only the icon. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  unavailable,
}: {
  label: string;
  value: T;
  options: Choice<T>[];
  onChange: (value: T) => void;
  /** The original's control that Claudex cannot back yet: disabled, with the reason. */
  unavailable?: string;
}) {
  // An icon-only segment names itself in a tooltip above it.
  const group = (
    <SegmentedControl
      className="settings-segmented"
      label={label}
      value={value}
      segments={options.map(({ value, label, icon }) => ({
        value,
        label,
        icon,
      }))}
      onChange={onChange}
      disabled={Boolean(unavailable)}
      tooltipPlacement="above"
    />
  );
  return unavailable ? (
    <Unavailable reason={unavailable}>{group}</Unavailable>
  ) : (
    group
  );
}

/** Gap between a dropdown's trigger and its list. */
export const dropdownGap = 6;
/** Closest a list comes to the window edge. */
const edgeMargin = 8;

export type ListPlace = { right: number; top?: number; bottom?: number };

/**
 * Where a list of `height` goes for a trigger `box`: right edges aligned,
 * below the trigger, or above it when it does not fit below but does above.
 */
export function dropdownPlacement(
  box: { top: number; bottom: number; right: number },
  height: number,
  view: { width: number; height: number },
): ListPlace {
  const right = Math.max(edgeMargin, view.width - box.right);
  const below = box.bottom + dropdownGap;
  if (below + height <= view.height - edgeMargin) return { right, top: below };
  if (box.top - dropdownGap - height >= edgeMargin)
    return { right, bottom: view.height - box.top + dropdownGap };
  return {
    right,
    top: Math.max(edgeMargin, view.height - edgeMargin - height),
  };
}

/** The option a key press moves to, wrapping at the ends; typing a letter jumps to the next label starting with it. */
export function nextChoice(
  labels: string[],
  active: number,
  key: string,
): number | undefined {
  const count = labels.length;
  if (!count) return undefined;
  if (key === "ArrowDown") return (active + 1 + count) % count;
  if (key === "ArrowUp")
    return active < 0 ? count - 1 : (active - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key.length === 1 && /\S/.test(key)) {
    const letter = key.toLowerCase();
    for (let step = 1; step <= count; step++) {
      const index = (active + step + count) % count;
      if (labels[index].toLowerCase().startsWith(letter)) return index;
    }
  }
  return undefined;
}

/** The framed choice field: a bordered `Dropdown`. */
export function SelectField<T extends string>(
  props: Omit<Parameters<typeof Dropdown<T>>[0], "bordered">,
) {
  return <Dropdown<T> {...props} bordered />;
}

/** Text input that reports its value when editing ends (blur or Enter). */
/**
 * What a key does in a TextField: Enter ends the edit and saves; Escape with an
 * edited value puts the saved one back and keeps Settings open; Escape on an
 * unedited value is left to close Settings.
 */
export function textFieldKey(
  key: string,
  draft: string,
  value: string,
): "commit" | "revert" | undefined {
  if (key === "Enter") return "commit";
  if (key === "Escape" && draft.trim() !== value.trim()) return "revert";
  return undefined;
}

export function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const reverted = useRef(false);
  const shown = focused ? draft : value;
  const commit = () => {
    setFocused(false);
    if (reverted.current) return void (reverted.current = false);
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      className="settings-input"
      aria-label={label}
      value={shown}
      placeholder={placeholder}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        // An input method's own Enter or Escape is not the field's.
        if (
          (event.key === "Enter" || event.key === "Escape") &&
          !isEditEndKey(event, event.key)
        )
          return;
        const action = textFieldKey(event.key, draft, value);
        if (action === "commit") event.currentTarget.blur();
        if (action === "revert") {
          event.stopPropagation();
          reverted.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Multi-line counterpart of TextField. */
export function TextArea({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  return (
    <textarea
      className="settings-textarea"
      aria-label={label}
      value={focused ? draft : value}
      placeholder={placeholder}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft !== value) onCommit(draft);
      }}
    />
  );
}

/**
 * Row buttons: grey by default (Log out, Export data, Manage), `primary` light
 * on dark (Edit config), `danger` red. A disabled primary keeps the original's
 * dimmed look. `size="compact"` (default) is 28 tall; `size="regular"` is 32
 * tall with 12px padding.
 */
export function Button({
  children,
  primary,
  danger,
  disabled,
  size = "compact",
  onClick,
  ref,
}: {
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  size?: "compact" | "regular";
  onClick: () => void;
  /** To give the button focus back (a subpage's Back). */
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={`settings-button ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${size === "regular" ? "regular" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * A row button the original has and Claudex cannot back yet: drawn as the
 * original's, disabled, the reason in a tooltip over it.
 */
export function UnavailableButton({
  children,
  reason,
  size = "compact",
}: {
  children: ReactNode;
  reason: string;
  size?: "compact" | "regular";
}) {
  return (
    <Unavailable reason={reason}>
      <Button size={size} disabled onClick={() => {}}>
        {children}
      </Button>
    </Unavailable>
  );
}

/**
 * A row that opens a page of its own, with a chevron; `reason` draws it
 * disabled when Claudex has no such page yet.
 */
export function LinkRow({
  label,
  reason,
  onOpen,
}: {
  label: string;
  reason?: string;
  onOpen?: () => void;
}) {
  const { props, tooltip } = useTooltip(reason ?? "", {
    placement: "above",
    size: "wrap",
    disabled: !reason,
  });
  return (
    <div className="settings-row settings-link-row" data-setting={label}>
      <button
        type="button"
        aria-disabled={reason ? true : undefined}
        onClick={reason ? undefined : onOpen}
        {...(reason ? props : {})}
      >
        <span className="settings-row-label">{label}</span>
        <ChevronRight size={16} strokeWidth={1.5} />
      </button>
      {tooltip}
    </div>
  );
}

/** Title row of the list pages (Skills, Connectors, Plugins). */
export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="settings-page-header">
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/**
 * A dialog opened from a Settings page (Manage, Delete account): drawn over
 * Settings, which would otherwise clip it. Escape closes only the dialog.
 */
export function SettingsModal({
  title,
  wide,
  variant,
  className,
  confirmFocus,
  showClose,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  /** "confirm" for a question with Cancel and a confirming button. */
  variant?: "default" | "confirm";
  /** The dialog's own class (Allowed sites is 400 wide). */
  className?: string;
  /** Which button of a confirmation starts focused (Modal's). */
  confirmFocus?: "confirm" | "cancel";
  showClose?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <Modal
      title={title}
      wide={wide}
      variant={variant}
      className={className}
      confirmFocus={confirmFocus}
      showClose={showClose}
      onClose={onClose}
    >
      {children}
    </Modal>,
    document.body,
  );
}
