import { createPortal } from "react-dom";
import { clipRight, keepInWindow } from "../../ui/clip-edge";
import { ModelDescription } from "./ModelDescription";
import { ReasonTooltip } from "../../ui/Tooltip";
import { FastTag } from "./ModelName";
export { FastTag } from "./ModelName";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Settings2, Check, ChevronRight } from "../../ui/glyphs";
import type { CodeEffort, Provider } from "../../../shared/types";
import { codeEffortLabels } from "../../../shared/code-effort";
import { codeEffortsFor } from "../code/code-effort-support";
import {
  choiceVendors,
  codeModelChoices,
  modelLabel,
  modelVendor,
  useModelCatalog,
  type CodeModelChoice,
} from "./code-model-choices";
import { VendorSwitch } from "./VendorSwitch";
import { fastModeState, isFastTier } from "../code/code-fast-mode";
import { t } from "../../i18n";
import "./code-session-model-menu.css";

type Props = {
  providers: Provider[];
  providerId: string;
  model: string;
  onSelect: (providerId: string, model: string) => void;
  onManage: () => void;
  onClose: () => void;
  /** Web draft's combined model/effort menu; absent keeps the native menu. */
  sessionEffort?: {
    value: CodeEffort;
    onChange: (effort: CodeEffort) => void;
    openRequest?: number;
  };
};

