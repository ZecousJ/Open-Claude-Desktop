import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type CSSProperties,
} from "react";
import type {
  CustomizeSkill,
  SkillContents,
  SkillFile,
} from "../../../shared/collections-api";
import { formatText, t, useLocale } from "../../i18n";
import {
  ArrowLeft,
  EllipsisVertical,
  FileText,
  FolderOpen,
  MessageCircleMore,
  Copy,
  Trash2,
} from "../../ui/glyphs";
import { Menu, type MenuEntry, type MenuPosition } from "../../ui/Menu";
import { Markdown } from "../../ui/Markdown";
import { Spinner } from "../../ui/Spinner";
import { AppIcon } from "../../ui/app-icon";
import { ResizeHandle } from "../../ui/ResizeHandle";
import {
  skillFileTree,
  clampSkillFileListWidth,
  skillFileListWidth,
  type SkillFileFolder,
} from "./skill-file-tree";
import "./installed-skill-page.css";

export type SkillDetailView = "overview" | "contents";

function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  action();
}

/** An installed skill's page; every operation uses the existing skill bridge. */
export function InstalledSkillPage({
  skill,
  contents,
  error,
  onReload,
  view,
  onViewChange,
  links,
  onBack,
  onTry,
  onToggle,
  onReveal,
  onRemove,
  onDuplicate,
}: {
  skill: CustomizeSkill;
  contents: SkillContents | null | undefined;
  error: string;
  onReload: () => void;
  view: SkillDetailView;
  onViewChange: (view: SkillDetailView) => void;
  links: { back: string; overview: string; contents: string };
  onBack: () => void;
  onTry: () => void;
  onToggle: () => Promise<void>;
  onReveal?: () => void;
  onRemove: () => void;
  onDuplicate?: () => void;
}) {
  useLocale();
  const titleId = useId();
  const moreLabelId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const [switching, setSwitching] = useState(false);
  const [actionError, setActionError] = useState("");
  useLayoutEffect(() => setMenu(undefined), [view]);
  const entries: MenuEntry[] = [
    ...(onDuplicate
      ? [
          {
            label: "Duplicate",
            icon: <Copy size={20} />,
            onSelect: onDuplicate,
          },
        ]
      : []),
    ...(onReveal
      ? [
          {
            label: "Show in folder",
            icon: <FolderOpen size={20} />,
            onSelect: onReveal,
          },
        ]
      : []),
    ...(skill.own
      ? [
          { separator: true as const },
          {
            label: "Remove",
            icon: <Trash2 size={20} />,
            danger: true,
            onSelect: onRemove,
          },
        ]
      : []),
  ];
  // The person, or the publisher the host reported; nothing is drawn when the
  // host reports neither.
  const creator =
    skill.own || skill.provenance?.source === "you"
      ? t("You")
      : skill.provenance?.publisher;
  return (
    <section className="installed-skill-page" aria-labelledby={titleId}>
      <a
        className="installed-skill-back"
        href={links.back}
        onClick={(event) => follow(event, onBack)}
      >
        <ArrowLeft size={16} />
        Your skills
      </a>
      <header className="installed-skill-head">
        <span className="installed-skill-icon" aria-hidden="true">
          <AppIcon name="Scroll" size={20} />
        </span>
        <div className="installed-skill-identity">
          <h2 id={titleId} data-no-translate>
            {skill.name}
          </h2>
        </div>
        <div className="installed-skill-actions">
          <button
            type="button"
            className="installed-skill-try"
            disabled={!skill.enabled || switching}
            onClick={onTry}
          >
            <MessageCircleMore size={16} />
            Try in chat
          </button>
          <button
            type="button"
            role="switch"
            aria-labelledby={titleId}
            aria-checked={skill.enabled}
            disabled={switching}
            className="installed-skill-switch"
            onClick={() => {
              setSwitching(true);
              setActionError("");
              void onToggle()
                .catch((reason) =>
                  setActionError(
                    reason instanceof Error ? reason.message : String(reason),
                  ),
                )
                .finally(() => setSwitching(false));
            }}
          >
            <span />
          </button>
          <span id={moreLabelId} hidden data-no-translate>
            {formatText("More options for {x}", { x: skill.name })}
          </span>
          <button
            ref={more}
            type="button"
            className="installed-skill-more"
            aria-labelledby={moreLabelId}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            disabled={!entries.length}
            onClick={() => {
              const rect = more.current!.getBoundingClientRect();
              setMenu(
                menu
                  ? undefined
                  : { right: innerWidth - rect.right, top: rect.bottom + 4 },
              );
            }}
          >
            <EllipsisVertical size={20} />
          </button>
          {menu && (
            <Menu
              label={t("More options")}
              size="regular"
              width={180}
              entries={entries}
              position={menu}
              anchors={[more]}
              onClose={() => setMenu(undefined)}
            />
          )}
        </div>
      </header>
      {actionError && (
        <p role="alert" className="customize-error">
          {actionError}
        </p>
      )}
      <nav className="installed-skill-tabs" aria-labelledby={titleId}>
        {(["overview", "contents"] as const).map((tab) => (
          <a
            key={tab}
            href={links[tab]}
            aria-current={view === tab ? "page" : undefined}
            onClick={(event) => follow(event, () => onViewChange(tab))}
          >
            {tab === "overview" ? "Overview" : "Contents"}
            {tab === "contents" && contents && contents.files.length > 0 && (
              <span> · {contents.files.length}</span>
            )}
          </a>
        ))}
      </nav>
      {view === "overview" ? (
        <div className="installed-skill-overview">
          <section>
            <h3>Description</h3>
            <p data-no-translate>{skill.description}</p>
          </section>
          {creator && (
            <aside>
              <h3>Created by</h3>
              <span data-no-translate={skill.own ? undefined : true}>
                {creator}
              </span>
            </aside>
          )}
        </div>
      ) : (
        <div className="installed-skill-content-view">
          <div className="installed-skill-file-toolbar">
            <span className="installed-skill-current">
              <span data-no-translate>{skill.name}</span> · {t("current")}
            </span>
          </div>
          {contents === undefined ? (
            <div
              className="skill-detail-loading"
              role="status"
              aria-label={t("Loading contents")}
            >
              <Spinner inheritColor size={16} className="spin" />
            </div>
          ) : contents === null ? (
            <div className="installed-skill-load-error" role="alert">
              <p>{error || t("Couldn’t load skill contents.")}</p>
              <button type="button" onClick={onReload}>
                Try again
              </button>
            </div>
          ) : (
            <SkillFiles key={skill.path} skill={skill} contents={contents} />
          )}
        </div>
      )}
    </section>
  );
}

