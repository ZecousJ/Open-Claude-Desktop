import type { ComposerField } from "../composer/composer-field";
import {
  createContext,
  useContext,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  Attachment,
  BackgroundTerminalInfo,
  Conversation,
  DesktopAPI,
  Mode,
  Project,
  Snapshot,
} from "../../shared/types";
import type { ClientPolicy } from "../../shared/client-policy";
import type { HostInfo } from "../../shared/host";
import type { Artifact } from "../ui/components";
import type { SidePanel } from "../conversation/ToolSidePanel";
import type { ArtifactPresentation } from "../artifacts/artifact-presentation";
import type { useNavigationHistory } from "./useNavigationHistory";
import type { useSidebarVisibility } from "../sidebar/useSidebarVisibility";
import type { useTranscriptScroll } from "../transcript/useTranscriptScroll";
import type { useComposerDraft } from "./useComposerDraft";
import type { useToolPanels } from "./useToolPanels";
import type { WindowRole } from "../conversation-window/window-role";

type Setter<T> = Dispatch<SetStateAction<T>>;
export type Settings = Snapshot["settings"];
export type ConversationPatch = Parameters<DesktopAPI["updateConversation"]>[1];
export type NewChatDraft = { draftSession: string; mode: Mode };

/** A question asked before an action that cannot be undone. */
export interface Confirmation {
  title: string;
  /** Already translated template containing a literal user-supplied name. */
  titleIsUserData?: boolean;
  body: string;
  action: () => Promise<void>;
  /** The confirming button's label; "Delete" by default. */
  confirm?: string;
  /** Red confirming button, as for deletions (the default). */
  danger?: boolean;
}

/**
 * What the window shares between its parts. App owns this state; the hosts in
 * src/app read it through useApp() so each area can change its own wiring
 * without editing App.tsx (see docs/ui-workpackages.md).
 */
export interface AppController {
  /**
   * The main window, or one conversation in its own window (R2): no sidebar,
   * other conversations and pages open in the main window.
   */
  windowRole: WindowRole;
  /** A separate window's conversation is gone; the window closes shortly. */
  lockedUnavailable: boolean;
  /**
   * The desktop app or the web app, and what it can do (shared/host.ts).
   * Components read it with useHost() (src/host), which also works outside
   * App; it is here for callbacks that only have the controller.
   */
  host?: HostInfo;

  // Signed-in account.
  accountId: string;
  accountEmail?: string;
  accountPlan?: string;
  remoteAccount: boolean;
  onSignOut?: () => Promise<void>;
  onSignOutEverywhere?: () => Promise<void>;
  policy: ClientPolicy;

  // Data from the main process.
  snapshot: Snapshot;
  setSnapshot: Setter<Snapshot | undefined>;
  /** The latest snapshot, for callbacks that outlive the render that made them. */
  latest: RefObject<Snapshot | undefined>;
  /** Live controller for async draft/account guards; cleared on unmount. */
  currentController?: RefObject<AppController | undefined>;
  controllerScope?: object;
  /** Conversations shown in lists, search and history (no incognito chat). */
  listed: Conversation[];
  /** Conversations with an approval waiting. */
  approvalIds: Set<string>;
  upsert: (conversation: Conversation) => void;
  patchConversation: (
    conversation: Conversation,
    patch: ConversationPatch,
  ) => Promise<void>;
  updatePreference: (patch: Partial<Settings>) => Promise<void>;

  // Errors and notices.
  error: string;
  setError: Setter<string>;
  report: (error: unknown) => void;
  /** Shows a corner notice (src/ui/toast-store.ts). */
  notify: (message: string) => void;
  /** Dismisses every notice. */
  dismissToast: () => void;

  // Where the window is.
  page: string;
  setPage: Setter<string>;
  mode: Mode;
  setMode: Setter<Mode>;
  activeId?: string;
  setActiveId: Setter<string | undefined>;
  active?: Conversation;
  /** The open conversation has a turn in progress. */
  running: boolean;
  /** An incognito Chat draft or chat is on screen. */
  incognitoShown: boolean;
  newChat: (
    mode?: Mode,
    projectId?: string,
    incognito?: boolean,
    afterStart?: (created?: NewChatDraft) => void,
  ) => void;
  /** The sidebar's Chat | Code switch: that area's last conversation, else a new one. */
  switchSurface?: (mode: Mode) => void;
  openConversation: (
    conversation: Conversation,
    options?: { artifactId?: string | null },
  ) => void;
  navigation: ReturnType<typeof useNavigationHistory>;
  sidebarView: ReturnType<typeof useSidebarVisibility>;
  sidebarWidthPreview?: number;
  setSidebarWidthPreview: Setter<number | undefined>;

