import type { SettingsPreferences } from "./settings-extras";

export type NotificationSettings = Pick<SettingsPreferences,
  "notifyResponses" | "notifySchedules" | "notifyCodeUpdates" |
  "notifyCodePermissions" | "notifySchedulesEmail" | "notifyCodeEmail"
>;

export function officialNotificationPreferencesOrganization(pathname: string) {
  return /^\/api\/organizations\/([^/]+)\/notification\/preferences$/.exec(pathname)?.[1];
}

export function browserNotificationSettings(settings: NotificationSettings) {
  return {
    notifyResponses: settings.notifyResponses === true,
    notifySchedules: settings.notifySchedules === true,
    notifyCodeUpdates: settings.notifyCodeUpdates === true,
    notifyCodePermissions: settings.notifyCodePermissions === true,
    notifySchedulesEmail: settings.notifySchedulesEmail === true,
    notifyCodeEmail: settings.notifyCodeEmail === true,
  };
}

export function officialNotificationPreferencesWire(settings: NotificationSettings) {
  const value = browserNotificationSettings(settings);
  const feature = {
    compass: { enable_push: value.notifyResponses },
    completion: { enable_push: value.notifyResponses },
    routines: { enable_push: value.notifySchedules, enable_email: value.notifySchedulesEmail },
    bogosort: { enable_push: value.notifyCodeUpdates, enable_email: value.notifyCodeEmail },
    code_requires_action: { enable_push: value.notifyCodePermissions },
  };
  return {
    preferences: { feature_preference: feature },
    effective_preferences: feature,
    push_reachability: { platforms: [], has_active_channel: false, most_recent_token_refresh: null },
    admin_spend_alerts_available: false,
    admin_join_request_alerts_available: false,
  };
}
