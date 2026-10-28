import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  edgeHint,
  edgeZone,
  peekCloseMs,
  peekDwellMs,
  type EdgeHint,
} from "./sidebar-peek";

/** The first thing a keyboard reaches in the card. */
const focusable =
  "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * The collapsed sidebar's peek (sidebar-peek.ts). While `enabled` (the
 * sidebar hidden), the pointer resting on the left edge or entering the
 * sidebar toggle opens the card, and leaving both the card and its owners
 * (`data-peek-owner`) closes it after a moment. Nothing opens or closes
 * while a button is held, so a row drag inside the card goes on undisturbed.
 * A menu opened from the card, a field being typed in or keyboard focus in
 * the card keep it open. From the keyboard, Down or Right on the toggle
 * opens it and moves into it; Escape closes it and returns to the toggle.
 * At narrow widths the toggle itself opens and closes it (`requested`), and
 * on a touch screen, where nothing hovers, a press outside closes it.
 *
 * `state` is undefined for a frame (or `armMs`) after the sidebar hides, so the card
 * takes its hidden place without animating; then "closed" or "open".
 */
export function useSidebarPeek(
  enabled: boolean,
  card: RefObject<HTMLElement | null>,
  {
    requested = false,
    onOpenChange,
    armMs = 0,
  }: {
    /**
     * The sidebar toggle asked for the card (useSidebarVisibility, narrow):
     * it opens, and closes when the ask is withdrawn.
     */
    requested?: boolean;
    /** The card opened or closed, whatever did it. */
    onOpenChange?: (open: boolean) => void;
    /**
     * How long after the sidebar hides the card takes its place: the web's
     * docked sidebar slides out first (useSidebarVisibility slideMs).
     */
    armMs?: number;
  } = {},
) {
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<EdgeHint>("none");
  const [armed, setArmed] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const toggle = useRef<HTMLElement | null>(null);
  // Closed from the toggle under the pointer: hovering it again does not reopen
  // the card until the pointer has left it.
  const suppressed = useRef(false);
  const changed = useRef(onOpenChange);
  changed.current = onOpenChange;
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopDwell = () => {
    clearTimeout(dwell.current);
    dwell.current = undefined;
  };
  const stopClosing = () => {
    clearTimeout(closing.current);
    closing.current = undefined;
  };
  /** A menu opened from the card is showing. */
  const menuOpen = () =>
    Boolean(
      card.current?.querySelector(
        '[aria-haspopup][aria-expanded="true"], .conversation-row.menu-open',
      ),
    );
  /** Something in the card holds it open. */
  const held = () => {
    const box = card.current;
    if (!box) return false;
    if (menuOpen()) return true;
    const focused = document.activeElement;
    if (!focused || !box.contains(focused)) return false;
    return (
      focused instanceof HTMLInputElement ||
      focused instanceof HTMLTextAreaElement ||
      focused.matches(":focus-visible")
    );
  };
  const show = () => {
    stopClosing();
    stopDwell();
    setHint("none");
    setOpen(true);
  };
  const hide = () => {
    stopClosing();
    stopDwell();
    setOpen(false);
  };
  const closeSoon = () => {
    if (!openRef.current || closing.current) return;
    const check = () => {
      if (held()) {
        closing.current = setTimeout(check, peekCloseMs);
        return;
      }
      closing.current = undefined;
      setOpen(false);
    };
    closing.current = setTimeout(check, peekCloseMs);
  };
  useEffect(() => {
    if (!enabled) {
      hide();
      setHint("none");
      setArmed(false);
      return;
    }
    let frame = 0;
    const arm = setTimeout(() => {
      frame = requestAnimationFrame(() => setArmed(true));
    }, armMs);
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (event.buttons !== 0) {
        stopDwell();
        setHint("none");
        return;
      }
      const zone = edgeZone(event.clientX, event.clientY, innerHeight);
      const target = event.target instanceof Element ? event.target : null;
      const over =
        Boolean(target?.closest("[data-peek-owner]")) ||
        Boolean(target && card.current?.contains(target));
      if (openRef.current) {
        if (over || zone === "open") stopClosing();
        else closeSoon();
        return;
      }
      setHint(edgeHint(zone, false));
      if (zone !== "open") stopDwell();
      else dwell.current ??= setTimeout(show, peekDwellMs);
    };
    // A mouse leaving the window; a finger lifting fires this too, and must
    // not close what it just opened.
    const leave = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      stopDwell();
      setHint("none");
      closeSoon();
    };
    const blur = () => {
      setHint("none");
      hide();
    };
    // A touch or pen press outside the card and its owners closes it, as
    // nothing hovers there to.
    const press = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || !openRef.current || menuOpen())
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target &&
        (card.current?.contains(target) || target.closest("[data-peek-owner]"))
      )
        return;
      hide();
    };
    addEventListener("pointermove", move, { capture: true, passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    addEventListener("blur", blur);
    addEventListener("pointerdown", press, { capture: true });
    return () => {
      clearTimeout(arm);
      cancelAnimationFrame(frame);
      removeEventListener("pointerdown", press, { capture: true });
      removeEventListener("pointermove", move, { capture: true });
      document.documentElement.removeEventListener("pointerleave", leave);
      removeEventListener("blur", blur);
      stopDwell();
      stopClosing();
    };
  }, [enabled]);
  // The toggle's ask; what the card does on its own is reported back.
  useEffect(() => {
    if (!enabled) return;
    if (requested) {
      suppressed.current = false;
      show();
    } else if (openRef.current) {
      suppressed.current = Boolean(
        document.querySelector("[data-peek-owner]:hover"),
      );
      hide();
    }
  }, [requested]);
  useEffect(() => {
    changed.current?.(open);
  }, [open]);
  /** Opens the card and moves the keyboard into it. */
  const enter = () => {
    show();
    requestAnimationFrame(() =>
      [...(card.current?.querySelectorAll<HTMLElement>(focusable) ?? [])]
        .find((element) => element.offsetParent !== null)
        ?.focus(),
    );
  };
  return {
    state: (enabled && armed ? (open ? "open" : "closed") : undefined) as
      "open" | "closed" | undefined,
    hint: enabled ? hint : "none",
    /** Closes the card now (a conversation or page was opened from it). */
    hide,
    /** For the collapsed title-bar controls: the toggle opens the card. */
    ownerProps: {
      "data-peek-owner": "",
      onPointerOver: (event: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || event.pointerType !== "mouse" || event.buttons) return;
        if (suppressed.current) return;
        const button = (event.target as Element).closest<HTMLElement>(
          ".window-nav-toggle",
        );
        if (!button) return;
        toggle.current = button;
        show();
      },
      onPointerLeave: () => {
        suppressed.current = false;
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        const button = (event.target as Element).closest<HTMLElement>(
          ".window-nav-toggle",
        );
        if (!enabled || !button) return;
        if (event.key !== "ArrowDown" && event.key !== "ArrowRight") return;
        event.preventDefault();
        toggle.current = button;
        enter();
      },
    },
    /** For the card (the sidebar itself). */
    cardProps: {
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (!openRef.current || event.key !== "Escape") return;
        // A menu or field inside handles its own Escape first.
        if (event.defaultPrevented || menuOpen()) return;
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        hide();
        toggle.current?.focus();
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!openRef.current) return;
        const next = event.relatedTarget as Element | null;
        if (
          next &&
          (card.current?.contains(next) || next.closest("[data-peek-owner]"))
        )
          return;
        // Focus that went to a menu the card opened keeps it open.
        requestAnimationFrame(() => {
          if (!held() && !card.current?.matches(":hover")) hide();
        });
      },
    },
  };
}
