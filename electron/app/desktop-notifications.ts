import {
  codePermissionNotificationAllowed,
  newCodeNotifications,
} from "../../shared/code-notifications";
import { Notification } from "electron";
import type { Approval, Conversation, Schedule } from "../../shared/types";
import { preference } from "../../shared/settings-extras";
import type {
  DesktopNotificationInput,
  NotificationActionEvent,
} from "../../shared/desktop-notifications";
import {
  approvalNotice,
  noticeTags,
  runningSchedule,
  scheduledApprovalNotice,
  groupedScheduleNotices,
  scheduleNotices,
  type Notice,
} from "../engine/attention-rules";
import type { DesktopIntegration } from "./desktop-integration";
import type { NotificationSuppressionReason } from "./desktop-integration";

/**
 * A banner's fixed words in the app's language. The grouped scheduled-task
 * title arrives with its count already in it, so it is matched back to its
 * template; the person's own text (a task or chat title) has no entry and
 * stays as written.
 */
function noticeText(text: string, translate: (text: string) => string) {
  const grouped = /^(\d+) scheduled tasks need your attention$/.exec(text);
  return grouped
    ? translate("{count} scheduled tasks need your attention").replace(
        "{count}",
        grouped[1],
      )
    : translate(text);
}

export function notify(this: DesktopIntegration, notice: Notice) {
  if (!Notification.isSupported()) return;
  const respond = this.options.respond;
  const allowOnce = respond ? notice.allowOnce : undefined;
  const settings = this.options.settings();
  // "Notification sound: None" quiets every banner; a finished turn is quiet
  // anyway.
  const silent =
    notice.silent ||
    (!!settings && preference(settings, "notificationSound") === "none");
  const translate = this.translate();
  const notification = new Notification({
    title: noticeText(notice.title, translate),
    body: noticeText(notice.body, translate),
    ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
    ...(silent ? { silent: true } : {}),
    // The original's permission banner offers Allow once (macOS shows
    // notification buttons; other systems leave them out).
    ...(allowOnce
      ? {
          actions: [{ type: "button" as const, text: translate("Allow once") }],
        }
      : {}),
  });
  const tag = notice.tag;
  if (tag) {
    this.shown.get(tag)?.notification.close();
    this.shown.set(tag, {
      notification,
      conversationId: notice.conversationId,
    });
    notification.on("close", () => {
      if (this.shown.get(tag)?.notification === notification)
        this.shown.delete(tag);
    });
  }
  notification.on("click", () => {
    this.open(notice.conversationId);
    if (notice.scheduledTasks) this.options.command("scheduled-tasks");
  });
  if (respond && allowOnce)
    notification.on("action", () => {
      // A request answered elsewhere meanwhile is refused by the engine:
      // the conversation opens instead, showing where it stands.
      void Promise.resolve()
        .then(() => respond(allowOnce.approvalId, allowOnce.response))
        .catch(() => this.open(notice.conversationId));
    });
  notification.show();
}

export function supportsNotificationActions(this: DesktopIntegration) {
  return process.platform === "darwin" && Notification.isSupported();
}

/** Renderer actions carry an opaque token. */
export function showNotification(
  this: DesktopIntegration,
  input: DesktopNotificationInput,
  action: (event: NotificationActionEvent) => void,
) {
  if (!Notification.isSupported()) return;
  const actions = this.supportsNotificationActions()
    ? (input.actions ?? [])
    : [];
  const notification = new Notification({
    title: input.title,
    body: input.body,
    ...(input.tag ? { id: input.tag } : {}),
    actions: actions.map((entry) => ({
      type: "button" as const,
      text: entry.title,
    })),
  });
  const shownAt = performance.now();
  let handled = false;
  this.rendererNotifications.add(notification);
  notification.on("close", () => {
    handled = true;
    this.rendererNotifications.delete(notification);
    if (input.tag && this.shown.get(input.tag)?.notification === notification)
      this.shown.delete(input.tag);
  });
  notification.on("click", () => {
    if (handled || !this.rendererNotifications.has(notification)) return;
    handled = true;
    this.open(input.conversationId);
  });
  notification.on("action", (_event, index) => {
    const selected = actions[index];
    if (
      handled ||
      !this.rendererNotifications.has(notification) ||
      !selected ||
      !input.tag ||
      !input.token
    )
      return;
    if (this.shown.get(input.tag)?.notification !== notification) return;
    handled = true;
    action({
      type: "notification-action",
      tag: input.tag,
      token: input.token,
      actionId: selected.id,
      sinceShownMs: Math.max(0, performance.now() - shownAt),
    });
    notification.close();
  });
  if (input.tag) {
    const tag = input.tag;
    this.withdraw(tag);
    this.shown.set(tag, {
      notification,
      conversationId: input.conversationId,
    });
  }
  notification.show();
}

