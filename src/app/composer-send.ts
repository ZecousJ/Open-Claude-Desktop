import {
  scheduledChatSetupFor,
  clearScheduledChatSetup,
} from "../collections/routines/scheduled-chat-setup";
import type { BlankArtifactSendLease } from "../artifacts/blank-artifact-flush";
import { startFailureCategory, startFailureMessage } from "./start-failure";
import { preference } from "../../shared/settings-extras";
import { showsThinking } from "../../shared/transcript-view";
import { transcriptViewFor } from "../transcript-view/transcript-view-store";
import { withLinearIssue } from "../../shared/linear-api";
import {
  clearReviewComments,
  reviewComments,
  withReviewComments,
} from "../changes/review-comments";
import { surface } from "../../shared/host";
import { validSkillTokens } from "../composer/skill-tokens";
import { beginComposerSending, composerSendScope } from "./composer-send-scope";
import { codePermissionModeOf } from "../../shared/code-session-permissions";
import { draftBranchFor } from "../composer/draft-branch";
import { api } from "../desktop-api";
import type { Attachment } from "../../shared/types";
import type { AppController } from "./AppContext";
import {
  isFolderPermissionError,
  requestFolderAccess,
} from "../cowork/useFolderAccess";
import { isWorkspaceTrustError } from "../../shared/workspace-trust-api";
import {
  ensureWorkspaceTrusted,
  trustTarget,
} from "../workspace-trust/trust-request";
import {
  getDraftResearch,
  setDraftResearch,
} from "../research/useResearchDraft";
import { currentCodeEnvironment } from "../ssh/codeEnvironment";
import { remoteEnvironment } from "../remote-control/environment";
import { sshState } from "../ssh/useSshHosts";
import { codeCloud } from "../composer/code-cloud";
import { currentCloudEnvironmentId } from "../composer/cloud-environments";
import {
  currentCodeRepositories,
  currentCodeRepository,
} from "../composer/code-repository";
import { sendWhileRunning } from "./composer-send-running";
import { settleComposer } from "./composer-send-running";
import { touchScreen } from "./composer-send-running";

/** The model to send with; without one, a Sub2API account asks the service again. */
async function sendableModel(app: AppController, current = () => true) {
  const { model, providerId } = app;
  if (model) return { providerId, model };
  const next = app.remoteAccount
    ? await api.refreshModels().catch((e: unknown) => {
        if (current()) app.report(e);
        return undefined;
      })
    : null;
  // The service could not be asked; the error is already shown.
  if (next === undefined || !current()) return undefined;
  const provider = next?.settings.providers.find(
    (p) => p.id === next.settings.activeProviderId,
  );
  if (next && provider?.model) {
    app.setSnapshot((s) =>
      s ? { ...s, settings: next.settings, modelUnavailable: undefined } : s,
    );
    app.setProviderId(provider.id);
    app.setModel(provider.model);
    return { providerId: provider.id, model: provider.model };
  }
  app.notify(
    next?.reason ??
      app.snapshot.modelUnavailable ??
      "Model service unavailable. Contact the server operator.",
  );
  return undefined;
}

/** Sends a fixed message (the failure notice's Continue), leaving the draft as it is. */
export async function sendText(
  app: AppController,
  text: string,
  attachments: Attachment[] = [],
) {
  await submitTurn(app, text, attachments, false);
}

export async function sendDraft(
  app: AppController,
  options: { later?: boolean } = {},
) {
  // A Code session's diff comments go with the message.
  const notes =
    app.active?.mode === "code" && !app.running
      ? reviewComments(app.active.id)
      : [];
  if (
    !app.text.trim() &&
    !app.attachments.length &&
    !notes.length &&
    !(app.mode === "code" && !app.active && app.composerDraft?.draftLinearIssue)
  )
    return;
  if (touchScreen()) app.composer.current?.blur();
  if (app.running && app.active)
    return sendWhileRunning(app, app.active, options.later);
  const id = app.active?.id;
  await submitTurn(
    app,
    app.text,
    app.attachments,
    true,
    false,
    notes.length && id
      ? {
          text: withReviewComments(app.text, notes),
          onSent: () => clearReviewComments(id),
        }
      : undefined,
  );
}

