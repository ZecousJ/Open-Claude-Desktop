import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type SetStateAction,
} from "react";
import { X } from "../ui/glyphs";
import { api } from "../desktop-api";
import type { Attachment, Conversation } from "../../shared/types";
import { IconButton } from "../ui/Controls";
import { useApp, AppContext, type AppController } from "../app/AppContext";
import { ComposerHost, useComposerAutosize } from "../app/ComposerHost";
import { ConversationHeaderHost } from "../app/ConversationHeaderHost";
import { ConversationLayout } from "../app/ConversationLayout";
import { HomeHost } from "../app/HomeHost";
import { TranscriptHost } from "../app/TranscriptHost";
import { ArtifactSelection } from "../artifacts/artifact-context";
import { ArtifactConversation } from "../artifacts/artifact-metadata";
import { useNativeBackgroundTerminals } from "../conversation/useBackgroundTaskPolling";
import { useTranscriptScroll } from "../transcript/useTranscriptScroll";
import { markedUnreadByHand } from "../conversation/unread";
import { draftPlace, usePlacedDraft } from "../composer/draft-store";
import { closePaneAsking } from "./discard-draft";
import { resetToDraft, retarget, setFocus } from "./split-actions";
import { paneFor, type PaneEntry } from "./split-layout";
import { primaryOnlyNotice } from "./split-notices";
import { splitState } from "./split-state";

const listActiveTerminals = async (id: string) =>
  (await api.listBackgroundTerminals(id)).items;
const ignoreTerminalError = () => {};

/**
 * One pane beside the primary pane: a Code session's title bar, transcript
 * and composer, or an empty new session. It reuses the hosts of the primary
 * pane (src/app) by giving them a controller of its own: the same window
 * state, with the open conversation, the draft in its composer, the
 * scrolling and the sending bound to this pane. The tool panels, the file
 * viewer and the side chat belong to the primary pane (as the original's
 * Side chat is "only available in the primary pane"), so asking for one
 * here says so.
 */
