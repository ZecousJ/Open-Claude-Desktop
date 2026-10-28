import type { CapabilityTip } from "../../shared/chat-suggestions";
import type { AppController } from "../app/AppContext";
import { t } from "../i18n";

// Fn/Wn.
export function actOnCapabilityTip(app: AppController, tip: CapabilityTip) {
  switch (tip) {
    case "projects":
      app.setPage("projects");
      return;
    case "scheduled_tasks":
      app.setPage("scheduled");
      return;
    case "skills":
      app.setPage("customize");
      window.dispatchEvent(new Event("claudex:customize-skills"));
      return;
    case "memory":
      app.openSettingsTab("memory");
      return;
    case "temporary_chat":
      app.newChat("chat", undefined, true);
      return;
    case "cowork":
      app.newChat("cowork");
      return;
    case "file_uploads":
    case "screenshots":
      return;
    default: {
      const prompt = t(
        {
          artifacts: "Make this an artifact I can keep editing and share.",
          document_creation:
            "Turn this into a file I can download and send as is.",
          chat_history_search: "Search my past chats for",
        }[tip],
      );
      app.setText(
        (text) =>
          `${text ? `${text}\n\n` : ""}${prompt}${tip === "chat_history_search" ? " " : ""}`,
      );
      app.composer.current?.focus();
    }
  }
}
