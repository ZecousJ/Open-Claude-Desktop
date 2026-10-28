import { SettingsModal } from "../settings/controls";
import { Library, GitBranch, Check, ChevronDown } from "../ui/glyphs";
import {
  anthropicSources,
  githubMarketplaceSource,
  AnthropicSourceMark,
  marketplaceInputError,
} from "./AddMarketplaceDialog";
import { formatText, tc } from "../i18n";
import { notAvailable } from "../settings/unavailable";
import { AppIcon } from "../ui/app-icon";
import { createPortal } from "react-dom";
import { isComposingKey } from "../ui/ime";
import { openSettingsLink } from "../settings/navigation";
import type { GitHubStatus, GitHubRepository } from "../../shared/github-api";
import type { PluginsState } from "./usePlugins";
import type { HostInfo } from "../../shared/host";

/** What addMarketplaceView needs from AddMarketplaceDialog.tsx. */
export interface AddMarketplaceViewKit {
  add: (source: string, closeWhenAdded?: boolean) => Promise<void>;
  busy: boolean;
  close: () => void;
  closePicker: () => void;
  connected: boolean;
  failure: string;
  github: GitHubStatus | undefined;
  githubFailure: string;
  host: HostInfo;
  loadMore: () => Promise<void>;
  nextPage: number | null;
  onClose: () => void;
  openPicker: () => void;
  ownsDialog: () => boolean;
  pickerAnchor: React.RefObject<HTMLButtonElement | null>;
  pickerPopup: React.RefObject<HTMLDivElement | null>;
  pickerPosition: { left: number; top: number; width: number } | undefined;
  plugins: PluginsState;
  querySubmitted: boolean;
  queryValidation: string | undefined;
  repositories: GitHubRepository[];
  repositoryQuery: string;
  searchFailure: string;
  searchOpen: boolean;
  searching: boolean;
  selectRepository: (source: string) => void;
  setGithubRevision: React.Dispatch<React.SetStateAction<number>>;
  setQuerySubmitted: React.Dispatch<React.SetStateAction<boolean>>;
  setRepositoryQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchRevision: React.Dispatch<React.SetStateAction<number>>;
  setStep: React.Dispatch<
    React.SetStateAction<"choose" | "repository" | "anthropic">
  >;
  step: "choose" | "repository" | "anthropic";
  truncated: boolean;
  url: string;
  validation: string | undefined;
}

