import { clipRight } from "../../ui/clip-edge";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Blocks, Paperclip, Plug, ChevronRight, Folder } from "../../ui/glyphs";
import { GithubMark } from "../../ui/GithubMark";
import { CodeConnectorSubmenu } from "./CodeConnectorSubmenu";
import { CodePluginSubmenu } from "./CodePluginSubmenu";
import { useEnabledPlugins } from "../../plugins/useEnabledPlugins";
import { usePolicy } from "../../policy/PolicyContext";
import { imageAttachmentTypes } from "../../../shared/client-policy";
import { AppContext } from "../../app/AppContext";
import { useWorkspaceGit } from "../../code-home/useWorkspaceGit";
import { useHostCapability } from "../../host/HostContext";
import { ReasonTooltip, shortcutText } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { useGitHubCliStatus } from "../../github/useGitHubCliStatus";
import { api } from "../../desktop-api";
import { LinearMark } from "../../linear/LinearMark";

type Props = {
  platform: NodeJS.Platform;
  onClose: () => void;
  onFiles: () => void;
  onFolder: () => void;
  onConnectors: () => void;
  onBrowseConnectors: () => void;
  onToggleConnector: (name: string, enabled: boolean) => void;
  connectors: Record<string, unknown>;
  onPlugins: () => void;
  /** Browse plugins: Settings → Plugins → Discover (else onPlugins). */
  onBrowsePlugins?: () => void;
  onSlashCommands: () => void;
  onUnavailable: (message: string) => void;
  canAddFolder: boolean;
  /** The task's folder has a GitHub remote (else Import GitHub issue is off). */
  githubRemote?: boolean;
  /** The desktop's Code home in the cloud: a repository, not a folder. */
  inCloud?: boolean;
  /** Opens Import GitHub issue; the row is left out without it. */
  onImportIssue?: () => void;
  onImportLinearIssue?: () => void;
};
function SlashIcon() {
  return (
    <svg
      className="code-add-slash"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="m14.5 6.5-5 11" />
    </svg>
  );
}

