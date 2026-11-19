import { Info } from "../ui/glyphs";
import "./extension-policy-notice.css";

// (live claude.ai bundle, 2026-10-14, c71860c77-xHdlpCO8; shared-frame-B1JORnF0 gT)
export function ExtensionPolicyNotice({
  message,
  icon = true,
}: {
  message: string;
  icon?: boolean;
}) {
  return (
    <div className="extension-policy-notice" role="status">
      {icon && <Info size={16} aria-hidden="true" />}
      <span>{message}</span>
    </div>
  );
}
