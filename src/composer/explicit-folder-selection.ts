import { useCallback, useSyncExternalStore } from "react";
import type { AppController } from "../app/AppContext";

type Selection = { accountId: string; draftSession: string };
const selections = new WeakMap<object, Selection>();
const listeners = new WeakMap<object, Set<() => void>>();

/** A native dialog/permission request can outlive navigation or sign-out. */
export function folderSelectionStillCurrent(app: AppController) {
  const live = app.currentController ? app.currentController.current : app;
  return Boolean(
    live &&
    live.accountId === app.accountId &&
    live.controllerScope === app.controllerScope &&
    live.draftSession === app.draftSession &&
    live.activeId === app.activeId &&
    live.cwd === app.cwd &&
    live.projectId === app.projectId &&
    live.mode === app.mode &&
    live.incognitoShown === app.incognitoShown &&
    !live.sending,
  );
}

/** Only an explicit, authorized choice marks a draft; remembered defaults do not.
 * O16 shared-23:7227–7246 checks foldersUserTouched separately from c3Pick.
 * Scope and draft identity also keep an old account/draft's choice out of a new one.
 */
export function markExplicitFolderSelection(app: AppController) {
  const scope = app.controllerScope;
  const live = app.currentController ? app.currentController.current : app;
  if (
    !scope ||
    !live ||
    live.accountId !== app.accountId ||
    live.controllerScope !== scope ||
    live.draftSession !== app.draftSession ||
    live.activeId ||
    live.incognitoShown ||
    live.sending
  )
    return;
  selections.set(scope, {
    accountId: app.accountId,
    draftSession: app.draftSession,
  });
  listeners.get(scope)?.forEach((listener) => listener());
}

export function explicitFolderSelected(app: AppController) {
  const selection = app.controllerScope && selections.get(app.controllerScope);
  return Boolean(
    selection &&
    selection.accountId === app.accountId &&
    selection.draftSession === app.draftSession,
  );
}

export function useExplicitFolderSelection(app: AppController) {
  const scope = app.controllerScope;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!scope) return () => {};
      let group = listeners.get(scope);
      if (!group) listeners.set(scope, (group = new Set()));
      group.add(listener);
      return () => {
        group.delete(listener);
      };
    },
    [scope],
  );
  return useSyncExternalStore(
    subscribe,
    () => explicitFolderSelected(app),
    () => false,
  );
}
