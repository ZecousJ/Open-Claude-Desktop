import {
  ComposerSheetBack,
  useComposerMenuPresentation,
  useComposerMenuSheet,
} from "./menu-sheet";
import { MenuSheetScrim } from "./MenuSheetScrim";
import { PlacePickerTrigger } from "./PlacePickerTrigger";
import { nativePickerBodyLimit } from "./native-picker-geometry";
import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { formatText, useT } from "../i18n";
import { useDismiss } from "../ui/useDismiss";
import { AppIcon, type AppIconName } from "../ui/app-icon";
import { Skeleton, SkeletonGroup } from "../ui/Skeleton";
import type { ProjectCatalogRead } from "./useProjectCatalogState";

export interface PlacePickerEntry {
  key: string;
  name: string;
  icon: AppIconName;
  detail?: string;
  selected?: boolean;
  isDefault?: boolean;
  section?: "Default" | "Pinned";
  onPick(): void;
  onDefault?: () => void;
  createName?: string;
  defaultUnavailableReason?: string;
}
export interface PlacePickerControl {
  key: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  checkbox?: boolean;
  section?: string;
  icon?: AppIconName;
  onPick(): void;
}
/** Shared source-backed combobox, typed creation, default keys and filter menu.
 * Native data and authorization remain in its lazy adapter, outside web startup.
 */