  // The composer's draft and what it sends with.
  draftSession: string;
  /** The draft's store: subscribe with useDraftText(app.draft) to follow typing. */
  draft: import("../composer/draft-text").DraftTextStore;
  /** The draft now (read when a handler runs; does not re-render). */
  text: string;
  setText: Setter<string>;
  skillTokens?: import("../composer/skill-tokens").SkillToken[];
  setSkillTokens?: Setter<import("../composer/skill-tokens").SkillToken[]>;
  attachments: Attachment[];
  setAttachments: Setter<Attachment[]>;
  draftWebSearch: boolean;
  setDraftWebSearch: Setter<boolean>;
  /** The new conversation's composer options. */
  composerDraft: ReturnType<typeof useComposerDraft>;
  cwd?: string;
  setCwd: Setter<string | undefined>;
  projectId?: string;
  setProjectId: Setter<string | undefined>;
  project?: Project;
  providerId: string;
  setProviderId: Setter<string>;
  model: string;
  setModel: Setter<string>;
  effort?: Settings["codeEffort"];
  setEffort: Setter<Settings["codeEffort"] | undefined>;
  sending: boolean;
  setSending: Setter<boolean>;
  beginComposerSend?: () => import("../composer/useComposerSending").ComposerSendLease;
  composer: RefObject<ComposerField | null>;
  /** The transcript keeps following new output. */
  follow: RefObject<boolean>;
  /** The next conversation event from a send opens that conversation. */
  selectNext: RefObject<boolean>;

  // Conversation actions shared by several areas.
  confirmDelete: (conversation: Conversation) => void;
  /**
   * Opens the project editor, with a name when given; a conversation id
   * joins the saved project.
   */
  startProject: (assignTo?: string, name?: string) => void;
  moveToProject: (id: string | null) => Promise<void>;
  addConversationToProject: (id: string) => Promise<void>;

  // Transcript and side panels.
  scroll: RefObject<HTMLDivElement | null>;
  transcriptScroll: ReturnType<typeof useTranscriptScroll>;
  activeTerminals: BackgroundTerminalInfo[];
  panel: SidePanel | null;
  setPanel: Setter<SidePanel | null>;
  /** The tool panels' state. */
  toolPanels: ReturnType<typeof useToolPanels>;
  dismissPlan: (conversationId: string) => void;
  artifact?: Artifact;
  artifactRouteId?: string;
  setArtifactRouteId?: Setter<string | undefined>;
  setArtifact: Setter<Artifact | undefined>;
  artifactWidth: number;
  setArtifactWidth: Setter<number>;
  artifactPresentation: RefObject<ArtifactPresentation>;

  // Dialogs and overlays.
  settingsOpen: boolean;
  setSettingsOpen: Setter<boolean>;
  settingsTab: string;
  openSettingsTab: (tab: string) => void;
  search: string | null;
  setSearch: Setter<string | null>;
  searchEntrypoint: "default" | "search" | "actions";
  setSearchEntrypoint: Setter<"default" | "search" | "actions">;
  rename?: { id: string; title: string };
  setRename: Setter<{ id: string; title: string } | undefined>;
  shortcutsOpen: boolean;
  setShortcutsOpen: Setter<boolean>;
  confirm?: Confirmation;
  setConfirm: Setter<Confirmation | undefined>;
  projectEditor?: Project;
  setProjectEditor: Setter<Project | undefined>;
  projectAssignee?: string;
  setProjectAssignee: Setter<string | undefined>;
  releaseNotes: boolean;
  setReleaseNotes: Setter<boolean>;
  /** The current release notes have been opened. */
  notesSeen: boolean;
  openReleaseNotes: () => void;
  editSidebar: boolean;
  setEditSidebar: Setter<boolean>;
  connectionDismissed: boolean;
  setConnectionDismissed: Setter<boolean>;
}

export const AppContext = createContext<AppController | undefined>(undefined);

/** The window's shared state; only rendered inside App once the snapshot loaded. */
export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp is used outside App.");
  return app;
}
