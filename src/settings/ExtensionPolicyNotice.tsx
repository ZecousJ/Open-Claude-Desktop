import { Info } from "../ui/glyphs";
import "./extension-policy-notice.css";

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
