export type NotificationAuthorization =
  "notDetermined" | "denied" | "authorized" | "provisional" | "ephemeral";

export interface DesktopNotificationInput {
  title: string;
  body: string;
  tag?: string;
  conversationId?: string;
  token?: string;
  actions?: { id: string; title: string }[];
}

export interface NotificationActionEvent {
  type: "notification-action";
  tag: string;
  token: string;
  actionId: string;
  sinceShownMs: number;
}

export interface NotificationAuthorizationAPI {
  getNotificationAuthorizationStatus(): Promise<NotificationAuthorization>;
  requestNotificationAuthorization(): Promise<"granted" | "denied" | "error">;
  openNotificationSettings(): Promise<void>;
  supportsNotificationActions(): Promise<boolean>;
  showDesktopNotification(input: DesktopNotificationInput): Promise<void>;
  setProjectPromptsWaiting(count: number): Promise<void>;
}

export async function enableDesktopNotifications(
  api: Pick<
    NotificationAuthorizationAPI,
    | "getNotificationAuthorizationStatus"
    | "requestNotificationAuthorization"
    | "openNotificationSettings"
  >,
) {
  const status = await api.getNotificationAuthorizationStatus();
  if (status === "notDetermined")
    return (await api.requestNotificationAuthorization()) === "granted";
  if (["authorized", "provisional", "ephemeral"].includes(status)) return true;
  await api.openNotificationSettings();
  return false;
}