export function CodeAddMenu({
  platform,
  onClose,
  onFiles,
  onFolder,
  onConnectors,
  onBrowseConnectors,
  onToggleConnector,
  connectors,
  onPlugins,
  onBrowsePlugins,
  onSlashCommands,
  onUnavailable,
  canAddFolder,
  githubRemote,
  inCloud = false,
  onImportIssue,
  onImportLinearIssue,
}: Props) {
  // The folder the task runs in: the conversation's, or the new task's.
  const app = useContext(AppContext);
  const [linearAvailable, setLinearAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    if (!app?.active)
      void api
        .linearStatus()
        .then((status) => {
          if (live) setLinearAvailable(status.connected);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [app?.active?.id]);
  const repository = useWorkspaceGit(app?.active ? app.active.cwd : app?.cwd);
  const hasGithubRemote = githubRemote ?? repository.githubRemote;
  // A cloud session has no folder of the person's to add or read Git from.
  const localFolders = useHostCapability("localFolders");
  const cloudCode = useHostCapability("cloudCode");
  // A local folder's issues come through the machine's GitHub CLI.
  const localIssues = localFolders && !inCloud && !app?.active;
  const cli = useGitHubCliStatus(localIssues && hasGithubRemote);
  const issueReady = localIssues ? hasGithubRemote && cli?.signedIn : cloudCode;
  const issueUnavailable = !localIssues
    ? undefined
    : !hasGithubRemote
      ? t("This folder doesn’t have a GitHub remote")
      : cli && !cli.installed
        ? t("Install the GitHub CLI and run gh auth login")
        : cli && !cli.signedIn
          ? t("Run gh auth login to connect GitHub")
          : undefined;
  const closedByKeyboard = useRef(false);
  const root = useRef<HTMLDivElement>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connectorOpen, setConnectorOpen] = useState(false),
    [pluginsOpen, setPluginsOpen] = useState(false),
    [flip, setFlip] = useState(false);
  // The enabled plugins make Plugins a submenu; none, an Add plugins row.
  const plugins = useEnabledPlugins();
  const attachmentTypes = usePolicy().attachments.types;
  const attachmentsAllowed = attachmentTypes.length > 0;
  // Only pictures allowed: the row reads "Add image".
  const imagesOnly =
    attachmentsAllowed &&
    attachmentTypes.every((type) =>
      imageAttachmentTypes.includes(type as never),
    );
  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect();
    setFlip(Boolean(rect && rect.right + 195 > clipRight(root.current) - 8));
  }, []);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null,
      menu = root.current;
    const outside = (event: PointerEvent) => {
      if (!root.current?.parentElement?.contains(event.target as Node))
        onClose();
    };
    document.addEventListener("pointerdown", outside);
    menu?.focus();
    // The menu is already detached when this cleanup runs, so focus has fallen back to <body>.
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("pointerdown", outside);
      if (
        !trigger ||
        !(
          !document.activeElement ||
          document.activeElement === document.body ||
          menu?.contains(document.activeElement)
        )
      )
        return;
      trigger.focus();
      // Script focus after a mouse-opened menu is not :focus-visible in Chromium, but Claude
      // rings the + button when Escape closes the menu, so mark keyboard returns explicitly.
      if (closedByKeyboard.current) {
        trigger.dataset.keyboardFocus = "true";
        trigger.addEventListener(
          "blur",
          () => {
            delete trigger.dataset.keyboardFocus;
          },
          { once: true },
        );
      }
    };
  }, []);
  const activate = (action: () => void) => {
    clearTimeout(timer.current);
    onClose();
    action();
  };
  const leaveBranch = () => {
    clearTimeout(timer.current);
    setConnectorOpen(false);
    setPluginsOpen(false);
  };
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement,
      menu = target.closest('[role="menu"]');
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(timer.current);
      if (connectorOpen) {
        setConnectorOpen(false);
        root.current
          ?.querySelector<HTMLElement>("[data-code-connectors]")
          ?.focus();
      } else if (event.key === "Escape") {
        closedByKeyboard.current = true;
        onClose();
      }
      return;
    }
    if (
      event.key === "ArrowRight" &&
      target.dataset.codeConnectors !== undefined
    ) {
      event.preventDefault();
      setConnectorOpen(true);
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>(".code-add-submenu button")
          ?.focus(),
      );
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    ).filter((row) => row.closest('[role="menu"]') === menu);
    const current = rows.indexOf(target as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : current < 0
            ? event.key === "ArrowDown"
              ? 0
              : rows.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length;
    rows[next]?.focus();
  };
  return (
    <div
      ref={root}
      className={`code-add-menu ${flip ? "flips-submenu" : ""}`}
      role="menu"
      tabIndex={-1}
      aria-label="Add to Code"
      onKeyDown={keydown}
      onMouseLeave={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setConnectorOpen(false);
          setPluginsOpen(false);
        }, 100);
      }}
      onMouseEnter={() => clearTimeout(timer.current)}
    >
      {attachmentsAllowed && (
        <button
          role="menuitem"
          onMouseEnter={leaveBranch}
          onClick={() => activate(onFiles)}
        >
          <Paperclip />
          <span>{imagesOnly ? "Add image" : "Add files or photos"}</span>
          <kbd>{shortcutText(platform, ["mod", "U"])}</kbd>
        </button>
      )}
      {/* Add folder: the desktop's rows only; in a cloud environment it stays,
         off, saying it is only available in local sessions. */}
      {localFolders && (
        <ReasonTooltip
          reason={inCloud ? t("Only available in local sessions") : undefined}
        >
          {(tip) => (
            <button
              {...tip}
              role="menuitem"
              aria-disabled={inCloud || !canAddFolder}
              onMouseEnter={leaveBranch}
              onClick={() =>
                inCloud
                  ? undefined
                  : canAddFolder
                    ? activate(onFolder)
                    : onUnavailable(
                        "Choose a new Code task before changing its folder.",
                      )
              }
            >
              <Folder />
              <span>Add folder</span>
            </button>
          )}
        </ReasonTooltip>
      )}
      {/* Import GitHub issue, on a new task only: a repository to read issues
         from opens the list (github/ImportIssueDialog.tsx); a local folder
         without a GitHub remote, or without a signed-in GitHub CLI, leaves the
         row off with the reason beside it. */}
      {onImportIssue && !app?.active && (issueUnavailable || issueReady) && (
        <ReasonTooltip reason={issueUnavailable}>
          {(tip) => (
            <button
              {...tip}
              role="menuitem"
              aria-disabled={issueUnavailable ? true : undefined}
              onMouseEnter={leaveBranch}
              onClick={() =>
                issueUnavailable ? undefined : activate(onImportIssue)
              }
            >
              <GithubMark />
              <span>Import GitHub issue</span>
            </button>
          )}
        </ReasonTooltip>
      )}
      {onImportLinearIssue && !app?.active && linearAvailable && (
        <button
          role="menuitem"
          onMouseEnter={leaveBranch}
          onClick={() => activate(onImportLinearIssue)}
        >
          <LinearMark />
          <span>Import Linear issue</span>
        </button>
      )}
      <button
        role="menuitem"
        onMouseEnter={leaveBranch}
        onClick={() => activate(onSlashCommands)}
      >
        <SlashIcon />
        <span>Slash commands</span>
      </button>
      <div
        className="code-add-branch"
        onMouseEnter={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setPluginsOpen(false);
            setConnectorOpen(true);
          }, 100);
        }}
      >
        <button
          role="menuitem"
          data-code-connectors
          aria-haspopup="menu"
          aria-expanded={connectorOpen}
          onClick={() => setConnectorOpen((value) => !value)}
        >
          <Blocks className="code-add-blocks" />
          <span>Connectors</span>
          <ChevronRight className="code-add-chevron" />
        </button>
        {connectorOpen && (
          <div onMouseEnter={() => clearTimeout(timer.current)}>
            <CodeConnectorSubmenu
              servers={connectors}
              onBrowse={() => activate(onBrowseConnectors)}
              onManage={() => activate(onConnectors)}
              onToggle={onToggleConnector}
              onUnavailable={onUnavailable}
            />
          </div>
        )}
      </div>
      {plugins.length ? (
        <div
          className="code-add-branch"
          onMouseEnter={() => {
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setConnectorOpen(false);
              setPluginsOpen(true);
            }, 100);
          }}
        >
          <button
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={pluginsOpen}
            onClick={() => setPluginsOpen((value) => !value)}
          >
            <Plug className="code-add-plug" />
            <span>Plugins</span>
            <ChevronRight className="code-add-chevron" />
          </button>
          {pluginsOpen && (
            <div onMouseEnter={() => clearTimeout(timer.current)}>
              <CodePluginSubmenu
                plugins={plugins}
                onOpen={() => activate(onPlugins)}
                onManage={() => activate(onPlugins)}
                onBrowse={() => activate(onBrowsePlugins ?? onPlugins)}
              />
            </div>
          )}
        </div>
      ) : (
        <button
          role="menuitem"
          onMouseEnter={leaveBranch}
          onClick={() => activate(onPlugins)}
        >
          <Plug className="code-add-plug" />
          <span>Add plugins</span>
        </button>
      )}
    </div>
  );
}
