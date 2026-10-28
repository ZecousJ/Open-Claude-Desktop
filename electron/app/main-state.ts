import { desktopConnectorLink } from "../../shared/connector-links";
import { parseDeepLink } from "../../shared/deep-links";
import { parseEmailLink } from "../../shared/email-link";
import type { RemoteAccounts } from "../sub2api/identity";
import { quickWindowFor } from "./quick-window-main";
import { BrowserWindow } from "electron";
import { Store } from "../store/store";
import { Engine } from "../engine/engine";
import { Scheduler } from "../routines/scheduler";
import { TerminalController } from "../terminal/terminal-controller";
import { ArtifactShares } from "../artifacts/artifact-shares";
import { ArtifactLibrary } from "../artifacts/artifact-library";
import { BackgroundHistory } from "../conversations/background-history";
import { Accounts } from "../account/accounts";
import { ProviderCredentials } from "../engine/provider-credentials";
import { ReplyFeedback } from "../conversations/reply-feedback";
import { type OperatorConfig } from "../../server/operator-config";
import { McpConfigFile } from "../connectors/mcp-config-file";
import type { Settings, PublicAccount } from "../../shared/types";
import { type PolicyHost, type RemoteHost } from "../remote/host";

/** The state main.ts keeps while the app runs. */
export const mainState = {
  window: undefined as BrowserWindow | undefined,
  /**
   * Startup has created the main window. Until then nothing else may make one:
   * a window opened while the account is still being restored found no IPC
   * handlers and showed the boot error page beside the real window.
   */
  started: false,
  store: undefined as unknown as Store,
  engine: undefined as unknown as Engine,
  pendingConnectorLink: process.argv.map(desktopConnectorLink).find(Boolean) as
    string | undefined,
  /** A claudex:// link that started the app (Windows, Linux), opened once the window loads. */
  pendingDeepLink: process.argv.find((arg) => parseDeepLink(arg)) as
    string | undefined,
  pendingEmailLink: process.argv.find((arg) => parseEmailLink(arg)) as
    string | undefined,
  artifactShares: undefined as unknown as ArtifactShares,
  artifactLibrary: undefined as unknown as ArtifactLibrary,
  backgroundHistory: undefined as unknown as BackgroundHistory,
  replyFeedback: undefined as unknown as ReplyFeedback,
  scheduler: undefined as Scheduler | undefined,
  terminals: undefined as TerminalController | undefined,
  accounts: undefined as unknown as Accounts,
  /** Claudex account sign-in (there are no local accounts); set at start. */
  remoteAccounts: undefined as RemoteAccounts | undefined,
  /** The signed-in Sub2API account's session, plan, key and quota (remote/host.ts). */
  remote: undefined as RemoteHost | undefined,
  activeAccount: undefined as PublicAccount | undefined,
  activeSessionToken: undefined as string | undefined,
  quitting: false as boolean,
  /** The weekly usage (percent) of the last "weekly-usage" event, for the tray menu. */
  trayUsagePercent: undefined as number | undefined,
  trayUsageUnavailable: false as boolean,
  /** Page zoom of every app window (View ▸ Zoom In / Out / Actual Size). */
  zoomLevel: 0 as number,
  /** The small sign-in window is showing: its bounds are not remembered. */
  signInShape: false as boolean,
  /** The window's bounds before it shrank to the sign-in window. */
  boundsBeforeSignIn: undefined as Electron.Rectangle | undefined,
  shuttingDown: false as boolean,
  shutdownComplete: false as boolean,
  credentials: undefined as unknown as ProviderCredentials,
  operatorConfig: undefined as OperatorConfig | undefined,
  /** The Quick Entry composer, created the first time its shortcut is pressed. */
  quickEntry: undefined as ReturnType<typeof quickWindowFor> | undefined,
  /** Developer → Edit config: the MCP servers as a file in the account's folder. */
  mcpConfig: undefined as McpConfigFile | undefined,
  /** The administrator's Claudex policy for the signed-in account (docs/self-hosting.md). */
  policyHost: undefined as PolicyHost | undefined,
  // Settings → Claude Code → Archive inactive sessions, for the active account.
  stopAutoArchive: undefined as (() => void) | undefined,
  /** The settings last sent to the window: what its next save is compared with. */
  rendererBase: undefined as Settings | undefined,
  /** Saves servers from the MCP configuration file; the runtime restarts once it is idle. */
  restartTimer: undefined as NodeJS.Timeout | undefined,
  inspectLabel: "Inspect Element" as string,
  editTranslate: ((value: string) => value) as (value: string) => string,
};
