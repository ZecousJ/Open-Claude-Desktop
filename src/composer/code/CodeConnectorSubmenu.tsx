import { useState } from "react";
import { ConnectorReconnectRows } from "../ConnectorReconnectRows";
import { usePolicy } from "../../policy/PolicyContext";
import { connectorAllowed } from "../../../shared/client-policy-rules";

type Props = {
  servers: Record<string, unknown>;
  onBrowse: () => void;
  onManage: () => void;
  onToggle: (name: string, enabled: boolean) => void;
  onUnavailable?: (message: string) => void;
};

/** Books on a shelf, drawn on a 0.5px grid (12 × 10). */
function ShelfIcon() {
  return (
    <svg
      className="code-add-sub-icon"
      width="12"
      height="10"
      viewBox="0 0 24 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 19h21M3.5 19V6.5a1.5 1.5 0 0 1 1.5-1.5h2M7 19V2.5A1.5 1.5 0 0 1 8.5 1h3A1.5 1.5 0 0 1 13 2.5V19M15 7.2l2.6-1 5 12.8M15 7.2l4.6 11.8" />
    </svg>
  );
}
/** Briefcase with a straight waist seam (12 × 10). */
function CaseIcon() {
  return (
    <svg
      className="code-add-sub-icon"
      width="12"
      height="10"
      viewBox="0 0 24 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="5" width="21" height="14" rx="2.5" />
      <path d="M8 5V3a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 16 3v2M1.5 11h21" />
    </svg>
  );
}

export function CodeConnectorSubmenu({
  servers,
  onBrowse,
  onManage,
  onToggle,
  onUnavailable = () => {},
}: Props) {
  const policy = usePolicy();
  // Connectors outside the administrator's allowlist never start, so they are not listed.
  const entries = Object.entries(servers).filter(
    ([name, value]) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      connectorAllowed(policy, name, value),
  );
  // Claude highlights the first entry as soon as the submenu opens.
  const [active, setActive] = useState(0);
  const row = (index: number) => ({
    "data-active": active === index,
    onMouseEnter: () => setActive(index),
    onFocus: () => setActive(index),
  });
  return (
    <div className="code-add-submenu" role="menu" aria-label="Connectors">
      <button role="menuitem" {...row(0)} onClick={onBrowse}>
        <ShelfIcon />
        <span>Browse connectors</span>
      </button>
      <button role="menuitem" {...row(1)} onClick={onManage}>
        <CaseIcon />
        <span>Manage connectors</span>
      </button>
      {entries.length > 0 && (
        <div className="code-add-submenu-separator" role="separator" />
      )}
      <ConnectorReconnectRows
        servers={Object.fromEntries(entries)}
        onToggle={onToggle}
        switchClass="code-connector-switch"
        rowProps={(index) => row(index + 2)}
        onError={(error) =>
          onUnavailable(error instanceof Error ? error.message : String(error))
        }
      />
    </div>
  );
}