export function CodeModelMenu({
  providers,
  providerId,
  model,
  onSelect,
  onManage,
  onClose,
  sessionEffort,
}: Props) {
  // The administrator's catalog names the models and moves hidden ones
  // under More models (owner decision 11); without it the ids are listed.
  const catalog = useModelCatalog();
  const choices = codeModelChoices(providers, providerId, model, catalog);
  // The provider switch, as in the Chat menu: with models of two or more
  // makers, one maker's models show, in the menu and under More models; it
  // opens on the current model's maker.
  const vendors = catalog?.items.length
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
  const fast = fastModeState(catalog, model);
  const root = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [branch, setBranch] = useState(false),
    [effortBranch, setEffortBranch] = useState(false),
    [flip, setFlip] = useState(false);
  const closeBranches = () => {
    setBranch(false);
    setEffortBranch(false);
  };
  const efforts = codeEffortsFor(catalog, model);
  // The catalog marks each model's own default effort; the badge follows it.
  const recommendedEffort = catalog?.items.find(
    (item) => item.id === model,
  )?.defaultEffort;
  // Claude highlights the first older model as soon as the submenu opens.
  const [active, setActive] = useState(0);
  // More models has a search box.
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = more.filter((choice) => {
    const text = `${choice.label ?? choice.name} ${choice.name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  useEffect(() => {
    if (branch) setActive(0);
    else setQuery("");
  }, [branch]);
  useEffect(() => setActive(0), [query]);
  // More models and Effort are placed on the window (placeBeside): the
  // main column clips what crosses its edges, and a list pushed back inside
  // the window covered the menu itself.
  const moreBox = useRef<HTMLDivElement>(null);
  const [morePlace, setMorePlace] = useState<SubmenuPlace>();
  useLayoutEffect(() => {
    setMorePlace(
      branch ? placeBeside(moreBox.current, root.current, flip) : undefined,
    );
  }, [branch, flip, found.length, more.length]);
  const effortBox = useRef<HTMLDivElement>(null);
  const [effortPlace, setEffortPlace] = useState<SubmenuPlace>();
  useLayoutEffect(() => {
    setEffortPlace(
      effortBranch
        ? placeBeside(effortBox.current, root.current, flip)
        : undefined,
    );
  }, [effortBranch, flip]);
  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect();
    setFlip(
      Boolean(
        rect &&
        rect.right + (sessionEffort ? 320 : 140) > clipRight(root.current) - 8,
      ),
    );
  }, []);
  useEffect(() => {
    if (sessionEffort?.openRequest) {
      setBranch(false);
      setEffortBranch(true);
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>(
            '.code-session-effort [aria-checked="true"], .code-session-effort button',
          )
          ?.focus(),
      );
    } else if (effortBranch) {
      // A normal Model command can replace an outstanding /effort request
      // while this popup stays mounted. Return to its root, not a stale panel.
      setEffortBranch(false);
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>(
            '.code-model-quick[data-shown] [aria-checked="true"]',
          )
          ?.focus(),
      );
    }
  }, [sessionEffort?.openRequest]);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const menuElement = root.current;
    const outside = (event: PointerEvent) => {
      if (!root.current?.parentElement?.contains(event.target as Node))
        onClose();
    };
    document.addEventListener("pointerdown", outside);
    // Opened by /model's second Enter the menu shows no highlight until an
    // arrow key moves it, so the first focus is not "visible".
    requestAnimationFrame(() =>
      (
        root.current?.querySelector<HTMLElement>(
          sessionEffort?.openRequest
            ? '.code-session-effort [aria-checked="true"], .code-session-effort button'
            : '[aria-checked="true"]',
        ) ?? root.current
      )?.focus({ focusVisible: false } as FocusOptions),
    );
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("pointerdown", outside);
      if (
        menuElement?.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        trigger?.focus();
    };
  }, []);
  const select = (choice: CodeModelChoice) => {
    if (choice.updateRequired) return;
    onSelect(choice.providerId, choice.name);
    onClose();
  };
  const focusBranch = () => {
    clearTimeout(timer.current);
    setEffortBranch(false);
    setBranch(true);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          ".code-model-search, .code-model-submenu button",
        )
        ?.focus(),
    );
  };
  const focusEffort = () => {
    clearTimeout(timer.current);
    setBranch(false);
    setEffortBranch(true);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          '.code-session-effort [aria-checked="true"], .code-session-effort button',
        )
        ?.focus(),
    );
  };
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement,
      menu = target.closest('[role="menu"]');
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (effortBranch) {
        setEffortBranch(false);
        root.current?.querySelector<HTMLElement>("[data-code-effort]")?.focus();
      } else if (branch) {
        setBranch(false);
        root.current?.querySelector<HTMLElement>("[data-more-models]")?.focus();
      } else if (event.key === "Escape") onClose();
      return;
    }
    if (event.key === "ArrowRight" && target.dataset.moreModels !== undefined) {
      event.preventDefault();
      focusBranch();
      return;
    }
    if (event.key === "ArrowRight" && target.dataset.codeEffort !== undefined) {
      event.preventDefault();
      focusEffort();
      return;
    }
    const digit = Number(event.key);
    if (menu === root.current && digit >= 1 && digit <= quick.length) {
      event.preventDefault();
      select(quick[digit - 1]);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).filter(
      (row) => row.closest('[role="menu"]') === menu && !row.closest("[inert]"),
    );
    const current = rows.indexOf(target as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : current < 0
            ? event.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length;
    rows[next]?.focus();
  };
  return (
    <div
      ref={root}
      className={`code-model-menu ${flip ? "flips-submenu" : ""}${sessionEffort ? " code-session-model-menu" : ""}`}
      role="menu"
      aria-label={`Model: ${modelLabel(catalog, model)}`}
      tabIndex={-1}
      onKeyDown={keydown}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(closeBranches, 100);
      }}
    >
      {sessionEffort && (
        <div className="code-session-model-heading">Model · this session</div>
      )}
      {vendors.length >= 2 && (
        <VendorSwitch
          vendors={vendors}
          selected={shownVendor!}
          onSelect={(id) => {
            setVendor(id);
            closeBranches();
            setActive(0);
          }}
        />
      )}
      {/* Every maker's models share one grid cell and only the shown one is
         visible, so the menu keeps the size of the longest list when the maker
         switch changes. */}
      <div className="code-model-quick-stack">
        {(vendors.length >= 2 ? vendors.map((v) => v.id) : [shownVendor]).map(
          (id) => {
            const list =
              vendors.length >= 2
                ? choices.quick.filter(
                    (choice) => modelVendor(choice.name).id === id,
                  )
                : quick;
            const shown = vendors.length < 2 || id === shownVendor;
            return (
              <div
                key={id ?? "all"}
                className="code-model-quick"
                data-shown={shown || undefined}
                aria-hidden={shown ? undefined : true}
                inert={shown ? undefined : true}
              >
                {list.map((choice, index) => (
                  <ReasonTooltip
                    key={`${choice.providerId}:${choice.name}`}
                    reason={
                      choice.updateRequired
                        ? t(
                            "Update Claudex to use this model on this computer.",
                          )
                        : undefined
                    }
                  >
                    {(tooltipProps) => (
                      <button
                        {...tooltipProps}
                        key={`${choice.providerId}:${choice.name}`}
                        role="menuitemradio"
                        className={
                          choice.description
                            ? "code-model-described"
                            : undefined
                        }
                        aria-checked={
                          choice.providerId === providerId &&
                          choice.name === model
                        }
                        onMouseEnter={closeBranches}
                        onClick={() => select(choice)}
                        aria-disabled={choice.updateRequired || undefined}
                      >
                        {/* Main-menu models carry their description; More models
                           keep theirs in the tip beside the list. */}
                        <span>
                          <span className="code-model-name">
                            {choice.label ?? choice.name}
                            {isFastTier(catalog, choice.name) && <FastTag />}
                          </span>
                          {choice.description && (
                            <ModelDescription text={choice.description} />
                          )}
                        </span>
                        {choice.providerId === providerId &&
                        choice.name === model ? (
                          <Check className="code-model-check" />
                        ) : (
                          <kbd>{index + 1}</kbd>
                        )}
                      </button>
                    )}
                  </ReasonTooltip>
                ))}
              </div>
            );
          },
        )}
      </div>
      <div className="code-model-separator" role="separator" />
      {sessionEffort && (
        <div
          className="code-model-branch"
          onMouseEnter={() => {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setBranch(false);
              setEffortBranch(true);
            }, 100);
          }}
        >
          <button
            role="menuitem"
            data-code-effort
            aria-haspopup="menu"
            aria-expanded={effortBranch}
            onClick={() =>
              effortBranch ? setEffortBranch(false) : focusEffort()
            }
          >
            <span>Effort</span>
            <small>{codeEffortLabels[sessionEffort.value]}</small>
            <ChevronRight className="code-model-chevron" />
          </button>
          {effortBranch && (
            <div
              ref={effortBox}
              className="code-model-more code-session-effort-wrap"
              style={placeStyle(effortPlace)}
              onMouseEnter={() => clearTimeout(timer.current)}
            >
              <div
                className="code-model-submenu code-session-effort"
                role="menu"
                aria-label="Reasoning effort"
              >
                <div className="code-session-effort-body">
                  <p role="presentation">
                    Higher effort means more thorough responses, but takes
                    longer and uses your limits faster.
                  </p>
                  {efforts.map((value) => (
                    <ReasonTooltip key={value} reason={undefined}>
                      {(tip) => (
                        <button
                          {...tip}
                          role="menuitemradio"
                          aria-checked={sessionEffort.value === value}
                          onClick={() => {
                            sessionEffort.onChange(value);
                            onClose();
                          }}
                        >
                          <span>
                            {codeEffortLabels[value]}
                            {value === recommendedEffort && (
                              <small>Default</small>
                            )}
                          </span>
                          {sessionEffort.value === value && (
                            <Check className="code-model-check" />
                          )}
                        </button>
                      )}
                    </ReasonTooltip>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <div
        className="code-model-branch"
        onMouseEnter={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setEffortBranch(false);
            setBranch(true);
          }, 100);
        }}
      >
        <button
          role="menuitem"
          data-more-models
          aria-haspopup="menu"
          aria-expanded={branch}
          onClick={() => (branch ? setBranch(false) : focusBranch())}
        >
          <span>More models</span>
          <ChevronRight className="code-model-chevron" />
        </button>
        {branch && (
          <div
            ref={moreBox}
            className="code-model-more"
            style={placeStyle(morePlace)}
            onMouseEnter={() => clearTimeout(timer.current)}
          >
            <div
              className="code-model-submenu"
              role="menu"
              aria-label="More models"
            >
              {more.length ? (
                <>
                  <input
                    className="code-model-search"
                    value={query}
                    placeholder={t("Search models")}
                    aria-label={t("Search models")}
                    autoComplete="off"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) {
                        event.stopPropagation();
                        return;
                      }
                      if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp"
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        const rows =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                            "button",
                          );
                        rows?.[
                          event.key === "ArrowDown" ? 0 : rows.length - 1
                        ]?.focus();
                        return;
                      }
                      if (event.key !== "Escape" && event.key !== "Tab")
                        event.stopPropagation();
                    }}
                  />
                  <div className="code-model-search-rule" role="separator" />
                  {found.length ? (
                    found.map((choice, index) => (
                      <ReasonTooltip
                        key={`${choice.providerId}:${choice.name}`}
                        reason={
                          choice.updateRequired
                            ? t(
                                "Update Claudex to use this model on this computer.",
                              )
                            : undefined
                        }
                      >
                        {(tooltipProps) => (
                          <button
                            {...tooltipProps}
                            key={`${choice.providerId}:${choice.name}`}
                            role="menuitemradio"
                            aria-checked={false}
                            data-active={active === index}
                            onMouseEnter={() => setActive(index)}
                            onFocus={(event) => {
                              tooltipProps?.onFocus(event);
                              setActive(index);
                            }}
                            onClick={() => select(choice)}
                            aria-disabled={choice.updateRequired || undefined}
                          >
                            <span>{choice.label ?? choice.name}</span>
                          </button>
                        )}
                      </ReasonTooltip>
                    ))
                  ) : (
                    <div className="code-model-no-match">No matches</div>
                  )}
                </>
              ) : (
                <button role="menuitem" onClick={onManage}>
                  <Settings2 />
                  <span>Manage models</span>
                </button>
              )}
            </div>
            {/* The highlighted model's note, beside the list, drawn above
               everything so the sidebar or the window edge never covers it. */}
            {/* Placed once the list has its place (a child lays out first). */}
            {morePlace &&
              found[active]?.description &&
              !found[active]?.updateRequired && (
                <ModelTip
                  text={found[active].description!}
                  row={active}
                  side={morePlace.side}
                  at={`${morePlace.left},${morePlace.bottom}`}
                />
              )}
          </div>
        )}
      </div>
      {/* Fast mode: a switch row, left out when the model has no fast tier in
         the catalog; it follows More models. */}
      {fast.available && (
        <button
          role="menuitemcheckbox"
          className="code-model-fast"
          aria-checked={fast.on}
          onMouseEnter={closeBranches}
          onClick={() => {
            onSelect(providerId, fast.target);
            onClose();
          }}
        >
          <span>Fast mode</span>
          <span
            className="menu-switch"
            data-checked={fast.on || undefined}
            aria-hidden="true"
          >
            <span />
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * The More models note, portaled to <body> with a fixed position: 4px beside
 * the submenu on its outer side, centred on the highlighted row; where that
 * side has no room, 4px above the submenu (or below it); kept 8px inside the
 * window and never over the menu.
 */
function ModelTip({
  text,
  row,
  side,
  at,
}: {
  text: string;
  row: number;
  side: "left" | "right";
  /** Where the list is, so the note moves with it. */
  at: string;
}) {
  const tip = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const element = tip.current;
    const submenu = document.querySelector<HTMLElement>(".code-model-submenu");
    const target = submenu?.querySelectorAll<HTMLElement>(
      'button[role="menuitemradio"]',
    )[row];
    if (!element || !submenu || !target) return;
    const list = submenu.getBoundingClientRect();
    const rowBox = target.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const gap = 4,
      edge = 8;
    // Beside the list on its outer side (away from the menu), centred on
    // the row; with no room there, just above the list (or below it), so it
    // never covers the menu itself.
    const x = side === "right" ? list.right + gap : list.left - gap - width;
    const top = Math.min(
      Math.max(rowBox.top + rowBox.height / 2 - height / 2, edge),
      window.innerHeight - edge - height,
    );
    if (x >= edge && x + width <= window.innerWidth - edge)
      return setPlace({ left: x, top });
    const startX = side === "right" ? list.left : list.right - width;
    const left = Math.min(
      Math.max(startX, edge),
      window.innerWidth - edge - width,
    );
    const above = list.top - gap - height;
    setPlace({
      left,
      top:
        above >= edge
          ? above
          : Math.min(list.bottom + gap, window.innerHeight - edge - height),
    });
  }, [text, row, side, at]);
  return createPortal(
    <div
      ref={tip}
      className="code-model-tip"
      role="tooltip"
      style={
        place
          ? { left: place.left, top: place.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      {text}
    </div>,
    document.body,
  );
}

type SubmenuPlace = { left: number; bottom: number; side: "left" | "right" };

/** A placed submenu is fixed on the window; unplaced it waits unseen. */
function placeStyle(place: SubmenuPlace | undefined): React.CSSProperties {
  return place
    ? { position: "fixed", left: place.left, bottom: place.bottom }
    : { visibility: "hidden" };
}

/**
 * Where a submenu goes on the window: 6px beside the menu, its bottom on its
 * row's; right when it fits (left first for a flipped menu), else the other
 * side, else the roomier one; always 8px inside the window. Never over the menu
 * itself.
 */
function placeBeside(
  box: HTMLElement | null,
  menu: HTMLElement | null,
  flip: boolean,
): SubmenuPlace | undefined {
  const row = box?.parentElement;
  if (!box || !menu || !row) return undefined;
  const menuBox = menu.getBoundingClientRect(),
    rowBox = row.getBoundingClientRect();
  const width = box.getBoundingClientRect().width,
    gap = 6,
    edge = 8;
  const right = menuBox.right + gap,
    left = menuBox.left - gap - width;
  const fitsRight = right + width <= window.innerWidth - edge,
    fitsLeft = left >= edge;
  const roomierRight = window.innerWidth - menuBox.right >= menuBox.left;
  const side: "left" | "right" = flip
    ? fitsLeft || (!fitsRight && !roomierRight)
      ? "left"
      : "right"
    : fitsRight || (!fitsLeft && roomierRight)
      ? "right"
      : "left";
  const x = side === "right" ? right : left;
  return {
    left: Math.min(Math.max(x, edge), window.innerWidth - edge - width),
    bottom: Math.max(window.innerHeight - rowBox.bottom, edge),
    side,
  };
}
