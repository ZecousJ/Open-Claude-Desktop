import {
  useComposerMenuPresentation,
  useComposerMenuSheet,
} from "../menu-sheet";
import {
  clipRight,
  keepInWindow,
  pinToWindow,
  release,
} from "../../ui/clip-edge";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Provider, Settings } from "../../../shared/types";
import {
  catalogDefaultEffort,
  chatEffortsFor,
  choiceVendors,
  codeModelChoices,
  modelVendor,
  useModelCatalogState,
} from "./code-model-choices";
import { modelMenuView } from "./ModelMenuView";
export { ModelName } from "./ModelName";
import "./model-menu.css";
import { phoneQuery, useMediaQuery } from "../../ui/useMediaQuery";

type Props = {
  providers: Provider[];
  providerId: string;
  model: string;
  effort: Settings["effort"];
  onSelect: (providerId: string, model: string) => void;
  onEffort: (effort: Settings["effort"]) => void;
  thinking?: boolean;
  onThinking?: () => void;
  onManage: () => void;
  onClose: () => void;
  /**
   * The conversation's retired model, told at the head of the menu
   * (src/composer/retired-model.ts).
   */
  notice?: string;
  /** Existing unified web sessions show the current model above the full chooser. */
};
export function ModelMenu({
  providers,
  providerId,
  model,
  effort,
  onSelect,
  onEffort,
  thinking,
  onThinking,
  onManage,
  onClose: closeImmediately,
  notice,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const sheet = useComposerMenuPresentation();
  const inline = useMediaQuery(phoneQuery) && !sheet;
  const effortHeading = useId();
  const modelsHeading = useId();
  const [branch, setBranch] = useState<"effort" | "models" | null>(null);
  const sheetMotion = useComposerMenuSheet(root, {
    sheet,
    nested: branch,
    panel: branch ? `[data-panel="${branch}"]` : undefined,
    trigger: branch ? `[data-branch="${branch}"]` : undefined,
    onBack: () => setBranch(null),
  });
  const onClose = () => sheetMotion.dismiss(closeImmediately);
  const [left, setLeft] = useState(false);
  const [up, setUp] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Provisional nominal delay supported by the sampled hover/exit recordings.
  // See model-menu.md for timing bounds; exact easing is not verified.
  const hoverDelay = 100;
  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  const pointerOpen = (name: "effort" | "models") => {
    if (sheet) return;
    clearTimers();
    if (branch === name) return;
    setBranch(null);
    openTimer.current = setTimeout(() => setBranch(name), hoverDelay);
  };
  const pointerLeave = () => {
    if (sheet) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setBranch(null), hoverDelay);
  };
  const provider = providers.find((p) => p.id === providerId);
  // With the administrator's catalog the menu lists its models with their
  // descriptions and hidden ones under More models (owner decision 11); without
  // one it shows the current model and its service.
  const catalogRead = useModelCatalogState();
  const catalog = catalogRead.value;
  const hasCatalogResult = catalog !== undefined;
  const catalogued = Boolean(catalog?.items.length);
  const choices = codeModelChoices(providers, providerId, model, catalog);
  // The provider switch: with models of two or more makers, a switch at the top
  // shows one maker's models, in the menu and under More models; it opens on
  // the current model's maker.
  const vendors = catalogued
    ? choiceVendors([...choices.quick, ...choices.more])
    : [];
  const [vendor, setVendor] = useState(() => modelVendor(model).id);
  const shownVendor = vendors.some((v) => v.id === vendor)
    ? vendor
    : vendors[0]?.id;
  const ofVendor = (choice: { name: string }) =>
    vendors.length < 2 || modelVendor(choice.name).id === shownVendor;
  const quick = choices.quick.filter(ofVendor);
  const more = choices.more.filter(ofVendor);
  const efforts = chatEffortsFor(catalog, model);
  const defaultEffort = catalogDefaultEffort(catalog, model) ?? "high";
  // usageHint describes the model, not one effort level. The current
  // catalog does not publish the effort warning metadata used by the
  // official chooser, so Max alone cannot imply a warning or multiplier.
  const usageHint = catalog?.items
    .find((item) => item.id === model)
    ?.usageHint?.trim();
  useLayoutEffect(() => {
    const popup = root.current;
    const wasUp = popup?.classList.contains("opens-up");
    // Measure the natural placement when data or viewport changes. Measuring
    // an already-flipped fitting popup would flip it back into the overflow.
    if (wasUp) popup?.classList.remove("opens-up");
    let rect: DOMRect | undefined;
    try {
      rect = popup?.getBoundingClientRect();
    } finally {
      if (wasUp) popup?.classList.add("opens-up");
    }
    setLeft(Boolean(rect && rect.right + 328 > clipRight(root.current)));
    // The Chat and Cowork home menu opens below the pill; without room it opens
    // above it.
    if (inline && popup) {
      // O16 Op.Popup uses sideOffset=4 and available-height; R17 live
      // phone home anchors at y812 and fits its popup above, ending at808.
      // A long catalog must scroll in that room instead of moving the page.
      const anchor = popup.parentElement?.getBoundingClientRect();
      const above = Math.max(0, (anchor?.top ?? 4) - 4);
      const below = Math.max(
        0,
        window.innerHeight - (anchor?.bottom ?? window.innerHeight) - 4,
      );
      const home = Boolean(popup.closest(".chat-home"));
      const openAbove =
        !home ||
        Boolean(rect && rect.bottom > window.innerHeight - 4 && above >= below);
      popup.style.setProperty(
        "--model-menu-available-height",
        `${openAbove ? above : below}px`,
      );
      setUp(openAbove);
    } else {
      popup?.style.removeProperty("--model-menu-available-height");
      setUp(
        Boolean(
          rect &&
          rect.bottom > window.innerHeight - 4 &&
          rect.top - 37.5 >= rect.height + 4,
        ),
      );
    }
    keepInWindow(root.current);
    if (
      !hasCatalogResult &&
      (document.activeElement === document.body ||
        root.current?.contains(document.activeElement))
    )
      root.current?.focus({ preventScroll: true });
  }, [catalogRead.status, catalog, hasCatalogResult, inline]);
  // A submenu that the column cuts on its side narrows to the room there
  // (220px at least), else it opens over the menu, as on a phone.
  useLayoutEffect(() => {
    const menu = root.current;
    const panel = menu?.querySelector<HTMLElement>("[data-panel]");
    if (!menu || !panel || inline || sheet) return;
    release(panel);
    panel.style.width = "";
    panel.style.maxHeight = "";
    panel.classList.remove("over-menu", "flip-left", "flip-right");
    const rect = menu.getBoundingClientRect();
    // The live submenus never cover their menu: they open on the menu's side
    // and turn to the other side of the window when that side is short.
    const gap = 6 + 8;
    const rightRoom = window.innerWidth - rect.right - gap;
    const leftRoom = rect.left - gap;
    const natural = left ? leftRoom : rightRoom;
    const other = left ? rightRoom : leftRoom;
    const flipped = natural < 320 && other > natural;
    if (flipped) panel.classList.add(left ? "flip-right" : "flip-left");
    const room = flipped ? other : natural;
    // Over the menu (a phone, or no room beside it) the list sits above its
    // row and fits the room up there.
    const fitAbove = () => {
      const row = panel.parentElement?.getBoundingClientRect();
      if (row)
        panel.style.maxHeight = `${Math.max(160, Math.floor(row.top - 12))}px`;
    };
    if (window.innerWidth < 640) return fitAbove();
    if (room >= 320) return pinToWindow(panel);
    if (room >= 220) {
      panel.style.width = `${Math.floor(room)}px`;
      pinToWindow(panel);
    } else {
      panel.classList.add("over-menu");
      fitAbove();
    }
  }, [branch, left, inline, sheet]);
  useLayoutEffect(() => {
    clearTimers();
    setBranch(null);
    if (document.activeElement === document.body)
      root.current?.focus({ preventScroll: true });
  }, [inline]);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const menuElement = root.current;
    // A press on the pill (the anchor the menu sits in, any of its words)
    // is left to the pill, which toggles the menu: closing here first made
    // its click open it again.
    const anchor = menuElement?.parentElement;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !anchor?.contains(target))
        onClose();
    };
    document.addEventListener("pointerdown", outside);
    // The popup is absolutely positioned beside the composer. Focusing its
    // scroll container must not scroll the home page to reveal that popup.
    root.current?.focus({ preventScroll: true });
    return () => {
      clearTimers();
      document.removeEventListener("pointerdown", outside);
      if (
        menuElement?.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        trigger?.focus({ preventScroll: true });
    };
  }, []);
  const focusBranch = (name: "effort" | "models") => {
    clearTimers();
    setBranch(name);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(`[data-panel="${name}"] button`)
        ?.focus(),
    );
  };
  function keydown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const menu = target.closest('[role="menu"]');
    if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      clearTimers();
      if (branch && !inline) {
        root.current
          ?.querySelector<HTMLElement>(`[data-branch="${branch}"]`)
          ?.focus();
        setBranch(null);
      } else if (e.key === "Escape") onClose();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const items = Array.from(
        menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
          [],
      ).filter((b) => b.closest('[role="menu"]') === menu);
      const current = items.indexOf(target as HTMLButtonElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? items.length - 1
            : current < 0
              ? e.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length;
      items[next]?.focus();
    } else if (!inline && e.key === "ArrowRight" && target.dataset.branch) {
      e.preventDefault();
      focusBranch(target.dataset.branch as "effort" | "models");
    } else if (e.key === "Tab") onClose();
  }
  const body = (children: ReactNode) =>
    inline ? (
      <div className="model-menu-inline-body">{children}</div>
    ) : (
      children
    );
  const modelService = (
    <>
      <div className="model-menu-separator" role="separator" />
      <button
        role="menuitem"
        onClick={() => {
          onClose();
          onManage();
        }}
      >
        Model service
      </button>
    </>
  );
  const modelMenuViewView = modelMenuView({
    body,
    branch,
    catalog,
    catalogRead,
    catalogued,
    cancelOpen: () => clearTimeout(openTimer.current),
    clearTimers,
    closeTimer,
    defaultEffort,
    effort,
    effortHeading,
    efforts,
    focusBranch,
    hasCatalogResult,
    inline,
    keydown,
    left,
    model,
    modelService,
    modelsHeading,
    more,
    notice,
    onClose,
    onEffort,
    onSelect,
    onThinking,
    pointerLeave,
    pointerOpen,
    provider,
    providerId,
    providers,
    quick,
    root,
    setBranch,
    setVendor,
    sheet,
    sheetMotion,
    shownVendor,
    thinking,
    up,
    usageHint,
    vendors,
  });
  return modelMenuViewView;
}
