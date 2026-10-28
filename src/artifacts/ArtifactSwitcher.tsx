import { useEffect, useRef, useState, type RefObject } from "react";
import { Diff, List, Check, ChevronDown, X } from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import { artifactIdentity } from "./artifact-metadata";
import { kindLabel } from "./artifact-kind";
import { formatText, t } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import "./file-viewer-panel.css";

/** Frame strip. */
export function ArtifactFrameTabs({
  artifact,
  artifacts,
  onSwitch,
  onActiveTabPress,
  onClose,
  menuOpen,
  activeMenuLabel,
  activeVersionLabel,
}: {
  artifact: Artifact;
  artifacts: Artifact[];
  onSwitch: (artifact: Artifact) => void;
  onActiveTabPress: (button: HTMLButtonElement) => void;
  onClose: () => void;
  menuOpen?: boolean;
  activeMenuLabel?: string;
  activeVersionLabel?: string;
}) {
  const current = artifactIdentity(artifact);
  const scope = artifact.conversationId ?? "";
  const [opened, setOpened] = useState<{ scope: string; keys: string[] }>({
    scope,
    keys: [current],
  });
  const root = useRef<HTMLDivElement>(null);
  const keys = opened.scope === scope ? opened.keys : [];
  const frameKeys = keys.includes(current) ? keys : [...keys, current];
  const available = new Map(
    artifacts.map((item) => [artifactIdentity(item), item]),
  );
  available.set(current, artifact);
  const frames = frameKeys.flatMap((key) => available.get(key) ?? []);
  useEffect(() => {
    setOpened((value) => ({
      scope,
      keys:
        value.scope === scope
          ? value.keys.includes(current)
            ? value.keys
            : [...value.keys, current]
          : [current],
    }));
  }, [scope, current]);
  function close(item: Artifact) {
    const key = artifactIdentity(item);
    const index = frames.findIndex((frame) => artifactIdentity(frame) === key);
    if (key === current) {
      const next = frames[index + 1] ?? frames[index - 1];
      if (!next) {
        onClose();
        return;
      }
      onSwitch(next);
    }
    setOpened({ scope, keys: frameKeys.filter((value) => value !== key) });
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
        ?.focus(),
    );
  }
  return (
    <div
      ref={root}
      className="artifact-frame-tabs"
      role="tablist"
      aria-label={t("Artifacts")}
    >
      {frames.map((item, index) => {
        const key = artifactIdentity(item);
        const selected = key === current;
        return (
          <div
            key={key}
            className="artifact-frame-tab"
            data-selected={selected || undefined}
          >
            <button
              role="tab"
              aria-selected={selected}
              aria-label={selected ? activeMenuLabel : undefined}
              aria-haspopup={selected ? "menu" : undefined}
              aria-expanded={selected ? menuOpen : undefined}
              tabIndex={selected ? 0 : -1}
              title={item.name}
              onClick={(event) =>
                selected
                  ? onActiveTabPress(event.currentTarget)
                  : onSwitch(item)
              }
              onContextMenu={(event) => {
                event.preventDefault();
                if (selected) onActiveTabPress(event.currentTarget);
                else onSwitch(item);
              }}
              onKeyDown={(event) => {
                if (event.key === "Delete") {
                  event.preventDefault();
                  close(item);
                  return;
                }
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const direction =
                  getComputedStyle(event.currentTarget).direction === "rtl"
                    ? -1
                    : 1;
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? frames.length - 1
                      : (index +
                          (event.key === "ArrowRight"
                            ? direction
                            : -direction) +
                          frames.length) %
                        frames.length;
                onSwitch(frames[next]);
                root.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              <AppIcon name="Artifacts" />
              <span data-no-translate>{item.name}</span>
              {selected && activeVersionLabel && (
                <span className="artifact-viewing-version">
                  {activeVersionLabel}
                </span>
              )}
            </button>
            <button
              className="artifact-frame-tab-close"
              aria-label={t("Close tab")}
              tabIndex={-1}
              onClick={() => close(item)}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/*
 * The artifact header's two pickers, after the original's: "Switch between
 * artifacts", a list button shown when the conversation has two or more
 * artifacts, which opens the artifacts as a column of cards (each sliding in
 * 12px over 300ms, 35ms after the one above it; hovering one previews it,
 * leaving the list goes back; the one on screen has a 1px accent ring); and the
 * version switcher, "v{n} · Latest", for a file the agent wrote more than once.
 */

/**
 * Closes a popup on a press outside it or on Escape (focus back on its
 * trigger), and moves focus through its buttons with the arrows, Home and
 * End.
 */
function usePopupKeys(
  open: boolean,
  close: () => void,
  trigger: RefObject<HTMLElement | null>,
  popup: RefObject<HTMLElement | null>,
) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const buttons = () => [
      ...(popup.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    (
      popup.current?.querySelector<HTMLButtonElement>(
        "[aria-current='true'], [aria-checked='true']",
      ) ?? buttons()[0]
    )?.focus();
    function pointer(event: PointerEvent) {
      const target = event.target as Node;
      if (
        !popup.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        latest.current();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current();
        trigger.current?.focus();
        return;
      }
      if (!popup.current?.contains(event.target as Node)) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const list = buttons();
      if (!list.length) return;
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : (at + (event.key === "ArrowDown" ? 1 : -1) + list.length) %
              list.length;
      list[next].focus();
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
}

/** "3 versions · HTML": what a card says under the artifact's name. */
export function switchRowDetail(artifact: Artifact, versions: number) {
  const kind = kindLabel(artifact);
  return versions > 1 ? `${versions} versions · ${kind}` : kind;
}

/**
 * The list button and its cards. `open` is the owner's, so the header can
 * read "Switch between artifacts" in place of the title while it is open.
 */
export function ArtifactSwitchList({
  artifact,
  artifacts,
  versionCount,
  open,
  onOpenChange,
  onSwitch,
  onPeek,
}: {
  artifact: Artifact;
  artifacts: Artifact[];
  /** How many versions an artifact has (one for a code block or a copy). */
  versionCount: (artifact: Artifact) => number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitch: (artifact: Artifact) => void;
  /** Shows an artifact in the panel while its card is hovered; undefined goes back. */
  onPeek: (artifact: Artifact | undefined) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLUListElement>(null);
  const close = () => {
    onPeek(undefined);
    onOpenChange(false);
  };
  usePopupKeys(open, close, trigger, popup);
  if (artifacts.length < 2) return null;
  const current = artifactIdentity(artifact);
  return (
    <div className="artifact-switch-anchor">
      <button
        ref={trigger}
        className="artifact-switch-button"
        aria-label="Switch between artifacts"
        title={open ? undefined : "Switch between artifacts"}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? close() : onOpenChange(true))}
      >
        <List size={16} />
      </button>
      {open && (
        <ul
          ref={popup}
          className="artifact-switch-list u-scroll-fade-y"
          aria-label="Switch between artifacts"
          onMouseLeave={() => onPeek(undefined)}
        >
          {artifacts.map((item, index) => {
            const identity = artifactIdentity(item);
            const here = identity === current;
            const versions = versionCount(item);
            const detail = switchRowDetail(item, versions);
            return (
              <li
                key={identity}
                className="artifact-switch-row"
                style={{ animationDelay: `${index * 35}ms` }}
              >
                <button
                  aria-current={here || undefined}
                  aria-label={`${item.name}, ${detail}`}
                  onMouseEnter={() => onPeek(here ? undefined : item)}
                  onFocus={() => onPeek(here ? undefined : item)}
                  onClick={() => {
                    onPeek(undefined);
                    onOpenChange(false);
                    if (!here) onSwitch(item);
                    trigger.current?.focus();
                  }}
                >
                  <span className="artifact-switch-name" data-no-translate>
                    {item.name}
                  </span>
                  <span className="artifact-switch-detail">{detail}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * "v{n} · Latest" and its menu of versions, newest first, the newest marked
 * Latest. Choosing one shows that snapshot; Latest follows the file again. Each
 * earlier version of a text file also has a Compare with current button.
 */
export function VersionSwitcher({
  count,
  shown,
  open,
  onOpenChange,
  onChoose,
  onCompare,
}: {
  count: number;
  /** The 1-based version on screen. */
  shown: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (version: number) => void;
  /** Absent for a file that cannot be compared (a binary one). */
  onCompare?: (version: number) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  usePopupKeys(open, () => onOpenChange(false), trigger, popup);
  if (count < 2) return null;
  const numbers = Array.from({ length: count }, (_, i) => count - i);
  return (
    <div className="artifact-version-anchor">
      <button
        ref={trigger}
        className="artifact-version-button"
        aria-label={formatText(
          "Switch artifact version, currently version {version}",
          { version: shown },
        )}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span>{`v${shown}`}</span>
        {shown === count && (
          <>
            <span className="artifact-version-dot">·</span>
            <span>{t("Latest")}</span>
          </>
        )}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          ref={popup}
          className="artifact-version-menu"
          role="menu"
          aria-label="Switch artifact version"
        >
          {numbers.map((number) => (
            <div key={number} className="artifact-version-row">
              <button
                role="menuitemradio"
                aria-checked={number === shown}
                aria-label={
                  number === count
                    ? `${formatText("Version {number}", { number })} · ${t("Latest")}`
                    : formatText("Version {number}", { number })
                }
                onClick={() => {
                  onOpenChange(false);
                  onChoose(number);
                  trigger.current?.focus();
                }}
              >
                <span className="artifact-version-check" aria-hidden="true">
                  {number === shown && <Check size={14} />}
                </span>
                <span>{formatText("Version {number}", { number })}</span>
                {number === count && <small>{t("Latest")}</small>}
              </button>
              {onCompare && number !== count && (
                <button
                  className="artifact-version-compare"
                  aria-label={formatText("Compare version {n} with current", {
                    n: number,
                  })}
                  title={t("Compare with current")}
                  onClick={() => {
                    onOpenChange(false);
                    onCompare(number);
                  }}
                >
                  <Diff size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
