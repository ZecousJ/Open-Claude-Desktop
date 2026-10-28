import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUpRight, Lock, RotateCw, Unlink, Check } from "../ui/glyphs";
import type { GitHubRepository, GitHubStatus } from "../../shared/github-api";
import { api } from "../desktop-api";
import { GithubMark } from "../ui/GithubMark";
import { useT } from "../i18n";
import { openSettingsLink } from "../settings/navigation";
import { SearchIcon } from "../ui/icons";
import { useHost } from "../host/HostContext";
import "./repository-menu.css";
import { usePagedList, Frame } from "./repository-menu-parts";

/** What the repository chip says while GitHub is not set up on the service. */
export const githubNotConfigured = "GitHub isn't set up on this service";

export const message = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Try again.";

/**
 * The service's answer when GitHub refused the stored connection (it drops
 * it): the list says the connection expired and offers to reconnect. The
 * desktop's IPC keeps only an error's words, so its sentence counts too
 * (internal/claudex/ghconn errNotConnected).
 */
const expiredCode = "CLAUDEX_GITHUB_NOT_CONNECTED";
const expiredMessage = "Connect your GitHub account first";

/** Escape closes a menu; the arrow keys move through its rows. */
export function keyDown(
  event: KeyboardEvent<HTMLDivElement>,
  close: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  );
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    index < 0
      ? event.key === "ArrowDown"
        ? 0
        : rows.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
        rows.length;
  rows[next]?.focus();
}