/**
 * A conversation changed. `cloud`: it runs in the cloud (Sync with the
 * web); it is told about as a local one is, as the original tells its
 * cloud Cowork tasks under the same levels, but never keeps this
 * computer awake.
 */
export function observeConversation(
  this: DesktopIntegration,
  conversation: Conversation,
  options: { cloud?: boolean } = {},
) {
  const previous = this.seen.get(conversation.id);
  this.seen.set(conversation.id, conversation);
  this.observeCodeNotifications(previous, conversation);
  if (options.cloud) this.cloudSeen.add(conversation.id);
  else this.cloudSeen.delete(conversation.id);
  const notice = this.turns.observe(conversation, {
    // A scheduled run's end is told by its own banner (observeSchedules).
    scheduledRun: this.schedules.some(
      (task) => task.conversationId === conversation.id,
    ),
  });
  if (!options.cloud) {
    this.work.observe(conversation, this.now());
    this.updateKeepAwake();
  }
  const settings = this.options.settings();
  // A new turn makes the previous one's banner stale.
  if (conversation.turns.at(-1)?.status === "inProgress")
    this.withdraw(noticeTags.idle(conversation.id));
  if (!notice || !settings) return;
  if (!this.ready) {
    this.options.suppressed?.("not_initialized", conversation.id);
    return;
  }
  const current = options.cloud
    ? conversation
    : this.options.conversations().find((c) => c.id === conversation.id);
  if (!current || current.archived || current.incognito) {
    this.options.suppressed?.("session_gone", conversation.id);
    return;
  }
  if (
    current.turns
      .at(-1)
      ?.items.some(
        (item) =>
          item.type === "collabAgentToolCall" &&
          item.tool === "workflow" &&
          item.status === "inProgress",
      )
  ) {
    this.options.suppressed?.("self_resume_workflow", conversation.id);
    return;
  }
  const latestTurn = current.turns.at(-1);
  if (
    latestTurn?.notificationTrigger === "ci-monitor" &&
    latestTurn.postTurnSummary?.is_noteworthy === false
  ) {
    this.options.suppressed?.("ci_not_noteworthy", conversation.id);
    return;
  }
  if (this.viewing(conversation.id)) {
    this.options.suppressed?.("viewing_session", conversation.id);
    return;
  }
  // Chat's finished replies are "Response completions"; a Code or Cowork
  // session's follow its "Task complete" level, a banner unless the person
  // turned it off.
  const allowed =
    conversation.mode === "chat"
      ? preference(settings, "notifyResponses")
      : this.effect("idle").banner;
  if (allowed) this.notify(notice);
  else
    this.options.suppressed?.(
      conversation.mode !== "chat" && !this.effect("idle").badge
        ? "level_off"
        : "banners_disabled",
      conversation.id,
    );
}

/**
 * A tool approval or question is waiting in a conversation. The original Says
 * it whichever kind of conversation waits: Chat with "needs your approval"
 * while the window is in the background, under no switch; a Code or Cowork
 * permission with what it would do and an Allow once button, a question with
 * its text, each under its level (Permission requests, Questions). A session on
 * screen gets no banner. A waiting request counts in the Dock badge when its
 * level says so, whether or not a banner shows.
 */
export function observeApproval(
  this: DesktopIntegration,
  approval: Approval,
  options: { reAlert?: boolean } = {},
) {
  const suppress = (reason: NotificationSuppressionReason) =>
    this.options.suppressed?.(reason, approval.conversationId);
  if (!this.ready) return suppress("not_initialized");
  const settings = this.options.settings();
  if (!settings) return;
  const conversation =
    this.options
      .conversations()
      .find((c) => c.id === approval.conversationId) ??
    (this.cloudSeen.has(approval.conversationId)
      ? this.seen.get(approval.conversationId)
      : undefined);
  if (!conversation || conversation.archived || conversation.incognito)
    return suppress("session_gone");
  if (this.waiting.has(approval.id) && !options.reAlert) return;
  clearTimeout(this.approvalTimers.get(approval.id));
  const notice = approvalNotice(approval, conversation, {
    repoName: this.options.repoName,
  });
  if (notice.kind === "chat") {
    this.waiting.set(approval.id, {
      tag: notice.tag,
      conversationId: conversation.id,
    });
    if (!this.focused) this.notify(notice);
    return;
  }
  const kind = notice.kind;
  this.waiting.set(approval.id, {
    tag: notice.tag,
    kind,
    conversationId: conversation.id,
  });
  this.updateBadge();
  this.refreshDockMenu();
  const effect = this.effect(kind);
  if (!effect.banner && !effect.badge) return suppress("level_off");
  if (this.viewing(conversation.id)) return suppress("viewing_session");
  this.attention();
  if (
    !effect.banner ||
    !codePermissionNotificationAllowed(settings, conversation, approval)
  )
    return suppress("banners_disabled");
  const deliver = () => {
    this.approvalTimers.delete(approval.id);
    if (!this.waiting.has(approval.id)) return suppress("resolved_during_prep");
    const current =
      this.options.conversations().find((c) => c.id === conversation.id) ??
      (this.cloudSeen.has(conversation.id)
        ? this.seen.get(conversation.id)
        : undefined);
    if (!current || current.archived || current.incognito)
      return suppress("session_gone");
    if (this.viewing(current.id)) return suppress("viewing_session");
    const currentEffect = this.effect(kind);
    const latestPreferences = this.options.settings();
    if (
      latestPreferences &&
      !codePermissionNotificationAllowed(latestPreferences, current, approval)
    )
      return suppress("banners_disabled");
    if (!currentEffect.banner)
      return suppress(currentEffect.badge ? "banners_disabled" : "level_off");
    // A scheduled run's request is the task's, under Scheduled tasks too.
    const task = runningSchedule(this.schedules, conversation.id);
    if (task) {
      const latestSettings = this.options.settings();
      if (latestSettings && preference(latestSettings, "notifySchedules"))
        this.queueScheduledAttention(scheduledApprovalNotice(task, approval));
      return;
    }
    this.notify(
      approvalNotice(approval, current, { repoName: this.options.repoName }),
    );
  };
  // Cowork's permission preparation waits 300 ms; Code does not.
  if (conversation.mode === "cowork" && kind === "permission")
    this.approvalTimers.set(approval.id, setTimeout(deliver, 300));
  else deliver();
}

