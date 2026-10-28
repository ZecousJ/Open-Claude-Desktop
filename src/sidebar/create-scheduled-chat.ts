import type { AppController } from "../app/AppContext";
import { requestComposerSubmitWhenReady } from "../composer/submit-request";
import {
  rememberScheduledChatSetup,
  type ScheduledChatSetupIntent,
} from "../collections/routines/scheduled-chat-setup";

/** O16 shared-18 DP/X5: translated prompts remain drafts; the exact English
 * first-party prompt is delivered through the normal unified Chat submit. */
export const scheduledChatPrompt =
  "Help me set up a scheduled task. Ask me what it should do, how often it should run, and when, then create it.";

const requests = new WeakMap<object, object>();

export function createScheduledChat(
  app: AppController,
  prompt: string,
  context: Omit<ScheduledChatSetupIntent, "returnTo"> = {},
) {
  const account = app.accountId;
  const scope = app.controllerScope;
  const bridge = window.desktop;
  const owner = scope ?? app;
  const request = {};
  requests.set(owner, request);
  const origin = {
    page: app.page,
    draftSession: app.draftSession,
    activeId: app.activeId,
  };
  const controller = () =>
    app.currentController ? app.currentController.current : app;
  const sameOwner = () => {
    const now = controller();
    return Boolean(
      now &&
      requests.get(owner) === request &&
      now.accountId === account &&
      now.controllerScope === scope &&
      window.desktop === bridge,
    );
  };
  const start = () =>
    app.newChat("chat", context.projectId, false, (created) => {
      // An older independent host may not provide the new draft receipt. It
      // must not write into the conversation that preceded this request.
      if (!created || created.mode === "code" || !sameOwner()) return;
      rememberScheduledChatSetup(app, created.draftSession, {
        returnTo: "scheduled",
        ...context,
      });
      if (context.cwd) app.setCwd(context.cwd);
      app.setText(prompt);
      app.setSkillTokens?.([]);
      app.setAttachments([]);
      if (prompt !== scheduledChatPrompt) return;
      requestComposerSubmitWhenReady(
        `${created.draftSession}:${created.mode}`,
        owner,
        () => {
          const now = controller();
          return Boolean(
            sameOwner() &&
            now &&
            now.page === "chat" &&
            !now.activeId &&
            !now.active &&
            now.draftSession === created.draftSession &&
            now.mode === created.mode &&
            !now.incognitoShown &&
            now.text === prompt &&
            !now.attachments.length &&
            !now.skillTokens?.length &&
            !now.sending &&
            !now.running,
          );
        },
      );
    });
  // The scheduler advertises its tool-backed Chat setup capability. Unknown
  // capability/error is not success and never opens a misleading setup Chat.
  return Promise.resolve()
    .then(() => bridge.routineCapabilities())
    .then((value) => {
      if (!sameOwner()) return false;
      const now = controller();
      if (
        !now ||
        now.page !== origin.page ||
        now.draftSession !== origin.draftSession ||
        now.activeId !== origin.activeId
      )
        return false;
      if (!value.setupWithChat) return false;
      start();
      return true;
    })
    .catch((error) => {
      if (sameOwner()) app.report(error);
      return false;
    });
}