/**
 * Bash mode (Code): runs the line as a shell command in the open session
 * instead of sending it to the model (`thread/shellCommand`). Resolves
 * false when it could not start, so the composer can keep the line.
 */
export async function runShell(app: AppController, command: string) {
  const { active } = app;
  if (!active || app.sending || app.running) return false;
  const scope = composerSendScope(app);
  const busy = beginComposerSending(app);
  app.setError("");
  app.follow.current = true;
  try {
    const updated = await api.runShellCommand(active.id, command);
    if (scope.controllerCurrent()) app.upsert(updated);
    return scope.current() && busy.owns();
  } catch (e) {
    if (scope.foreground()) app.report(e);
    return false;
  } finally {
    const owned = busy.owns();
    busy.finish();
    if (owned && scope.foreground()) settleComposer(app);
  }
}

/** After a reply stopped at the output limit, asks it to go on. */
export function continueResponse(app: AppController) {
  return submitTurn(app, "Continue", [], false);
}

/** Voice mode: what was said becomes the next message, sent at once. */
export function sendSpoken(app: AppController, text: string) {
  return submitTurn(app, text, [], false);
}

/**
 * Starts a turn in the open conversation, or a new conversation from the
 * draft. A draft sent from the composer is restored when sending fails.
 */
async function submitTurn(
  app: AppController,
  prompt: string,
  files: Attachment[],
  fromComposer: boolean,
  askedForFolder = false,
  /** What is sent when it differs from the draft (review comments added). */
  sent?: { text: string; onSent: () => void },
) {
  const { active, activeId } = app;
  const scope = composerSendScope(app);
  const blankBridge = active?.blankArtifact ? window.desktop : undefined;
  const skillTokens = fromComposer
    ? validSkillTokens(prompt, app.skillTokens)
    : [];
  if (app.sending || app.running) return;
  if (
    !activeId &&
    app.mode === "code" &&
    currentCodeEnvironment().kind === "ssh"
  ) {
    const state = sshState();
    if (!state.loaded) {
      app.notify("SSH hosts are still loading. Try again in a moment.");
      return;
    }
    const environment = currentCodeEnvironment();
    if (
      environment.kind === "ssh" &&
      !state.hosts.some((host) => host.id === environment.hostId)
    ) {
      app.notify("Choose a host first.");
      return;
    }
  }
  const remote =
    !activeId && app.mode === "code" ? remoteEnvironment() : undefined;
  if (remote) {
    const busy = beginComposerSending(app);
    try {
      const folders = (await api.dispatchCall(
        remote.id,
        "listDirectories",
        [],
      )) as import("../../shared/remote-devices").DeviceDirectory[];
      if (!scope.current() || !busy.owns()) return;
      const cwd =
        remote.folder ??
        folders.find((folder) => folder.default)?.path ??
        folders[0]?.path;
      if (!cwd) {
        app.openSettingsTab("general");
        return;
      }
      const result = (await api.dispatchCall(remote.id, "newSession", [
        { cwd, text: prompt, attachmentIds: files.map((file) => file.id) },
      ])) as { conversationId: string };
      if (!scope.foreground() || !busy.owns()) return;
      const url = new URL(window.location.href);
      url.searchParams.set("device", remote.id);
      url.searchParams.set("task", result.conversationId);
      window.history.replaceState(null, "", url);
      if (fromComposer) {
        app.setText("");
        app.setAttachments([]);
      }
      sent?.onSent();
      app.setPage("dispatch");
    } catch (error) {
      if (scope.foreground()) app.report(error);
    } finally {
      busy.finish();
    }
    return;
  }
  let folderRefused: string | undefined;
  let trustRefused: ReturnType<typeof trustTarget>;
  let settledId: string | undefined;
  const busy = beginComposerSending(app);
  let target: Awaited<ReturnType<typeof sendableModel>>;
  let blankLease: BlankArtifactSendLease | undefined;
  try {
    if (active?.blankArtifact) {
      const { prepareBlankArtifactSend } =
        await import("../artifacts/blank-artifact-flush");
      blankLease = await prepareBlankArtifactSend(app);
      if (!blankLease.saved || !scope.foreground() || !busy.owns()) {
        blankLease.release();
        busy.finish();
        return;
      }
    }
    target = await sendableModel(
      app,
      () => scope.current() && (!blankLease || blankLease.current()),
    );
  } catch (error) {
    const current = !blankLease || blankLease.current();
    blankLease?.release();
    busy.finish();
    if (current && scope.foreground()) app.report(error);
    return;
  }
  if (
    !target ||
    !scope.current() ||
    !busy.owns() ||
    (blankLease && !blankLease.current())
  ) {
    blankLease?.release();
    busy.finish();
    return;
  }
  app.setError("");
  app.selectNext.current = !activeId;
  // The new-chat draft becomes the chat it starts in the history.
  if (!activeId) app.navigation.replaceNext();
  if (fromComposer) {
    app.setText("");
    app.setSkillTokens?.([]);
    app.setAttachments([]);
  }
  app.follow.current = true;
  // A new Chat starts in Research mode when its draft's switch is on (R4);
  // Research searches the web, so web search is sent on with it.
  const research =
    !activeId &&
    app.mode === "chat" &&
    !app.incognitoShown &&
    app.policy.webSearch &&
    getDraftResearch();
  const scheduledTaskSetup =
    !activeId && app.mode !== "code" ? scheduledChatSetupFor(app) : undefined;
  const artifactOutputKind =
    !activeId && app.mode === "code"
      ? app.composerDraft?.draftArtifactOutput
      : undefined;
  let codePermissionMode:
    | import("../../shared/code-session-permissions").CodePermissionMode
    | undefined;
  try {
    if (
      app.mode === "code" &&
      app.snapshot.host?.capabilities?.codeSessionPermissions === true
    ) {
      const { waitForCodePermissions } =
        await import("./code-permission-state");
      await waitForCodePermissions(app, activeId);
    }
    const live = app.currentController ? app.currentController.current : app;
    if (
      !live ||
      !scope.current() ||
      !busy.owns() ||
      (blankLease && !blankLease.current())
    ) {
      if (fromComposer)
        scope.restoreDeparted({
          text: prompt,
          attachments: files,
          skillTokens,
        });
      return;
    }
    if (
      !activeId &&
      app.mode === "code" &&
      live.snapshot.host?.capabilities?.codeSessionPermissions === true
    ) {
      const chosen = live.composerDraft.getDraftCodePermissionMode
        ? live.composerDraft.getDraftCodePermissionMode()
        : live.composerDraft.draftCodePermissionMode;
      codePermissionMode =
        chosen ?? codePermissionModeOf(live.snapshot.settings);
    }
    const c = await (
      await import("./chat-device-send")
    ).sendWithChatDevice(app, {
      conversationId: activeId,
      ...(blankLease?.expected
        ? { blankArtifactRevision: blankLease.expected }
        : {}),
      artifactOutputKind,
      scheduledTaskSetup,
      codePermissionMode,
      thinkingMode:
        app.mode === "cowork"
          ? (active?.thinkingMode ??
            preference(app.snapshot.settings, "coworkThinkingMode"))
          : undefined,
      thinkingSummariesWanted:
        app.mode === "code"
          ? showsThinking(
              transcriptViewFor(
                activeId ?? "",
                preference(app.snapshot.settings, "defaultTranscriptView"),
              ),
            )
          : undefined,
      effort:
        app.mode !== "code" && app.effort === "ultra" ? "max" : app.effort,
      text: withLinearIssue(
        sent?.text ?? prompt,
        !activeId && app.mode === "code"
          ? app.composerDraft?.draftLinearIssue
          : undefined,
      ),
      mode: app.mode,
      // A cloud Chat runs with the mode this computer's picker shows; a
      // local one reads it from settings, and the web's picker is the
      // account's setting already.
      taskPermission:
        (active ? active.mode : app.mode) !== "code" &&
        app.snapshot?.host?.kind !== "web" &&
        app.snapshot?.settings
          ? preference(app.snapshot.settings, "taskPermission")
          : undefined,
      // Turned off by the administrator: sent without it (the main process agrees).
      // Web search belongs to Chat and Cowork: a Code send never carries it,
      // even when the draft switch is on by default.
      webSearch:
        app.policy.webSearch &&
        (active ? active.mode : app.mode) !== "code" &&
        (active ? Boolean(active.webSearch) : app.draftWebSearch || research),
      research: !activeId ? research : undefined,
      connectorToolOverrides: !activeId
        ? app.composerDraft?.draftConnectorTools
        : undefined,
      connectorOverrides: !activeId
        ? app.composerDraft?.draftConnectors
        : undefined,
      toolSearchMode: !activeId
        ? app.composerDraft?.draftToolSearchMode
        : undefined,
      projectId: app.projectId,
      cwd: app.cwd,
      additionalFolders:
        !activeId &&
        app.mode === "code" &&
        surface !== "web" &&
        !codeCloud() &&
        currentCodeEnvironment().kind === "local"
          ? app.composerDraft?.draftAdditionalFolders.filter(
              (folder) => folder !== app.cwd,
            )
          : undefined,
      // A new Code session starts where the Local ▾ menu points (R9); a
      // conversation keeps its environment, so later sends leave it out.
      environment:
        !activeId && app.mode === "code" ? currentCodeEnvironment() : undefined,
      // A new web Code session clones the repository chosen on the Code home.
      repository:
        !activeId && app.mode === "code" ? currentCodeRepository() : undefined,
      cloudEnvironmentId:
        !activeId && app.mode === "code"
          ? currentCloudEnvironmentId()
          : undefined,
      // With several, all of them, the main one first (cloned inside it).
      repositories:
        !activeId && app.mode === "code" && currentCodeRepositories().length > 1
          ? currentCodeRepositories()
          : undefined,
      attachments: files,
      ...target,
      incognito: !activeId && app.incognitoShown ? true : undefined,
      // The folder chip's Worktree switch: a new local session on this
      // computer starts in its own worktree (electron/code-worktree.ts).
      worktree:
        surface !== "web" &&
        !activeId &&
        app.mode === "code" &&
        currentCodeEnvironment()?.kind !== "ssh" &&
        preference(app.snapshot.settings, "codeWorktree")
          ? true
          : undefined,
      // …from the branch picked in the folder menu.
      worktreeBranch:
        surface !== "web" && !activeId && app.mode === "code"
          ? draftBranchFor(app.cwd)
          : undefined,
      // Pull requests settings: a cloud session opens one after a push.
      autoPullRequest:
        app.mode === "code" && preference(app.snapshot.settings, "prAutoCreate")
          ? preference(app.snapshot.settings, "prAutoCreateDraft")
            ? "draft"
            : "ready"
          : undefined,
    });
    if (scheduledTaskSetup) clearScheduledChatSetup(app, scheduledTaskSetup);
    settledId = c.id;
    if (!scope.controllerCurrent() || (blankLease && !blankLease.current()))
      return;
    app.upsert(c);
    if (!scope.foreground(c.id) || !busy.owns()) return;
    if (!activeId && app.mode === "code") {
      app.composerDraft?.setDraftLinearIssue(undefined);
      if (artifactOutputKind)
        app.composerDraft?.setDraftArtifactOutput((current) =>
          current === artifactOutputKind ? undefined : current,
        );
      if (codePermissionMode)
        app.composerDraft?.setDraftCodePermissionMode((current) =>
          current === codePermissionMode ? undefined : current,
        );
      app.composerDraft?.setDraftAdditionalFolders([]);
    }
    sent?.onSent();
    app.setActiveId(c.id);
    app.setPage("chat");
    // The switch belongs to the draft; the next new Chat starts without it.
    if (research) setDraftResearch(false);
  } catch (e) {
    if (blankLease && !blankLease.current()) {
      if (window.desktop === blankBridge && scope.controllerCurrent()) {
        if (fromComposer && scope.current() && scope.empty()) {
          app.setText(prompt);
          app.setSkillTokens?.(skillTokens);
          app.setAttachments(files);
        } else if (fromComposer)
          scope.restoreDeparted({
            text: prompt,
            attachments: files,
            skillTokens,
          });
      }
      return;
    }
    if (!scope.current() || !busy.owns()) {
      if (fromComposer)
        scope.restoreDeparted({
          text: prompt,
          attachments: files,
          skillTokens,
        });
      return;
    }
    app.selectNext.current = false;
    if (fromComposer && scope.empty()) {
      app.setText(prompt);
      app.setSkillTokens?.(skillTokens);
      app.setAttachments(files);
    }
    // Cowork's folder was never allowed (R11): ask, then send again below.
    const folder = active ? active.cwd : (app.cwd ?? app.project?.cwd);
    if (
      !askedForFolder &&
      (active?.mode ?? app.mode) === "cowork" &&
      folder &&
      isFolderPermissionError(e)
    )
      folderRefused = folder;
    else {
      // Code's folder isn't trusted yet (here or on its SSH host): "Trust
      // this workspace?", then again.
      const workspace =
        !askedForFolder && isWorkspaceTrustError(e)
          ? trustTarget({
              cwd: folder,
              environment: active
                ? active.environment
                : app.mode === "code"
                  ? currentCodeEnvironment()
                  : undefined,
            })
          : undefined;
      // A new cloud session that could not start for the connection or a
      // server error: the original's sentence with what to do next.
      const startFailure =
        !activeId && app.mode === "code" && (surface === "web" || codeCloud())
          ? startFailureCategory(e)
          : undefined;
      if (workspace) trustRefused = workspace;
      else if (startFailure)
        app.report(new Error(startFailureMessage(startFailure)));
      else app.report(e);
    }
  } finally {
    blankLease?.release();
    const owned = busy.owns();
    busy.finish();
    if (owned && scope.foreground(settledId)) settleComposer(app);
  }
  if (scope.current() && folderRefused)
    await askAndResend(app, folderRefused, prompt, files, fromComposer);
  if (scope.current() && trustRefused)
    await trustAndResend(app, trustRefused, prompt, files, fromComposer);
}

