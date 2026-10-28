import { useId, useRef, useState } from "react";
import {
  Ban,
  CircleCheck,
  Ellipsis,
  ChevronDown,
  ChevronRight,
  Hand,
} from "../../ui/glyphs";
import type {
  ConnectorToolPermission,
  McpToolState,
} from "../../../shared/settings-desktop-api";
import { Menu, type MenuPosition } from "../../ui/Menu";
import { usePolicy } from "../../policy/PolicyContext";
import { Unavailable } from "../controls";
import { formatText, t, useLocale } from "../../i18n";
import "./tool-permissions.css";

/** Why Always allow is greyed: the administrator requires approving each request. */
export const alwaysAllowUnavailable =
  "Your administrator requires approving each request";

type Mode = ConnectorToolPermission;
/**
 * A tool's permission: Blocked when it is in `disabled_tools`, Always allow
 * when its approval mode is "approve" (Codex never asks), else Needs approval
 * (Codex asks, by default or "prompt").
 */
export const modeOf = (tool: McpToolState): Mode =>
  !tool.enabled ? "block" : tool.approval === "approve" ? "allow" : "ask";

/** The group's control: its tools' shared mode, or Custom when they differ. */
export function groupMode(tools: McpToolState[]): Mode | "custom" {
  const modes = new Set(tools.map(modeOf));
  return modes.size === 1 ? [...modes][0] : "custom";
}

// Search and empty copy.
export function filterConnectorTools(tools: McpToolState[], query: string) {
  const needle = query.trim().toLowerCase();
  return tools.filter((tool) => tool.name.toLowerCase().includes(needle));
}

/**
 * Tool permissions: "Choose when Claudex is allowed to use these tools", the
 * tools under a collapsible group with its count and a menu that sets them all
 * (Always allow, Needs approval, Blocked; Custom when they differ), and on each
 * row three icon buttons for the same three. Blocked is Codex's
 * `disabled_tools`; Always allow and Needs approval are the tool's
 * `approval_mode` ("approve" never asks, "prompt" always asks).
 */
export function ToolPermissions({
  server,
  tools,
  editable,
  onSet,
}: {
  server: string;
  tools: McpToolState[];
  /** The configuration can be changed here (desktop, policy allows). */
  editable: boolean;
  onSet: (tool: string, permission: ConnectorToolPermission) => void;
}) {
  useLocale();
  const permissionsLabelId = useId();
  const toolLabelPrefix = useId();
  const toolsLabelId = useId();
  const serverLabelId = useId();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuPosition>();
  const anchor = useRef<HTMLButtonElement>(null);
  const policy = usePolicy();
  const mode = groupMode(tools);
  const visibleTools = filterConnectorTools(tools, query);
  const alwaysAllowed = policy.approvalsAlwaysAllow !== false;
  const setAll = (permission: Mode) =>
    tools
      .filter((tool) => modeOf(tool) !== permission)
      .forEach((tool) => onSet(tool.name, permission));
  return (
    <div className="tool-permissions">
      <h4>Tool permissions</h4>
      <p>Choose when Claudex is allowed to use these tools.</p>
      <div className="tool-permissions-group">
        <span id={permissionsLabelId} hidden data-no-translate>
          {formatText("Permissions for all tools of {x}", { x: server })}
        </span>
        <span id={toolsLabelId} hidden>
          {t("Tools")}
        </span>
        <span id={serverLabelId} hidden data-no-translate>
          {server}
        </span>
        <button
          type="button"
          className="tool-permissions-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Tools
          <span className="tool-permissions-count">{tools.length}</span>
        </button>
        <button
          ref={anchor}
          type="button"
          className="tool-permissions-all"
          disabled={!editable}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          aria-labelledby={permissionsLabelId}
          onClick={() => {
            const rect = anchor.current!.getBoundingClientRect();
            setMenu(
              menu
                ? undefined
                : { right: innerWidth - rect.right, top: rect.bottom + 4 },
            );
          }}
        >
          {mode === "allow" ? (
            <CircleCheck size={15} strokeWidth={1.6} />
          ) : mode === "ask" ? (
            <Hand size={15} strokeWidth={1.6} />
          ) : mode === "block" ? (
            <Ban size={15} strokeWidth={1.6} />
          ) : (
            <Ellipsis size={15} strokeWidth={1.6} />
          )}
          {mode === "allow"
            ? "Always allow"
            : mode === "ask"
              ? "Needs approval"
              : mode === "block"
                ? "Blocked"
                : "Custom"}
          <ChevronDown size={14} strokeWidth={1.6} />
        </button>
        {menu && (
          <Menu
            label="Tool permissions"
            size="regular"
            width={180}
            position={menu}
            anchors={[anchor]}
            onClose={() => setMenu(undefined)}
            entries={[
              {
                label: "Always allow",
                checked: mode === "allow",
                disabled: !alwaysAllowed,
                title: alwaysAllowed ? undefined : alwaysAllowUnavailable,
                onSelect: () => setAll("allow"),
              },
              {
                label: "Needs approval",
                checked: mode === "ask",
                onSelect: () => setAll("ask"),
              },
              {
                label: "Blocked",
                checked: mode === "block",
                onSelect: () => setAll("block"),
              },
            ]}
          />
        )}
      </div>
      {open && (
        <input
          className="settings-input"
          type="search"
          placeholder={t("Search tools")}
          aria-label={t("Search tools")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {open && visibleTools.length === 0 && (
        <p className="connector-tools-empty">No tools match your search.</p>
      )}
      {open && (
        <ul aria-labelledby={`${toolsLabelId} ${serverLabelId}`}>
          {visibleTools.map((tool, index) => {
            const current = modeOf(tool);
            const allowButton = (
              <button
                type="button"
                role="radio"
                aria-label="Always allow"
                aria-checked={current === "allow"}
                disabled={!editable || !alwaysAllowed}
                onClick={() => current !== "allow" && onSet(tool.name, "allow")}
              >
                <CircleCheck size={16} strokeWidth={1.6} />
              </button>
            );
            return (
              <li key={tool.name}>
                <div>
                  <strong data-no-translate>{tool.name}</strong>
                  {tool.description && (
                    <span data-no-translate>{tool.description}</span>
                  )}
                </div>
                {/* The group's name keeps the tool's own name as data (the
                    document translator would otherwise fill "{name}
                    permission" again and turn a tool called Search into
                    搜索); the buttons inside stay translatable. */}
                <span
                  id={`${toolLabelPrefix}-${index}`}
                  hidden
                  data-no-translate
                >
                  {formatText("{name} permission", { name: tool.name })}
                </span>
                <span
                  className="tool-permission"
                  role="radiogroup"
                  aria-labelledby={`${toolLabelPrefix}-${index}`}
                >
                  {alwaysAllowed ? (
                    allowButton
                  ) : (
                    <Unavailable reason={alwaysAllowUnavailable}>
                      {allowButton}
                    </Unavailable>
                  )}
                  <button
                    type="button"
                    role="radio"
                    aria-label="Needs approval"
                    aria-checked={current === "ask"}
                    disabled={!editable}
                    onClick={() => current !== "ask" && onSet(tool.name, "ask")}
                  >
                    <Hand size={16} strokeWidth={1.6} />
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-label="Blocked"
                    aria-checked={current === "block"}
                    disabled={!editable}
                    onClick={() =>
                      current !== "block" && onSet(tool.name, "block")
                    }
                  >
                    <Ban size={16} strokeWidth={1.6} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
