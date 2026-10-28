import type { EngineExtension } from "./engine-extensions";
import { codeNotificationTool } from "../../shared/code-notifications";
import {
  preference,
  type SettingsPreferences,
} from "../../shared/settings-extras";

/**
 * Code notifications (Settings → General → Notifications): a Code session
 * can send the person a short notification about an important update. A
 * Code thread started while it is on has the tool; turned off later, a call
 * says so and nothing is shown (the desktop banner and the web's browser
 * notification read the sent call from the transcript).
 */
export function codeNotificationsExtension(
  settings: () => SettingsPreferences | undefined,
): EngineExtension {
  return {
    id: "code-notifications",
    // Offered to a Code thread started while the setting is on.
    dynamicTools: ({ mode, settings }) =>
      mode !== "code" || !preference(settings, "notifyCodeUpdates")
        ? []
        : [
            {
              type: "function",
              name: codeNotificationTool,
              description:
                "Send the user a short notification about an important update from this session: a long task finished, a blocker that needs them, or a decision only they can make. Use sparingly, never for routine progress.",
              inputSchema: {
                type: "object",
                properties: {
                  message: {
                    type: "string",
                    description: "One short sentence, under 200 characters.",
                  },
                },
                required: ["message"],
                additionalProperties: false,
              },
            },
          ],
    handleDynamicTool(call) {
      if (call.namespace || call.tool !== codeNotificationTool) return;
      const message = (call.arguments as { message?: unknown } | null)?.message;
      const current = settings();
      const on = !!current && preference(current, "notifyCodeUpdates");
      const valid = typeof message === "string" && !!message.trim();
      return {
        success: on && valid,
        contentItems: [
          {
            type: "inputText",
            text: !valid
              ? "Give a short message."
              : on
                ? "Notification sent."
                : "The user has turned Code notifications off; it was not sent. Don't send more.",
          },
        ],
      };
    },
  };
}
