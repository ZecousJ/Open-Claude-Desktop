import {
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Conversation } from "../../shared/types";
import { formatText, useT } from "../i18n";
import { api } from "../desktop-api";
import { useApp } from "../app/AppContext";
import { WithTooltip } from "../ui/Tooltip";
import { PlusIcon } from "../ui/icons";
import {
  chooseSessionFolders,
  sessionFoldersChoosable,
} from "./session-folders";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { railGlyphs, type RailGlyph } from "./rail-glyphs";
import { railCardTitles, useRailCardOpen, type RailCardId } from "./rail-store";
import "./session-rail.css";
import { shownFolder } from "../../shared/session-folder";

/** A rail glyph at its size. */
export function RailIcon({
  name,
  className,
}: {
  name: RailGlyph;
  className?: string;
}) {
  const { icon: Icon, size } = railGlyphs[name];
  return (
    <Icon
      className={className}
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}

export interface CardChrome {
  sessionId: string;
  /** Opens the cards menu (right-click on a heading). */
  onMenu: (position: MenuPosition) => void;
  /** Drag reorder from the grip. */
  onDrag: (id: RailCardId, event: ReactPointerEvent<HTMLElement>) => void;
  onMove: (id: RailCardId, by: -1 | 1) => void;
}

/**
 * A rail card: a heading button with the title, the caret (turned when open)
 * and the folded summary at the end; a six-dot grip replaces the summary while
 * the heading row is hovered and drags the card (6px before it moves);
 * right-click opens the cards menu. Folding is kept per session.
 */
export function RailCard({
  chrome,
  id,
  summary,
  defaultOpen,
  live,
  children,
}: {
  chrome: CardChrome;
  id: RailCardId;
  /** Shown at the end of the heading while folded. */
  summary?: ReactNode;
  defaultOpen: boolean;
  /** A summary that stays while open (Context's percent and meter). */
  live?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useRailCardOpen(chrome.sessionId, id, defaultOpen);
  const heading = useId();
  const title = t(railCardTitles[id]);
  return (
    <section
      className="rail-card"
      aria-labelledby={heading}
      data-rail-section={id}
    >
      <div
        className="rail-card-top"
        onContextMenu={(event) => {
          event.preventDefault();
          chrome.onMenu({ left: event.clientX, top: event.clientY });
        }}
      >
        <h3 className="rail-card-heading">
          <button
            type="button"
            id={heading}
            className="rail-card-head"
            aria-expanded={open}
            data-panel-open={open || undefined}
            onClick={() => setOpen(!open)}
          >
            <span className="rail-card-title">{title}</span>
            <RailIcon name="CaretRight" className="rail-card-caret" />
            {summary !== undefined && (live || !open) && (
              <span className="rail-card-summary">{summary}</span>
            )}
          </button>
        </h3>
        <div
          className="rail-grip"
          role="button"
          tabIndex={0}
          data-rail-grip=""
          aria-label={formatText("Reorder {name}", { name: title })}
          onPointerDown={(event) => chrome.onDrag(id, event)}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              chrome.onMove(id, event.key === "ArrowUp" ? -1 : 1);
            }
          }}
        >
          <span className="rail-grip-box">
            <span className="rail-grip-dots" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          </span>
        </div>
      </div>
      {open && <div className="rail-card-body">{children}</div>}
    </section>
  );
}

export function RailRow({
  icon,
  glyph,
  children,
  trailing,
  onClick,
  title,
}: {
  icon?: RailGlyph;
  /** A glyph of another set in the 20px well (the pull request state). */
  glyph?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const content = (
    <>
      {(icon || glyph) && (
        <span className="rail-row-icon">
          {glyph ?? <RailIcon name={icon!} />}
        </span>
      )}
      <span className="rail-row-label">{children}</span>
      {trailing}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="rail-row interactive"
      onClick={onClick}
      title={title}
    >
      {content}
    </button>
  ) : (
    <div className="rail-row" title={title}>
      {content}
    </div>
  );
}

/** The heading's context meter: a pill whose fill turns amber at 75% and red at 90%. */
export function ContextMeter({ pct }: { pct: number }) {
  return (
    <span className="rail-meter" aria-hidden="true">
      <span
        className="rail-meter-fill"
        data-severity={severity(pct)}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

export const severity = (pct: number) =>
  pct >= 90 ? "danger" : pct >= 75 ? "warning" : "accent";

export const tokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : value >= 1000
      ? `${Math.round(value / 1000)}k`
      : String(value);

/** A path with the home folder (/Users/x, /home/x, C:\Users\x) shortened to ~. */
function homeShort(path: string) {
  return path.replace(
    /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/,
    "~",
  );
}

/** Folder controls and extra rows. */
export function SessionFolders({
  conversation,
}: {
  conversation: Conversation;
}) {
  const app = useApp();
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const cwd = shownFolder(conversation.worktree?.origin ?? conversation.cwd);
  const extras = conversation.additionalFolders ?? [];
  const canChoose = sessionFoldersChoosable(conversation);
  const choose = () =>
    chooseSessionFolders(
      conversation,
      t("Add folders to this session"),
      app.report,
    );
  const name = cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  const parent = cwd?.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
  const entries: MenuEntry[] = [
    {
      label: "Copy path",
      onSelect: () =>
        void api
          .copyText(cwd!)
          .then(() => app.notify("Path copied to clipboard."))
          .catch(app.report),
    },
    ...(canChoose ? [{ label: "Add folder…", onSelect: choose }] : []),
  ];
  return (
    <>
      {cwd ? (
        <RailRow
          icon="Folder"
          trailing={
            canChoose ? (
              <button
                type="button"
                className="rail-stop rail-folder-add"
                aria-label={t("Add folder")}
                onClick={choose}
              >
                <PlusIcon />
              </button>
            ) : undefined
          }
        >
          <span className="rail-folder-content">
            <WithTooltip
              label={t("Working folder")}
              detail={cwd}
              disabled={Boolean(menu)}
            >
              {(props) => (
                <button
                  {...props}
                  ref={anchor}
                  type="button"
                  className="rail-folder-button"
                  data-no-translate
                  aria-haspopup="menu"
                  aria-expanded={Boolean(menu)}
                  onClick={() => {
                    const box = anchor.current?.getBoundingClientRect();
                    if (menu || !box) return setMenu(undefined);
                    setMenu({ left: box.left, top: box.bottom + 6 });
                  }}
                >
                  <span className="rail-folder-name">{name}</span>
                </button>
              )}
            </WithTooltip>
            {parent && parent !== cwd && (
              <span className="rail-detail"> · {homeShort(parent)}</span>
            )}
          </span>
        </RailRow>
      ) : (
        canChoose && (
          <RailRow icon="Folder" onClick={choose}>
            {t("Choose folder…")}
          </RailRow>
        )
      )}
      {extras
        .filter((folder) => folder !== cwd)
        .map((folder) => (
          <RailRow
            key={folder}
            icon="Folder"
            title={`${t("Additional folder")}\n${folder}`}
          >
            <span data-no-translate>
              {folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}
            </span>
          </RailRow>
        ))}
      {menu && (
        <Menu
          label="Working folder"
          width={200}
          position={menu}
          anchors={[anchor]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

/** The rail's xs switch (the original's Switch, data-size="xs"). */
export function RailSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className="rail-switch"
      data-checked={checked || undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="rail-switch-knob" />
    </button>
  );
}
