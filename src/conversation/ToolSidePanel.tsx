import { Suspense } from "react";
import type { BrowserPanelEnv } from "../browser/BrowserPanel";
import "../cowork/progress-panel.css";
import type {
  AgentTranscript,
  BackgroundTerminalInfo,
  Conversation,
} from "../../shared/types";
import type { FinishedBackgroundTerminal } from "../../shared/panels-api";
import type { Artifact } from "../ui/ArtifactTypes";
import { useHost } from "../host/HostContext";
import { lazyPiece } from "../ui/lazy-piece";
import { filesPaneAvailable } from "../files/files-model";

// Each panel loads the first time it opens: Activity with unified Chat or a
// Cowork task, Terminal, Changes and the Browser with Code, the background
// list when asked for (the web app's first load).
const ActivityPanel = lazyPiece(
  () => import("../cowork/ActivityPanel"),
  "ActivityPanel",
);
const TerminalPanel = lazyPiece(
  () => import("../terminal/TerminalPanel"),
  "TerminalPanel",
);
const BackgroundTasksPanel = lazyPiece(
  () => import("./BackgroundTasksPanel"),
  "BackgroundTasksPanel",
);
const ChangesPanel = lazyPiece(
  () => import("../changes/ChangesPanel"),
  "ChangesPanel",
);
const BrowserPanel = lazyPiece(
  () => import("../browser/BrowserPanel"),
  "BrowserPanel",
);
const FilesPanel = lazyPiece(() => import("../files/FilesPanel"), "FilesPanel");
const RunsPanel = lazyPiece(() => import("../runs/RunsPanel"), "RunsPanel");
const SessionPanel = lazyPiece(
  () => import("../session/SessionPanel"),
  "SessionPanel",
);
const PullRequestPanel = lazyPiece(
  () => import("../pr/PullRequestPanel"),
  "PullRequestPanel",
);
const WidgetPanel = lazyPiece(
  () => import("../widgets/WidgetPanel"),
  "WidgetPanel",
);
const PlanPanel = lazyPiece(() => import("../plan/PlanPanel"), "PlanPanel");
const AgentTranscriptPanel = lazyPiece(
  () => import("../transcript/agents/AgentTranscriptPanel"),
  "AgentTranscriptPanel",
);
const SimulatorPanel = lazyPiece(
  () => import("../simulators/SimulatorPanel"),
  "SimulatorPanel",
);

export type SidePanel =
  | "terminal"
  | "changes"
  | "background"
  | "plan"
  /** One child Agent's transcript (`useToolPanels().agent`). */
  | "agent"
  /** Cowork's Progress card. */
  | "progress"
  /** Code's built-in browser (R8-D); it can also sit under Changes. */
  | "browser"
  /** Code's iOS Simulator and Android Emulator panes (desktop only). */
  | "ios-simulator"
  | "android-emulator"
  /** Code's Files pane: the session's folder beside its open files. */
  | "files"
  | "runs"
  | "session"
  | "pr"
  | "widget"
  | "artifact";

/** The child Agent an "agent" panel shows. */
export interface AgentPanelTarget {
  conversationId: string;
  agentId: string;
  title: string;
}

/**
 * The tool panel beside the conversation. Terminal, Changes and the
 * Browser belong to Code tasks and Progress to Cowork. Unified Chat
 * exposes Activity; a panel absent from this mode and host shows nothing.
 */
