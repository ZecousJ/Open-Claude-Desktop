import {
  codePermissionModeOf,
  type CodePermissionPatch,
} from "../../shared/code-session-permissions";
import type { AppController } from "./AppContext";
import type { Conversation, Snapshot } from "../../shared/types";
import type { CodePermissionMode } from "../../shared/code-session-permissions";
import { api } from "../desktop-api";

/** Permission acks never replace unrelated transcript/archive changes or newer choices. */
export function mergeCodePermissionResponse(
  snapshot: Snapshot | undefined,
  updated: Conversation,
): Snapshot | undefined {
  if (!snapshot) return snapshot;
  const current = snapshot.conversations.find((item) => item.id === updated.id);
  if (
    !current ||
    (current.codePermissionRevision ?? 0) >
      (updated.codePermissionRevision ?? 0)
  )
    return snapshot;
  const turns = current.turns.map((turn) => {
    const recorded = updated.turns.find(
      (item) => item.id === turn.id,
    )?.codePermissionMode;
    return turn.codePermissionMode === undefined && recorded !== undefined
      ? { ...turn, codePermissionMode: recorded }
      : turn;
  });
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((item) =>
      item === current
        ? {
            ...current,
            codePermissionMode: updated.codePermissionMode,
            codePermissionRevision: updated.codePermissionRevision,
            turns,
          }
        : item,
    ),
  };
}

export function applyCodePermissionResponse(
  app: AppController,
  updated: Conversation,
) {
  const live = () =>
    app.currentController ? app.currentController.current : app;
  const valid = () =>
    live()?.accountId === app.accountId &&
    live()?.controllerScope === app.controllerScope;
  if (!valid()) return;
  live()!.setSnapshot((snapshot) =>
    valid() ? mergeCodePermissionResponse(snapshot, updated) : snapshot,
  );
}

const pendingByScope = new WeakMap<object, Map<string, Promise<boolean>>>();

/** The Code footer edits its session/draft; account defaults live in Settings. */
export function setSessionCodePermission(
  app: AppController,
  patch: CodePermissionPatch,
  target = app.active,
  persist: (
    target: Conversation,
    mode: CodePermissionMode,
  ) => Promise<Conversation> = (target, mode) =>
    api.updateConversation(target.id, { codePermissionMode: mode }),
): Promise<boolean> {
  if (app.sending) return Promise.resolve(false);
  const owner = app.accountId;
  const scope = app.controllerScope;
  const draft = app.draftSession;
  const namespace = scope ?? app.currentController ?? app;
  const pending =
    pendingByScope.get(namespace) ?? new Map<string, Promise<boolean>>();
  pendingByScope.set(namespace, pending);
  const key = JSON.stringify([owner, target?.id ?? draft]);
  const live = () =>
    app.currentController ? app.currentController.current : app;
  const valid = () =>
    live()?.accountId === owner &&
    live()?.controllerScope === scope &&
    live()?.snapshot.host?.capabilities?.codeSessionPermissions === true &&
    (target !== undefined || live()?.draftSession === draft);
  const next = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!valid()) return false;
      if (target && target.mode !== "code")
        throw Error("Only Code sessions have a Code permission choice.");
      const before = live()!.snapshot.settings.bypassFolders ?? [];
      if (
        patch.bypassFolders &&
        (before.length !== patch.bypassFolders.length ||
          before.some((value, i) => value !== patch.bypassFolders![i]))
      )
        await live()!.updatePreference({ bypassFolders: patch.bypassFolders });
      if (!valid()) return false;
      const mode = codePermissionModeOf(patch);
      if (target) {
        const updated = await persist(target, mode);
        if (!valid()) return false;
        if (
          updated.codePermissionMode !== mode ||
          !Number.isSafeInteger(updated.codePermissionRevision)
        )
          throw Error("Session permissions could not be saved.");
        applyCodePermissionResponse(app, updated);
      } else live()!.composerDraft.setDraftCodePermissionMode(mode);
      return true;
    });
  pending.set(key, next);
  return next.finally(() => {
    if (pending.get(key) === next) pending.delete(key);
  });
}

export function waitForCodePermissions(
  app: AppController,
  targetId = app.activeId,
) {
  const namespace = app.controllerScope ?? app.currentController ?? app;
  const key = JSON.stringify([app.accountId, targetId ?? app.draftSession]);
  return pendingByScope.get(namespace)?.get(key) ?? Promise.resolve();
}
