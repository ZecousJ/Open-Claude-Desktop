import { api } from "../desktop-api";
import { exportConversation } from "../conversation/conversation-export";
import {
  cloudSessionUrl,
  openSessionInDesktopApp,
} from "../conversation/cloud-session-links";
import { editSessionCloudEnvironment } from "../composer/cloud-environments";
import { SessionEnvironmentEditor } from "../conversation/SessionEnvironmentEditor";
import { onShareRequest, takeShareRequest } from "../sharing/share-request";
import { workflowsIn } from "../../shared/workflow-model";
import { Suspense, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { useConversationSharingStatus } from "../sharing/useConversationSharingStatus";
import { ConversationHeader } from "../conversation/ConversationHeader";
import { useApp } from "./AppContext";
import { useHost } from "../host/HostContext";
import { openInWindow } from "./AppSidebar";
import { fileManagerName } from "../sidebar/ConversationRow";
import "../conversation/conversation-share.css";
import { forkConversation } from "./fork";
import { outputStyleNames } from "../../shared/output-styles";
import { lazyPiece } from "../ui/lazy-piece";
import { useTranscriptViewActions } from "../transcript-view/useTranscriptViewActions";
import { useInstalledEditors } from "../editors/useInstalledEditors";
import { menuEditors } from "../../shared/editors";
import { openInSplitView } from "../split-view/open-in-split";
import { sessionPullRequest } from "../../shared/pull-request";
import { openPullRequest } from "../pr/open-pull-request";
import { useOpenLink } from "../ui/ExternalLinks";
import { formatText } from "../i18n";
import { Folder } from "../ui/glyphs";
import { markedUnreadByHand } from "../conversation/unread";
import {
  keepGroupWhileEmpty,
  setConversationGroups,
  useConversationGroups,
} from "../sidebar/grouping";
import { moveToGroupEntries } from "../sidebar/move-to-group-entries";
import {
  askedClaude,
  canContinueInCloud,
  onContinueInCloudRequest,
  onResumeArmed,
  takeResume,
} from "./continue-resume";

// Kept here for the callers that read it from the header.
export { canContinueInCloud };

/** A menu may copy only an existing, unexpired service link. */
function usableTitleShareUrl(
  share: HostedShare | null | undefined,
  invited: boolean,
) {
  if (
    share?.status !== "active" ||
    (share.expiresAt !== undefined && share.expiresAt <= Date.now())
  )
    return undefined;
  const value =
    invited && share.access === "invited"
      ? (share.inviteUrl ?? share.url)
      : share.url;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Uses the same read/copy bridge as Code; never creates a share or a URL. */
export function conversationTitleCopyLink(
  id: string,
  known: HostedShare | null | undefined,
  options: {
    invited?: boolean;
    isCurrent?: () => boolean;
    onCopied: () => void;
    onError: (error: unknown) => void;
  },
) {
  if (!usableTitleShareUrl(known, Boolean(options.invited))) return undefined;
  return async () => {
    const current = options.isCurrent ?? (() => true);
    if (!current()) return;
    try {
      const fresh = await api.conversationShare(id);
      if (!current()) return;
      const url = usableTitleShareUrl(fresh, Boolean(options.invited));
      if (!url) return;
      await api.copyText(url);
      if (current()) options.onCopied();
    } catch (error) {
      if (current()) options.onError(error);
    }
  };
}

// The share dialog opens on demand: off the first load.
const ConversationShareDialog = lazyPiece(
  () => import("../conversation/ConversationShareDialog"),
  "ConversationShareDialog",
);
// Continue in ▸ Cloud's dialog, likewise.
const ContinueInCloudDialog = lazyPiece(
  () => import("./ContinueInCloudDialog"),
  "ContinueInCloudDialog",
);
const NewOutputStyleDialog = lazyPiece(
  () => import("../output-style/NewOutputStyleDialog"),
);
// New group… in the title menu's Move to group, likewise.
const GroupNameDialog = lazyPiece(
  () => import("../sidebar/GroupNameDialog"),
  "GroupNameDialog",
);

/**
 * Whether the service offers hosted sharing for the conversation (R1-U1):
 * a Claudex account whose administrator turned sharing on, and a
 * conversation that is not incognito. The link itself is read too, so a
 * blocked account can still stop an existing one.
 */
function useSharing(conversation: Conversation) {
  return useConversationSharingStatus(conversation);
}

/**
 * The open conversation's title bar: title menu, panel toggles and export.
 * A pane beside the primary pane in split view passes `splitPane` for its
 * Close pane button (and has no panel toggles).
 */
export function ConversationHeaderHost({
  active,
  splitPane,
}: {
  active: Conversation;
  splitPane?: { onClose: () => void };
}) {
  const app = useApp();
  const { panel, patchConversation, confirmDelete, report } = app;
  const sharing = useSharing(active);
  const transcriptView = useTranscriptViewActions(active);
  const host = useHost();
  const latestCopyOwner = useRef({
    accountId: app.accountId,
    id: active.id,
    scope: app.controllerScope,
  });
  latestCopyOwner.current = {
    accountId: app.accountId,
    id: active.id,
    scope: app.controllerScope,
  };
  const copyMounted = useRef(true);
  useEffect(() => {
    copyMounted.current = true;
    return () => {
      copyMounted.current = false;
    };
  }, []);
  const { capabilities } = host;
  const platform = app.snapshot.platform;
  const openLink = useOpenLink();
  const code = active.mode === "code" && !active.incognito;
  // Open in ▸ editors: a Code session's folder, here or on its SSH host.
  const editors = menuEditors(
    useInstalledEditors(code && capabilities.localFolders),
    active.environment?.kind === "ssh",
  );
  const pullRequest = code ? sessionPullRequest(active) : undefined;
  // The status the dialog opened with: it stays open while a blocked
  // account stops its last link (which hides the button).
  const [dialog, setDialog] = useState<{
    id: string;
    owner: string;
    controller: object | undefined;
    status: SharingStatus;
  } | null>(null);
  const openShare = () => {
    if (
      dialog &&
      dialog.id === active.id &&
      dialog.owner === app.accountId &&
      dialog.controller === app.controllerScope
    ) {
      setDialog(null);
      return;
    }
    const codeManagement =
      code &&
      !sharing.pending &&
      !active.slim &&
      sharing.status &&
      (sharing.status.conversations || sharing.share);
    if (!sharing.status || (!codeManagement && !sharing.canOpen())) return;
    setDialog({
      id: active.id,
      owner: app.accountId,
      controller: app.controllerScope,
      status: sharing.status,
    });
  };
  // Continue in cloud's dialog; `resume` when it comes back after this
  // session was asked to push the work.
  const [continuing, setContinuing] = useState<
    false | { resume?: { includeUntracked: boolean } }
  >(false);
  const [newStyle, setNewStyle] = useState(false);
  // The title menu's Move to group, as the sidebar row's (RowMenu.tsx).
  const groups = useConversationGroups();
  const groupId = groups.members[active.id];
  const [naming, setNaming] = useState(false);
  useEffect(() => {
    setDialog(null);
    setContinuing(false);
    setNewStyle(false);
    setNaming(false);
  }, [active.id]);
  const moveToGroup = (target: string | null) => {
    if (active.pinned && target !== null)
      void patchConversation(active, { pinned: false });
    void window.desktop
      .moveConversationToGroup(active.id, target)
      .then((next) => {
        if (groupId && groupId !== target) keepGroupWhileEmpty(groupId);
        setConversationGroups(next);
      })
      .catch(report);
  };
  useEffect(() => {
    if (!sharing.pending && sharing.status === null) setDialog(null);
  }, [sharing.pending, sharing.status]);
  const [armed, setArmed] = useState(0);
  useEffect(() => onResumeArmed(() => setArmed((n) => n + 1)), []);
  useEffect(() => {
    const resume = takeResume(active);
    if (resume) setContinuing({ resume });
  }, [active, armed]);
  // Other ways in (the sleep band's Continue in cloud).
  const offersCloud = canContinueInCloud(active, capabilities.localCode);
  useEffect(
    () =>
      onContinueInCloudRequest((id) => {
        if (id === active.id && offersCloud) setContinuing({});
      }),
    [active.id, offersCloud],
  );
  // Share from a sidebar row: the dialog opens once sharing is known.
  const shareReady = Boolean(sharing.status && sharing.ready);
  useEffect(() => {
    const take = () => {
      if (shareReady && takeShareRequest(active.id)) openShare();
    };
    take();
    return onShareRequest(take);
  });
  return (
    <>
      <ConversationHeader
        key={active.id}
        conversation={active}
        mode={app.mode}
        projects={app.snapshot.projects}
        panel={panel}
        running={app.running}
        titleActions={{
          onPin: () =>
            void patchConversation(active, {
              pinned: !active.pinned,
            }),
          onToggleUnread: () => {
            if (active.unread) markedUnreadByHand.delete(active.id);
            else markedUnreadByHand.add(active.id);
            void patchConversation(active, { unread: !active.unread });
          },
          moveToGroup: {
            label: "Move to group",
            icon: <Folder size={20} strokeWidth={1.5} />,
            submenu: moveToGroupEntries({
              groups: groups.groups,
              groupId,
              moveTo: moveToGroup,
              newGroup: () => setNaming(true),
            }),
          },
          onRename: (title) => void patchConversation(active, { title }),
          onRenameDialog: () =>
            app.setRename({ id: active.id, title: active.title }),
          onMoveToProject: (id) => void app.moveToProject(id).catch(report),
          onCreateProject: (name) => app.startProject(active.id, name),
          onOpenProjects: () => app.setPage("projects"),
          onArchive: () =>
            void patchConversation(active, {
              archived: !active.archived,
            }),
          onDelete: () => confirmDelete(active),
          onExport: () => void exportConversation(active, report),
          onShare:
            !code && sharing.status && sharing.ready ? openShare : undefined,
          onOpenInWindow:
            capabilities.popOutWindows && !active.incognito
              ? () => void openInWindow(app, active).catch(report)
              : undefined,
          onRevealFolder:
            capabilities.localFolders && active.cwd
              ? () => void api.revealConversationFolder(active.id).catch(report)
              : undefined,
          fileManager: fileManagerName(platform),
          onFork:
            active.incognito || !active.turns.length
              ? undefined
              : () => void forkConversation(app),
          forkDisabledReason: active.incognito
            ? "Incognito sessions can't be forked"
            : !active.turns.length
              ? "A session with no messages yet has nothing to fork"
              : undefined,
          transcriptView:
            active.mode === "code" ? transcriptView.menu : undefined,
          outputStyle:
            active.mode === "code"
              ? outputStyleNames(active.customOutputStyles).map((name) => ({
                  name,
                  onSelect: () =>
                    void patchConversation(active, { outputStyle: name }),
                }))
              : undefined,
          onNewOutputStyle:
            active.mode === "code" ? () => setNewStyle(true) : undefined,
          // Split view is the desktop's (the web keeps one pane).
          onOpenInSplit:
            code && host.kind === "desktop" && !splitPane
              ? () => openInSplitView(app, active)
              : undefined,
          onOpenTerminal:
            code && capabilities.localTerminal && active.cwd
              ? () => app.setPanel("terminal")
              : undefined,
          editors:
            code && active.cwd
              ? editors.map((editor) => ({
                  name: editor.name,
                  onSelect: () =>
                    void api
                      .openConversationInEditor(active.id, editor.kind)
                      .then((opened) => {
                        if (!opened)
                          report(
                            new Error(
                              formatText("Couldn’t open this in {editor}.", {
                                editor: editor.name,
                              }),
                            ),
                          );
                      })
                      .catch(report),
                }))
              : undefined,
          onOpenPr: pullRequest
            ? () =>
                openPullRequest(
                  pullRequest.url,
                  app.snapshot.settings,
                  openLink,
                )
            : undefined,
          // Native Chat uses only an existing service link. A local chat
          // without one keeps this conditional entry absent, never an export or
          // an invented claude.ai/deep link. Web Chat keeps its popover. A web
          // Code session is a cloud one: its link is its own address, and it
          // opens in the desktop app and edits its cloud environment from here.
          ...(code && host.kind === "web"
            ? {
                onOpenInDesktop: () => openSessionInDesktopApp(active.id),
                onEditEnvironment: () =>
                  void editSessionCloudEnvironment(
                    active.cloudEnvironmentId,
                  ).catch(report),
              }
            : {}),
          onCopyLink:
            code && host.kind === "web" && !active.incognito
              ? () =>
                  void api
                    .copyText(cloudSessionUrl(active.id))
                    .then(() => app.notify("Link copied to clipboard."))
                    .catch(report)
              : !active.incognito && (code || host.kind === "desktop")
                ? conversationTitleCopyLink(active.id, sharing.share, {
                    invited: !code,
                    isCurrent: () => {
                      const latest = latestCopyOwner.current;
                      return (
                        copyMounted.current &&
                        latest.accountId === app.accountId &&
                        latest.id === active.id &&
                        latest.scope === app.controllerScope
                      );
                    },
                    onCopied: () => app.notify("Link copied to clipboard."),
                    onError: report,
                  })
                : undefined,
          ...(() => {
            if (!code) return {};
            const tasks = workflowsIn([active]);
            const finished = tasks
              .filter(
                (task) =>
                  task.status !== "running" &&
                  !app.snapshot.dismissedBackgroundTasks?.includes(task.id),
              )
              .map((task) => task.id);
            return {
              ...(tasks.length ||
              app.activeTerminals.some(
                (item) => item.conversationId === active.id,
              )
                ? {
                    onSeeBackgroundTasks: () => {
                      if (!app.toolPanels.isOpen("background"))
                        app.toolPanels.toggle("background");
                    },
                  }
                : {}),
              ...(finished.length
                ? {
                    onClearBackgroundTasks: () =>
                      void api
                        .clearFinishedBackgroundTasks(finished)
                        .then((dismissedBackgroundTasks) =>
                          app.setSnapshot((current) =>
                            current
                              ? { ...current, dismissedBackgroundTasks }
                              : current,
                          ),
                        )
                        .catch(report),
                  }
                : {}),
            };
          })(),
          // Keep computer awake, only for this session (a local Code session).
          keepAwake:
            code && capabilities.localCode && host.kind === "desktop"
              ? {
                  on: Boolean(active.keepAwake),
                  onToggle: () =>
                    void api
                      .updateConversation(active.id, {
                        keepAwake: !active.keepAwake,
                      })
                      .then((next) => app.upsert(next))
                      .catch(report),
                }
              : undefined,
          onContinueInCloud: canContinueInCloud(active, capabilities.localCode)
            ? () => setContinuing({})
            : undefined,
        }}
        platform={platform}
        splitPane={splitPane}
        onTogglePanel={(value) => {
          // Closing the task list keeps it closed for this conversation.
          if (
            (value === "plan" || value === "progress") &&
            app.toolPanels.isOpen(value)
          )
            app.dismissPlan(active.id);
          app.toolPanels.toggle(value);
          app.setArtifact(undefined);
        }}
        onRename={() =>
          app.setRename({
            id: active.id,
            title: active.title,
          })
        }
        onPin={() =>
          void patchConversation(active, {
            pinned: !active.pinned,
          })
        }
        onExport={() => void exportConversation(active, report)}
        onArchive={() =>
          void patchConversation(active, {
            archived: !active.archived,
          })
        }
        onDelete={() => confirmDelete(active)}
        share={
          (
            code
              ? sharing.status &&
                (sharing.status.conversations || sharing.share)
              : sharing.status || sharing.pending
          )
            ? {
                shared: sharing.share?.status === "active",
                audience:
                  sharing.share?.access === "invited" ? "invited" : "link",
                ready: sharing.ready,
                busy: sharing.pending,
                disabledReason: sharing.disabledReason,
                open: Boolean(dialog && dialog.id === active.id),
                onOpen: openShare,
              }
            : undefined
        }
      />
      {dialog &&
        dialog.id === active.id &&
        dialog.owner === app.accountId &&
        dialog.controller === app.controllerScope && (
          <Suspense fallback={null}>
            <ConversationShareDialog
              conversation={active}
              key={`${app.accountId}:${active.id}`}
              status={sharing.status ?? dialog.status}
              capabilityPending={sharing.pending || Boolean(active.slim)}
              onClose={() => setDialog(null)}
            />
          </Suspense>
        )}
      {continuing && (
        <Suspense fallback={null}>
          <ContinueInCloudDialog
            conversation={active}
            resume={continuing.resume}
            onClose={() => setContinuing(false)}
            onAskedToPush={() => {
              setContinuing(false);
              app.notify(askedClaude);
            }}
            onMoved={(created, unverified) => {
              setContinuing(false);
              app.upsert(created);
              app.openConversation(created);
              app.notify(
                unverified
                  ? "Session now in the cloud. The session on this computer stays until you archive it."
                  : "Session now in the cloud",
              );
            }}
          />
        </Suspense>
      )}
      {naming && (
        <Suspense fallback={null}>
          <GroupNameDialog
            title="New group"
            confirm="Create group"
            onSubmit={async (name) => {
              const left = groupId;
              const next = await window.desktop.createConversationGroup(
                name,
                active.id,
              );
              // The group it left stays in view, empty or not.
              if (left) keepGroupWhileEmpty(left);
              setConversationGroups(next);
              const added = next.groups.find(
                (group) => !groups.groups.some((old) => old.id === group.id),
              );
              if (added) keepGroupWhileEmpty(added.id);
            }}
            onError={report}
            onClose={() => setNaming(false)}
          />
        </Suspense>
      )}
      {newStyle && (
        <Suspense fallback={null}>
          <NewOutputStyleDialog
            onClose={() => setNewStyle(false)}
            onSave={(name, prompt) => {
              setNewStyle(false);
              void patchConversation(active, {
                outputStyle: name,
                customOutputStyles: {
                  ...(active.customOutputStyles ?? {}),
                  [name]: { name, prompt },
                },
              });
            }}
          />
        </Suspense>
      )}
      {code && host.kind === "web" && (
        <SessionEnvironmentEditor onError={report} />
      )}
    </>
  );
}