export function addMarketplaceView(kit: AddMarketplaceViewKit) {
  const {
    add,
    busy,
    close,
    closePicker,
    connected,
    failure,
    github,
    githubFailure,
    host,
    loadMore,
    nextPage,
    onClose,
    openPicker,
    ownsDialog,
    pickerAnchor,
    pickerPopup,
    pickerPosition,
    plugins,
    querySubmitted,
    queryValidation,
    repositories,
    repositoryQuery,
    searchFailure,
    searchOpen,
    searching,
    selectRepository,
    setGithubRevision,
    setQuerySubmitted,
    setRepositoryQuery,
    setSearchRevision,
    setStep,
    step,
    truncated,
    url,
    validation,
  } = kit;
  const addMarketplaceViewView = (
    <SettingsModal
      title={step === "anthropic" ? "Curated sources" : "Add marketplace"}
      className={`add-marketplace-dialog add-marketplace-${step}`}
      showClose={!busy}
      onClose={close}
    >
      {step === "choose" ? (
        <div className="directory-marketplace">
          <button
            type="button"
            className="directory-option"
            disabled={busy}
            onClick={() => {
              if (ownsDialog()) setStep("anthropic");
            }}
          >
            <Library size={16} strokeWidth={1.5} />
            <span>
              <strong>Browse curated sources</strong>
              <small>Curated marketplaces of plugins</small>
            </span>
          </button>
          <button
            type="button"
            className="directory-option"
            disabled={busy}
            onClick={() => {
              if (ownsDialog()) setStep("repository");
            }}
          >
            <GitBranch size={16} strokeWidth={1.5} />
            <span>
              <strong>Add from a repository</strong>
              <small>
                Sync a plugin marketplace from a GitHub repository or Git URL
              </small>
            </span>
          </button>
          {failure && (
            <p className="directory-warning" role="alert">
              {failure}
            </p>
          )}
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : step === "anthropic" ? (
        <div className="anthropic-sources-content">
          <p className="anthropic-sources-description">
            Choose which curated sources to include.
          </p>
          <ul className="anthropic-sources-list" role="list">
            {anthropicSources.map((source) => {
              // The internal Anthropic Directory subscription is not the public
              // claude-plugins-official repository. Its adapter remains unavailable.
              const added = Boolean(
                source.source &&
                plugins.catalog?.marketplaces.some(
                  (marketplace) =>
                    githubMarketplaceSource(marketplace.source) ===
                    source.source,
                ),
              );
              return (
                <li key={source.id} data-source={source.id}>
                  <AnthropicSourceMark />
                  <span className="anthropic-source-summary">
                    <strong>{source.title}</strong>
                    {source.source && (
                      <small data-no-translate>{source.source}</small>
                    )}
                  </span>
                  <button
                    type="button"
                    className={
                      added ? "anthropic-source-added" : "anthropic-source-add"
                    }
                    aria-label={formatText(
                      added ? "{name} added" : "Add {name}",
                      { name: source.title },
                    )}
                    disabled={
                      added || busy || !plugins.catalog || !source.source
                    }
                    title={!source.source ? notAvailable : undefined}
                    aria-description={!source.source ? notAvailable : undefined}
                    onClick={() => {
                      if (source.source) void add(source.source, false);
                    }}
                  >
                    {added && <Check size={16} aria-hidden="true" />}
                    {added ? tc("state", "Added") : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
          {failure && <p role="alert">{failure}</p>}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={close}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="directory-marketplace"
          onSubmit={(event) => {
            event.preventDefault();
            void add(url);
          }}
        >
          <div className="directory-warning" role="note">
            <AppIcon name="Warning" size={16} />
            <p>
              Make sure you trust a plugin before installing, updating, or using
              it. Plugins installed from marketplaces are not controlled by
              Claudex, and Claudex cannot verify that they will work as intended
              or that they won't change. See each plugin's homepage for more
              information.
            </p>
          </div>
          <div className="directory-field marketplace-repository-field">
            <span id="marketplace-url-label">URL</span>
            <button
              type="button"
              className="marketplace-repository-trigger"
              id="marketplace-repository-trigger"
              ref={pickerAnchor}
              role="combobox"
              data-selected={Boolean(url)}
              aria-label={url || "Select a repository"}
              aria-haspopup="listbox"
              aria-controls="marketplace-repositories"
              aria-expanded={searchOpen}
              aria-describedby="marketplace-repository-hint marketplace-repository-error"
              aria-invalid={Boolean(failure || validation)}
              disabled={busy}
              onClick={() => (searchOpen ? closePicker() : openPicker())}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  openPicker();
                }
              }}
            >
              <span data-no-translate={url ? "" : undefined}>
                {url || "Select a repository"}
              </span>
              <ChevronDown size={16} />
            </button>
          </div>
          {searchOpen &&
            pickerPosition &&
            createPortal(
              <div
                className="marketplace-repository-popover"
                ref={pickerPopup}
                style={{
                  left: pickerPosition.left,
                  top: pickerPosition.top,
                  width: pickerPosition.width,
                  maxHeight: Math.max(
                    120,
                    Math.min(291, innerHeight - pickerPosition.top - 4),
                  ),
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closePicker();
                  }
                }}
              >
                <input
                  className="settings-input"
                  id="marketplace-repository"
                  autoFocus
                  placeholder="Search GitHub or paste a repository URL"
                  aria-label="Search GitHub or paste a repository URL"
                  aria-controls="marketplace-repositories"
                  aria-describedby="marketplace-query-error"
                  aria-invalid={Boolean(
                    queryValidation &&
                    (querySubmitted || repositoryQuery.includes(":")),
                  )}
                  value={repositoryQuery}
                  disabled={busy}
                  onChange={(event) => {
                    if (!ownsDialog()) return;
                    setRepositoryQuery(event.target.value);
                    setQuerySubmitted(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (!isComposingKey(event))
                        selectRepository(repositoryQuery);
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      pickerPopup.current
                        ?.querySelector<HTMLButtonElement>(
                          '[role="option"]:not(:disabled)',
                        )
                        ?.focus();
                    }
                  }}
                />
                <div
                  className="marketplace-repository-results"
                  id="marketplace-repositories"
                  role="listbox"
                  aria-label="GitHub repositories"
                  aria-busy={searching}
                >
                  {repositories.map((repository) => (
                    <button
                      key={repository.fullName}
                      type="button"
                      role="option"
                      aria-selected={url === repository.fullName}
                      aria-label={repository.fullName}
                      disabled={busy}
                      onClick={() => selectRepository(repository.fullName)}
                    >
                      <strong data-no-translate>{repository.name}</strong>
                      <small data-no-translate>{repository.owner}</small>
                    </button>
                  ))}
                  {connected && searching && (
                    <p role="status">
                      {repositories.length
                        ? "Loading more…"
                        : "Searching repositories…"}
                    </p>
                  )}
                  {connected &&
                    !/^https?:/i.test(repositoryQuery) &&
                    !searching &&
                    !searchFailure &&
                    repositories.length === 0 && <p>No repositories found.</p>}
                  {searchFailure && (
                    <p role="alert">
                      {searchFailure}{" "}
                      <button
                        type="button"
                        onClick={() => {
                          if (!ownsDialog()) return;
                          if (nextPage === null)
                            setSearchRevision((revision) => revision + 1);
                          else void loadMore();
                        }}
                      >
                        Try again
                      </button>
                    </p>
                  )}
                  {nextPage !== null && !searchFailure && (
                    <button
                      type="button"
                      disabled={searching || busy}
                      onClick={() => void loadMore()}
                    >
                      Load more
                    </button>
                  )}
                  {repositoryQuery.trim() && !queryValidation && (
                    <button
                      type="button"
                      role="option"
                      aria-selected={url === repositoryQuery.trim()}
                      className="marketplace-repository-custom"
                      onClick={() => selectRepository(repositoryQuery)}
                    >
                      {formatText("Use {repository}", {
                        repository: repositoryQuery.trim(),
                      })}
                    </button>
                  )}
                  {truncated && (
                    <p>
                      Showing recently updated repositories. Paste a repository
                      URL to add another.
                    </p>
                  )}
                </div>
                {queryValidation &&
                  (querySubmitted || repositoryQuery.includes(":")) && (
                    <p
                      id="marketplace-query-error"
                      className="marketplace-query-error"
                      role="alert"
                    >
                      {queryValidation}
                    </p>
                  )}
              </div>,
              document.body,
            )}
          {githubFailure ? (
            <p role="alert">
              {githubFailure}{" "}
              <button
                type="button"
                onClick={() => {
                  if (ownsDialog())
                    setGithubRevision((revision) => revision + 1);
                }}
              >
                Try again
              </button>
            </p>
          ) : github && !connected ? (
            <div className="marketplace-github-access">
              {host.kind === "desktop" ? (
                <>
                  <p>
                    {github.configured
                      ? "Sign in to GitHub with gh auth login."
                      : "Install GitHub CLI to search repositories."}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (ownsDialog())
                        setGithubRevision((revision) => revision + 1);
                    }}
                  >
                    Retry
                  </button>
                </>
              ) : github.configured ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (!ownsDialog()) return;
                    onClose();
                    if (!ownsDialog()) return;
                    openSettingsLink("connectors", "integration-github");
                  }}
                >
                  Connect GitHub
                </button>
              ) : (
                <p>
                  GitHub isn't set up on this service. Ask your administrator to
                  enable it.
                </p>
              )}
            </div>
          ) : null}
          <small className="directory-hint" id="marketplace-repository-hint">
            Enter a GitHub owner/repo or a Git repository URL to sync.
          </small>
          <p
            className="directory-warning"
            id="marketplace-repository-error"
            role={failure || validation ? "alert" : undefined}
          >
            {failure || validation}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                !url.trim() || Boolean(marketplaceInputError(url)) || busy
              }
            >
              {busy ? "Syncing…" : "Sync"}
            </button>
          </div>
        </form>
      )}
    </SettingsModal>
  );
  return addMarketplaceViewView;
}