export function SecondaryPane({
  entry,
  focus,
  focused,
  style,
  captionClear,
}: {
  entry: PaneEntry;
  /** Its focus index (1 for the first pane). */
  focus: number;
  focused: boolean;
  style: CSSProperties;
  /** The pane is not under the window's caption buttons (Windows, Linux). */
  captionClear: boolean;
}) {
  const parent = useApp();
  const id = entry.ref.kind === "session" ? entry.ref.id : undefined;
  const conversation = id
    ? parent.snapshot.conversations.find((c) => c.id === id)
    : undefined;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string>();
  const [providerId, setProviderId] = useState(
    conversation?.providerId ?? parent.providerId,
  );
  const [model, setModel] = useState(conversation?.model ?? parent.model);
  const [cwd, setCwd] = useState(conversation?.cwd ?? parent.cwd);
  const [projectId, setProjectId] = useState(conversation?.projectId);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const selectNext = useRef(false);
  const running =
    conversation?.turns.some((t) => t.status === "inProgress") ?? false;
  const transcriptScroll = useTranscriptScroll(
    scroll,
    follow,
    conversation,
    "code",
  );
  useComposerAutosize(composer, text, "code", id);
  const { terminals } = useNativeBackgroundTerminals(
    conversation ? [conversation] : [],
    id,
    parent.snapshot.engine.state === "ready",
    listActiveTerminals,
    ignoreTerminalError,
  );

  // The pane opens another session (from inside it, or a draft's first
  // message started one): the composer starts again as App.openConversation does.
  const shown = useRef(id);
  useEffect(() => {
    if (shown.current === id) return;
    shown.current = id;
    setProviderId(conversation?.providerId ?? parent.providerId);
    setModel(conversation?.model ?? parent.model);
    setCwd(conversation?.cwd ?? parent.cwd);
    setProjectId(conversation?.projectId);
    follow.current = true;
  }, [id]);
  // The pane's composer keeps each session's unsent draft, and its own for
  // a new session (src/composer/draft-store.ts).
  usePlacedDraft({
    owner: parent.accountId,
    place: draftPlace({
      conversationId: id,
      mode: "code",
      incognito: conversation?.incognito,
      pane: entry.key,
    }),
    text,
    attachments,
    setText,
    setAttachments,
  });

  // Reading it here reads it, as in the primary pane.
  useEffect(() => {
    if (!conversation?.unread || markedUnreadByHand.has(conversation.id))
      return;
    if (document.visibilityState === "hidden") return;
    void api
      .updateConversation(conversation.id, { unread: false })
      .then(parent.upsert)
      .catch(parent.report);
  }, [conversation?.id, conversation?.unread]);

  /** Shows another session here, or moves the focus to the pane that has it. */
  const open = (next: string) => {
    if (next === id) return;
    if (next === parent.activeId) return setFocus(0);
    const elsewhere = paneFor(splitState().panes, {
      kind: "session",
      id: next,
    });
    if (elsewhere !== -1) return setFocus(elsewhere + 1);
    // A session just created is not in the window's list until its render.
    if (parent.snapshot.conversations.some((c) => c.id === next))
      retarget(entry.key, next);
    else setPending(next);
  };
  useEffect(() => {
    if (
      !pending ||
      !parent.snapshot.conversations.some((c) => c.id === pending)
    )
      return;
    setPending(undefined);
    retarget(entry.key, pending);
  }, [pending, parent.snapshot.conversations]);
  const toPrimary = () => parent.notify(primaryOnlyNotice);
  const app: AppController = {
    ...parent,
    mode: "code",
    setMode: () => {},
    incognitoShown: false,
    activeId: id,
    active: conversation,
    running,
    setActiveId: (value: SetStateAction<string | undefined>) => {
      const next = typeof value === "function" ? value(id) : value;
      if (next === undefined) resetToDraft(entry.key);
      else open(next);
    },
    newChat: () => void closePaneAsking(entry.key, parent.accountId),
    openConversation: (c: Conversation) => open(c.id),
    // A draft's first message does not take over the window's history.
    navigation: { ...parent.navigation, replaceNext: () => {} },
    draftSession: entry.key,
    text,
    setText,
    attachments,
    setAttachments,
    cwd,
    setCwd,
    projectId,
    setProjectId,
    project: parent.snapshot.projects.find((p) => p.id === projectId),
    providerId,
    setProviderId,
    model,
    setModel,
    sending,
    setSending,
    composer,
    follow,
    selectNext,
    scroll,
    transcriptScroll,
    activeTerminals: terminals,
    moveToProject: async (target) => {
      if (target) return app.addConversationToProject(target);
      if (conversation)
        parent.upsert(
          await api.updateConversation(conversation.id, { projectId: null }),
        );
      setProjectId(undefined);
    },
    addConversationToProject: async (target) => {
      const selected = parent.snapshot.projects.find((p) => p.id === target);
      if (!selected) throw Error("Project no longer exists.");
      if (conversation)
        parent.upsert(
          await api.updateConversation(conversation.id, { projectId: target }),
        );
      setProjectId(target);
      if (selected.cwd) setCwd(selected.cwd);
    },
    // The tool panels and the file viewer are the primary pane's.
    panel: null,
    setPanel: (value) => {
      if ((typeof value === "function" ? value(null) : value) !== null)
        toPrimary();
    },
    toolPanels: {
      ...parent.toolPanels,
      single: null,
      dock: [],
      agent: undefined,
      isOpen: () => false,
      close: () => {},
      toggle: toPrimary,
      setPanel: (value) => {
        if ((typeof value === "function" ? value(null) : value) !== null)
          toPrimary();
      },
      setAgent: toPrimary,
    },
    dismissPlan: () => {},
    artifact: undefined,
    setArtifactWidth: () => {},
    setArtifact: (value) => {
      if (
        (typeof value === "function" ? value(undefined) : value) !== undefined
      )
        toPrimary();
    },
  };
  const close = () => void closePaneAsking(entry.key, parent.accountId);
  return (
    <section
      className="split-pane"
      role="region"
      aria-label="Secondary pane"
      aria-current={focused ? "true" : undefined}
      data-pane-index={focus}
      data-row={entry.pos.row}
      data-focused={focused ? "" : undefined}
      data-caption-clear={captionClear ? "" : undefined}
      style={style}
      onPointerDownCapture={() => setFocus(focus)}
      onFocusCapture={() => setFocus(focus)}
    >
      <AppContext.Provider value={app}>
        <ArtifactConversation.Provider value={id}>
          <ArtifactSelection.Provider value={undefined}>
            {conversation ? (
              <ConversationLayout
                header={
                  <ConversationHeaderHost
                    active={conversation}
                    splitPane={{ onClose: close }}
                  />
                }
                main={
                  <div className="chat-main has-conversation code-main">
                    <TranscriptHost active={conversation} />
                    <ComposerHost />
                  </div>
                }
                panels={null}
              />
            ) : !id ? (
              <ConversationLayout
                header={<DraftHeader onClose={close} />}
                main={
                  <div className="chat-main empty-chat code-main">
                    <HomeHost />
                  </div>
                }
                panels={null}
              />
            ) : null}
          </ArtifactSelection.Provider>
        </ArtifactConversation.Provider>
      </AppContext.Provider>
    </section>
  );
}

/** The title bar of an empty pane: nothing but Close pane. */
function DraftHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="chat-header">
      <div />
      <div className="header-actions">
        <IconButton label="Close pane" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
    </header>
  );
}
