/**
 * The Code tool panels beside a conversation: terminal, Changes, background
 * tasks, and the Browser panel with its dev servers (R8; types in
 * `shared/browser.ts`). Handlers go in `electron/ipc/panels.ts` (terminal and
 * background terminal ones in `electron/ipc/terminal.ts` and
 * `electron/ipc/background-terminals.ts`).
 */
import type {
  BackgroundTerminalInfo,
  DiffScope,
  TerminalSessionInfo,
  WorkingTreeChanges,
} from "./types";
import type {
  BrowserBounds,
  BrowserNavigateResult,
  BrowserState,
  BrowserViewport,
  BrowserColorScheme,
  DevServerState,
  ElementPick,
  LaunchConfiguration,
} from "./browser";
import { bridgeMethods } from "./bridge-methods";
import type { ChromeImportAPI } from "./chrome-import";
import type { PreviewOriginAPI } from "./preview-origin";
import type { SessionLoop, SessionLoopInput } from "./session-loops";
import type { TaskBacklogAPI } from "./task-backlog";

/**
 * A background terminal that ended: stopped from the Background tasks panel, or
 * gone from Codex's list on its own. Codex's list carries no exit code, so the
 * panel shows one only when the command's own item has it.
 */
export interface FinishedBackgroundTerminal {
  /** `terminal:<conversationId>:<processId>`, as Clear finished tasks uses. */
  id: string;
  conversationId: string;
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  status: "stopped" | "completed";
  finishedAt: number;
}

/**
 * A Code session's branch for the pull request row above the composer: which
 * branch, the repository it belongs to on GitHub, how far it is from the base
 * branch and how much it changes.
 */
export interface CodeGitStatus {
  state: "ready" | "not-git" | "no-folder";
  /** The checked-out branch; absent when HEAD is detached or has no commit. */
  branch?: string;
  /** The remote's default branch (`origin/HEAD`), when the clone knows it. */
  baseBranch?: string;
  /** "owner/name" of the github.com remote; absent without one. */
  repository?: string;
  /** Commits on the branch that the base branch lacks. */
  ahead: number;
  /** Commits on the base branch that the branch lacks. */
  behind?: number;
  /** The remote has a branch of this name (as far as the last fetch or push knew). */
  pushed: boolean;
  /** Uncommitted changes in the working tree (tracked or new files). */
  dirty: boolean;
  /** Lines added and removed against the base branch's merge point (HEAD without one). */
  additions: number;
  deletions: number;
}

