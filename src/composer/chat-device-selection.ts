import type { AppController } from "../app/AppContext";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";

type Election = {
  accountId: string;
  draftId: string;
  accountScope: string;
  organizationId: null;
  deviceId: string;
  bridge: Window["desktop"];
};
// One current draft intention per controller. The owning account/controller
// becomes collectable on unmount; histories and permanent maps are not kept.
const drafts = new WeakMap<object, Election>();
const owner = (app: AppController) =>
  app.controllerScope ?? app.currentController ?? app;
export function draftChatDevice(app: AppController) {
  const value = drafts.get(owner(app));
  return !app.activeId &&
    value?.accountId === app.accountId &&
    value.draftId === app.draftSession &&
    value.bridge === window.desktop
    ? value
    : undefined;
}
export function electDraftChatDevice(
  app: AppController,
  directory: ChatDeviceDirectory,
  deviceId: string | null,
) {
  if (app.activeId || app.mode === "code" || app.incognitoShown)
    throw new Error("This draft cannot select a Chat device.");
  if (deviceId === null) {
    drafts.delete(owner(app));
    return;
  }
  drafts.set(owner(app), {
    accountId: app.accountId,
    draftId: app.draftSession,
    accountScope: directory.accountScope,
    organizationId: null,
    deviceId,
    bridge: window.desktop,
  });
}
export function clearDraftChatDevice(app: AppController) {
  const value = drafts.get(owner(app));
  if (value?.accountId === app.accountId && value.draftId === app.draftSession)
    drafts.delete(owner(app));
}

/** The caller invokes this while the original send scope is still current.
 * Returning a target is not confirmation; only the backend may bind it. */
export function chatDeviceSendTarget(app: AppController) {
  if (app.mode === "code" || app.incognitoShown) return undefined;
  const binding = app.active?.chatDeviceBinding;
  if (binding)
    return {
      version: 1 as const,
      accountScope: binding.accountScope,
      organizationId: null,
      deviceId: binding.deviceId,
      expectedBindingRevision: binding.revision,
    };
  const draft = draftChatDevice(app);
  return draft
    ? {
        version: 1 as const,
        accountScope: draft.accountScope,
        organizationId: null,
        deviceId: draft.deviceId,
      }
    : undefined;
}
