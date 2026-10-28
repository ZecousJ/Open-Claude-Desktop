import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Code2,
  MoreVertical,
  UserRound,
  ChevronDown,
  ChevronRight,
  Eye,
  Folder,
} from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import type { SkillContents, SkillFile } from "../../../shared/collections-api";
import { Markdown } from "../../ui/Markdown";
import { Menu, type MenuEntry, type MenuPosition } from "../../ui/Menu";
import { ScrollIcon } from "../../ui/icons";
import { Toggle } from "../controls";
import "./skill-page.css";
import { currentLocale, tf } from "../../i18n";

/** The skill as the Skills page lists it. */
export interface PageSkill {
  name: string;
  description?: string;
  shortDescription?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  editedAt?: number;
}

/** Who a skill comes from, for "by …" and Created by. */
export function skillAuthor(scope = "user") {
  return scope === "system"
    ? "Codex"
    : scope === "admin"
      ? "Your organization"
      : scope === "repo"
        ? "This project"
        : "You";
}

const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
  });

interface TreeFolder {
  name: string;
  path: string;
  folders: TreeFolder[];
  files: string[];
}

/** The folder's files as a tree: SKILL.md first, then folders, then files. */
export function skillTree(paths: string[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", folders: [], files: [] };
  for (const file of paths) {
    const parts = file.split("/");
    let at = root;
    parts.slice(0, -1).forEach((part, index) => {
      let next = at.folders.find((folder) => folder.name === part);
      if (!next) {
        next = {
          name: part,
          path: parts.slice(0, index + 1).join("/"),
          folders: [],
          files: [],
        };
        at.folders.push(next);
      }
      at = next;
    });
    at.files.push(file);
  }
  const order = (folder: TreeFolder) => {
    folder.files.sort((a, b) =>
      a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b),
    );
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.folders.forEach(order);
  };
  order(root);
  return root;
}

/**
 * A skill's page in Settings → Skills: back to the list, the skill's tile,
 * name, author and date with its switch and menu, then Overview (the
 * description and Created by) and Contents (its folder as a tree beside a
 * reader that previews Markdown or shows the source).
 */
export function SkillPage({
  skill,
  menuEntries,
  onBack,
  onToggle,
  onError,
}: {
  skill: PageSkill;
  menuEntries: MenuEntry[];
  onBack: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [tab, setTab] = useState<"overview" | "contents">("overview");
  const [contents, setContents] = useState<SkillContents | null>();
  const [menu, setMenu] = useState<MenuPosition>();
  const [switching, setSwitching] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const on = skill.enabled !== false;
  useEffect(() => {
    let live = true;
    window.desktop
      .readSkill(skill.path)
      .then((value) => live && setContents(value))
      .catch((error) => {
        if (!live) return;
        setContents(null);
        onError(error);
      });
    return () => {
      live = false;
    };
  }, [skill.path]);
  const author = skillAuthor(skill.scope);
  return (
    <div className="skill-page">
      <button type="button" className="skill-page-back" onClick={onBack}>
        <ArrowLeft size={14} strokeWidth={1.75} />
        Your skills
      </button>
      <header className="skill-page-head">
        <span className="skill-page-tile" aria-hidden="true">
          <ScrollIcon />
        </span>
        <div>
          <h2>{skill.name}</h2>
          <p>
            {skill.editedAt === undefined
              ? tf("by {a}", { a: author })
              : tf("by {author} · updated {date}", {
                  author,
                  date: dateLabel(skill.editedAt),
                })}
          </p>
        </div>
        <Toggle
          label={`${skill.name} on`}
          checked={on}
          disabled={switching}
          onChange={(value) => {
            setSwitching(true);
            void onToggle(value)
              .catch(onError)
              .finally(() => setSwitching(false));
          }}
        />
        <button
          ref={more}
          type="button"
          className="desktop-row-more"
          aria-label={`More options for ${skill.name}`}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          onClick={() => {
            const rect = more.current!.getBoundingClientRect();
            setMenu(
              menu
                ? undefined
                : { right: innerWidth - rect.right, top: rect.bottom + 4 },
            );
          }}
        >
          <MoreVertical size={17} />
        </button>
        {menu && (
          <Menu
            label={`Options for ${skill.name}`}
            size="regular"
            entries={menuEntries}
            position={menu}
            width={180}
            anchors={[more]}
            onClose={() => setMenu(undefined)}
          />
        )}
      </header>
      <div className="skill-page-tabs" role="tablist" aria-label={skill.name}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "contents"}
          onClick={() => setTab("contents")}
        >
          Contents
          {contents && ` · ${contents.files.length}`}
        </button>
      </div>
      {tab === "overview" ? (
        <div className="skill-page-overview">
          <section>
            <h3>Description</h3>
            <p>{skill.description || skill.shortDescription}</p>
          </section>
          <aside>
            <h3>Created by</h3>
            <span>
              <i aria-hidden="true">
                <UserRound size={11} strokeWidth={1.75} />
              </i>
              {author}
            </span>
          </aside>
        </div>
      ) : contents === undefined ? (
        <div className="skill-page-loading" aria-label="Loading contents">
          <Spinner inheritColor size={16} className="spin" />
        </div>
      ) : contents === null ? null : (
        <SkillContentsView
          skill={skill}
          contents={contents}
          onError={onError}
        />
      )}
    </div>
  );
}

