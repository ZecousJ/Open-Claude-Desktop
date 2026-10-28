import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  TaskFolderBrowser as BrowserCapability,
  TaskFolderDirectory,
} from "../../shared/folder-browser";
import {
  folderPathParts,
  folderPathSeparator,
  folderPathWithSeparator,
} from "../../shared/folder-browser";
import Fuse from "fuse.js";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Controls";
import { Folder, ChevronRight } from "../ui/glyphs";
import { formatText, useLocale } from "../i18n";
import "./task-folder-browser.css";

type ExecutionBrowser = Extract<BrowserCapability, { kind: "execution" }>;

/** Fuse ranking with primary-prefix priority. */
function filterFolderNames(names: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return names;
  return new Fuse(
    names.map((name) => ({ name })),
    {
      keys: ["name"],
      threshold: 0.2,
      ignoreLocation: true,
      includeScore: true,
      includeMatches: true,
      minMatchCharLength: 1,
      shouldSort: true,
      getFn: (item, key) => String(Fuse.config.getFn(item, key)).slice(0, 2000),
    },
  )
    .search(needle)
    .map((result) => ({
      ...result,
      prefix:
        result.matches?.some((match) =>
          match.indices.some(([start]) => start === 0),
        ) ?? false,
    }))
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) || (a.score ?? 0) - (b.score ?? 0),
    )
    .map(({ item }) => item.name);
}

