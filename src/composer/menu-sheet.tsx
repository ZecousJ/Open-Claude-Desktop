import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { ArrowLeft } from "../ui/glyphs";
import { t } from "../i18n";
import { AppContext } from "../app/AppContext";

/** O16 shared-frame:10033–10042: explicit sheet context OR coarse pointer. */
export const ComposerMenuPresentation = createContext<"auto" | "sheet">("auto");
let stylesheet: Promise<unknown> | undefined;
const loadSheetStyle = () =>
  (stylesheet ??= import("./composer-sheet-navigation.css").catch((error) => {
    stylesheet = undefined;
    throw error;
  }));
export function useComposerMenuPresentation() {
  const mode = useContext(ComposerMenuPresentation);
  const coarse = useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia?.("(pointer: coarse)");
      query?.addEventListener?.("change", changed);
      return () => query?.removeEventListener?.("change", changed);
    },
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)")?.matches ?? false),
    () => false,
  );
  return mode === "sheet" || coarse;
}
interface SheetFrame {
  box: HTMLElement;
  current(): boolean;
  child?: HTMLElement;
  scrim?: HTMLElement;
  uncover?(): void;
  restoreHeight?(): void;
  cancel?(): void;
  motion?: "peel" | "close";
  dismiss(done: () => void): void;
}
const frames = new Set<SheetFrame>();
function reduced(box: HTMLElement) {
  return (
    box.ownerDocument.documentElement.dataset.motion === "reduced" ||
    box.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches === true
  );
}
function duration(box: HTMLElement) {
  const token =
    box.ownerDocument.defaultView
      ?.getComputedStyle(box)
      .getPropertyValue("--composer-sheet-duration")
      .trim() ?? "";
  const amount = Number.parseFloat(token);
  // c6a992d55 CSS:66900: --cds-dur-sheet: .3s; no invented hold delay.
  return Number.isFinite(amount)
    ? amount * (token.endsWith("ms") ? 1 : 1000)
    : 300;
}
/** A scrim can live beside a Suspense boundary or the portaled picker. The
 * active frame owns its exit; a retired/unmounted frame never delays routing. */
export function dismissComposerSheet(from: HTMLElement, done: () => void) {
  const live = [...frames].filter(
    (frame) =>
      frame.box.isConnected && frame.box.ownerDocument === from.ownerDocument,
  );
  const frame =
    [...live]
      .reverse()
      .find((frame) => frame.box.parentElement?.contains(from)) ?? live.at(-1);
  frame ? frame.dismiss(done) : done();
}
function arrive(
  node: HTMLElement,
  ready: Promise<unknown>,
  alive: () => boolean,
) {
  const opacity = node.style.opacity;
  node.style.opacity = "0";
  let animationFrame = 0;
  void ready.then(
    () => {
      if (!alive()) return;
      if (!reduced(node)) {
        node.dataset.composerSheetStarting = "true";
        node.getBoundingClientRect();
        animationFrame =
          node.ownerDocument.defaultView?.requestAnimationFrame?.(() => {
            delete node.dataset.composerSheetStarting;
          }) ?? 0;
      }
      node.style.opacity = opacity;
    },
    () => {
      if (alive()) node.style.opacity = opacity;
    },
  );
  return () => {
    node.ownerDocument.defaultView?.cancelAnimationFrame?.(animationFrame);
    node.style.opacity = opacity;
    delete node.dataset.composerSheetStarting;
  };
}

/** Source sheet frame Hc/tP/cD and native menu:1200–1450. Submenus use
 * the browser top layer, preserving their React/event ownership while making
 * their viewport position independent of the covered parent's transform.
 * Unsupported popover hosts retain functional drill/back without that scale. */