/** A request was answered (here, on another device, or it went away). */
export function observeApprovalResolved(
  this: DesktopIntegration,
  id: string | number,
) {
  const entry = this.waiting.get(id);
  for (const [key, notice] of this.scheduledAttention)
    if (notice.tag === entry?.tag) this.scheduledAttention.delete(key);
  this.waiting.delete(id);
  if (entry?.tag) this.withdraw(entry.tag);
  this.updateBadge();
  this.refreshDockMenu();
  // The bounce stops once no request that asked for it waits.
  for (const { kind } of this.waiting.values()) {
    const effect = kind && this.effect(kind);
    if (effect && (effect.banner || effect.badge)) return;
  }
  this.stopAttention();
}

/**
 * The person looks at other conversations now (or brought a window
 * forward): the banners about what they see are taken away, as the
 * original closes a session's idle and scheduled-run banners when it is
 * opened. Banners for requests stay until they are answered.
 */
export function observeViewing(this: DesktopIntegration) {
  for (const [tag, entry] of [...this.shown]) {
    const id = entry.conversationId;
    if (!id || !this.viewing(id)) continue;
    if (tag === noticeTags.idle(id) || tag === noticeTags.scheduled(id))
      this.withdraw(tag);
  }
}

/**
 * Scheduled runs that ended: the original's banner for a run on this
 * computer follows the Task complete level; Claudex's Scheduled tasks
 * switch must allow it too.
 */
export function observeSchedules(
  this: DesktopIntegration,
  schedules: Schedule[],
) {
  const settings = this.options.settings();
  const notices = scheduleNotices(this.schedules, schedules);
  this.schedules = structuredClone(schedules);
  if (
    !settings ||
    !preference(settings, "notifySchedules") ||
    !this.effect("idle").banner
  )
    return;
  for (const notice of notices) {
    if (this.viewing(notice.conversationId)) continue;
    if (notice.title === "Scheduled task completed") this.notify(notice);
    else this.queueScheduledAttention(notice);
  }
}

export function queueScheduledAttention(
  this: DesktopIntegration,
  notice: Notice,
) {
  this.scheduledAttention.set(notice.conversationId ?? notice.tag!, notice);
  if (this.scheduledAttentionTimer) return;
  this.scheduledAttentionTimer = setTimeout(() => {
    this.scheduledAttentionTimer = undefined;
    const notices = [...this.scheduledAttention.values()].filter(
      (value) => !this.viewing(value.conversationId),
    );
    this.scheduledAttention.clear();
    const settings = this.options.settings();
    if (!settings || !preference(settings, "notifySchedules")) return;
    for (const value of groupedScheduleNotices(notices)) this.notify(value);
  }, 2_000);
  this.scheduledAttentionTimer.unref();
}

/**
 * Code notifications: what a Code session sent with its PushNotification
 * tool while the setting is on, as a banner unless the session is on
 * screen (Settings → General → Code notifications).
 */
export function observeCodeNotifications(
  this: DesktopIntegration,
  previous: Conversation | undefined,
  conversation: Conversation,
) {
  const sent = newCodeNotifications(previous, conversation);
  const settings = this.options.settings();
  if (
    !sent.length ||
    !settings ||
    !preference(settings, "notifyCodeUpdates") ||
    !this.ready ||
    conversation.archived ||
    conversation.incognito ||
    this.viewing(conversation.id)
  )
    return;
  for (const body of sent)
    this.notify({
      title: conversation.title.trim() || "Code session",
      body,
      tag: `code-update-${conversation.id}`,
      conversationId: conversation.id,
    });
}