function SkillFiles({
  skill,
  contents,
}: {
  skill: CustomizeSkill;
  contents: SkillContents;
}) {
  const fileLabelId = useId();
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; x: number } | undefined>(undefined);
  const [width, setWidth] = useState<number>(skillFileListWidth.default);
  const [dragging, setDragging] = useState(false);
  const tree = useMemo(
    () => skillFileTree(contents.files.map((file) => file.path)),
    [contents],
  );
  const [folded, setFolded] = useState(() => new Set<string>());
  const initial =
    contents.files.find((file) => file.path === "SKILL.md")?.path ??
    contents.files[0]?.path;
  const [chosen, setChosen] = useState(initial);
  const [read, setRead] = useState<{
    path: string;
    value?: SkillFile;
    error?: string;
  }>();
  const [retry, setRetry] = useState(0);
  const selected = read?.path === chosen ? read : undefined;
  useEffect(() => {
    if (!chosen || chosen === "SKILL.md") return;
    let active = true;
    setRead(undefined);
    void window.desktop
      .readSkillFile(skill.path, chosen)
      .then((value) => {
        if (
          !value ||
          typeof value.text !== "string" ||
          typeof value.binary !== "boolean" ||
          typeof value.truncated !== "boolean"
        )
          throw new Error("Couldn’t load file.");
        if (active) setRead({ path: chosen, value });
      })
      .catch((reason) => {
        if (active)
          setRead({
            path: chosen,
            error: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      active = false;
    };
  }, [skill.path, chosen, retry]);
  if (!contents.files.length)
    return (
      <p role="status" className="installed-skill-no-files">
        No files to show.
      </p>
    );
  const resize = (next: number) =>
    setWidth(
      clampSkillFileListWidth(
        next,
        frame.current?.getBoundingClientRect().width,
      ),
    );
  const fileRow = (path: string) => (
    <li key={path}>
      <button
        type="button"
        aria-current={chosen === path ? "true" : undefined}
        onClick={() => setChosen(path)}
      >
        <FileText size={16} />
        <span data-no-translate>{path.split("/").pop()}</span>
      </button>
    </li>
  );
  const folderRows = (folder: SkillFileFolder): ReactNode => (
    <>
      {folder.files.filter((path) => path === "SKILL.md").map(fileRow)}
      {folder.folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            aria-expanded={!folded.has(child.path)}
            onClick={() =>
              setFolded((before) => {
                const next = new Set(before);
                if (next.has(child.path)) next.delete(child.path);
                else next.add(child.path);
                return next;
              })
            }
          >
            <FolderOpen size={16} />
            <span data-no-translate>{child.name}</span>
          </button>
          {!folded.has(child.path) && <ul>{folderRows(child)}</ul>}
        </li>
      ))}
      {folder.files.filter((path) => path !== "SKILL.md").map(fileRow)}
    </>
  );
  return (
    <div
      ref={frame}
      className="installed-skill-contents"
      style={{ "--skill-file-list-width": `${width}px` } as CSSProperties}
    >
      <ul aria-label={t("Files")}>
        {folderRows(tree)}
        {contents.truncated && (
          <li className="installed-skill-truncated">
            More files are in the skill’s folder.
          </li>
        )}
      </ul>
      <ResizeHandle
        label={t("Resize file list")}
        className="installed-skill-file-resize"
        dragging={dragging}
        aria-valuemin={skillFileListWidth.min}
        aria-valuemax={skillFileListWidth.max}
        aria-valuenow={width}
        onStep={(step) => resize(width + step)}
        onActivate={() => resize(skillFileListWidth.default)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { start: width, x: event.clientX };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          resize(
            drag.current.start +
              (event.clientX - drag.current.x) *
                (document.documentElement.dir === "rtl" ? -1 : 1),
          );
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (drag.current) setWidth(drag.current.start);
          drag.current = undefined;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            setWidth(drag.current.start);
            drag.current = undefined;
            setDragging(false);
          } else if (
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            (event.key === "Home" || event.key === "End")
          ) {
            event.preventDefault();
            resize(
              event.key === "Home"
                ? skillFileListWidth.min
                : skillFileListWidth.max,
            );
          }
        }}
      />
      <section className="installed-skill-reader" aria-labelledby={fileLabelId}>
        <header>
          <span id={fileLabelId} data-no-translate>
            {chosen}
          </span>
        </header>
        {chosen === "SKILL.md" ? (
          <div className="skill-detail-markdown" data-no-translate>
            <Markdown text={contents.markdown} />
          </div>
        ) : selected?.error ? (
          <div role="alert">
            <p>{selected.error}</p>
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : selected?.value === undefined ? (
          <div role="status" aria-label={t("Loading contents")}>
            <Spinner inheritColor size={16} className="spin" />
          </div>
        ) : selected.value.binary ? (
          <p>This file isn’t text, so it can’t be shown here.</p>
        ) : /\.md$/i.test(chosen ?? "") ? (
          <div className="skill-detail-markdown" data-no-translate>
            <Markdown text={selected.value.text} />
          </div>
        ) : (
          <pre data-no-translate>{selected.value.text}</pre>
        )}
        {selected?.value?.truncated && (
          <p>The rest of this file is too long to show here.</p>
        )}
      </section>
    </div>
  );
}