/**
 * Asks to trust the Code folder a send was refused for and sends the same
 * message again once it is trusted (once). Cancel leaves the draft in the
 * composer.
 */
async function trustAndResend(
  app: AppController,
  workspace: NonNullable<ReturnType<typeof trustTarget>>,
  prompt: string,
  files: Attachment[],
  fromComposer: boolean,
) {
  if (
    !(await ensureWorkspaceTrusted(workspace.folder, {
      api,
      notify: app.notify,
      ...(workspace.place ? { place: workspace.place } : {}),
    }))
  )
    return;
  await submitTurn(app, prompt, files, fromComposer, true);
}

/**
 * Asks for the Cowork folder a send was refused for, and sends the same
 * message again once it is allowed (once). Cancel leaves the draft in the
 * composer, as a failed send does.
 */
async function askAndResend(
  app: AppController,
  folder: string,
  prompt: string,
  files: Attachment[],
  fromComposer: boolean,
) {
  const conversationId = app.active?.id;
  let result;
  try {
    result = await requestFolderAccess(folder, {
      notify: app.notify,
      ...(conversationId ? { conversationId } : {}),
    });
  } catch (e) {
    app.report(e);
    return;
  }
  if (result !== "granted") return;
  // The dialog is modal: the draft and target are still the ones refused.
  await submitTurn(app, prompt, files, fromComposer, true);
}