export interface PanelsAPI
  extends ChromeImportAPI, PreviewOriginAPI, TaskBacklogAPI {
  setPreviewLinkRouting(
    conversationId: string,
    tabId: string,
    enabled: boolean,
  ): Promise<void>;
  listSessionLoops(conversationId: string): Promise<SessionLoop[]>;
  createSessionLoop(
    conversationId: string,
    input: SessionLoopInput,
  ): Promise<SessionLoop>;
  stopSessionLoop(conversationId: string, id: string): Promise<boolean>;
  terminalList(conversationId: string): Promise<TerminalSessionInfo[]>;
  terminalEnsure(conversationId: string): Promise<TerminalSessionInfo[]>;
  /** A new tab, with one of `terminalShells` (else the default shell). */
  terminalStart(
    conversationId: string,
    shell?: string,
  ): Promise<TerminalSessionInfo>;
  /** The shells a new tab can start with (Choose shell); none on an SSH host. */
  terminalShells(
    conversationId: string,
  ): Promise<{ shells: { id: string; name: string }[]; defaultId: string }>;
  terminalWrite(
    conversationId: string,
    id: string,
    deltaBase64: string,
  ): Promise<void>;
  terminalResize(
    conversationId: string,
    id: string,
    rows: number,
    cols: number,
  ): Promise<void>;
  /**
   * The ids of the conversation's terminal tabs where a command is still
   * running (asked before a tab with one is closed).
   */
  terminalBusy(conversationId: string): Promise<string[]>;
  terminalClose(conversationId: string, id: string): Promise<void>;
  listBackgroundTerminals(conversationId: string): Promise<{
    conversationId: string;
    items: BackgroundTerminalInfo[];
    /** Background terminals of this conversation that ended. */
    finished?: FinishedBackgroundTerminal[];
  }>;
  stopBackgroundTerminal(
    conversationId: string,
    processId: string,
  ): Promise<boolean>;
  workingTreeChanges(
    conversationId: string,
    context?: number,
    /** What to compare (the Changes panel's diff scope); "All changes" by default. */
    scope?: DiffScope,
  ): Promise<WorkingTreeChanges>;
  /**
   * The branches of the conversation's repository the Changes panel can
   * compare against: the default first, the checked-out one left out.
   */
  gitBranches(conversationId: string): Promise<string[]>;
  /**
   * View image: an image file of the Changes panel as it was before the
   * change or is after it (relative to the repository's top), as a `data:`
   * URL; null when that side has none or can't be read.
   */
  changedImage(
    conversationId: string,
    path: string,
    side: "before" | "after",
    scope?: DiffScope,
  ): Promise<string | null>;
  /**
   * Apply a reviewer's suggested change to a file of a local session's
   * repository (relative to its top), when the lines still read `original`.
   */
  applyReviewSuggestion(
    conversationId: string,
    input: {
      path: string;
      startLine: number;
      endLine: number;
      original: string;
      suggestion: string;
    },
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "changed" | "denied" | "hidden" | "moved" }
  >;
  /**
   * The conversation's branch and what its pull request row needs (read-only
   * `git` queries in the session's folder, where the Changes panel's run).
   */
  codeGitStatus(conversationId: string): Promise<CodeGitStatus>;
  /** Hides finished background tasks from the panel; the ids that stay hidden. */
  clearFinishedBackgroundTasks(ids: string[]): Promise<string[]>;

  // The Browser panel of a Code conversation (R8). Changes arrive as
  // "browser" events carrying the whole BrowserState.
  browserState(conversationId: string): Promise<BrowserState>;
  /** The panel opened in the calling window; the page shows once bounds arrive. */
  browserOpen(conversationId: string): Promise<BrowserState>;
  /** The panel closed: pages stay open for Claude but leave the window. */
  browserHide(conversationId: string): Promise<void>;
  /** Where the page goes: the placeholder's box in CSS pixels of the app page. */
  browserSetBounds(
    conversationId: string,
    bounds: BrowserBounds,
  ): Promise<void>;
  /**
   * An app menu or dialog covers the page (true) or closed (false). While
   * covered the page leaves the window; `snapshot` (a JPEG data URL) stands in.
   */
  browserOcclude(
    conversationId: string,
    on: boolean,
  ): Promise<{ snapshot?: string }>;
  /** Opens an address typed in the address bar; refused words come back as a message. */
  browserNavigate(
    conversationId: string,
    input: string,
    tabId?: string,
  ): Promise<BrowserNavigateResult>;
  browserBack(conversationId: string): Promise<void>;
  browserForward(conversationId: string): Promise<void>;
  browserReload(conversationId: string): Promise<void>;
  browserStop(conversationId: string): Promise<void>;
  /** A new tab (blank, or opening `url`); its id. */
  browserNewTab(conversationId: string, url?: string): Promise<string>;
  browserSelectTab(conversationId: string, tabId: string): Promise<void>;
  browserCloseTab(conversationId: string, tabId: string): Promise<void>;
  browserCloseOtherTabs(conversationId: string, tabId: string): Promise<void>;
  browserSetViewport(
    conversationId: string,
    viewport: BrowserViewport,
  ): Promise<void>;
  /** The prefers-color-scheme the conversation's pages see. */
  browserSetColorScheme(
    conversationId: string,
    scheme: BrowserColorScheme,
  ): Promise<void>;
  /** Select element: resolves with the element the person clicked, or null when cancelled. */
  browserPickElement(conversationId: string): Promise<ElementPick | null>;
  browserCancelPick(conversationId: string): Promise<void>;
  /** A PNG of the page as shown (screenshot markup); null without a page. */
  browserCapture(conversationId: string): Promise<{ pngBase64: string } | null>;
  browserConsoleLogs(
    conversationId: string,
    options?: { onlyErrors?: boolean; clear?: boolean },
  ): Promise<
    { level: string; text: string; timestamp: number; source?: string }[]
  >;
  browserModelScreenshot(conversationId: string): Promise<{
    base64: string;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
  } | null>;
  browserSnapshot(conversationId: string): Promise<string | null>;
  browserInspect(
    conversationId: string,
    selector: string,
    properties?: string[],
  ): Promise<{
    found: boolean;
    info?: {
      tagName: string;
      text: string;
      className: string;
      id: string;
      value?: string;
      styles: Record<string, string>;
      boundingBox?: { x: number; y: number; width: number; height: number };
      reactComponent?: string;
      reactProps?: Record<string, string | number | boolean | null>;
    };
  } | null>;
  /** Save screenshot: a system save dialog; false when cancelled. */
  browserSaveScreenshot(conversationId: string): Promise<boolean>;
  browserExportFile(conversationId: string): Promise<boolean>;
  /** Open HTML file…: a system open dialog; false when cancelled. */
  browserOpenHtmlFile(conversationId: string): Promise<boolean>;
  /** Open in <default browser>: the page's address in the system browser. */
  browserOpenExternally(conversationId: string): Promise<void>;
  /** Answers the page's confirm, prompt or leave-page dialog. */
  browserAnswerDialog(
    conversationId: string,
    tabId: string,
    accept: boolean,
    text?: string,
  ): Promise<void>;
  /** Clear browsing data (cookies, site data, cache) for the Keep cookies choice in use. */
  browserClearData(conversationId?: string): Promise<void>;
  browserClearPreviewData(): Promise<void>;
  browserShowStartPage(conversationId: string): Promise<void>;
  /** The system's default browser ("Google Chrome") for "Open in …", or null. */
  browserDefaultBrowserName(): Promise<string | null>;

  // Dev servers of the conversation's folder (R8-B). Refused while
  // BrowserState.devServersAvailable is false.
  /** Draft configurations found in the folder (package.json scripts, frameworks). */
  devServersDetect(conversationId: string): Promise<LaunchConfiguration[]>;
  /** Adds or replaces a configuration in the folder's .claude/launch.json. */
  /** Saves the project's Auto-verify choice in `.claude/launch.json`. */
  devServersSetAutoVerify(conversationId: string, on: boolean): Promise<void>;
  devServersSave(
    conversationId: string,
    config: LaunchConfiguration,
  ): Promise<void>;
  /** Starts a configuration the person confirmed in the panel. */
  devServersStart(
    conversationId: string,
    name: string,
  ): Promise<DevServerState>;
  devServersStop(conversationId: string, name: string): Promise<void>;
  devServersLogs(
    conversationId: string,
    name: string,
    lines?: number,
  ): Promise<string[]>;
}

