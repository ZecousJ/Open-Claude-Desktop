import { z } from "zod";
import type { DesktopAPI } from "../../shared/types";
import { officialNotificationPreferencesWire, type NotificationSettings } from "../../shared/official-notification-preferences";

const push = z.strictObject({ enable_push: z.boolean() });
const code = z.strictObject({ enable_push: z.boolean().optional(), enable_email: z.boolean().optional() });
const preferences = z.strictObject({
  preferences: z.strictObject({
    feature_preference: z.strictObject({
      compass: push.optional(),
      completion: push.optional(),
      routines: code.optional(),
      bogosort: code.optional(),
      code_requires_action: push.optional(),
    }),
  }),
});

export interface OfficialNotificationPreferences {
  save(body: unknown): Promise<Response>;
}

export function createOfficialNotificationPreferences(
  api: Pick<DesktopAPI, "snapshot" | "saveSettings">,
  current: () => boolean,
): OfficialNotificationPreferences {
  let writes: Promise<unknown> = Promise.resolve();
  const check = () => {
    if (!current()) throw new DOMException("The active account changed.", "AbortError");
  };
  return {
    async save(body) {
      const value = preferences.safeParse(body);
      if (!value.success) return Response.json({ error: "Invalid notification preferences." }, { status: 400 });
      const { compass, completion, routines, bogosort, code_requires_action: approvals } =
        value.data.preferences.feature_preference;
      if (compass && completion && compass.enable_push !== completion.enable_push)
        return Response.json({ error: "Response notification preferences must agree." }, { status: 400 });

      const patch: NotificationSettings = {};
      const responses = completion ?? compass;
      if (responses) patch.notifyResponses = responses.enable_push;
      if (routines?.enable_push !== undefined) patch.notifySchedules = routines.enable_push;
      if (routines?.enable_email !== undefined) patch.notifySchedulesEmail = routines.enable_email;
      if (bogosort?.enable_push !== undefined) patch.notifyCodeUpdates = bogosort.enable_push;
      if (bogosort?.enable_email !== undefined) patch.notifyCodeEmail = bogosort.enable_email;
      if (approvals) patch.notifyCodePermissions = approvals.enable_push;

      const answer = writes.then(async () => {
        check();
        const { settings } = await api.snapshot();
        check();
        const saved = await api.saveSettings({ ...settings, ...patch });
        check();
        return Response.json(officialNotificationPreferencesWire(saved), { headers: { "Cache-Control": "no-store" } });
      });
      writes = answer.catch(() => {});
      return answer;
    },
  };
}
