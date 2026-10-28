import {
  ComposerSheetBack,
  useComposerMenuPresentation,
  useComposerMenuSheet,
} from "./menu-sheet";
import { connectorSessionPatch } from "./connector-session-state";
import { mergeConversationToolOverrides } from "../../shared/conversation-tools";
import type { McpServerState } from "../../shared/settings-desktop-api";
import { ConnectorReconnectRows } from "./ConnectorReconnectRows";
import { ConnectorAddMenu } from "./ConnectorAddMenu";
import { useHostCapability } from "../host/HostContext";
import { ToolAccessMenu } from "./ToolAccessMenu";
import { effectiveToolSearch } from "../../shared/tool-search-mode";
import { clipRight, keepInWindow, pinToWindow, release } from "../ui/clip-edge";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Blocks,
  Globe,
  Palette,
  Check,
  ChevronRight,
  Library,
  Plus,
  Search,
} from "../ui/glyphs";
import { BriefcaseIcon } from "../ui/icons";
import { GithubMark } from "../ui/GithubMark";
import { AttachmentIcon } from "./AttachmentIcon";
import { ExtendedThinkingIcon } from "./ExtendedThinkingIcon";
import { shortcutParts, shortcutText } from "../ui/Tooltip";
import type { Project } from "../../shared/types";
import type { CustomizeSkill } from "../../shared/collections-api";
import { preference } from "../../shared/settings-extras";
import {
  researchPolicyOf,
  imageAttachmentTypes,
} from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { AppContext } from "../app/AppContext";
import { usePolicy } from "../policy/PolicyContext";
import { researchConnectorEnabled } from "../../shared/research";
import "./composer-add-menu.css";
import { AppIcon } from "../ui/app-icon";
import { t } from "../i18n";
import { callableSkills } from "./skill-tokens";
import { useAddMenuResource } from "./useAddMenuResource";
import { Skeleton } from "../ui/Skeleton";
import { ChatDeviceMenu, useChatDevices } from "./ChatDeviceMenu";

const readSkills = (bridge: Window["desktop"]) => bridge.customizeSkills();
const readDesigns = (bridge: Window["desktop"]) => bridge.listDesignSystems();

