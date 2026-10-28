import type { CoreDesktopAPI } from "../../shared/types";
import type { AppController } from "./AppContext";
import { api } from "../desktop-api";
import {
  chatDeviceSendTarget,
  clearDraftChatDevice,
} from "../composer/chat-device-selection";
import { preference } from "../../shared/settings-extras";

/** This is a separate API: an old server must refuse it, never strip the
 * election from an ordinary send and run the message elsewhere. */
export async function sendWithChatDevice(
  app: AppController,
  input: Parameters<CoreDesktopAPI["send"]>[0],
) {
  const current = app.currentController?.current;
  if (
    app.currentController &&
    (!current ||
      current.accountId !== app.accountId ||
      current.controllerScope !== app.controllerScope ||
      current.activeId !== app.activeId ||
      (!app.activeId && current.draftSession !== app.draftSession))
  )
    throw new Error("The signed-in account or draft changed. Try again.");
  const target = chatDeviceSendTarget(app);
  if (!target) return api.send(input);
  if (
    input.mode === "code" ||
    input.incognito ||
    input.blankArtifactRevision ||
    input.scheduledTaskSetup ||
    app.active?.blankArtifact ||
    input.projectId ||
    (!app.active && input.cwd)
  )
    throw new Error(
      "This conversation's complete context cannot be moved to another device yet. Its current device was kept.",
    );
  const permission = preference(app.snapshot.settings, "taskPermission");
  if (permission !== "default" && permission !== "auto")
    throw new Error(
      "This computer doesn't support the selected permission mode.",
    );
  const conversation = await api.sendOnChatDevice({
    ...target,
    version: 1,
    organizationId: null,
    requestId: crypto.randomUUID(),
    conversationId: input.conversationId,
    mode: input.mode,
    text: input.text,
    providerId: input.providerId,
    model: input.model,
    taskPermission: permission,
    attachments: input.attachments,
    options: {
      effort: input.effort,
      webSearch: input.webSearch,
      research: input.research,
      thinkingMode: input.thinkingMode,
      connectorOverrides: input.connectorOverrides,
      connectorToolOverrides: input.connectorToolOverrides,
    },
  });
  if (!input.conversationId) clearDraftChatDevice(app);
  return conversation;
}
