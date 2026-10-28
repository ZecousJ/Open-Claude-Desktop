import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { GitBranch, Check } from "../ui/glyphs";
import type { GitHubBranch } from "../../shared/github-api";
import { api } from "../desktop-api";
import { useDismiss } from "../ui/useDismiss";
import { MenuSheetScrim } from "./MenuSheetScrim";
import "./repository-menu.css";
import {
  message,
  keyDown,
  Search,
  Note,
  NoteLink,
  LoadMore,
} from "./RepositoryMenu";

/**
 * A page-at-a-time list fed by the service: `load(query, page)` for the
 * search text after a short pause. The newest search wins; "Load more" adds
 * the next page and `reload` starts again from the first.
 */
export function usePagedList<T>(
  load: (
    query: string,
    page: number,
  ) => Promise<{ items: T[]; nextPage: number | null; truncated: boolean }>,
  query: string,
  key: unknown = undefined,
) {
  const [state, setState] = useState<{
    items: T[];
    nextPage: number | null;
    truncated: boolean;
    loading: boolean;
    error?: string;
    errorCode?: string;
  }>({ items: [], nextPage: null, truncated: false, loading: true });
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  const run = (page: number, append: boolean) => {
    const id = ++latest.current;
    setState((s) => ({
      ...(append ? s : { items: [], nextPage: null, truncated: false }),
      loading: true,
    }));
    loader
      .current(query.trim(), page)
      .then((result) => {
        if (id !== latest.current) return;
        setState((s) => ({
          items: append ? [...s.items, ...result.items] : result.items,
          nextPage: result.nextPage,
          truncated: result.truncated,
          loading: false,
        }));
      })
      .catch((error: unknown) => {
        if (id !== latest.current) return;
        const code = (error as { code?: unknown } | undefined)?.code;
        setState((s) => ({
          ...s,
          items: append ? s.items : [],
          nextPage: null,
          loading: false,
          error: message(error),
          ...(typeof code === "string" ? { errorCode: code } : {}),
        }));
      });
  };
  useEffect(() => {
    const timer = setTimeout(() => run(1, false), query ? 250 : 0);
    return () => {
      clearTimeout(timer);
      // A previous query must stop publishing as soon as the input changes,
      // including the pause before the next request starts.
      latest.current++;
    };
  }, [query, key]);
  return {
    ...state,
    more: () => state.nextPage && !state.loading && run(state.nextPage, true),
    reload: () => run(1, false),
  };
}

/**
 * The menus of the web Code home's repository chips, in the frame of the Cowork
 * "Project or folder" menu (cowork-options.css: a search row over a rule, 32px
 * rows with a 20px icon, a name and a grey second line, a blue check on the
 * chosen row), opening 6px above the chip as the workspace menus do. The
 * original's repository menu was not captured; the frame follows that closest
 * capture, and its words, empty and error states and the footer actions follow
 * the live picker.
 */
export function Frame({
  label,
  left,
  anchor,
  onClose,
  children,
  combobox = false,
  popupId,
}: {
  label: string;
  left: number;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  combobox?: boolean;
  popupId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss([box, anchor], true, onClose);
  const trigger = combobox
    ? anchor.current?.getBoundingClientRect?.()
    : undefined;
  const position =
    trigger &&
    Number.isFinite(window.innerWidth) &&
    Number.isFinite(window.innerHeight)
      ? {
          position: "fixed" as const,
          left: Math.max(
            8,
            Math.min(
              trigger.left,
              window.innerWidth - Math.min(320, window.innerWidth - 16) - 8,
            ),
          ),
          bottom: window.innerHeight - trigger.top + 8,
          maxHeight: Math.max(24, Math.min(360, trigger.top - 16)),
        }
      : { left };
  return (
    <>
      {!combobox && <MenuSheetScrim onClose={onClose} />}
      <div
        ref={box}
        id={popupId}
        className={`cowork-menu ${combobox ? "repository-combobox" : "repository-menu"}`}
        role={combobox ? "dialog" : "menu"}
        aria-label={label}
        style={position}
        onKeyDown={(event) => {
          if (!combobox) return keyDown(event, onClose);
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
          requestAnimationFrame(() => anchor.current?.focus());
        }}
      >
        {children}
      </div>
    </>
  );
}

/** The branch chip's menu. */
export function BranchMenu({
  repository,
  defaultBranch,
  current,
  left,
  anchor,
  onChoose,
  onClose,
}: {
  /** "owner/name" */
  repository: string;
  defaultBranch: string;
  /** The chosen branch. */
  current: string;
  left: number;
  anchor: RefObject<HTMLElement | null>;
  onChoose: (branch: GitHubBranch) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const list = usePagedList<GitHubBranch>(
    (q, page) => api.githubBranches({ repository, query: q, page }),
    query,
  );
  return (
    <Frame label="Branch" left={left} anchor={anchor} onClose={onClose}>
      <Search value={query} label="Search branches…" onChange={setQuery} />
      <div className="cowork-menu-list">
        {list.items.map((branch) => (
          <button
            key={branch.name}
            role="menuitemradio"
            aria-checked={branch.name === current}
            onClick={() => onChoose(branch)}
          >
            <GitBranch size={20} strokeWidth={1.25} />
            <span className="cowork-menu-text">
              <strong>{branch.name}</strong>
              {branch.name === defaultBranch && <small>Default branch</small>}
            </span>
            {branch.name === current && <Check size={14} />}
          </button>
        ))}
        {list.loading && !list.items.length && (
          <p className="cowork-menu-empty">Loading…</p>
        )}
        {list.error && (
          // The live picker's branch error: one line with a retry link.
          <div
            className="cowork-menu-empty repository-menu-note repository-menu-error"
            role="alert"
          >
            <span>
              Couldn’t load branches.{" "}
              <NoteLink onClick={() => list.reload()}>Try again</NoteLink>
            </span>
          </div>
        )}
        {!list.loading && !list.error && !list.items.length && (
          <Note title="No branches match" />
        )}
        {list.nextPage && !list.error && (
          <LoadMore loading={list.loading} onLoad={() => void list.more()} />
        )}
      </div>
    </Frame>
  );
}
