import { helpUrl } from "../../shared/help-links";
import { useContext, useState } from "react";
import { X } from "../ui/glyphs";
import { AppContext } from "../app/AppContext";
import "./task-permission-notice.css";

export function PermissionModeNotice({ mode }: { mode: "auto" | "bypass" }) {
  const app = useContext(AppContext);
  const key = `cowork-permission-banner-dismissed:${app?.accountId ?? "local"}:${mode}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div
      className={`permission-mode-notice ${mode === "bypass" ? "warning" : "neutral"}`}
      role="status"
    >
      <div>
        <strong>
          {mode === "auto"
            ? "Permission mode is set to Auto."
            : "Skip all approvals is on."}
        </strong>{" "}
        {mode === "auto"
          ? "Claudex runs on its own and pauses if anything looks unsafe. This includes using your connectors and apps on your computer, unless you turn them off."
          : "Claudex never pauses, even for unsafe actions. This includes using your connectors and apps on your computer. You can turn off individual connectors in the + menu."}{" "}
        <a
          href={helpUrl("skip-approvals-safety")}
          onClick={(event) => {
            event.preventDefault();
            void window.desktop.openExternal(event.currentTarget.href);
          }}
        >
          {mode === "auto" ? "Learn more" : "See safe use tips"}
        </a>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(key, "1");
          } catch {}
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
