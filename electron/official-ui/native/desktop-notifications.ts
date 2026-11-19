import { z } from "zod";
import type { DesktopIntegration } from "../../app/desktop-integration";
import {
  notificationAuthorizationStatus,
  openNotificationSettings,
  requestNotificationAuthorization,
} from "../../notification-authorization";
import { desktopNotificationInput } from "../../../shared/desktop-notifications-input";
import type { NativeHost } from "./host";

type NotificationIntegration = Pick<
  DesktopIntegration,
  | "showNotification"
  | "supportsNotificationActions"
  | "setProjectPromptsWaiting"
>;

const notification = desktopNotificationInput.safeExtend({
  tag: z.string().min(1).max(256).optional(),
  navigateTo: z.string().optional(),
  notificationType: z.string().optional(),
  attribution: z
    .object({
      sessionId: z.string().max(128).optional(),
      sessionGroupingId: z.string().max(128).optional(),
    })
    .optional(),
});
const notificationWithActions = notification.safeExtend({
  tag: notification.shape.tag.unwrap(),
  token: notification.shape.token.unwrap(),
  actions: notification.shape.actions.unwrap(),
});
const promptCount = z.number().min(0).max(999);

export function registerDesktopNotifications(
  host: NativeHost,
  integration: NotificationIntegration,
) {
  const caller = () => {
    if (!host.caller) throw Error("This account window has retired.");
    return host.caller;
  };
  const show = ({
    navigateTo,
    notificationType,
    attribution,
    ...input
  }: z.output<typeof notification>) => {
    const window = caller();
    const current =
      host.ctx.isCurrent ?? (() => host.currentWindows().includes(window));
    const origin = new URL(window.webContents.mainFrame.url).origin;
    const target = navigateTo?.startsWith("/")
      ? URL.parse(navigateTo, origin)
      : null;
    if (
      navigateTo &&
      (target?.origin !== origin || target.pathname.startsWith("//"))
    )
      throw Error("Invalid notification destination.");
    const kind =
      notificationType === "remote_requires_action"
        ? "permission"
        : notificationType === "remote_turn_complete" ||
            notificationType === "remote_idle"
          ? "idle"
          : undefined;
    const groupId = attribution?.sessionGroupingId
      ? `group-${attribution.sessionGroupingId}`
      : attribution?.sessionId
        ? `session-${attribution.sessionId}`
        : undefined;
    integration.showNotification(
      input,
      ({ type: _type, ...press }) =>
        host.emitTo(
          window,
          "DesktopNotifications",
          "notificationAction",
          press,
        ),
      {
        current,
        activate: () => {
          if (target)
            host.emitTo(
              window,
              "Navigation",
              "navigate",
              target.pathname + target.search + target.hash,
            );
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        },
        kind,
        groupId,
        silent: notificationType === "remote_turn_complete",
      },
    );
  };

  host.on(
    "DesktopNotifications.getAuthorizationStatus",
    notificationAuthorizationStatus,
  );
  host.on(
    "DesktopNotifications.requestAuthorization",
    requestNotificationAuthorization,
  );
  host.on(
    "DesktopNotifications.openNotificationSettings",
    openNotificationSettings,
  );
  host.on("DesktopNotifications.supportsNotificationActions", () =>
    integration.supportsNotificationActions(),
  );
  host.on(
    "DesktopNotifications.showNotification",
    (
      title: unknown,
      body: unknown,
      tag: unknown,
      navigateTo: unknown,
      notificationType: unknown,
      attribution: unknown,
    ) =>
      show(
        notification.parse({
          title,
          body,
          tag,
          navigateTo,
          notificationType,
          attribution,
        }),
      ),
  );
  host.on(
    "DesktopNotifications.showNotificationWithActions",
    (input: unknown) => show(notificationWithActions.parse(input)),
  );
  host.on("DesktopNotifications.setProjectPromptsWaiting", (value: unknown) =>
    integration.setProjectPromptsWaiting(
      caller().webContents,
      promptCount.parse(value),
    ),
  );
}
