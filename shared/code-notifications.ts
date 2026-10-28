import type { Approval, Conversation, Item } from "./types";
import { approvalKind } from "./approval-response";
import { preference, type SettingsPreferences } from "./settings-extras";

/** Only Code approvals use this channel. Questions and completions keep theirs. */
export function codePermissionNotificationAllowed(
  settings: SettingsPreferences,
  conversation: Pick<Conversation, "mode">,
  approval: Approval,
) {
  return (
    conversation.mode !== "code" ||
    approvalKind(approval) === "questions" ||
    preference(settings, "notifyCodePermissions")
  );
}

/**
 * Code notifications: the tool a Code session calls with a short message while
 * the setting is on.
 */
export const codeNotificationTool = "PushNotification";

/** The message of a sent Code notification, undefined for any other item. */
export function codeNotificationMessage(item: Item): string | undefined {
  if (
    item.type !== "dynamicToolCall" ||
    item.tool !== codeNotificationTool ||
    item.status !== "completed" ||
    item.success !== true
  )
    return undefined;
  const message = (item.arguments as { message?: unknown } | undefined)
    ?.message;
  return typeof message === "string" && message.trim()
    ? message.trim().slice(0, 300)
    : undefined;
}

/**
 * The notifications a Code session sent since `previous` was seen: its
 * latest turn's sent ones that were not sent then. Nothing for a session
 * seen for the first time (a reload must not repeat old ones).
 */
export function newCodeNotifications(
  previous: Pick<Conversation, "turns"> | undefined,
  next: Pick<Conversation, "mode" | "turns">,
): string[] {
  if (!previous || next.mode !== "code") return [];
  const sent = new Set(
    (previous.turns.at(-1)?.items ?? [])
      .filter((item) => codeNotificationMessage(item) !== undefined)
      .map((item) => item.id),
  );
  return (next.turns.at(-1)?.items ?? []).flatMap((item) => {
    const message = codeNotificationMessage(item);
    return message !== undefined && !sent.has(item.id) ? [message] : [];
  });
}