/** Loaded only when an execution host has advertised an actual browser. */
export function TaskFolderBrowser({
  capability,
  listDirectory,
  onSelect,
  onClose,
}: {
  capability: ExecutionBrowser;
  listDirectory(path: string): Promise<TaskFolderDirectory>;
  onSelect(path: string): Promise<boolean>;
  onClose(): void;
}) {
  useLocale();
  const [value, setValue] = useState(() =>
    folderPathWithSeparator(
      capability.initialPath,
      folderPathSeparator(capability.initialPath),
    ),
  );
  const separator = folderPathSeparator(capability.root);
  const { directory, query } = folderPathParts(value, separator);
  const [selected, setSelected] = useState(-1);
  const [completion, setCompletion] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();
  const cache = useRef(new Map<string, TaskFolderDirectory>());
  const [read, setRead] = useState<{
    directory: string;
    data?: TaskFolderDirectory;
    loading: boolean;
    error?: string;
  }>({ directory, loading: true });
  const listId = useId();
  useEffect(() => {
    let live = true;
    setRead({ directory, data: cache.current.get(directory), loading: true });
    if (!directory) {
      setRead({
        directory,
        loading: false,
        error: formatText("Choose an absolute folder."),
      });
      return;
    }
    Promise.resolve()
      .then(() => listDirectory(directory))
      .then(
        (data) => {
          if (!live) return;
          cache.current.set(directory, data);
          setRead({ directory, data, loading: false });
        },
        (error: unknown) => {
          if (live)
            setRead({
              directory,
              data: cache.current.get(directory),
              loading: false,
              error:
                error instanceof Error
                  ? error.message
                  : formatText(
                      "Couldn’t open that folder. Check the path and try again.",
                    ),
            });
        },
      );
    return () => {
      live = false;
    };
  }, [directory, revision, listDirectory]);
  const current: typeof read =
    read.directory === directory
      ? read
      : { directory, loading: true, data: cache.current.get(directory) };
  const data = current.data;
  const base = data ? folderPathWithSeparator(data.path, separator) : directory;
  const search = completion ?? query;
  const visible = useMemo(
    () => filterFolderNames(data?.directories ?? [], search),
    [data?.directories, search],
  );
  const parent = !query ? data?.parent : undefined;
  const active =
    selected === -2 ? parent : selected >= 0 ? visible[selected] : undefined;
  const exact = data?.directories.find(
    (name) => name.toLowerCase() === query.toLowerCase(),
  );
  const candidate =
    selected >= 0 && visible[selected]
      ? base + visible[selected]
      : !query
        ? data?.path
        : exact
          ? base + exact
          : undefined;
  useEffect(() => {
    if (selected !== -1)
      document
        .getElementById(`${listId}-${selected}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [selected, listId]);
  const canSelect =
    !busy &&
    !current.loading &&
    !current.error &&
    selected !== -2 &&
    Boolean(candidate);
  const navigate = (path: string) => {
    setValue(folderPathWithSeparator(path, separator));
    setSelected(-1);
    setCompletion(null);
    setSelectionError(undefined);
  };
  const descend = (name: string) => navigate(base + name);
  const up = () => {
    if (query) navigate(base);
    else if (data?.parent) navigate(data.parent);
  };
  const select = async () => {
    if (!canSelect || !candidate) return;
    setBusy(true);
    setSelectionError(undefined);
    try {
      if (await onSelect(candidate)) onClose();
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || busy) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCompletion(null);
      setSelected((index) =>
        index < 0
          ? visible.length
            ? 0
            : -1
          : Math.min(index + 1, visible.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCompletion(null);
      setSelected((index) =>
        index === -2 ? -1 : index <= 0 ? (parent ? -2 : -1) : index - 1,
      );
    } else if (
      event.key ===
        (document.documentElement.dir === "rtl" ? "ArrowLeft" : "ArrowRight") &&
      active
    ) {
      event.preventDefault();
      if (selected === -2) up();
      else descend(active);
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey || selected === -2) up();
      else if (visible.length === 1) descend(visible[0]);
      else if (completion === null && selected >= 0 && visible[selected])
        descend(visible[selected]);
      else if (visible.length) {
        if (completion === null) setCompletion(query);
        const next = selected + 1 >= visible.length ? 0 : selected + 1;
        setSelected(next);
        setValue(base + visible[next]);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selected === -2) up();
      else void select();
    }
  };
  // The picker is mounted inside a composer, whose transformed/contained
  // layout must not become the fixed dialog's containing block. Hand the
  // screen back to the existing non-modal permission card while it asks.
  if (busy) return null;
  return createPortal(
    <Modal
      title="Select a folder"
      className="task-folder-browser"
      onClose={() => {
        if (!busy) onClose();
      }}
      showClose={false}
    >
      <div className="task-folder-path">
        <Folder size={16} aria-hidden="true" />
        <input
          autoFocus
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setSelected(-1);
            setCompletion(null);
            setSelectionError(undefined);
          }}
          onKeyDown={keyDown}
          spellCheck={false}
          autoComplete="off"
          dir="ltr"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? `${listId}-${selected}` : undefined}
          aria-label={formatText("Folder path")}
        />
        {current.loading && (
          <span role="status" aria-label={formatText("Loading folders…")}>
            …
          </span>
        )}
      </div>
      {current.error && (
        <div role="alert" className="task-folder-error">
          <p>{current.error}</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            {formatText("Retry")}
          </button>
        </div>
      )}
      <div
        className="task-folder-list"
        role="listbox"
        id={listId}
        aria-label={formatText("Folders")}
        aria-busy={current.loading}
      >
        {parent && (
          <button
            type="button"
            role="option"
            id={`${listId}--2`}
            aria-label={formatText("Parent folder")}
            aria-selected={selected === -2}
            disabled={busy || current.loading}
            onMouseDown={(event) => event.preventDefault()}
            onClick={up}
          >
            ↵ <span>..</span>
          </button>
        )}
        {visible.map((name, index) => (
          <button
            key={name}
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={selected === index}
            disabled={busy || current.loading}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => descend(name)}
          >
            <Folder size={16} aria-hidden="true" />
            <span dir="auto" data-no-translate>
              {name}
            </span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ))}
        {!visible.length && !current.loading && !current.error && (
          <p>{formatText("No folders")}</p>
        )}
      </div>
      {selectionError && <p role="alert">{selectionError}</p>}
      <footer>
        <span>{formatText("Tab to open · Enter to select")}</span>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            {formatText("Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canSelect}
            onClick={() => void select()}
          >
            {formatText("Select")}
          </button>
        </div>
      </footer>
    </Modal>,
    document.body,
  );
}
