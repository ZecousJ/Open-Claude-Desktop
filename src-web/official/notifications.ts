import { newCodeNotifications } from "../../shared/code-notifications";
import { browserNotificationSettings } from "../../shared/official-notification-preferences";
import { runningSchedule } from "../../shared/routine-notices";
import type { Conversation, Schedule, Settings } from "../../shared/types";
import {
  clearWebNotifications,
  notificationsAvailable,
  notifyCodePermission,
  notifyCodeUpdate,
  notifyFinished,
  notifyRoutineFinished,
  withdrawCodePermission,
} from "../../src/app/web-notifications";
import { mergeConversationTurn } from "../../src/host/events";
import type { WebBridge } from "../bridge";

async function route(conversation: Conversation, owner: string | undefined) {
  if (conversation.mode === "chat") return "/chat/" + encodeURIComponent(conversation.id);
  if (!owner) return;
  const key = new TextEncoder().encode(JSON.stringify([owner, conversation.id]));
  const digest = await crypto.subtle.digest("SHA-256", key);
  const id = Array.from(new Uint8Array(digest).slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return `/${conversation.mode}/session_${id}`;
}

export function subscribeOfficialNotifications(
  bridge: {
    api: Pick<WebBridge["api"], "snapshot" | "listSchedules">;
    officialUiEvents: WebBridge["officialUiEvents"];
  },
  owner: () => string | undefined,
  current: () => boolean,
) {
  let active = true;
  let readVersion = 0;
  let settings: Settings | undefined;
  let schedules: Schedule[] | undefined;
  const conversations = new Map<string, Conversation>();
  const approvals = new Set<string | number>();
  const live = () => active && current();
  const permitted = () => notificationsAvailable() && Notification.permission === "granted";
  const read = () => {
    const version = ++readVersion;
    const currentRead = () => live() && version === readVersion;
    void bridge.api.snapshot().then(next => {
      if (!currentRead()) return;
      settings ??= next.settings;
      for (const conversation of next.conversations)
        if (!conversations.has(conversation.id)) conversations.set(conversation.id, conversation);
    }).catch(() => {});
    void bridge.api.listSchedules().then(next => {
      if (currentRead()) schedules ??= next;
    }).catch(() => {});
  };
  const onscreen = (path?: string) => !location.hash.startsWith("#settings") &&
    location.pathname.replace(/^\/code\/cse_/, "/code/session_") === path;
  const open = (path?: string) => {
    if (path && live()) location.assign(path);
  };
  const change = (conversation: Conversation) => {
    const previous = conversations.get(conversation.id);
    conversations.set(conversation.id, conversation);
    if (!settings || !previous || !permitted()) return;
    const preferences = browserNotificationSettings(settings);
    const updates = preferences.notifyCodeUpdates ? newCodeNotifications(previous, conversation) : [];
    const completed = preferences.notifyResponses && !conversation.scheduledRun &&
      previous.turns.some(turn => turn.status === "inProgress") &&
      !conversation.turns.some(turn => turn.status === "inProgress");
    if (!completed && !updates.length) return;
    void route(conversation, owner()).then(path => {
      if (!live() || !path) return;
      if (completed) notifyFinished(conversation, onscreen(path), () => open(path));
      for (const message of updates)
        notifyCodeUpdate(conversation, message, onscreen(path), () => open(path));
    });
  };
  const off = bridge.officialUiEvents(event => {
    if (!live()) return;
    switch (event.type) {
      case "settings":
        settings = event.settings;
        break;
      case "conversation":
        change(event.conversation);
        break;
      case "conversation-turn": {
        const conversation = mergeConversationTurn(conversations.get(event.conversationId), event);
        if (conversation) change(conversation);
        break;
      }
      case "approval": {
        const conversation = conversations.get(event.approval.conversationId);
        if (!conversation || !settings || !permitted()) break;
        const preferences = { ...settings, ...browserNotificationSettings(settings) };
        const task = runningSchedule(schedules ?? [], conversation.id);
        const { approval } = event;
        approvals.add(approval.id);
        void route(conversation, owner()).then(path => {
          if (path && live() && approvals.has(approval.id))
            notifyCodePermission(approval, conversation, preferences, onscreen(path), () => open(path), task);
        });
        break;
      }
      case "approval-resolved":
        approvals.delete(event.id);
        withdrawCodePermission(event.id);
        break;
      case "schedules": {
        const previous = schedules;
        schedules = event.schedules;
        if (!previous || !settings?.notifySchedules || !permitted()) break;
        const running = previous.filter(task => task.lastRunStatus === "running" || task.lastRunStatus === "starting");
        void Promise.all(running.map(async task => {
          const conversation = task.conversationId && conversations.get(task.conversationId);
          const path = conversation && await route(conversation, owner());
          return conversation && path ? [conversation.id, path] as const : undefined;
        })).then(entries => {
          if (!live()) return;
          const paths = new Map(entries.filter(entry => entry !== undefined));
          const known = event.schedules.filter(task => task.conversationId && paths.has(task.conversationId));
          notifyRoutineFinished(previous, known, id => onscreen(paths.get(id)), id => open(paths.get(id)));
        });
        break;
      }
      case "resync":
        clearWebNotifications();
        approvals.clear();
        conversations.clear();
        schedules = undefined;
        settings = undefined;
        read();
        break;
    }
  });
  read();
  return () => {
    active = false;
    off();
    clearWebNotifications();
  };
}
