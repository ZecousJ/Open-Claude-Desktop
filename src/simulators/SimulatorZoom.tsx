import type { ReactNode } from "react";
import { ZoomIn, ZoomOut } from "../ui/glyphs";
import { useTooltip } from "../ui/Tooltip";
import type { ZoomAction } from "./simulator-model";

/** A magnifier in lucide's geometry with something drawn inside its lens. */
function Magnifier({ children }: { children: ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      {children}
    </svg>
  );
}

/** Zoom to fit: four small arrows pointing into the lens. */
export function ZoomFitIcon() {
  return (
    <Magnifier>
      <path
        d="M11 6.5 12.6 8.4H9.4ZM11 15.5 12.6 13.6H9.4ZM6.5 11 8.4 9.4V12.6ZM15.5 11 13.6 9.4V12.6Z"
        fill="currentColor"
        strokeWidth={0}
      />
    </Magnifier>
  );
}

/** Physical size: a "1" in the lens. */
export function ZoomPhysicalIcon() {
  return (
    <Magnifier>
      <path d="M9.6 8.2 11.6 7v8" strokeWidth={1.6} />
    </Magnifier>
  );
}

function ZoomButton({
  label,
  shortcut,
  icon,
  pressed,
  enabled,
  reason,
  onZoom,
}: {
  label: string;
  shortcut: string[];
  icon: ReactNode;
  /** Fit and Physical size show whether they are the current mode. */
  pressed?: boolean;
  enabled: boolean;
  /** Why the button does nothing, shown as its tooltip then. */
  reason: string;
  onZoom: () => void;
}) {
  // A pressed mode button stays clickable (it does nothing), as the live one does.
  const disabled = !enabled && pressed !== true;
  const { props, tooltip } = useTooltip(disabled ? reason : label, {
    shortcut: disabled ? undefined : shortcut,
  });
  return (
    <>
      <button
        {...props}
        type="button"
        className="icon-button sim-icon-button"
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        // The screen keeps the focus, so typing and the shortcuts go on working.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (enabled) onZoom();
        }}
      >
        {icon}
      </button>
      {tooltip}
    </>
  );
}

/**
 * The zoom buttons at the end of the picker row: Zoom out, a divider, Zoom to
 * fit, Physical size and Zoom in. `canZoom` is null while the screen isn't
 * drawn yet.
 */
export function ZoomControls({
  canZoom,
  mode,
  onZoom,
}: {
  canZoom: ((action: ZoomAction) => boolean) | null;
  mode: "fit" | "physical" | "step";
  onZoom: (action: ZoomAction) => void;
}) {
  const waiting = "Available once the device is ready";
  const button = (
    action: ZoomAction,
    label: string,
    shortcut: string[],
    icon: ReactNode,
    atLimit: string,
  ) => (
    <ZoomButton
      label={label}
      shortcut={shortcut}
      icon={icon}
      pressed={
        action === "fit" || action === "physical"
          ? canZoom !== null && mode === action
          : undefined
      }
      enabled={canZoom?.(action) === true}
      reason={canZoom === null ? waiting : atLimit}
      onZoom={() => onZoom(action)}
    />
  );
  return (
    <div className="sim-zoom" role="group" aria-label="Zoom">
      {button(
        "out",
        "Zoom out",
        ["mod", "-"],
        <ZoomOut size={16} aria-hidden="true" />,
        "Can’t zoom out further",
      )}
      <span className="sim-zoom-divider" aria-hidden="true" />
      {button("fit", "Zoom to fit", ["mod", "0"], <ZoomFitIcon />, waiting)}
      {button(
        "physical",
        "Physical size",
        ["mod", "1"],
        <ZoomPhysicalIcon />,
        "Not available: this device doesn’t report its screen density",
      )}
      {button(
        "in",
        "Zoom in",
        ["mod", "+"],
        <ZoomIn size={16} aria-hidden="true" />,
        "Can’t zoom in further",
      )}
    </div>
  );
}
