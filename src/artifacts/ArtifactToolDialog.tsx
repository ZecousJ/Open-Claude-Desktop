import { useEffect, useState } from "react";
import type { ArtifactToolRequest } from "../../shared/artifact-tools";
import { artifactToolReadiness } from "../../shared/artifact-tool-readiness";
import {
  artifactToolDisplay,
  artifactToolPreview,
} from "../../shared/artifact-tools";
import { formatText, t } from "../i18n";
import { Modal } from "../ui/Controls";
import "./artifact-tool-dialog.css";

export function toolDisplay(value: string) {
  return artifactToolDisplay(value);
}

export function ArtifactToolDialog({
  request,
  busy,
  onDecision,
}: {
  request: ArtifactToolRequest;
  busy: boolean;
  onDecision: (allow: boolean) => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => artifactToolReadiness(document, setReady), [request.id]);
  const count = request.groups.reduce(
    (total, group) => total + group.tools.length,
    0,
  );
  const quote = (value: string) =>
    `“⁨${artifactToolDisplay(value.replace(/[\uD800-\uDFFF]/gu, "�"), 128)}⁩”`;
  const title =
    count === 1
      ? t("Let this artifact run these 1 tool?")
      : formatText("Let this artifact run these {count} tools?", { count });
  const description =
    request.groups.length === 1
      ? formatText(
          "These tools are from {connector}. Claudex may decide when this artifact runs them. After you allow them, this artifact can run them without asking.",
          { connector: quote(request.groups[0].server) },
        )
      : t(
          "Claudex may decide when this artifact runs these tools. After you allow them, this artifact can run them without asking.",
        );
  const input = artifactToolPreview(request.input);
  const argumentsLabel = formatText("This time it will run {tool} and send", {
    tool: quote(request.tool),
  });
  return (
    <Modal
      title={title}
      onClose={() => !busy && onDecision(false)}
      className="artifact-tool-dialog"
      disablePointerDismissal
      focusDialog
      titleIcon={
        <span className="artifact-tool-connector" aria-hidden="true">
          {[...toolDisplay(request.server)][0]?.toUpperCase() ?? "?"}
        </span>
      }
    >
      <p className="artifact-tool-description">{description}</p>
      <div className="artifact-tool-body">
        <div
          className="artifact-tool-list"
          role="region"
          aria-label={t("Tools to allow")}
          tabIndex={0}
        >
          {request.groups.map((group) => (
            <div className="artifact-tool-group" key={group.server}>
              {request.groups.length > 1 && (
                <div>
                  {formatText("From {connector}", {
                    connector: quote(group.server),
                  })}
                </div>
              )}
              <ul>
                {group.tools.map((tool) => (
                  <li dir="ltr" key={tool}>
                    {toolDisplay(tool)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="artifact-tool-input">
          <div>{argumentsLabel}</div>
          {input.shortened && (
            <p>{t("Only the start is shown. All of it will be sent.")}</p>
          )}
          {Object.keys(request.input).length ? (
            <div
              className="artifact-tool-args"
              role="region"
              dir="ltr"
              aria-label={argumentsLabel}
              tabIndex={0}
            >
              {input.rows ? (
                <dl>
                  {input.rows.map((row) => (
                    <div
                      className={row.stacked ? "stacked" : ""}
                      key={row.label}
                    >
                      <dt>{row.label}</dt>
                      <dd>{row.text}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <pre>{input.text}</pre>
              )}
            </div>
          ) : (
            <p>{t("Nothing — this call has no arguments.")}</p>
          )}
        </div>
      </div>
      <div className="artifact-tool-footer">
        <button
          className="secondary"
          disabled={busy || !ready}
          onClick={() => onDecision(false)}
        >
          {t("Cancel")}
        </button>
        <button
          className="primary"
          disabled={busy || !ready}
          onClick={() => onDecision(true)}
        >
          {t("Allow")}
        </button>
      </div>
    </Modal>
  );
}