function SkillContentsView({
  skill,
  contents,
  onError,
}: {
  skill: PageSkill;
  contents: SkillContents;
  onError: (error: unknown) => void;
}) {
  const tree = useMemo(
    () => skillTree(contents.files.map((file) => file.path)),
    [contents],
  );
  const [open, setOpen] = useState(
    () => new Set(tree.folders.map((f) => f.path)),
  );
  const [chosen, setChosen] = useState(
    contents.files.some((file) => file.path === "SKILL.md")
      ? "SKILL.md"
      : contents.files[0]?.path,
  );
  const [file, setFile] = useState<SkillFile | null>();
  const [source, setSource] = useState(false);
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setFile(undefined);
    window.desktop
      .readSkillFile(skill.path, chosen)
      .then((value) => live && setFile(value))
      .catch((error) => {
        if (!live) return;
        setFile(null);
        onError(error);
      });
    return () => {
      live = false;
    };
  }, [skill.path, chosen]);
  const markdown = Boolean(chosen && /\.md$/i.test(chosen));
  const fileRow = (path: string, depth: number) => (
    <li key={path}>
      <button
        type="button"
        className="skill-tree-file"
        style={{ paddingLeft: 8 + depth * 12 + (depth ? 12 : 0) }}
        aria-current={chosen === path || undefined}
        onClick={() => setChosen(path)}
      >
        {path.split("/").pop()}
      </button>
    </li>
  );
  // SKILL.md heads the tree, then the folders, then the other files.
  const renderFolder = (folder: TreeFolder, depth: number) => (
    <>
      {folder.files
        .filter((path) => path === "SKILL.md")
        .map((path) => fileRow(path, depth))}
      {folder.folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            className="skill-tree-folder"
            style={{ paddingLeft: 8 + depth * 12 }}
            aria-expanded={open.has(child.path)}
            onClick={() =>
              setOpen((current) => {
                const next = new Set(current);
                if (next.has(child.path)) next.delete(child.path);
                else next.add(child.path);
                return next;
              })
            }
          >
            <Folder size={14} strokeWidth={1.5} />
            <span>{child.name}</span>
            {open.has(child.path) ? (
              <ChevronDown size={14} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} />
            )}
          </button>
          {open.has(child.path) && <ul>{renderFolder(child, depth + 1)}</ul>}
        </li>
      ))}
      {folder.files
        .filter((path) => path !== "SKILL.md")
        .map((path) => fileRow(path, depth))}
    </>
  );
  return (
    <div className="skill-page-contents">
      {/* One version: the folder as it is now. */}
      <button type="button" className="skill-page-version" disabled>
        {skill.name} · current
        <ChevronDown size={14} strokeWidth={1.75} />
      </button>
      <div className="skill-page-split">
        <ul className="skill-tree" aria-label="Files">
          {renderFolder(tree, 0)}
          {contents.truncated && (
            <li className="skill-tree-more">More files are in the folder.</li>
          )}
        </ul>
        <section className="skill-reader" aria-label={chosen}>
          <header>
            <code>/{chosen}</code>
            {markdown && (
              <span className="skill-reader-modes">
                <button
                  type="button"
                  aria-label="Preview"
                  aria-pressed={!source}
                  onClick={() => setSource(false)}
                >
                  <Eye size={15} strokeWidth={1.6} />
                </button>
                <button
                  type="button"
                  aria-label="Source"
                  aria-pressed={source}
                  onClick={() => setSource(true)}
                >
                  <Code2 size={15} strokeWidth={1.6} />
                </button>
              </span>
            )}
          </header>
          <div className="skill-reader-body">
            {file === undefined ? (
              <Spinner inheritColor size={16} className="spin" />
            ) : file === null ? null : file.binary ? (
              <p className="skill-reader-note">
                This file isn’t text, so it can’t be shown here.
              </p>
            ) : markdown && !source ? (
              <Markdown
                text={file.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")}
              />
            ) : (
              <pre>{file.text}</pre>
            )}
            {file?.truncated && (
              <p className="skill-reader-note">
                The rest of this file is too long to show here.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
