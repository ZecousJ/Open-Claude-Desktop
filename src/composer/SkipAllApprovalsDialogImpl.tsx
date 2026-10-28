import { helpUrl } from "../../shared/help-links";
import { Modal } from "../ui/Controls";
import { useEffect, useState } from "react";
import type {
  McpServerState,
  McpToolState,
} from "../../shared/settings-desktop-api";
import {
  connectors as catalogue,
  connectorServer,
} from "../../shared/connectors-catalogue";
import { formatText } from "../i18n";
import { ChevronRight } from "../ui/glyphs";
import { ConnectorLogo } from "../settings/directory/ConnectorRows";
import { directoryGlyph } from "../settings/directory/icons";
import "./task-permission-notice.css";

/**
 * One connector and the tools it would run unasked: its icon, name and tool
 * count, a caret that turns down to list the tools, each marked Read-only or
 * Write/delete from the server's own annotations, or Already allowed.
 */
function ConnectorRow({
  name,
  server,
}: {
  name: string;
  server?: McpServerState;
}) {
  const [open, setOpen] = useState(false);
  const tools = server?.toolList
    ?.filter((tool) => tool.enabled)
    .sort((a, b) => rank(a) - rank(b));
  const count = tools?.length ?? server?.tools;
  const entry =
    server && catalogue.find((item) => connectorServer(item, [server]));
  const Glyph = directoryGlyph("server");
  return (
    <li>
      <button
        type="button"
        className="skip-approvals-connector"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {entry ? (
          <ConnectorLogo entry={entry} size={20} glyphSize={16} />
        ) : (
          <span
            className="connector-logo"
            style={{ width: 20, height: 20 }}
            aria-hidden="true"
          >
            <Glyph size={16} />
          </span>
        )}
        <span className="skip-approvals-name" data-no-translate>
          {name}
        </span>
        {!open && count !== undefined && (
          <span className="skip-approvals-count">
            {count === 1 ? "1 tool" : formatText("{count} tools", { count })}
          </span>
        )}
        <span className={`skip-approvals-caret${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
      </button>
      {open && tools && (
        <ul className="skip-approvals-tools">
          {tools.map((tool) => (
            <li key={tool.name}>
              <span className="skip-approvals-name" data-no-translate>
                {tool.name}
              </span>
              {tool.approval === "approve" ? (
                <span className="skip-approvals-access">Already allowed</span>
              ) : tool.access ? (
                <span
                  className={`skip-approvals-access ${tool.access === "write" ? "write" : ""}`}
                >
                  {tool.access === "readOnly" ? "Read-only" : "Write/delete"}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Writing tools first, then read-only, then unmarked, then ones already allowed. */
function rank(tool: McpToolState) {
  return tool.approval === "approve"
    ? 3
    : tool.access === "write"
      ? 0
      : tool.access === "readOnly"
        ? 1
        : 2;
}

export function SkipAllApprovalsDialog({
  onCancel,
  onConfirm,
  connectors,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  connectors: string[];
}) {
  const [servers, setServers] = useState<McpServerState[]>([]);
  useEffect(() => {
    let live = true;
    void window.desktop
      .mcpServers()
      .then((result) => {
        if (live)
          setServers(
            result.servers.filter((server) => server.state !== "disabled"),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <Modal
      title="Skip all approvals?"
      onClose={onCancel}
      variant="confirm"
      confirmFocus="cancel"
      className="skip-approvals-dialog"
      titleIcon={<span className="skip-approvals-beta">Beta</span>}
    >
      <p>
        Claudex will work, browse the web, and use any connectors you’ve enabled
        without pausing for approval. This can put your data at risk.{" "}
        <a
          href={helpUrl("skip-approvals-safety")}
          onClick={(event) => {
            event.preventDefault();
            void window.desktop?.openExternal(helpUrl("skip-approvals-safety"));
          }}
        >
          Learn more
        </a>
      </p>
      {connectors.length > 0 && (
        <section>
          <h3>Connectors</h3>
          <ul>
            {connectors.map((name) => (
              <ConnectorRow
                key={name}
                name={name}
                server={servers.find((entry) => entry.name === name)}
              />
            ))}
          </ul>
        </section>
      )}
      <div className="button-row">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          Yes, continue
        </button>
      </div>
    </Modal>
  );
}
