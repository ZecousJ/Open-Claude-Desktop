import { ScheduledTaskSetupReceipt } from "./ScheduledTaskSetupReceipt";
import { Suspense, useRef, type ComponentType } from "react";
import type { Conversation } from "../../shared/types";
import { useApp } from "./AppContext";
import { ArtifactsRoute } from "./ArtifactHost";
import { ComposerHost } from "./ComposerHost";
import { ConversationLayout } from "./ConversationLayout";
import { ConversationHeaderHost } from "./ConversationHeaderHost";
import { HomeHost } from "./HomeHost";
import { RightPanels } from "./RightPanels";
import {
  SessionRailSlot,
  useSessionRail,
} from "../session-rail/SessionRailHost";
import { SideChatHost } from "./SideChatHost";
import { HomeCornerActions } from "./ShellChrome";
import { TranscriptHost } from "./TranscriptHost";
import { PageBoundary } from "./PageBoundary";
import { usePageFade } from "../ui/page-fade";
import { useSplitPanes } from "../split-view/useSplitPanes";
import { lazyPiece } from "../ui/lazy-piece";
import { SpinOffSlot } from "../cowork/SpinOffSlot";
import { surface } from "../../shared/host";
// A Code session with its panes open is the tiled workspace on both hosts.
const NativeCodeLayout = lazyPiece(
  () => import("./CodeWorkspaceLayout"),
  "CodeWorkspaceLayout",
);
const DispatchRoute = lazyPiece(
  () => import("../dispatch/DispatchPage"),
  "DispatchPage",
);
const StandaloneArtifactRoute = lazyPiece(
  () => import("./StandaloneArtifactRoute"),
);

/**
 * The collection pages load when first opened, so the first screen (a new
 * chat) does not wait for them (the web app's first-load budget; the
 * desktop starts faster too).
 */
const collectionPages = () => import("./CollectionPages");
const CustomizeRoute = lazyPiece(collectionPages, "CustomizeRoute");
const ScheduledRoute = lazyPiece(collectionPages, "ScheduledRoute");
const ProjectsRoute = lazyPiece(collectionPages, "ProjectsRoute");
const HistoryRoute = lazyPiece(collectionPages, "HistoryRoute");
const SharedRoute = lazyPiece(collectionPages, "SharedRoute");
const ApiRoute = lazyPiece(collectionPages, "ApiRoute");
const StatusRoute = lazyPiece(collectionPages, "StatusRoute");

/** The other panes of the split view load the first time one is opened. */
const SplitPanes = lazyPiece(() => import("../split-view/SplitPanes"));

/** The page each sidebar destination shows in the workspace. */
const pages: Record<string, ComponentType> = {
  chat: ChatPage,
  customize: CustomizeRoute,
  scheduled: ScheduledRoute,
  projects: ProjectsRoute,
  artifacts: ArtifactsRoute,
  artifact: StandaloneArtifactRoute,
  history: HistoryRoute,
  api: ApiRoute,
  status: StatusRoute,
  dispatch: DispatchRoute,
  shared: SharedRoute,
  "not-found": NotFoundPage,
};

/** A separate conversation window's title bar (R2); the main title bar until one is registered. */
let conversationWindowHeader: ComponentType<{ active: Conversation }> =
  ConversationHeaderHost;

/**
 * Sets the title bar a separate conversation window shows (package R2-C's
 * ConversationWindowHeader, from its `*.slot.tsx` module).
 */
export function registerConversationWindowHeader(
  header: ComponentType<{ active: Conversation }>,
) {
  conversationWindowHeader = header;
}

/** The workspace beside the sidebar, showing the current page. */
export function AppPages() {
  const { page, active, artifactWidth, windowRole } = useApp();
  const workspace = useRef<HTMLElement>(null);
  usePageFade(
    workspace,
    page,
    active?.id ?? null,
    active?.createdAt,
    windowRole.kind !== "conversation",
  );
  // A separate window shows its one conversation and nothing else.
  const Page =
    windowRole.kind === "conversation"
      ? ConversationWindowPage
      : Object.hasOwn(pages, page)
        ? pages[page]
        : undefined;
  const split = useSplitPanes(workspace);
  return (
    <>
      <main
        ref={workspace}
        className="workspace"
        style={
          {
            "--file-viewer-width": `clamp(var(--file-viewer-least), ${artifactWidth}%, calc(100% - var(--file-viewer-inset)))`,
          } as React.CSSProperties
        }
        {...split.primary}
      >
        {Page && (
          <PageBoundary
            resetKey={`${page}\u0000${active?.id ?? ""}`}
            chat={page === "chat"}
            session={page === "chat" && active?.mode === "code"}
          >
            <Suspense fallback={null}>
              <Page />
            </Suspense>
          </PageBoundary>
        )}
        {windowRole.kind !== "conversation" && <SpinOffSlot />}
      </main>
      {/* Split view (desktop Code): the other panes share the window's grid. */}
      {split.primary && (
        <Suspense fallback={null}>
          <SplitPanes />
        </Suspense>
      )}
    </>
  );
}

/** A conversation, or a new chat's home, with the panels beside it. */
function ChatPage() {
  const app = useApp();
  const { active, mode } = app;
  const main = useRef<HTMLDivElement>(null);
  const rail = useSessionRail(active, main);
  const Layout =
    mode === "code" && active && !app.toolPanels.single
      ? NativeCodeLayout
      : ConversationLayout;
  return (
    <Layout
      header={
        active ? (
          <ConversationHeaderHost active={active} />
        ) : (
          <HomeCornerActions />
        )
      }
      main={
        <div
          ref={main}
          className={`chat-main ${active ? "has-conversation" : "empty-chat"} ${mode === "code" ? "code" : "chat"}-main${rail === "column" ? " with-session-rail" : ""}`}
        >
          {active ? (
            <>
              <TranscriptHost active={active} />
              <ScheduledTaskSetupReceipt />
              <ComposerHost />
              <SideChatHost active={active} />
              {rail && (
                <SessionRailSlot active={active} raised={rail === "raised"} />
              )}
            </>
          ) : (
            <HomeHost />
          )}
        </div>
      }
      panels={<RightPanels />}
    />
  );
}

/**
 * An address the web app does not know (page "not-found", set by its URL
 * routing). The desktop never shows it.
 */
function NotFoundPage() {
  const { newChat } = useApp();
  return (
    <div className="chat-main empty-chat not-found-page">
      <div className="panel-empty" role="status">
        <h1>Page not found</h1>
        <p>This page doesn't exist or is no longer available.</p>
        <button type="button" className="primary" onClick={() => newChat()}>
          New chat
        </button>
      </div>
    </div>
  );
}

/**
 * A separate conversation window (R2): its conversation with the panels
 * beside it, under the window's own title bar. Until the conversation
 * arrives nothing shows; when it is gone the window says so and closes.
 */
function ConversationWindowPage() {
  const { active, lockedUnavailable, mode } = useApp();
  const Header = conversationWindowHeader;
  if (!active)
    return lockedUnavailable ? (
      <div className="chat-main empty-chat">
        <div className="panel-empty" role="status">
          <p>This conversation isn't available.</p>
        </div>
      </div>
    ) : null;
  return (
    <ConversationLayout
      header={<Header active={active} />}
      main={
        <div
          className={`chat-main has-conversation ${mode === "code" ? "code" : "chat"}-main`}
        >
          <TranscriptHost active={active} />
          <ScheduledTaskSetupReceipt />
          <ComposerHost />
        </div>
      }
      panels={<RightPanels />}
    />
  );
}