export function PlacePickerSurface({
  label,
  popupLabel,
  chosen,
  collapsed,
  platform,
  native = false,
  badgeCount = 1,
  content,
  controls,
  externalTrigger,
  projectRead,
}: {
  label: string;
  /** Host-specific accessible menu name, independent of its compact width. */
  popupLabel?: string;
  chosen: boolean;
  collapsed: boolean;
  platform: NodeJS.Platform;
  native?: boolean;
  badgeCount?: number;
  content(query: string): {
    rows: PlacePickerEntry[];
    footer: PlacePickerEntry[];
  };
  controls: PlacePickerControl[];
  projectRead?: ProjectCatalogRead;
  externalTrigger?: {
    anchor: RefObject<HTMLButtonElement | null>;
    popup?: RefObject<HTMLDivElement | null>;
    onClose(): void;
  };
}) {
  const t = useT();
  const [open, setOpen] = useState(Boolean(externalTrigger));
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string>();
  const [filterOpen, setFilterOpen] = useState(false);
  const [place, setPlace] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>();
  const internalAnchor = useRef<HTMLButtonElement>(null);
  const anchor = externalTrigger?.anchor ?? internalAnchor;
  const internalPopup = useRef<HTMLDivElement>(null);
  const popup = externalTrigger?.popup ?? internalPopup;
  const input = useRef<HTMLInputElement>(null);
  const filter = useRef<HTMLButtonElement>(null);
  const sheet = useComposerMenuPresentation();
  const sheetMotion = useComposerMenuSheet(popup, {
    sheet: sheet && open,
    nested: filterOpen,
    panel: ".project-picker-filter",
    trigger: filter,
    onBack: () => setFilterOpen(false),
  });
  const focusFilter = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const [bodyLimit, setBodyLimit] = useState<number>();
  const id = useId();
  const { rows, footer } = content(query);
  const options = [...rows, ...footer];
  const active = options.findIndex((row) => row.key === activeKey);
  const optionId = (entry: PlacePickerEntry) =>
    `${id}-option-${encodeURIComponent(entry.key.replace(":", "-"))}`;
  const setActive = (index: number) => setActiveKey(options[index]?.key);
  const keys = platform === "darwin" ? "Option+Enter" : "Alt+Enter";
  const closeImmediately = () => {
    setOpen(false);
    setFilterOpen(false);
    setQuery("");
    setActiveKey(undefined);
    anchor.current?.focus({ preventScroll: true });
    externalTrigger?.onClose();
  };
  const close = () => sheetMotion.dismiss(closeImmediately);
  useDismiss([popup, anchor], open, close);
  useLayoutEffect(() => {
    if (!open) return;
    let maximumHeight = 0;
    const update = () => {
      const trigger = anchor.current?.getBoundingClientRect();
      if (!trigger) return;
      const measured =
        popup.current?.scrollHeight || popup.current?.offsetHeight || 286;
      maximumHeight = Math.max(maximumHeight, measured);
      const height = native ? maximumHeight : measured;
      const below = innerHeight - trigger.bottom - 12;
      const above = trigger.top - 12;
      const next = {
        left: Math.max(
          8,
          Math.min(
            trigger.left,
            innerWidth - Math.min(native ? 327 : 258, innerWidth - 16) - 8,
          ),
        ),
        ...(below >= height || below >= above
          ? { top: trigger.bottom + 4 }
          : { bottom: innerHeight - trigger.top + 4 }),
        maxHeight: Math.max(96, Math.max(below, above)),
      };
      setPlace((previous) =>
        previous && JSON.stringify(previous) === JSON.stringify(next)
          ? previous
          : next,
      );
    };
    update();
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    if (popup.current) resize?.observe(popup.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, native]);
  useLayoutEffect(() => {
    if (!native || !open || !body.current || !popup.current) return;
    // z0 uses the density token cap, not the measured heights of six rows.
    const chrome = Math.max(
      0,
      (popup.current.offsetHeight || 0) - (body.current.offsetHeight || 0),
    );
    setBodyLimit(
      nativePickerBodyLimit(popup.current, place?.maxHeight ?? 408, chrome),
    );
  }, [
    native,
    open,
    query,
    rows.map((row) => row.key + row.section).join("|"),
    place?.maxHeight,
    projectRead?.status,
  ]);
  useLayoutEffect(() => {
    if (open && place) input.current?.focus({ preventScroll: true });
  }, [open, Boolean(place)]);
  useLayoutEffect(() => {
    if (!filterOpen || !focusFilter.current) return;
    focusFilter.current = false;
    popup.current
      ?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      )
      ?.focus();
  }, [filterOpen]);
  const pick = (entry?: PlacePickerEntry) => {
    if (entry) {
      entry.onPick();
      close();
    }
  };
  const renderEntry = (entry: PlacePickerEntry, index: number) => (
    <div
      key={entry.key}
      id={optionId(entry)}
      role="option"
      tabIndex={-1}
      data-place-key={entry.key}
      aria-selected={Boolean(entry.selected)}
      data-active={activeKey === entry.key || undefined}
      className="project-picker-row"
      data-detail={Boolean(entry.detail) || undefined}
      title={
        entry.defaultUnavailableReason
          ? `${entry.detail ?? entry.name}\n\n${entry.defaultUnavailableReason}`
          : entry.detail
      }
      aria-description={entry.defaultUnavailableReason}
      aria-label={
        entry.onDefault
          ? formatText(
              t(
                entry.isDefault
                  ? "{name}, press {keys} to remove default"
                  : "{name}, press {keys} to set as default",
              ),
              { name: entry.name, keys },
            )
          : entry.name
      }
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => setActive(index)}
      onClick={() => pick(entry)}
    >
      <AppIcon name={entry.icon} size={native ? 20 : 16} />
      <span
        className="project-picker-name"
        data-no-translate={
          entry.createName || entry.detail || entry.key.startsWith("project:")
            ? true
            : undefined
        }
      >
        {entry.createName ? (
          <>
            {t("Create")} <span data-no-translate>{entry.createName}</span>
          </>
        ) : (
          entry.name
        )}
        {entry.detail && <small>{entry.detail}</small>}
      </span>
      {entry.onDefault && (
        <button
          type="button"
          tabIndex={-1}
          className="project-picker-default"
          aria-label={t(entry.isDefault ? "Remove default" : "Set as default")}
          aria-pressed={Boolean(entry.isDefault)}
          onClick={(event) => {
            event.stopPropagation();
            entry.onDefault?.();
          }}
        >
          <AppIcon
            name={entry.isDefault ? "StarFilled" : "Star"}
            size={12}
          />
        </button>
      )}
      {entry.selected && <AppIcon name="Check" size={12} />}
    </div>
  );
  return (
    <>
      {!externalTrigger && (
        <PlacePickerTrigger
          label={label}
          chosen={chosen}
          collapsed={collapsed}
          native={native}
          badgeCount={badgeCount}
          open={open}
          anchor={anchor}
          onToggle={() => (open ? close() : setOpen(true))}
        />
      )}
      {open && <MenuSheetScrim onClose={close} />}
      {open &&
        createPortal(
          <div
            ref={popup}
            className={`cowork-menu project-picker${native ? " native-project-picker" : ""}`}
            role={native || popupLabel ? "menu" : undefined}
            aria-label={
              popupLabel ?? (native ? t("Project or folder") : undefined)
            }
            style={place ?? { left: 0, top: 0, visibility: "hidden" }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (filterOpen) {
                  setFilterOpen(false);
                  input.current?.focus();
                } else close();
              } else if (
                filterOpen &&
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const buttons = Array.from(
                  popup.current?.querySelectorAll<HTMLElement>(
                    '[role^="menuitem"]:not(:disabled)',
                  ) ?? [],
                );
                const current = buttons.indexOf(
                  document.activeElement as HTMLElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (current +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            <div className="project-picker-search-row">
              <label className="project-picker-search">
                <AppIcon name="Search" size={16} />
                <input
                  ref={input}
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={id}
                  aria-activedescendant={
                    active >= 0 ? optionId(options[active]) : undefined
                  }
                  aria-label={t("Search or create a project")}
                  placeholder={t("Search or create a project")}
                  autoComplete="off"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveKey(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.nativeEvent.isComposing ||
                      event.keyCode === 229
                    ) {
                      event.stopPropagation();
                      return;
                    }
                    if (event.key === "Escape") return;
                    event.stopPropagation();
                    if (event.repeat) return;
                    if (
                      event.key === "Enter" &&
                      event.altKey &&
                      !event.ctrlKey &&
                      !event.metaKey
                    ) {
                      event.preventDefault();
                      options[active]?.onDefault?.();
                      return;
                    }
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setActive(
                        active < 0
                          ? event.key === "ArrowDown"
                            ? 0
                            : options.length - 1
                          : (active +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              options.length) %
                              options.length,
                      );
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      pick(options[active < 0 ? 0 : active]);
                    }
                  }}
                />
              </label>
              <button
                ref={filter}
                className="project-picker-filter-trigger"
                type="button"
                aria-label={t("Filter and sort")}
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen(!filterOpen)}
                onKeyDown={(event) => {
                  if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  focusFilter.current = true;
                  if (filterOpen) {
                    focusFilter.current = false;
                    popup.current
                      ?.querySelector<HTMLElement>(
                        '[role="menuitemradio"][aria-checked="true"]',
                      )
                      ?.focus();
                  } else setFilterOpen(true);
                }}
              >
                <AppIcon name="Filter" size={16} />
              </button>
            </div>
            <div className="cowork-menu-separator" role="separator" />
            {projectRead?.status === "pending" && (
              // c2b3e8506:1453 / shared-28:2274: three project-read rows.
              <SkeletonGroup label={t("Loading...")}>
                {[160, 128, 144].map((width) => (
                  <div
                    key={width}
                    className="project-picker-row"
                    aria-hidden="true"
                    style={{ pointerEvents: "none" }}
                  >
                    <Skeleton
                      width={native ? 20 : 16}
                      height={native ? 20 : 16}
                    />
                    <Skeleton width={width} height={16} />
                  </div>
                ))}
              </SkeletonGroup>
            )}
            {projectRead?.status === "failed" && (
              <div className="cowork-menu-empty" role="alert">
                <p>{t("Couldn’t load this.")}</p>
                <button type="button" onClick={projectRead.retry}>
                  {t("Retry")}
                </button>
              </div>
            )}
            <div
              role="listbox"
              aria-busy={projectRead?.status === "pending" || undefined}
              aria-label={
                native || popupLabel
                  ? t("Search or create a project")
                  : t("Projects")
              }
              aria-multiselectable={native || undefined}
              id={id}
              ref={body}
              aria-owns={native ? footer.map(optionId).join(" ") : undefined}
              className="project-picker-options"
              data-project-catalog={projectRead?.status}
              data-project-cached={projectRead?.cached}
              style={{
                maxHeight: native
                  ? bodyLimit
                  : Math.max(32, (place?.maxHeight ?? 408) - 48),
              }}
            >
              {rows.map((entry, index) => (
                <div key={entry.key} className="project-picker-entry">
                  {entry.section !== rows[index - 1]?.section &&
                    (index > 0 || entry.section) && (
                      <>
                        {index > 0 && (
                          <div
                            className="cowork-menu-separator"
                            role="separator"
                          />
                        )}
                        {entry.section && (
                          <p className="project-picker-section">
                            {t(entry.section)}
                          </p>
                        )}
                      </>
                    )}
                  {renderEntry(entry, index)}
                </div>
              ))}
              {!rows.length &&
                (!projectRead || projectRead.status === "ready") && (
                  <p className="cowork-menu-empty">
                    {query.trim() ? t("No matches") : t("No projects yet.")}
                  </p>
                )}
              {!native && (
                <>
                  <div className="cowork-menu-separator" role="separator" />
                  {footer.map((entry, index) =>
                    renderEntry(entry, rows.length + index),
                  )}
                </>
              )}
            </div>
            {native && (
              <div className="native-project-picker-footer">
                <div className="cowork-menu-separator" role="separator" />
                {footer.map((entry, index) =>
                  renderEntry(entry, rows.length + index),
                )}
              </div>
            )}
            {filterOpen && (
              <div
                className="project-picker-filter"
                role="menu"
                aria-label={t("Filter and sort")}
              >
                <ComposerSheetBack
                  sheet={sheet}
                  title={t("Filter and sort")}
                  onBack={sheetMotion.back}
                />
                <p>{t("Sort by")}</p>
                {controls.map((control, index) => (
                  <Fragment key={control.key}>
                    {control.section &&
                      control.section !== controls[index - 1]?.section && (
                        <>
                          <div
                            className="cowork-menu-separator"
                            role="separator"
                          />
                          <p>{t(control.section)}</p>
                        </>
                      )}
                    <button
                      key={control.key}
                      type="button"
                      data-picker-control={control.key}
                      role={
                        control.checkbox ? "menuitemcheckbox" : "menuitemradio"
                      }
                      aria-checked={Boolean(control.checked)}
                      disabled={control.disabled}
                      title={control.disabled ? t("Unavailable") : undefined}
                      onClick={() => {
                        control.onPick();
                        setActiveKey(undefined);
                      }}
                    >
                      {control.icon && (
                        <AppIcon
                          name={control.icon}
                          size={native ? 20 : 16}
                        />
                      )}
                      <span>{t(control.label)}</span>
                      {control.checked && (
                        <AppIcon name="Check" size={12} />
                      )}
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
