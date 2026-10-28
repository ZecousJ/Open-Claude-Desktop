import { codePermissionNotificationAllowed } from "../../shared/code-notifications";
import { approvalKind } from "../../shared/approval-response";
import {
  preference,
  type SettingsPreferences,
} from "../../shared/settings-extras";
import type { Approval, Conversation, Schedule } from "../../shared/types";
import { clip, finishedNotice } from "../../shared/notice-text";
import { t } from "../i18n";
import { routineCompletionNotices } from "../../shared/routine-notices";
import type { Routine } from "../../shared/routines";

/*
 * Response completions on the web: the browser's own notifications. On
 * claude.ai the switch asks the browser for permission when it is turned on and
 * a finished reply is announced unless its chat is on screen in a visible tab.
 * The desktop app's banners come from the main process instead
 * (electron/desktop-integration.ts).
 */

/** What asking the browser gave. */
export type NotificationAsk = "granted" | "denied" | "default" | "unavailable";

/**
 * Whether this page can show notifications at all: a browser that has them,
 * a secure page, and Claudex in its own tab rather than inside another page.
 */
export function notificationsAvailable(): boolean {
  try {
    return (
      typeof Notification !== "undefined" &&
      window.isSecureContext &&
      window.top === window
    );
  } catch {
    return false;
  }
}

/** Asks the browser for permission to notify (once it is granted, nothing is asked). */
export async function askNotificationPermission(): Promise<NotificationAsk> {
  if (!notificationsAvailable()) return "unavailable";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "unavailable";
  }
}

/**
 * The toast for an answer that keeps the switch off (the original's words),
 * undefined when the permission was granted.
 */
export function permissionRefusal(ask: NotificationAsk): string | undefined {
  if (ask === "granted") return undefined;
  if (ask === "denied")
    return "Notifications are blocked. Allow them in your browser or system settings, then try again.";
  if (ask === "default")
    return "To turn this on, try again and allow notifications when your browser asks.";
  return "Notifications can’t be turned on here. Open Claudex in its own browser tab and try again.";
}

const shown = new Map<string, Notification>();

export function notifyRoutineFinished(
  previous: Routine[],
  next: Routine[],
  onScreen: (conversationId: string) => boolean,
  open: (conversationId: string) => void,
) {
  if (!notificationsAvailable() || Notification.permission !== "granted")
    return;
  for (const notice of routineCompletionNotices(previous, next)) {
    const id = notice.conversationId;
    if (!id || (onScreen(id) && document.visibilityState === "visible"))
      continue;
    try {
      const key = `scheduled-${id}`;
      shown.get(key)?.close();
      const notification = new Notification(t(notice.title), {
        body: notice.body,
        tag: key,
        silent: notice.title === "Scheduled task completed",
      });
      shown.set(key, notification);
      notification.onclose = () => {
        if (shown.get(key) === notification) shown.delete(key);
      };
      notification.onclick = () => {
        window.focus();
        notification.close();
        open(id);
      };
    } catch {}
  }
}

/**
 * A reply finished in `conversation`: shows the browser notification unless
 * the person is looking at it (`onScreen` in a visible tab). A click brings
 * the tab forward and opens the conversation.
 */
export function notifyFinished(
  conversation: Conversation,
  onScreen: boolean,
  open: (conversationId: string) => void,
) {
  if (conversation.incognito) return;
  if (onScreen && document.visibilityState === "visible") return;
  if (!notificationsAvailable() || Notification.permission !== "granted")
    return;
  const notice = finishedNotice(conversation);
  if (!notice) return;
  const id = conversation.id;
  try {
    shown.get(id)?.close();
    const notification = new Notification(
      conversation.title.trim() ? notice.title : t(notice.title),
      { body: t(notice.body), tag: `idle-${id}`, silent: !notice.failed },
    );
    shown.set(id, notification);
    notification.onclose = () => {
      if (shown.get(id) === notification) shown.delete(id);
    };
    notification.onclick = () => {
      window.focus();
      notification.close();
      open(id);
    };
  } catch {
    // Some browsers (Android Chrome) only notify from a service worker.
  }
}

/**
 * A Code session's own notification (Code notifications): its message under
 * the session's title, unless the session is on screen in a visible tab.
 */
export function notifyCodeUpdate(
  conversation: Conversation,
  message: string,
  onScreen: boolean,
  open: (conversationId: string) => void,
) {
  if (conversation.incognito || conversation.archived) return;
  if (onScreen && document.visibilityState === "visible") return;
  if (!notificationsAvailable() || Notification.permission !== "granted")
    return;
  const id = conversation.id;
  try {
    const notification = new Notification(
      conversation.title.trim() || t("Code session"),
      { body: message, tag: `code-update-${id}` },
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
      open(id);
    };
  } catch {
    // Some browsers (Android Chrome) only notify from a service worker.
  }
}

/**
 * Browser delivery for the runner's real approval events while this page is
 * open. A request in a scheduled task's run (`task`, found with
 * runningSchedule) is the task's, under Scheduled tasks and whatever the
 * session's mode: "Scheduled task needs your approval" with the task's name;
 * any other request is a Code permission request.
 */
export function notifyCodePermission(
  approval: Approval,
  conversation: Conversation,
  settings: SettingsPreferences,
  onScreen: boolean,
  open: (conversationId: string) => void,
  task?: Pick<Schedule, "name">,
) {
  if (
    conversation.incognito ||
    conversation.archived ||
    (task
      ? !preference(settings, "notifySchedules")
      : conversation.mode !== "code" ||
        approvalKind(approval) === "questions" ||
        !codePermissionNotificationAllowed(settings, conversation, approval)) ||
    (onScreen && document.visibilityState === "visible") ||
    !notificationsAvailable() ||
    Notification.permission !== "granted"
  )
    return;
  const tag = `code-permission-${approval.id}`;
  if (shown.has(tag)) return;
  try {
    const notification = new Notification(
      t(
        task
          ? "Scheduled task needs your approval"
          : "Code permission requests",
      ),
      {
        body: task
          ? clip(task.name, 80) || t("Scheduled task")
          : conversation.title ||
            t("Claudex needs your approval in a Code session."),
        tag,
      },
    );
    shown.set(tag, notification);
    notification.onclose = () => {
      if (shown.get(tag) === notification) shown.delete(tag);
    };
    notification.onclick = () => {
      window.focus();
      notification.close();
      open(conversation.id);
    };
  } catch {}
}

export function withdrawCodePermission(id: Approval["id"]) {
  const tag = `code-permission-${id}`;
  shown.get(tag)?.close();
  shown.delete(tag);
}

/** Account/session teardown must not leave approval banners from the old account. */
export function clearCodePermissionNotifications() {
  for (const [tag, notification] of shown) {
    if (!tag.startsWith("code-permission-")) continue;
    notification.close();
    shown.delete(tag);
  }
}
