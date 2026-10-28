import type { AppController } from "./AppContext";
import {
  draftPlace,
  readDraft,
  writeDraft,
  type Draft,
} from "../composer/draft-store";
import type { ComposerSendLease } from "../composer/useComposerSending";

export function composerSendScope(app: AppController) {
  const accountId = app.accountId,
    controller = app.controllerScope,
    activeId = app.activeId,
    session = app.draftSession,
    mode = app.mode,
    incognito = app.incognitoShown,
    page = app.page;
  const place = draftPlace({
    conversationId: activeId,
    mode,
    incognito: app.active ? app.active.incognito : incognito,
  });
  const live = () =>
    app.currentController ? app.currentController.current : app;
  const controllerCurrent = () => {
    const current = live();
    return Boolean(
      current &&
      current.accountId === accountId &&
      current.controllerScope === controller,
    );
  };
  const current = (createdId?: string) => {
    const now = live();
    return Boolean(
      controllerCurrent() &&
      (now?.activeId === activeId ||
        (!activeId && createdId && now?.activeId === createdId)) &&
      (activeId || now?.draftSession === session) &&
      now?.mode === mode &&
      now?.incognitoShown === incognito,
    );
  };
  return {
    controllerCurrent,
    current,
    foreground: (createdId?: string) =>
      current(createdId) && live()?.page === page,
    empty: () =>
      !app.currentController || (!live()?.text && !live()?.attachments.length),
    /** Restore a departed conversation's draft in its own place. A newer
     * draft occupying the same home slot is never overwritten. */
    restoreDeparted(draft: Draft) {
      const now = live();
      if (!controllerCurrent() || !now) return;
      const shown = draftPlace({
        conversationId: now.activeId,
        mode: now.mode,
        incognito: now.active ? now.active.incognito : now.incognitoShown,
      });
      const saved = readDraft(accountId, place);
      if (place.key !== shown.key && !saved?.text && !saved?.attachments.length)
        writeDraft(accountId, place, draft);
    },
  };
}
export function beginComposerSending(app: AppController): ComposerSendLease {
  if (app.beginComposerSend) return app.beginComposerSend();
  app.setSending(true);
  // Compatibility for independent callers that do not use the main App
  // hook. Guard its global setter before a later place owns the composer.
  const scope = composerSendScope(app);
  return {
    owns: scope.current,
    finish() {
      if (scope.current()) app.setSending(false);
    },
  };
}