type Branch = "project" | "skills" | "connectors" | "design" | "devices";
type Props = {
  /** Main unified Chat projections; independent task callers keep legacy actions. */
  presentation?: "web-chat" | "native-chat" | "legacy";
  platform: NodeJS.Platform;
  projects: Project[];
  currentProjectId?: string;
  webSearch: boolean;
  webSearchAvailable: boolean;
  onWebSearch: () => void;
  /** Research mode; the row is left out without onResearch. */
  research?: boolean;
  researchAvailable?: boolean;
  /** Why Research can't be turned on, when it can't. */
  researchUnavailableReason?: string;
  onResearch?: () => void;
  thinking?: boolean;
  onThinking?: () => void;
  onClose: () => void;
  onFiles: () => void;
  /** Inserts an enabled skill reference into this draft; never sends it. */
  onSkill?: (skill: CustomizeSkill) => void;
  onBrowseSkills?: () => void;
  /** Settings → Connectors on its directory; without it, Connectors as it opens. */
  onBrowseConnectors?: () => void;
  /** Settings → Connectors with the custom connector form open. */
  onAddCustomConnector?: () => void;
  /** Authorized host callback; absent when this host has no local folder bridge. */
  onFolder?: () => void;
  folderUnavailableReason?: string;
  /** Current native session processing; other projections keep their own policy. */
  processing?: boolean;
  onGitHub?: () => void;
  /** The chosen project's id; null takes the conversation out of its project. */
  onProject: (id: string | null) => void;
  /** With a name, creates a project of that name right away. */
  onCreateProject: (name?: string) => void;
  onSettings: (tab: string) => void;
  onUnavailable: (message: string) => void;
  /** Set when the project catalogue cannot be read. */
  projectsError?: boolean;
  /** Set when project creation is unavailable in the current workspace. */
  projectsAvailable?: boolean;
};
function ProjectIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.5 3.5h13M4.5 7h15M3.5 10.5h17l-1.7 9a1.5 1.5 0 0 1-1.5 1.2H6.7a1.5 1.5 0 0 1-1.5-1.2z" />
    </svg>
  );
}
export function ComposerAddMenu({
  presentation = "legacy",
  platform,
  projects,
  currentProjectId,
  webSearch,
  webSearchAvailable,
  onWebSearch,
  research = false,
  researchAvailable = false,
  researchUnavailableReason,
  onResearch,
  thinking = false,
  onThinking,
  onClose: closeImmediately,
  onFiles,
  onSkill,
  onBrowseSkills,
  onBrowseConnectors,
  onAddCustomConnector,
  onFolder,
  folderUnavailableReason,
  processing = false,
  onGitHub,
  onProject,
  onCreateProject,
  onSettings,
  onUnavailable,
  projectsError = false,
  projectsAvailable = true,
}: Props) {
  const webChat = presentation === "web-chat";
  const nativeChat = presentation === "native-chat";
  const unifiedChat = webChat || nativeChat;
  const root = useRef<HTMLDivElement>(null);
  const sheet = useComposerMenuPresentation();
  const policy = usePolicy();
  // Adding a custom connector: on this computer's configuration or the
  // service's runner, unless the administrator keeps the list fixed (the
  // Connectors page's own rule).
  const localMcp = useHostCapability("localMcp");
  const customConnectors = useHostCapability("customConnectors");
  const canAddCustomConnector =
    (localMcp || customConnectors) && policy.localMcpEditing;
  const app = useContext(AppContext);
  const connectorProcessing =
    nativeChat && Boolean(processing || app?.running || app?.sending);
  // A menu can stay mounted while a send starts. Retained actions must use
  // the current lock rather than the render in which they were opened.
  const connectorLock = useRef(connectorProcessing);
  connectorLock.current = connectorProcessing;
  const [branch, setBranch] = useState<Branch | null>(null);
  const sheetMotion = useComposerMenuSheet(root, {
    sheet,
    nested: branch,
    panel: branch ? `[data-add-panel="${branch}"]` : undefined,
    trigger: branch ? `[data-add-branch="${branch}"]` : undefined,
    onBack: () => setBranch(null),
  });
  const onClose = () => sheetMotion.dismiss(closeImmediately);
  // The project submenu's "Search or create a project" field.
  const [projectQuery, setProjectQuery] = useState("");
  const showResearch =
    policy.webSearch && researchPolicyOf(policy).enabled && !!onResearch;
  // Standalone skills insert a current prompt reference (O16 shared5 Es→ci),
  // while installing/enabling remains an explicit Customize action.
  const skills = useAddMenuResource(readSkills, app?.accountId ?? "local");
  // Design system submenu: the one in use is told to new Chat and Cowork turns.
  const designs = useAddMenuResource(readDesigns, app?.accountId ?? "local");
  const devices = useChatDevices(
    unifiedChat && Boolean(app) && app?.mode !== "code" && !app?.incognitoShown,
  );
  const designInUse = app
    ? preference(app.snapshot.settings, "designSystem")
    : "";
  const chooseDesign = (id: string) => {
    void app
      ?.updatePreference({ designSystem: designInUse === id ? "" : id })
      .catch(app.report);
  };
  const skillRows = callableSkills(skills.rows);
  const resourceState = (
    resource: { status: string; reload(): void },
    failure = t("Something went wrong"),
  ) =>
    resource.status === "pending" ? (
      <div
        className="composer-add-loading"
        role="status"
        aria-label={t("Loading")}
      >
        <Skeleton width={20} height={20} />
        <Skeleton width={96} height={16} />
      </div>
    ) : resource.status === "failed" ? (
      <div className="composer-add-load-error" role="alert">
        <p>{failure}</p>
        <button role="menuitem" onClick={resource.reload}>
          {t("Try again")}
        </button>
      </div>
    ) : null;
  const servers = app?.snapshot.settings.mcpServers ?? {};
  // Connectors outside the administrator's allowlist never start, so they are not listed.
  const connectorRows = Object.entries(servers).filter(
    ([connector, value]) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      connectorAllowed(policy, connector, value),
  );
  const [connectorRevision, setConnectorRevision] = useState(0);
  const connectorRetirement = useRef(0);
  const connectorOwner = useMemo(
    () => ({}),
    [
      app?.accountId,
      app?.controllerScope,
      app?.activeId,
      app?.draftSession,
      app?.page,
      connectorRevision,
      typeof window === "undefined" ? undefined : window.desktop,
    ],
  );
  const connectorOwnerRef = useRef(connectorOwner);
  connectorOwnerRef.current = connectorOwner;
  const [connectorPending, setConnectorPending] = useState<{
    owner: object;
    request: object;
  }>();
  const connectorSaving = connectorPending?.owner === connectorOwner;
  const connectorSave = useRef<{ owner: object; request: object } | undefined>(
    undefined,
  );
  useEffect(() => {
    const bridge = window.desktop;
    return bridge.onEvent?.((event) => {
      if (event.type !== "service-changed" && event.type !== "signed-out")
        return;
      ++connectorRetirement.current;
      connectorSave.current = undefined;
      setConnectorPending(undefined);
      setConnectorRevision((value) => value + 1);
    });
  }, [
    app?.accountId,
    app?.controllerScope,
    typeof window === "undefined" ? undefined : window.desktop,
  ]);
  const toggleConnector = (
    connector: string,
    enabled: boolean,
    status?: McpServerState,
  ) => {
    if (
      !app ||
      connectorLock.current ||
      connectorSave.current?.owner === connectorOwner
    )
      return;
    const retirement = connectorRetirement.current;
    const account = app.accountId,
      scope = app.controllerScope,
      bridge = window.desktop;
    const origin = {
      active: app.activeId,
      draft: app.draftSession,
      page: app.page,
    };
    const current = () => {
      const now = app.currentController ? app.currentController.current : app;
      return Boolean(
        root.current?.isConnected &&
        connectorOwnerRef.current === connectorOwner &&
        connectorRetirement.current === retirement &&
        window.desktop === bridge &&
        now &&
        now.accountId === account &&
        now.controllerScope === scope &&
        now.activeId === origin.active &&
        now.draftSession === origin.draft &&
        now.page === origin.page &&
        !connectorLock.current,
      );
    };
    if (!current()) return;
    const overrides =
      app.active?.connectorOverrides ?? app.composerDraft.draftConnectors;
    const next = { ...overrides, [connector]: enabled };
    const tools = mergeConversationToolOverrides(
      app.active?.connectorToolOverrides ??
        app.composerDraft.draftConnectorTools ??
        {},
      connectorSessionPatch(status, enabled),
    );
    const finish = () => {
      if (!current()) return;
      if (
        !enabled &&
        research &&
        !webSearch &&
        !researchConnectorEnabled(app.snapshot.settings, policy, next)
      )
        onResearch?.();
    };
    if (app.active) {
      const request = { owner: connectorOwner, request: {} };
      connectorSave.current = request;
      setConnectorPending(request);
      void app
        .patchConversation(app.active, {
          connectorOverrides: next,
          connectorToolOverrides: tools,
        })
        .then(finish)
        .catch((error) => {
          if (current()) app.report(error);
        })
        .finally(() => {
          if (connectorSave.current === request) {
            connectorSave.current = undefined;
            if (current()) setConnectorPending(undefined);
          }
        });
    } else {
      app.composerDraft.setDraftConnectors(next);
      app.composerDraft.setDraftConnectorTools?.(tools);
      finish();
    }
  };
  const [above, setAbove] = useState(false),
    [left, setLeft] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    ),
    closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };
  useLayoutEffect(() => {
    const rect = root.current?.parentElement?.getBoundingClientRect();
    // Below the button unless the menu (its real height: nine rows and two
    // rules today) would run off the window and there is more room above.
    const height = root.current?.offsetHeight ?? 286;
    setAbove(
      Boolean(
        rect &&
        rect.bottom + 8 + height > window.innerHeight - 8 &&
        rect.top > window.innerHeight - rect.bottom,
      ),
    );
    setLeft(Boolean(rect && rect.right + 230 > clipRight(root.current) - 8));
    keepInWindow(root.current);
  }, []);
  // An open submenu never covers the menu or runs off the window: it turns to
  // the menu's other side when the window cuts it.
  useLayoutEffect(() => {
    const panel = root.current?.querySelector<HTMLElement>(
      ":scope .composer-add-submenu",
    );
    if (!panel || sheet) return;
    release(panel);
    panel.classList.remove("flip-left", "flip-right");
    const margin = 8;
    const box = panel.getBoundingClientRect();
    const menu = root.current!.getBoundingClientRect();
    if (box.right > window.innerWidth - margin) {
      if (menu.left - 5 - box.width >= margin) panel.classList.add("flip-left");
    } else if (box.left < margin) {
      if (menu.right + 5 + box.width <= window.innerWidth - margin)
        panel.classList.add("flip-right");
    }
    pinToWindow(panel);
  }, [branch, sheet]);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const outside = (event: PointerEvent) => {
      if (!root.current?.parentElement?.contains(event.target as Node))
        onClose();
    };
    document.addEventListener("pointerdown", outside);
    root.current?.focus();
    return () => {
      clear();
      document.removeEventListener("pointerdown", outside);
      if (root.current?.contains(document.activeElement)) trigger?.focus();
    };
  }, []);
  const hoverBranch = (name: Branch) => {
    if (sheet) return;
    clear();
    if (branch === name) return;
    setBranch(null);
    openTimer.current = setTimeout(() => setBranch(name), 100);
  };
  const focusBranch = (name: Branch) => {
    clear();
    setBranch(name);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLElement>(
          `[data-add-panel="${name}"] :is(input, button)`,
        )
        ?.focus(),
    );
  };
  const activate = (action: () => void) => {
    clear();
    onClose();
    action();
  };
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement,
      menu = target.closest('[role="menu"]');
    // Inside the project search field the caret keys are the field's own.
    if (
      target instanceof HTMLInputElement &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      if (branch) {
        root.current
          ?.querySelector<HTMLElement>(`[data-add-branch="${branch}"]`)
          ?.focus();
        setBranch(null);
      } else if (event.key === "Escape") onClose();
    } else if (event.key === "ArrowRight" && target.dataset.addBranch) {
      event.preventDefault();
      focusBranch(target.dataset.addBranch as Branch);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(
        menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
          [],
      ).filter((item) => item.closest('[role="menu"]') === menu);
      const index = items.indexOf(target as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length;
      items[next]?.focus();
    } else if (event.key === "Tab") onClose();
  };
  // Research does not lock Web search.
  const webSearchReason = webSearchAvailable
    ? undefined
    : "Web search requires an idle conversation and a Responses-compatible model service.";
  const typedProject = projectQuery.trim();
  const shownProjects = typedProject
    ? projects.filter((project) =>
        project.name.toLowerCase().includes(typedProject.toLowerCase()),
      )
    : projects;
  // Typing a name no project has offers to create it.
  const newProjectName = projects.some(
    (project) => project.name.toLowerCase() === typedProject.toLowerCase(),
  )
    ? ""
    : typedProject.slice(0, 100);
  const submenu = (name: Branch) =>
    branch === name && (
      <div
        className="composer-add-submenu"
        role="menu"
        data-add-panel={name}
        data-add-state={
          name === "skills"
            ? skills.status === "loaded" && !skillRows.length
              ? "empty"
              : skills.status
            : name === "design"
              ? designs.status === "loaded" && !designs.rows.length
                ? "empty"
                : designs.status
              : undefined
        }
        onMouseEnter={() => clearTimeout(closeTimer.current)}
      >
        <ComposerSheetBack
          sheet={sheet}
          title={t(
            {
              project: "Project",
              skills: "Skills",
              connectors: "Connectors",
              design: "Design system",
              devices: "Devices",
            }[name],
          )}
          onBack={sheetMotion.back}
        />
        {name === "devices" && devices.value ? (
          <ChatDeviceMenu
            value={devices.value}
            processing={processing || Boolean(app?.running || app?.sending)}
            onSettings={() => activate(() => onSettings("cowork"))}
            onError={onUnavailable}
          />
        ) : name === "project" ? (
          <>
            <label className="composer-add-search">
              <Search />
              <input
                value={projectQuery}
                placeholder="Search or create a project"
                aria-label="Search or create a project"
                onChange={(event) => setProjectQuery(event.target.value)}
              />
            </label>
            <div className="composer-add-project-list">
              {shownProjects.map((project) => (
                <button
                  key={project.id}
                  role="menuitemcheckbox"
                  aria-checked={project.id === currentProjectId}
                  // The chosen project again takes the conversation out of it.
                  onClick={() =>
                    activate(() =>
                      onProject(
                        project.id === currentProjectId ? null : project.id,
                      ),
                    )
                  }
                >
                  <ProjectIcon />
                  <span>{project.name}</span>
                  {project.id === currentProjectId && <Check size={14} />}
                </button>
              ))}
              {projectsError ? (
                <button type="button" disabled role="menuitem">
                  <span>Failed to load projects</span>
                </button>
              ) : !projectsAvailable ? (
                <button type="button" disabled role="menuitem">
                  <span>No projects available</span>
                </button>
              ) : shownProjects.length === 0 ? (
                <button type="button" disabled role="menuitem">
                  <span>{typedProject ? "No matches" : "No projects yet"}</span>
                </button>
              ) : null}
            </div>
            <div className="composer-add-separator" role="separator" />
            <button
              role="menuitem"
              onClick={() =>
                activate(() =>
                  onCreateProject(newProjectName ? newProjectName : undefined),
                )
              }
            >
              <Plus />
              <span
                className={
                  newProjectName ? "composer-add-create-label" : undefined
                }
              >
                {newProjectName ? "Create project" : "New project"}
                {newProjectName && (
                  <strong className="composer-add-project-tag">
                    {newProjectName}
                  </strong>
                )}
              </span>
            </button>
          </>
        ) : name === "skills" ? (
          <>
            {resourceState(skills)}
            {skillRows.map((skill) => (
              <button
                key={skill.path}
                role="menuitem"
                disabled={!onSkill}
                title={skill.description || undefined}
                onClick={() => activate(() => onSkill?.(skill))}
              >
                <AppIcon name="Scroll" size={20} />
                <span data-no-translate>{skill.name}</span>
              </button>
            ))}
            {skillRows.length > 0 && (
              <div className="composer-add-separator" role="separator" />
            )}
            <button
              role="menuitem"
              onClick={() => activate(() => onSettings("skills"))}
            >
              <AppIcon name="Tool" size={20} />
              <span>Manage skills</span>
            </button>
            {onBrowseSkills && (
              <button role="menuitem" onClick={() => activate(onBrowseSkills)}>
                <Plus />
                <span>{t("Browse skills")}</span>
              </button>
            )}
          </>
        ) : name === "connectors" ? (
          // Browse connectors (Add connectors while there are none), Manage
          // connectors, the connectors with their switches, then Tool access ›.
          <>
            <ConnectorAddMenu
              sheet={Boolean(sheet)}
              canAddCustom={canAddCustomConnector}
              hasConnectors={connectorRows.length > 0}
              onBrowse={() =>
                activate(onBrowseConnectors ?? (() => onSettings("connectors")))
              }
              onAddCustom={() =>
                activate(
                  onAddCustomConnector ?? (() => onSettings("connectors")),
                )
              }
            />
            <button
              role="menuitem"
              onClick={() => activate(() => onSettings("connectors"))}
            >
              <AppIcon name="Tool" size={20} />
              <span>Manage connectors</span>
            </button>
            {connectorRows.length > 0 && (
              <div className="composer-add-separator" role="separator" />
            )}
            <ConnectorReconnectRows
              servers={servers}
              enabledOverrides={
                app?.active?.connectorOverrides ??
                app?.composerDraft.draftConnectors
              }
              toolOverrides={
                app?.active?.connectorToolOverrides ??
                app?.composerDraft.draftConnectorTools
              }
              onToggle={toggleConnector}
              disabled={connectorProcessing || connectorSaving}
              disabledReason={
                connectorProcessing
                  ? t("Cannot modify connectors while message is processing")
                  : undefined
              }
              switchClass="composer-add-switch"
              onError={app?.report}
            />
            <div className="composer-add-separator" role="separator" />
            <ToolAccessMenu
              sheet={Boolean(sheet)}
              mode={effectiveToolSearch(
                app?.active ??
                  (app?.composerDraft.draftToolSearchMode
                    ? { toolSearchMode: app.composerDraft.draftToolSearchMode }
                    : undefined),
                app?.snapshot.settings ?? {},
              )}
              disabledReason={
                connectorProcessing
                  ? t("Cannot modify connectors while message is processing")
                  : undefined
              }
              onChoose={(toolSearchMode) => {
                if (!app) return;
                if (app.active)
                  void app
                    .patchConversation(app.active, { toolSearchMode })
                    .catch(app.report);
                else app.composerDraft.setDraftToolSearchMode(toolSearchMode);
              }}
            />
          </>
        ) : (
          // Design systems: the ones the account has (one is in use), Manage
          // design systems and New design system ›.
          <>
            {resourceState(
              designs,
              t("Design systems couldn’t be loaded. Refresh to try again."),
            )}
            {designs.rows.map((system) => (
              <button
                key={system.id}
                role="menuitemradio"
                aria-checked={system.id === designInUse}
                disabled={!system.guidelines}
                title={
                  system.guidelines ? undefined : "Write its guidelines first"
                }
                onClick={() => chooseDesign(system.id)}
              >
                <Palette />
                <span>{system.name}</span>
                {system.id === designInUse && <Check size={14} />}
              </button>
            ))}
            {designs.rows.length > 0 && (
              <div className="composer-add-separator" role="separator" />
            )}
            <button
              role="menuitem"
              onClick={() => activate(() => onSettings("design"))}
            >
              <BriefcaseIcon className="composer-add-wide-icon" />
              <span>Manage design systems</span>
            </button>
            <button
              role="menuitem"
              onClick={() => activate(() => onSettings("design"))}
            >
              <Plus />
              <span>New design system</span>
              <ChevronRight className="composer-add-chevron" />
            </button>
          </>
        )}
      </div>
    );
  const branchRow = (name: Branch, label: string, icon: ReactNode) => (
    <div className="composer-add-branch" onMouseEnter={() => hoverBranch(name)}>
      <button
        role="menuitem"
        data-add-branch={name}
        aria-haspopup="menu"
        aria-expanded={branch === name}
        onClick={() => (branch === name ? setBranch(null) : focusBranch(name))}
      >
        {icon}
        <span>{label}</span>
        <ChevronRight className="composer-add-chevron" />
      </button>
      {submenu(name)}
    </div>
  );
  return (
    <div
      ref={root}
      className={`composer-add-menu ${webChat ? "composer-add-web-chat" : nativeChat ? "composer-add-native-chat" : ""} ${above ? "opens-above" : ""} ${left ? "opens-left" : ""}`}
      role="menu"
      tabIndex={-1}
      aria-label="Add files, connectors, and more"
      onKeyDown={keydown}
      onMouseEnter={() => clearTimeout(closeTimer.current)}
      onMouseLeave={() => {
        if (sheet) return;
        clear();
        closeTimer.current = setTimeout(() => setBranch(null), 100);
      }}
    >
      {policy.attachments.types.length > 0 && (
        <button
          role="menuitem"
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => activate(onFiles)}
        >
          <AttachmentIcon />
          <span>
            {policy.attachments.types.some(
              (type) => !imageAttachmentTypes.includes(type),
            )
              ? "Upload or add files"
              : "Add image"}
          </span>
          {unifiedChat ? (
            <span className="composer-add-shortcut" aria-hidden="true">
              {shortcutParts(platform, ["mod", "U"]).map((part) => (
                <kbd key={part}>{part}</kbd>
              ))}
            </span>
          ) : (
            <kbd>{shortcutText(platform, ["mod", "U"])}</kbd>
          )}
        </button>
      )}
      {nativeChat && onFolder && (
        <button
          role="menuitem"
          disabled={Boolean(folderUnavailableReason)}
          title={
            folderUnavailableReason ? t(folderUnavailableReason) : undefined
          }
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => {
            if (!folderUnavailableReason) activate(onFolder);
          }}
        >
          <AppIcon name="FolderPlus" size={20} />
          <span>Add folder</span>
        </button>
      )}
      {/* Recording needs the native supported/startWatchRecording protocol.
          As in c752b32f8 Ns(), unavailable recording has no menu entry. */}
      {!unifiedChat && branchRow("project", "Add to project", <ProjectIcon />)}
      {!unifiedChat && onGitHub && connectorAllowed(policy, "github") && (
        <button
          role="menuitem"
          onClick={() => activate(onGitHub)}
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
        >
          <GithubMark />
          <span>Add content from GitHub</span>
        </button>
      )}
      <div className="composer-add-separator" role="separator" />
      {branchRow("skills", "Skills", <AppIcon name="Scroll" size={20} />)}
      {/* No connector yet: the root row adds one. An administrator's allowlist
         keeps the submenu. */}
      {connectorRows.length === 0 && !policy.connectors ? (
        <button
          role="menuitem"
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => activate(() => onSettings("connectors"))}
        >
          <Blocks />
          <span>Add connector</span>
        </button>
      ) : (
        branchRow("connectors", "Connectors", <Blocks />)
      )}
      {branchRow("design", "Design system", <Palette />)}
      <button
        role="menuitem"
        onMouseEnter={() => {
          clear();
          setBranch(null);
        }}
        onClick={() => activate(() => onSettings("plugins"))}
      >
        <AppIcon name="Plugin" size={20} />
        <span>Add plugins</span>
      </button>
      {unifiedChat &&
        devices.value &&
        devices.value.devices.length > 0 &&
        branchRow("devices", "Devices", <AppIcon name="Computer" size={20} />)}
      {(showResearch || (!unifiedChat && policy.webSearch)) && (
        <div className="composer-add-separator" role="separator" />
      )}
      {/* Research: hidden where the administrator turned it off; turning it on
         turns on web search too. */}
      {showResearch && (
        <button
          className="composer-add-research"
          role="menuitemcheckbox"
          aria-checked={research}
          // Disabled with its reason on hover, and a click that works closes
          // the menu.
          disabled={!researchAvailable}
          title={
            researchAvailable
              ? undefined
              : (researchUnavailableReason ??
                "Enable a search integration to use research")
          }
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => activate(() => onResearch?.())}
        >
          <AppIcon name="Research" size={20} />
          <span>Research</span>
          {research && <Check className="composer-add-check" />}
        </button>
      )}
      {!unifiedChat && policy.webSearch && (
        <button
          role="menuitemcheckbox"
          aria-checked={webSearch}
          disabled={Boolean(webSearchReason)}
          title={webSearchReason}
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => activate(onWebSearch)}
        >
          <Globe />
          <span>Web search</span>
          {webSearch && <Check className="composer-add-check" />}
        </button>
      )}
      {!unifiedChat && onThinking && (
        <button
          role="menuitemcheckbox"
          aria-checked={thinking}
          onMouseEnter={() => {
            clear();
            setBranch(null);
          }}
          onClick={() => activate(onThinking)}
        >
          <ExtendedThinkingIcon />
          <span>Extended thinking</span>
          {thinking && <Check className="composer-add-check" />}
        </button>
      )}
    </div>
  );
}
