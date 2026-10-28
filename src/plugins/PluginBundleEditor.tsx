import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FileCodeEditor, type FileEditorCache } from "../files/FileCodeEditor";
import { defaultFilePreferences } from "../files/file-preferences";
import { Markdown } from "../ui/Markdown";
import { Copy, File, FolderOpen, Plus, Trash2 } from "../ui/glyphs";
import { ResizeHandle } from "../ui/ResizeHandle";
import { useConversationServices } from "../conversation/ConversationServices";
import { formatText, t } from "../i18n";
import {
  clampSkillFileListWidth,
  skillFileListWidth,
  skillFileTree,
  type SkillFileFolder,
} from "../collections/customize/skill-file-tree";
import {
  pluginDraftPathError,
  type PluginDraftFile,
} from "./plugin-create-files";

const preferences = { ...defaultFilePreferences, autoSave: false };
export function PluginBundleEditor({
  files,
  onChange,
  busy,
  current,
  onSave,
  onCancel,
}: {
  files: PluginDraftFile[];
  onChange(files: PluginDraftFile[]): void;
  busy: boolean;
  current(): boolean;
  onSave(): void;
  onCancel(): void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(skillFileListWidth.default);
  const drag = useRef<{ width: number; x: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState(files[0]?.path);
  const [folded, setFolded] = useState(new Set<string>());
  const [mode, setMode] = useState<"code" | "preview">("code");
  const [pathDraft, setPathDraft] = useState<{
    previous?: string;
    value: string;
  }>();
  const [pathError, setPathError] = useState<string>();
  const [copied, setCopied] = useState<{ path: string; content: string }>();
  const [copyError, setCopyError] = useState(false);
  const cache = useMemo<FileEditorCache>(() => new Map(), []);
  const latestFiles = useRef(files);
  latestFiles.current = files;
  const file = files.find((entry) => entry.path === selected) ?? files[0];
  const tree = useMemo(
    () => skillFileTree(files.map((entry) => entry.path)),
    [files],
  );
  const services = useConversationServices();
  const resize = (value: number) =>
    setWidth(clampSkillFileListWidth(value, frame.current?.clientWidth));
  const choose = (path: string) => {
    setSelected(path);
    setPathDraft(undefined);
    setPathError(undefined);
  };
  const commitPath = () => {
    if (busy || !current() || !pathDraft) return;
    const path = pathDraft.value.trim();
    const error = pluginDraftPathError(path, files, pathDraft.previous);
    if (error) {
      setPathError(error);
      return;
    }
    onChange(
      pathDraft.previous
        ? files.map((entry) =>
            entry.path === pathDraft.previous ? { ...entry, path } : entry,
          )
        : [...files, { path, content: "" }],
    );
    setFolded(new Set());
    choose(path);
    setMode("code");
  };
  const pathInput = pathDraft && (
    <div className="plugin-bundle-path">
      <input
        autoFocus
        aria-label={t(
          pathDraft.previous ? "Rename file path" : "New file path",
        )}
        value={pathDraft.value}
        placeholder="path/to/file.md"
        disabled={busy}
        onChange={(event) => {
          setPathDraft({ ...pathDraft, value: event.target.value });
          setPathError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitPath();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setPathDraft(undefined);
            setPathError(undefined);
          }
        }}
      />
      {pathError && <p role="alert">{t(pathError)}</p>}
      <button type="button" disabled={busy} onClick={commitPath}>
        {t(pathDraft.previous ? "Rename" : "Add file")}
      </button>
    </div>
  );
  const folderRows = (folder: SkillFileFolder): ReactNode => (
    <>
      {folder.folders.map((child) => (
        <li key={child.path}>
          <button
            type="button"
            aria-label={formatText("Open folder {folder}", {
              folder: child.name,
            })}
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
      {folder.files.map((path) => (
        <li key={path}>
          <button
            type="button"
            aria-label={path}
            aria-current={file?.path === path ? "true" : undefined}
            onClick={() => choose(path)}
          >
            <File size={16} />
            <span data-no-translate>{path.split("/").at(-1)}</span>
          </button>
        </li>
      ))}
    </>
  );
  return (
    <div
      ref={frame}
      className="plugin-bundle-editor"
      style={{ "--plugin-files-width": `${width}px` } as CSSProperties}
    >
      <aside className="plugin-bundle-files">
        <ul aria-label={t("Files")}>{folderRows(tree)}</ul>
        {!pathDraft?.previous && pathInput}
        <button
          className="plugin-bundle-add"
          type="button"
          disabled={busy}
          onClick={() => {
            setPathDraft({ value: "" });
            setPathError(undefined);
          }}
        >
          <Plus size={16} />
          {t("Add file")}
        </button>
      </aside>
      <ResizeHandle
        label={t("Resize file list")}
        className="plugin-bundle-resize"
        dragging={dragging}
        aria-valuemin={skillFileListWidth.min}
        aria-valuemax={skillFileListWidth.max}
        aria-valuenow={width}
        onStep={(step) => resize(width + step)}
        onActivate={() => resize(skillFileListWidth.default)}
        onDoubleClick={() => resize(skillFileListWidth.default)}
        onKeyDown={(event) => {
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            resize(
              event.key === "Home"
                ? skillFileListWidth.min
                : skillFileListWidth.max,
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { width, x: event.clientX };
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(
              drag.current.width +
                (event.clientX - drag.current.x) *
                  (document.documentElement.dir === "rtl" ? -1 : 1),
            );
        }}
        onPointerUp={(event) => {
          drag.current = undefined;
          setDragging(false);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
      />
      <div className="plugin-bundle-file">
        <div className="plugin-bundle-file-toolbar">
          {pathDraft?.previous ? (
            <div className="plugin-bundle-rename">{pathInput}</div>
          ) : (
            <button
              className="plugin-bundle-filename"
              type="button"
              aria-label={`${t("Rename")} /${file?.path ?? ""}`}
              title={t("Rename")}
              data-no-translate
              disabled={busy || !file}
              onClick={() => {
                if (file) {
                  setPathDraft({ previous: file.path, value: file.path });
                  setPathError(undefined);
                }
              }}
            >
              {file ? `/${file.path}` : ""}
            </button>
          )}
          <div
            className="plugin-bundle-mode"
            role="group"
            aria-label={t("File view")}
          >
            {(["preview", "code"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {t(value === "code" ? "Code" : "Preview")}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={t("Delete")}
            disabled={busy || !file}
            onClick={() => {
              if (file && current()) {
                cache.delete(file.path);
                onChange(files.filter((entry) => entry !== file));
                setSelected(files.find((entry) => entry !== file)?.path ?? "");
                setPathDraft(undefined);
                setPathError(undefined);
              }
            }}
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            aria-label={t("Copy code")}
            disabled={!file}
            onClick={() => {
              if (!file || !current()) return;
              const path = file.path,
                content = file.content;
              setCopyError(false);
              void services
                .copyText(content)
                .then(() => {
                  if (
                    current() &&
                    latestFiles.current.some(
                      (entry) =>
                        entry.path === path && entry.content === content,
                    )
                  )
                    setCopied({ path, content });
                })
                .catch(() => {
                  if (current()) setCopyError(true);
                });
            }}
          >
            <Copy size={16} />
          </button>
        </div>
        {copyError && <p role="alert">{t("Copy failed")}</p>}
        {copied?.path === file?.path && copied?.content === file?.content && (
          <span className="sr-only" role="status">
            {t("Copied")}
          </span>
        )}
        {!file ? (
          <p className="plugin-bundle-empty">
            {t("Add a file before saving.")}
          </p>
        ) : mode === "code" ? (
          <FileCodeEditor
            cacheKey={file.path}
            path={file.path}
            value={file.content}
            reload={0}
            editable={!busy}
            preferences={preferences}
            cache={cache}
            canCache={() =>
              current() &&
              latestFiles.current.some((entry) => entry.path === file.path)
            }
            onChange={(content) => {
              if (!busy && current())
                onChange(
                  latestFiles.current.map((entry) =>
                    entry.path === file.path ? { ...entry, content } : entry,
                  ),
                );
            }}
            onSave={() => onSave()}
            onEscape={onCancel}
          />
        ) : (
          <div className="plugin-bundle-preview">
            {/\.(md|markdown)$/i.test(file.path) ? (
              <Markdown
                text={file.content.replace(
                  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
                  "",
                )}
              />
            ) : (
              <pre>{file.content}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