export const panelsMethods = bridgeMethods<PanelsAPI>({
  getTaskBacklog: true,
  dismissTaskBacklogItem: true,
  backgroundTaskSuggestions: true,
  launchBackgroundTaskSuggestion: true,
  popBackgroundTaskSuggestion: true,
  popBackgroundTaskSuggestionById: true,
  setPreviewLinkRouting: true,
  getPreviewAllowedOrigins: true,
  addPreviewAllowedOrigin: true,
  removePreviewAllowedOrigin: true,
  clearPreviewAllowedOrigins: true,
  getChromeImportAvailability: true,
  getCoworkChromeImportAvailability: true,
  clearCoworkBrowserData: true,
  getChromeImportSharedOffer: true,
  acceptChromeImportSharedOffer: true,
  listChromeImportProfiles: true,
  listChromeImportSites: true,
  importChromeLogins: true,
  listImportedChromeLogins: true,
  removeImportedChromeLogins: true,
  listSessionLoops: true,
  createSessionLoop: true,
  stopSessionLoop: true,
  terminalList: true,
  terminalEnsure: true,
  terminalStart: true,
  terminalShells: true,
  terminalWrite: true,
  terminalResize: true,
  terminalBusy: true,
  terminalClose: true,
  listBackgroundTerminals: true,
  stopBackgroundTerminal: true,
  workingTreeChanges: true,
  gitBranches: true,
  changedImage: true,
  applyReviewSuggestion: true,
  codeGitStatus: true,
  clearFinishedBackgroundTasks: true,
  browserState: true,
  browserOpen: true,
  browserHide: true,
  browserSetBounds: true,
  browserOcclude: true,
  browserNavigate: true,
  browserBack: true,
  browserForward: true,
  browserReload: true,
  browserStop: true,
  browserNewTab: true,
  browserSelectTab: true,
  browserCloseTab: true,
  browserCloseOtherTabs: true,
  browserSetViewport: true,
  browserSetColorScheme: true,
  browserPickElement: true,
  browserCancelPick: true,
  browserCapture: true,
  browserConsoleLogs: true,
  browserModelScreenshot: true,
  browserSnapshot: true,
  browserInspect: true,
  browserSaveScreenshot: true,
  browserExportFile: true,
  browserOpenHtmlFile: true,
  browserOpenExternally: true,
  browserAnswerDialog: true,
  browserClearData: true,
  browserClearPreviewData: true,
  browserShowStartPage: true,
  browserDefaultBrowserName: true,
  devServersDetect: true,
  devServersSave: true,
  devServersSetAutoVerify: true,
  devServersStart: true,
  devServersStop: true,
  devServersLogs: true,
});
