import {
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";
import type { MenuPosition } from "../ui/Menu";
import { lazyPiece } from "../ui/lazy-piece";
import { useDismiss } from "../ui/useDismiss";
import { AppIcon } from "../ui/app-icon";
import { useTooltip } from "../ui/Tooltip";

/**
 * The same anchored popup opens to the left when the phone's row action has no
 * room at its right.
 */
export function navCreatePosition(
  box: Pick<DOMRect, "left" | "right" | "top">,
  width: number,
  viewportWidth: number,
): MenuPosition {
  const right = box.right + 4;
  return {
    left:
      right + width <= viewportWidth - 8
        ? right
        : Math.max(8, box.left - width - 4),
    top: box.top,
  };
}

/**
 * Current official template-menu tiles, read from the live DOM on 20px tint,
 * 5px corners and a 16px font glyph.
 */
export function NavTemplateIcon({
  kind,
}: {
  kind: "Docs" | "Slides" | "Design" | "Dashboard";
}) {
  const names = {
    Docs: "File",
    Slides: "Slides",
    Design: "Palette",
    Dashboard: "ChartLine",
  } as const;
  return (
    <span className="nav-template-icon" data-template={kind} aria-hidden="true">
      <AppIcon name={names[kind]} size={16} />
    </span>
  );
}

/** Keep cancellation active while only the eager trigger has committed.
 * Once the actual portal mounts, its Menu owns dismissal and focus. */
type PopupModule = Pick<typeof import("./NavCreatePopup"), "NavCreatePopup">;
type ReadyPopupProps = ComponentProps<PopupModule["NavCreatePopup"]> & {
  onReady(): void;
};
export function createNavCreateMenu(load: () => Promise<PopupModule>) {
  const NavCreatePopup = lazyPiece<
    { NavCreatePopup: ComponentType<ReadyPopupProps> },
    "NavCreatePopup"
  >(async () => {
    const { NavCreatePopup: Popup } = await load();
    return {
      NavCreatePopup({ onReady, ...props }: ReadyPopupProps) {
        useLayoutEffect(onReady, [onReady]);
        return <Popup {...props} />;
      },
    };
  }, "NavCreatePopup");
  return function NavCreateMenu({ kind }: { kind: "artifacts" | "scheduled" }) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [position, setPosition] = useState<MenuPosition>();
    const [ready, setReady] = useState(false);
    const onReady = useCallback(() => setReady(true), []);
    useDismiss([anchor], Boolean(position) && !ready, () =>
      setPosition(undefined),
    );
    const label = kind === "artifacts" ? "New from a template" : "New task";
    const width = kind === "artifacts" ? 240 : 183;
    const tip = useTooltip(label);
    return (
      <>
        <button
          {...tip.props}
          ref={anchor}
          className={`main-nav-create ${kind}`}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={Boolean(position)}
          onClick={() => {
            const box = anchor.current!.getBoundingClientRect();
            setReady(false);
            setPosition(
              position ? undefined : navCreatePosition(box, width, innerWidth),
            );
          }}
        >
          <AppIcon name="Add" size={16} />
        </button>
        {tip.tooltip}
        {position && (
          <Suspense fallback={null}>
            <NavCreatePopup
              kind={kind}
              position={position}
              anchor={anchor}
              onClose={() => setPosition(undefined)}
              onReady={onReady}
            />
          </Suspense>
        )}
      </>
    );
  };
}
export const NavCreateMenu = createNavCreateMenu(
  () => import("./NavCreatePopup"),
);