export function ToolSidePanel({
  panel,
  conversation,
  accountId,
  agent,
  onClose,
  onArtifact,
  onStopAgent,
  onStopRun,
  onRefreshWorkflow,
  onListTerminals,
  onStopTerminal,
  onStopCommand,
  onClearFinished,
  onReadAgent,
  onShowBackground,
  dismissedFinished,
  engineReady,
  onError,
  browser,
  onAttachSelection,
}: {
  panel: SidePanel;
  conversation: Conversation;
  accountId: string;
  agent?: AgentPanelTarget;
  onClose: () => void;
  onArtifact: (artifact: Artifact) => void;
  onStopAgent: (conversationId: string, agentIds: string[]) => Promise<void>;
  onStopRun?: (conversationId: string, runId: string) => Promise<void>;
  onRefreshWorkflow: () => Promise<void>;
  onListTerminals?: (conversationId: string) => Promise<{
    items: BackgroundTerminalInfo[];
    finished?: FinishedBackgroundTerminal[];
  }>;
  onStopTerminal: (
    conversationId: string,
    processId: string,
  ) => Promise<boolean>;
  onStopCommand: (conversationId: string) => Promise<void>;
  onClearFinished: (ids: string[]) => Promise<void>;
  onReadAgent: (
    conversationId: string,
    agentId: string,
  ) => Promise<AgentTranscript>;
  /** Back from an Agent's transcript to the task list. */
  onShowBackground: () => void;
  dismissedFinished: string[];
  engineReady: boolean;
  onError: (error: unknown) => void;
  /** The Browser panel's window state; without it no Browser shows. */
  browser?: BrowserPanelEnv;
  /** The Terminal's Attach selection as context: text and the terminal's name. */
  onAttachSelection?: (text: string, label: string) => void;
}) {
  const host = useHost();
  if (panel === "session" || panel === "pr" || panel === "widget") {
    const Panel =
      panel === "session"
        ? SessionPanel
        : panel === "pr"
          ? PullRequestPanel
          : WidgetPanel;
    return (
      <Suspense fallback={null}>
        <Panel conversation={conversation} onClose={onClose} />
      </Suspense>
    );
  }
  if (panel === "runs")
    return (
      <Suspense fallback={null}>
        <RunsPanel conversation={conversation} onClose={onClose} />
      </Suspense>
    );
  if (panel === "background")
    return (
      <Suspense fallback={null}>
        <BackgroundTasksPanel
          key={conversation.id}
          conversations={[conversation]}
          accountId={accountId}
          activeConversationId={conversation.id}
          engineReady={engineReady}
          onClose={onClose}
          onStop={onStopAgent}
          onStopRun={onStopRun}
          onRefresh={onRefreshWorkflow}
          onListTerminals={onListTerminals}
          onStopTerminal={onStopTerminal}
          onStopCommand={onStopCommand}
          onClearFinished={onClearFinished}
          onReadAgent={onReadAgent}
          dismissedFinished={dismissedFinished}
          onError={onError}
        />
      </Suspense>
    );
  if (panel === "agent" && agent?.conversationId === conversation.id)
    return (
      <Suspense fallback={null}>
        <AgentTranscriptPanel
          key={`${agent.conversationId}:${agent.agentId}`}
          {...agent}
          accountId={accountId}
          onRead={onReadAgent}
          onBack={onShowBackground}
          onClose={onClose}
          onError={onError}
        />
      </Suspense>
    );
  if (panel === "plan")
    return (
      <Suspense fallback={null}>
        <PlanPanel
          key={conversation.id}
          conversation={conversation}
          onClose={onClose}
        />
      </Suspense>
    );
  if (
    panel === "progress" &&
    (conversation.mode === "cowork" || conversation.mode === "chat")
  )
    return (
      <Suspense fallback={null}>
        <ActivityPanel
          key={conversation.id}
          conversation={conversation}
          onArtifact={onArtifact}
          onClose={onClose}
        />
      </Suspense>
    );
  if (panel === "changes" && conversation.mode === "code")
    return (
      <Suspense fallback={null}>
        <ChangesPanel
          key={conversation.id}
          conversation={conversation}
          onClose={onClose}
          onError={onError}
        />
      </Suspense>
    );
  if (
    panel === "browser" &&
    (conversation.mode === "code" || conversation.mode === "cowork") &&
    browser
  )
    return (
      <Suspense fallback={null}>
        <BrowserPanel
          key={conversation.id}
          conversation={conversation}
          env={browser}
          onClose={onClose}
          onError={onError}
        />
      </Suspense>
    );
  if (
    (panel === "ios-simulator" || panel === "android-emulator") &&
    conversation.mode === "code" &&
    host.kind === "desktop"
  )
    return (
      <Suspense fallback={null}>
        <SimulatorPanel
          key={`${conversation.id}:${panel}`}
          kind={panel === "ios-simulator" ? "ios" : "android"}
          conversation={conversation}
          onClose={onClose}
          onError={onError}
        />
      </Suspense>
    );
  if (panel === "files" && filesPaneAvailable(conversation))
    return (
      <Suspense fallback={null}>
        <FilesPanel
          key={`${accountId}:${conversation.id}`}
          conversation={conversation}
          bridge={window.desktop}
          accountId={accountId}
          onClose={onClose}
        />
      </Suspense>
    );
  if (
    panel === "terminal" &&
    conversation.mode === "code" &&
    host.capabilities.localTerminal
  )
    return (
      <Suspense fallback={null}>
        <TerminalPanel
          key={conversation.id}
          conversationId={conversation.id}
          accountId={accountId}
          onAttachSelection={onAttachSelection}
          onClose={onClose}
        />
      </Suspense>
    );
  return null;
}
