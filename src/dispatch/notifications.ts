import type { DeviceAppEvent } from "../../shared/remote-devices";
import { t } from "../i18n";

export function showDispatchNotification(
  deviceId: string,
  event: Extract<DeviceAppEvent, { type: "dispatch-notification" }>,
  {
    path = "/dispatch",
    current = () => true,
  }: {
    path?: string;
    current?: () => boolean;
  } = {},
) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    const notice = new Notification(event.title, {
      body: t(event.body),
      tag: event.tag,
    });
    notice.onclick = () => {
      if (current()) {
        window.focus();
        window.location.assign(
          `${path}?device=${encodeURIComponent(deviceId)}&task=${encodeURIComponent(event.conversationId)}`,
        );
      }
      notice.close();
    };
    return notice;
  } catch {}
}
