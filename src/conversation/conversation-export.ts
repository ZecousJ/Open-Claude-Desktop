import type { Conversation } from "../../shared/types";
import { surface } from "../../shared/host";
import { api } from "../desktop-api";
import { formatText, t } from "../i18n";
import { dismissToast, showToast } from "../ui/toast-store";

/** Local and hosted success notices. */
export async function exportConversation(
  conversation: Conversation,
  report: (error: unknown) => void,
) {
  const code = conversation.mode === "code";
  const pending = code ? showToast(t("Exporting session…")) : undefined;
  try {
    const file = await api.exportConversation(conversation.id);
    if (!file) return;
    if (!code) {
      showToast(t("Conversation exported"));
      return;
    }
    if (surface === "web") {
      showToast(t("Session exported to your downloads."));
      return;
    }
    const platform = navigator.platform;
    const reveal = t(
      /Mac/i.test(platform)
        ? "Show in Finder"
        : /Win/i.test(platform)
          ? "Show in Explorer"
          : "Show in file manager",
    );
    showToast(
      formatText("Session exported to {filePath}", { filePath: file }),
      {
        inlineAction: {
          label: file,
          title: formatText("{action}: {path}", { action: reveal, path: file }),
          ariaLabel: formatText("{name}, {action}", {
            name: file,
            action: reveal,
          }),
          onSelect: () => {
            void api
              .revealConversationExport(file)
              .then((shown) => {
                if (!shown)
                  throw Error(
                    t(
                      /Mac/i.test(platform)
                        ? "Couldn’t show this in Finder. It may have been deleted or moved."
                        : /Win/i.test(platform)
                          ? "Couldn’t show this in Explorer. It may have been deleted or moved."
                          : "Couldn’t show this in the file manager. It may have been deleted or moved.",
                    ),
                  );
              })
              .catch(report);
          },
        },
      },
    );
  } catch (error) {
    report(
      code
        ? new Error(t("Failed to export session. You can try again."), {
            cause: error,
          })
        : error,
    );
  } finally {
    if (pending !== undefined) dismissToast(pending);
  }
}
