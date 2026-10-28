import type { AppController } from "../../app/AppContext";
import type { ScheduledTaskSetupIntent } from "../../../shared/scheduled-task-setup";

/** Kept with the exact new Chat draft until its first send is accepted. */
export type ScheduledChatSetupIntent = ScheduledTaskSetupIntent;

type Pending = {
  draftSession: string;
  accountId: string;
  bridge: Window["desktop"];
  intent: ScheduledChatSetupIntent;
};
const pending = new WeakMap<object, Pending>();
const owner = (app: AppController) => app.controllerScope ?? app;

export function rememberScheduledChatSetup(
  app: AppController,
  draftSession: string,
  intent: ScheduledChatSetupIntent,
) {
  pending.set(owner(app), {
    draftSession,
    accountId: app.accountId,
    bridge: window.desktop,
    intent,
  });
}

/** Read before send; retries keep the intent, another draft/account cannot use it. */
export function scheduledChatSetupFor(
  app: AppController,
): ScheduledChatSetupIntent | undefined {
  const value = pending.get(owner(app));
  return value &&
    value.draftSession === app.draftSession &&
    value.accountId === app.accountId &&
    value.bridge === window.desktop &&
    app.mode !== "code" &&
    !app.activeId &&
    !app.active &&
    !app.incognitoShown
    ? value.intent
    : undefined;
}

/** Call only after the send carrying this exact intent succeeded. */
export function clearScheduledChatSetup(
  app: AppController,
  intent?: ScheduledChatSetupIntent,
) {
  if (!intent || pending.get(owner(app))?.intent === intent)
    pending.delete(owner(app));
}