export function useComposerMenuSheet(
  root: RefObject<HTMLElement | null>,
  {
    sheet,
    nested,
    panel,
    panelRef,
    trigger,
    onBack,
  }: {
    sheet: boolean;
    nested?: string | boolean | null;
    panel?: string;
    panelRef?: RefObject<HTMLElement | null>;
    trigger?: string | RefObject<HTMLElement | null>;
    onBack?: () => void;
  },
) {
  const app = useContext(AppContext);
  const owner = useMemo(
    () => ({}),
    [
      app?.accountId,
      app?.controllerScope,
      app?.activeId,
      app?.draftSession,
      app?.page,
      typeof window === "undefined" ? undefined : window.desktop,
    ],
  );
  const latest = useRef(onBack);
  latest.current = onBack;
  const active = useRef<SheetFrame | undefined>(undefined);
  const start = (kind: "peel" | "close", done: () => void) => {
    const frame = active.current;
    const node = kind === "peel" ? frame?.child : frame?.box;
    if (frame && !frame.current()) return;
    if (!frame || !node || !node.isConnected || reduced(node)) {
      done();
      return;
    }
    if (frame.motion) return;
    frame.motion = kind;
    const oldInert = node.getAttribute("inert");
    const childInert = frame.child?.getAttribute("inert");
    node.setAttribute("inert", "");
    if (kind === "peel") {
      frame.uncover?.();
      frame.restoreHeight?.();
      node.dataset.composerSheetPeeling = "true";
    } else {
      frame.box.dataset.composerSheetTreeClosing = "true";
      if (frame.scrim) frame.scrim.dataset.composerSheetEnding = "true";
      if (frame.child) {
        frame.child.dataset.composerSheetTreeClosing = "true";
        frame.child.dataset.composerSheetEnding = "true";
        frame.child.setAttribute("inert", "");
      }
    }
    node.dataset.composerSheetEnding = "true";
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const clear = () => {
      clearTimeout(timer);
      node.removeEventListener("transitionend", end);
      delete node.dataset.composerSheetEnding;
      delete node.dataset.composerSheetPeeling;
      delete frame.box.dataset.composerSheetTreeClosing;
      if (frame.scrim) delete frame.scrim.dataset.composerSheetEnding;
      if (frame.child) {
        delete frame.child.dataset.composerSheetEnding;
        delete frame.child.dataset.composerSheetTreeClosing;
        if (kind === "close") {
          if (childInert == null) frame.child.removeAttribute("inert");
          else frame.child.setAttribute("inert", childInert);
        }
      }
      if (oldInert === null) node.removeAttribute("inert");
      else node.setAttribute("inert", oldInert);
      frame.motion = undefined;
      frame.cancel = undefined;
    };
    const complete = () => {
      if (finished) return;
      finished = true;
      clear();
      if (active.current === frame && frame.box.isConnected && frame.current())
        done();
    };
    const end = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === "translate")
        complete();
    };
    node.addEventListener("transitionend", end);
    timer = setTimeout(complete, duration(node));
    frame.cancel = () => {
      finished = true;
      clear();
    };
  };
  useLayoutEffect(() => {
    const box = root.current;
    if (!sheet || !box) return;
    let parent = box.parentElement;
    let scrim: HTMLElement | undefined;
    while (parent && !scrim) {
      scrim = Array.from(
        parent.querySelectorAll<HTMLElement>(".composer-menu-scrim"),
      ).find(
        (candidate) => ![...frames].some((frame) => frame.scrim === candidate),
      );
      parent = parent.parentElement;
    }
    const bridge = window.desktop;
    const origin = window.location?.origin;
    const frame: SheetFrame = {
      box,
      scrim,
      current: () => {
        const actor = app?.currentController?.current;
        return (
          window.desktop === bridge &&
          window.location?.origin === origin &&
          (!app?.currentController ||
            Boolean(
              actor &&
              actor.accountId === app.accountId &&
              actor.controllerScope === app.controllerScope &&
              actor.activeId === app.activeId &&
              actor.draftSession === app.draftSession &&
              actor.page === app.page,
            ))
        );
      },
      dismiss: (done) => start("close", done),
    };
    active.current = frame;
    frames.add(frame);
    box.dataset.composerSheet = "true";
    const cancelScrimArrival = scrim
      ? arrive(
          scrim,
          loadSheetStyle(),
          () => active.current === frame && scrim.isConnected,
        )
      : undefined;
    const cancelArrival = arrive(
      box,
      loadSheetStyle(),
      () => active.current === frame && box.isConnected,
    );
    return () => {
      frame.cancel?.();
      frames.delete(frame);
      if (active.current === frame) active.current = undefined;
      cancelArrival();
      cancelScrimArrival?.();
      delete box.dataset.composerSheet;
      delete box.dataset.composerSheetCovered;
      delete box.dataset.composerSheetDrilled;
    };
  }, [root, sheet, owner]);
  useLayoutEffect(() => {
    const frame = active.current;
    const box = frame?.box;
    const child = nested
      ? (panelRef?.current ??
        (panel ? box?.querySelector<HTMLElement>(panel) : undefined))
      : undefined;
    if (!sheet || !frame || !box || !child) return;
    frame.child = child;
    const HTMLElementClass = box.ownerDocument.defaultView?.HTMLElement;
    const isElement = (value: unknown): value is HTMLElement =>
      Boolean(HTMLElementClass && value instanceof HTMLElementClass);
    const covered = new Map<
      HTMLElement,
      { inert: string | null; hidden: string | null }
    >();
    const scroll = box.scrollTop;
    const returnTo =
      typeof trigger === "string"
        ? box.querySelector<HTMLElement>(trigger)
        : trigger?.current;
    const height = box.style.height;
    const ownHeight = box.getBoundingClientRect().height;
    const oldPopover = child.getAttribute("popover");
    let layered = false;
    if (typeof child.showPopover === "function") {
      try {
        child.setAttribute("popover", "manual");
        child.showPopover();
        layered = true;
      } catch {
        /* Older hosts retain the usable non-transformed sheet. */
      }
    }
    const cover = (node: HTMLElement) => {
      if (node === child || child.contains(node)) return;
      if (node.contains(child)) {
        for (const element of Array.from(node.children))
          if (isElement(element)) cover(element);
        return;
      }
      if (!covered.has(node))
        covered.set(node, {
          inert: node.getAttribute("inert"),
          hidden: node.getAttribute("aria-hidden"),
        });
      node.setAttribute("inert", "");
      node.setAttribute("aria-hidden", "true");
      node.dataset.composerSheetContentCovered = "true";
    };
    const coverParent = () => {
      if (frame.motion === "peel") return;
      for (const element of Array.from(box.children))
        if (isElement(element)) cover(element);
    };
    const uncover = () => {
      delete box.dataset.composerSheetCovered;
      delete box.dataset.composerSheetDrilled;
      for (const [node, old] of covered) {
        if (old.inert === null) node.removeAttribute("inert");
        else node.setAttribute("inert", old.inert);
        if (old.hidden === null) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", old.hidden);
        delete node.dataset.composerSheetContentCovered;
      }
    };
    frame.uncover = uncover;
    frame.restoreHeight = () => {
      box.style.height = height;
    };
    box.dataset.composerSheetDrilled = "true";
    box.dataset.composerSheetCovered = "true";
    box.dataset.composerSheetLayered = String(layered);
    child.dataset.composerSheetChild = "true";
    coverParent();
    const cancelArrival = arrive(
      child,
      loadSheetStyle(),
      () =>
        active.current === frame && frame.child === child && child.isConnected,
    );
    const size = () => {
      if (!frame.motion) {
        const childHeight = child.getBoundingClientRect().height;
        if (ownHeight > 0 && childHeight > 0)
          box.style.height = `${Math.max(ownHeight, childHeight)}px`;
      }
    };
    void loadSheetStyle().then(
      () => {
        if (active.current === frame && frame.child === child) size();
      },
      () => {},
    );
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(size);
    resize?.observe(child);
    const observer =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(coverParent);
    observer?.observe(box, { childList: true, subtree: true });
    const backKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
      if (
        event.key === "ArrowLeft" &&
        isElement(event.target) &&
        event.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      start("peel", () => latest.current?.());
    };
    child.addEventListener("keydown", backKey, true);
    child
      .querySelector<HTMLElement>(
        'input, [role^="menuitem"]:not(:disabled), button:not(:disabled)',
      )
      ?.focus({ preventScroll: true });
    return () => {
      frame.cancel?.();
      observer?.disconnect();
      resize?.disconnect();
      child.removeEventListener("keydown", backKey, true);
      cancelArrival();
      if (layered)
        try {
          child.hidePopover();
        } catch {
          /* Already detached. */
        }
      if (oldPopover === null) child.removeAttribute("popover");
      else child.setAttribute("popover", oldPopover);
      delete child.dataset.composerSheetChild;
      delete box.dataset.composerSheetLayered;
      uncover();
      box.style.height = height;
      frame.child = undefined;
      frame.uncover = undefined;
      frame.restoreHeight = undefined;
      if (active.current === frame && box.isConnected) {
        box.scrollTop = scroll;
        if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
      }
    };
  }, [root, sheet, nested, panel, panelRef, trigger, owner]);
  return {
    back: () => start("peel", () => latest.current?.()),
    dismiss: (done: () => void) => start("close", done),
  };
}
export function ComposerSheetBack({
  sheet,
  onBack,
  title,
}: {
  sheet: boolean;
  title?: string;
  onBack(): void;
}) {
  return sheet ? (
    <div className="composer-sheet-heading">
      <button
        type="button"
        className="composer-sheet-back"
        aria-label={t("Back")}
        onClick={onBack}
      >
        <ArrowLeft size={20} />
      </button>
      <span aria-hidden="true">{title ?? t("Back")}</span>
    </div>
  ) : null;
}