export function Search({
  value,
  label,
  onChange,
  listId,
  activeId,
  onKeyDown,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  listId?: string;
  activeId?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="cowork-menu-search">
      <SearchIcon size={16} />
      <input
        autoFocus
        value={value}
        placeholder={label}
        aria-label={label}
        role={listId ? "combobox" : undefined}
        aria-autocomplete={listId ? "list" : undefined}
        aria-haspopup={listId ? "listbox" : undefined}
        aria-expanded={listId ? true : undefined}
        aria-controls={listId}
        aria-activedescendant={activeId}
        autoComplete={listId ? "off" : undefined}
        autoCapitalize={listId ? "none" : undefined}
        spellCheck={listId ? false : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

/**
 * The list's empty or problem message: a line, then footnote lines (the
 * live picker's `flex flex-col gap-1` with `text-footnote` details).
 */
export function Note({
  title,
  children,
  alert,
}: {
  title: string;
  children?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div
      className="cowork-menu-empty repository-menu-note"
      role={alert ? "alert" : "status"}
    >
      <span>{title}</span>
      {children}
    </div>
  );
}

/** A link inside a note (the live picker's inline link buttons). */
export function NoteLink({
  children,
  external,
  disabled,
  onClick,
}: {
  children: ReactNode;
  /** Leaves for GitHub: the ↗ glyph after the words. */
  external?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="repository-menu-link"
      disabled={disabled}
      aria-busy={disabled || undefined}
      onClick={onClick}
    >
      <span>{children}</span>
      {external && <ArrowUpRight size={16} strokeWidth={1.5} />}
    </button>
  );
}

/**
 * "Load more" under a list with another page; it also loads by itself when
 * it scrolls into view (the live picker's footnote link, 10% visible).
 */
export function LoadMore({
  loading,
  onLoad,
}: {
  loading: boolean;
  onLoad: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  useEffect(() => {
    const node = box.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => entry?.isIntersecting && load.current(),
      { threshold: 0.1 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="repository-menu-more">
      <button
        type="button"
        className="repository-menu-link"
        disabled={loading}
        onClick={onLoad}
      >
        {loading ? "Loading more…" : "Load more"}
      </button>
    </div>
  );
}

/** Why the session's only repository can't be taken away. */
export const lastRepositoryReason =
  "This session needs at least one repository.";

/**
 * A repository chip's menu: a pill's (`chosen`, choosing swaps it) or the
 * Add trigger's (`selected`: every pill is a checked row, choosing one
 * takes it away, except the last).
 */
export function RepositoryMenu({
  status,
  left,
  anchor,
  chosen,
  selected,
  exclude,
  noRepository = true,
  allowDisconnect = true,
  onChoose,
  onStatus,
  onClose,
  combobox = false,
  popupId,
  focusFallback,
}: {
  /** undefined while the service is asked. */
  status: GitHubStatus | undefined;
  left: number;
  anchor: RefObject<HTMLElement | null>;
  /** "owner/name" of the chosen repository. */
  chosen?: string;
  /** The Add trigger's menu: the session's repositories, checked. */
  selected?: string[];
  /** Repositories other pills hold, left out of a pill's list. */
  exclude?: string[];
  /** Whether a chosen repository offers "No repository". */
  noRepository?: boolean;
  allowDisconnect?: boolean;
  onChoose: (repository: GitHubRepository | undefined) => void;
  onStatus: (status: GitHubStatus) => void;
  onClose: () => void;
  /** Only the web Code draft's Add picker uses the live combobox structure. */
  combobox?: boolean;
  popupId?: string;
  /** The Add trigger disappears at the repository cap; focus a retained chip. */
  focusFallback?: (
    repository: GitHubRepository,
  ) => HTMLElement | null | undefined;
}) {
  const host = useHost();
  const t = useT();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const connected = Boolean(status?.configured && status.connected);
  const list = usePagedList<GitHubRepository>(
    (q, page) =>
      connected
        ? api.githubRepositories({ query: q, page })
        : Promise.resolve({ items: [], nextPage: null, truncated: false }),
    query,
    connected,
  );
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  // The service sends the browser to GitHub and back to /code. The
  // desktop's cloud environment opens GitHub in the browser instead (its
  // window never leaves the app); the bar asks again when it is back.
  const connect = () =>
    act(async () => {
      const { authorizeUrl } = await api.githubConnect();
      if (host.kind === "desktop") {
        await api.openExternal(authorizeUrl);
        onClose();
      } else window.location.assign(authorizeUrl);
    });
  const disconnect = () =>
    act(async () => {
      onStatus(await api.githubDisconnect());
      onChoose(undefined);
      onClose();
    });
  const actionError = error && (
    <p className="cowork-menu-empty repository-menu-error" role="alert">
      {error}
    </p>
  );
  const frameProps = {
    label: "Repository",
    left,
    anchor,
    onClose,
    combobox,
    popupId,
  };

  if (!status)
    return (
      <Frame {...frameProps}>
        <p className="cowork-menu-empty">Loading…</p>
      </Frame>
    );
  if (!status.configured)
    return (
      <Frame {...frameProps}>
        <p className="cowork-menu-empty" role="status">
          {githubNotConfigured}. Ask the administrator to set it up in the
          service console.
        </p>
      </Frame>
    );
  if (!status.connected)
    return (
      <Frame {...frameProps}>
        <Note title="Connect GitHub to pick a repository for this session">
          <NoteLink external disabled={busy} onClick={() => void connect()}>
            Connect to GitHub
          </NoteLink>
        </Note>
        {actionError}
      </Frame>
    );
  // GitHub refused the saved connection; the service has dropped it.
  const expired =
    list.errorCode === expiredCode || list.error === expiredMessage;
  const searching = Boolean(query.trim());
  const rows = exclude?.length
    ? list.items.filter((repository) => !exclude.includes(repository.fullName))
    : list.items;
  const optionId = (repository: GitHubRepository) =>
    `${listId}-${encodeURIComponent(repository.fullName)}`;
  const active = rows.find((repository) => repository.fullName === highlighted);
  const cannotRemoveLast = (repository: GitHubRepository) =>
    selected?.length === 1 && selected[0] === repository.fullName;
  const choose = (repository: GitHubRepository) => {
    if (cannotRemoveLast(repository)) return;
    onChoose(repository);
    if (combobox)
      requestAnimationFrame(() => {
        const target = anchor.current?.isConnected
          ? anchor.current
          : focusFallback?.(repository);
        if (target?.isConnected) target.focus();
      });
  };
  const searchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const available = rows.filter(
        (repository) => !cannotRemoveLast(repository),
      );
      if (!available.length) return;
      const current = available.findIndex(
        (repository) => repository.fullName === highlighted,
      );
      const next =
        current < 0
          ? event.key === "ArrowDown"
            ? 0
            : available.length - 1
          : (current +
              (event.key === "ArrowDown" ? 1 : -1) +
              available.length) %
            available.length;
      const repository = available[next];
      setHighlighted(repository.fullName);
      document
        .getElementById(optionId(repository))
        ?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      choose(active);
    }
  };
  return (
    <Frame {...frameProps}>
      <Search
        value={query}
        label="Search repositories…"
        onChange={(value) => {
          setQuery(value);
          setHighlighted(undefined);
        }}
        listId={combobox ? listId : undefined}
        activeId={combobox && active ? optionId(active) : undefined}
        onKeyDown={combobox ? searchKeyDown : undefined}
      />
      <div
        className="cowork-menu-list"
        id={combobox ? listId : undefined}
        role={combobox ? "listbox" : undefined}
        aria-multiselectable={combobox ? true : undefined}
      >
        {chosen && noRepository && !selected && !searching && !expired && (
          <button
            role="menuitemradio"
            aria-checked={false}
            onClick={() => onChoose(undefined)}
          >
            <GithubMark size={20} />
            <span className="cowork-menu-text">
              <strong>No repository</strong>
            </span>
          </button>
        )}
        {rows.map((repository) => {
          const checked = selected
            ? selected.includes(repository.fullName)
            : repository.fullName === chosen;
          // The live picker keeps the session's last repository.
          const last =
            checked && selected?.length === 1
              ? lastRepositoryReason
              : undefined;
          const Row = combobox ? "div" : "button";
          return (
            <Row
              key={repository.fullName}
              id={combobox ? optionId(repository) : undefined}
              role={
                combobox
                  ? "option"
                  : selected
                    ? "menuitemcheckbox"
                    : "menuitemradio"
              }
              aria-checked={combobox ? undefined : checked}
              aria-selected={combobox ? checked : undefined}
              aria-disabled={last ? true : undefined}
              data-highlighted={
                (combobox && repository.fullName === highlighted) || undefined
              }
              title={
                last ?? (repository.private ? "Private repository" : undefined)
              }
              onMouseDown={
                combobox ? (event) => event.preventDefault() : undefined
              }
              onMouseMove={
                combobox ? () => setHighlighted(repository.fullName) : undefined
              }
              onClick={() => !last && choose(repository)}
            >
              {repository.private ? (
                <Lock size={20} strokeWidth={1.25} />
              ) : (
                <GithubMark size={20} />
              )}
              <span className="cowork-menu-text" data-no-translate>
                <strong>{repository.fullName}</strong>
                {repository.description && (
                  <small>{repository.description}</small>
                )}
              </span>
              {checked && <Check size={14} />}
            </Row>
          );
        })}
        {list.loading && !list.items.length && (
          <p className="cowork-menu-empty">Loading…</p>
        )}
        {expired ? (
          <Note title="GitHub connection expired" alert>
            <span>
              GitHub rejected the saved connection. Reconnect to load your
              repositories.
            </span>
            <NoteLink disabled={busy} onClick={() => void connect()}>
              Reconnect GitHub
            </NoteLink>
          </Note>
        ) : (
          list.error && (
            <p className="cowork-menu-empty repository-menu-error" role="alert">
              {list.error}
            </p>
          )
        )}
        {!list.loading && !list.error && !rows.length && (
          <Note
            title={
              searching ? "No repositories match" : "No repositories available"
            }
          />
        )}
        {list.nextPage && !list.error && (
          <LoadMore loading={list.loading} onLoad={() => void list.more()} />
        )}
        {!list.loading && list.truncated && (
          <p className="cowork-menu-empty">
            Only your most recently pushed repositories were searched.
          </p>
        )}
      </div>
      <div className="cowork-menu-separator" role="separator" />
      {combobox ? (
        <div className="repository-combobox-footer">
          <button
            disabled={list.loading && !list.items.length}
            onClick={() => list.reload()}
          >
            <RotateCw size={16} strokeWidth={1.25} />
            <span>Refresh list</span>
          </button>
          <a
            href="/customize/connectors/yours/id/integration-github?src=repo_picker"
            aria-label={t("Manage GitHub connection")}
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              onClose();
              openSettingsLink("connectors", "integration-github");
            }}
          >
            {t("Manage")}
          </a>
        </div>
      ) : (
        <>
          <button
            role={combobox ? undefined : "menuitem"}
            disabled={list.loading && !list.items.length}
            onClick={() => list.reload()}
          >
            <RotateCw size={20} strokeWidth={1.25} />
            <span className="cowork-menu-text">
              <strong>Refresh list</strong>
            </span>
          </button>
          {!expired && allowDisconnect && (
            <button
              role={combobox ? undefined : "menuitem"}
              disabled={busy}
              onClick={() => void disconnect()}
            >
              <Unlink size={20} strokeWidth={1.25} />
              <span className="cowork-menu-text">
                <strong>
                  Disconnect{status.login ? ` @${status.login}` : " GitHub"}
                </strong>
              </span>
            </button>
          )}
        </>
      )}
      {actionError}
    </Frame>
  );
}
