import { useFavicons } from "../../research/useFavicons";
import { formatText, useLocale, t } from "../../i18n";
import { useContext, useRef, useState } from "react";
import { Globe, Pencil, Check } from "../../ui/glyphs";
import type { Project } from "../../../shared/types";
import {
  availableProjectTools,
  recommendedProjectTools,
  updateProjectTools,
  type ProjectTools,
} from "../../../shared/project-tools";
import { usePolicy } from "../../policy/PolicyContext";
import { ResearchIcon } from "../../research/ResearchIcon";
import { AppContext } from "../../app/AppContext";
import { Modal } from "../../ui/Controls";
import "./project-overview.css";

/** Project instructions. */
export function InstructionsDialog({
  project,
  onClose,
  onSave,
  onSaveTools,
  readOnly: readOnlyOverride,
}: {
  project: Project;
  /** Effective permission supplied by the owning project backend. */
  readOnly?: boolean;
  onClose: () => void;
  onSave: (instructions: string) => Promise<void>;
  onSaveTools?: (tools: ProjectTools) => Promise<void>;
}) {
  useLocale();
  const app = useContext(AppContext);
  const readOnly =
    readOnlyOverride === true ||
    (project.capabilities !== undefined &&
      project.capabilities?.canEditInstructions !== true);
  const currentReadOnly = useRef(readOnly);
  currentReadOnly.current = readOnly;
  const policy = usePolicy();
  const available = availableProjectTools(
    policy,
    app?.snapshot.settings.mcpServers ?? {},
  );
  const [selected, setSelected] = useState(() =>
    recommendedProjectTools(project.tools),
  );
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const recommendedIds = recommendedProjectTools(project.tools);
  const recommended = available.filter((tool) =>
    recommendedIds.includes(tool.id),
  );
  const [text, setText] = useState(project.instructions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tools, setTools] = useState(false);
  const alongside = t(
    "This will work alongside your <link>profile instructions</link> and the selected style in a chat.",
  ).split(/<link>|<\/link>/);
  if (tools && !readOnly) {
    return (
      <Modal
        title="Power your project with tools"
        className="prj-instructions-dialog"
        showClose={false}
        onClose={onClose}
      >
        <p className="prj-tools-description">
          Claudex can use tools to give you more relevant answers. You can turn
          them on or off in any chat.
        </p>
        <div className="prj-tools-list">
          {available.length === 0 ? (
            <p className="prj-tools-empty">No available tools.</p>
          ) : (
            [false, true].map((connectors) => {
              const rows = available.filter(
                (tool) => Boolean(tool.connector) === connectors,
              );
              return (
                rows.length > 0 && (
                  <section className="prj-tools-group" key={String(connectors)}>
                    <h3>{connectors ? "Connectors" : "Tools"}</h3>
                    <div className="prj-tools-rows">
                      {rows.map((tool) => (
                        <label className="prj-tool-row" key={tool.id}>
                          <span className="prj-tool-label">
                            <span className="prj-tool-icon">
                              {tool.connector ? (
                                <ProjectConnectorIcon
                                  name={tool.name}
                                  url={tool.url}
                                />
                              ) : tool.id === "builtin:web-search" ? (
                                <Globe size={20} />
                              ) : (
                                <ResearchIcon />
                              )}
                            </span>
                            <span
                              data-no-translate={
                                tool.connector ? true : undefined
                              }
                            >
                              {tool.connector ? tool.name : t(tool.name)}
                            </span>
                          </span>
                          <span className="prj-tool-checkbox">
                            <input
                              type="checkbox"
                              aria-label={
                                tool.connector ? tool.name : t(tool.name)
                              }
                              checked={selected.includes(tool.id)}
                              onChange={() => {
                                const checked = selected.includes(tool.id);
                                setSelected((current) =>
                                  checked
                                    ? current.filter((id) => id !== tool.id)
                                    : [...current, tool.id],
                                );
                                setRemoved((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(tool.id);
                                  else next.delete(tool.id);
                                  return next;
                                });
                              }}
                            />
                            <span aria-hidden="true">
                              <Check size={16} strokeWidth={3} />
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                )
              );
            })
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          {available.length > 0 && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                if (busy || currentReadOnly.current) return;
                setBusy(true);
                setError("");
                const settings = updateProjectTools(
                  project.tools,
                  available,
                  selected,
                  removed,
                );
                void Promise.resolve()
                  .then(async () => {
                    if (currentReadOnly.current) return;
                    if (onSaveTools) await onSaveTools(settings);
                    else
                      await window.desktop.saveProject({
                        ...project,
                        tools: settings,
                      });
                  })
                  .then(onClose)
                  .catch((reason) => {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                    setBusy(false);
                  });
              }}
            >
              Save
            </button>
          )}
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={readOnly ? "Project instructions" : "Set project instructions"}
      className="prj-instructions-dialog"
      showClose={false}
      onClose={onClose}
      wide
    >
      <form
        className="prj-instructions-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (currentReadOnly.current || busy || text === project.instructions)
            return;
          setBusy(true);
          setError("");
          void Promise.resolve()
            .then(() => {
              if (!currentReadOnly.current) return onSave(text);
            })
            .catch((reason) => {
              // The service's diagnostics stay out of the person's draft/error copy.
              console.error("Error saving project instructions", reason);
              setError("Error saving instructions, please try again later");
              setBusy(false);
            });
        }}
      >
        {!readOnly && (
          <p data-no-translate>
            {formatText(
              "Provide Claudex with relevant instructions and information for chats within {projectName}.",
              { projectName: project.name },
            )}
            {"\u00a0"}
            {alongside[0]}
            <a
              href="/settings/account"
              onClick={(event) => {
                event.preventDefault();
                app?.openSettingsTab("account");
              }}
            >
              {alongside[1]}
            </a>
            {alongside[2]}
          </p>
        )}
        <textarea
          autoFocus
          aria-label={
            readOnly ? "Project instructions" : "Set project instructions"
          }
          readOnly={readOnly}
          data-testid="custom-instructions-textarea"
          rows={16}
          required
          placeholder="Think step by step and show reasoning for complex problems. Use specific examples."
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {/* The recommended tools as tiles with an Edit button, or Add tools
           while there are none. */}
        {recommended.length > 0 ? (
          <div className="prj-recommended-tools">
            <p className="prj-recommended-title">{t("Recommended Tools:")}</p>
            <div className="prj-recommended-row">
              {recommended.map((tool) => (
                <span
                  key={tool.id}
                  className="prj-tool-icon prj-recommended-tile"
                  title={tool.connector ? tool.name : t(tool.name)}
                >
                  {tool.connector ? (
                    <ProjectConnectorIcon name={tool.name} url={tool.url} />
                  ) : tool.id === "builtin:web-search" ? (
                    <Globe size={20} />
                  ) : (
                    <ResearchIcon />
                  )}
                </span>
              ))}
              {!readOnly && (
                <button
                  type="button"
                  className="prj-recommended-edit"
                  aria-label={t("Edit recommended tools")}
                  onClick={() => setTools(true)}
                >
                  <Pencil size={16} strokeWidth={1.6} />
                </button>
              )}
            </div>
          </div>
        ) : (
          !readOnly && (
            <button
              type="button"
              className="prj-instructions-add-tools"
              onClick={() => setTools(true)}
            >
              Add tools
            </button>
          )
        )}
        {error && (
          <p className="error-text" role="alert">
            {t(error)}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button
              className="primary"
              disabled={busy || text === project.instructions}
            >
              {project.instructions.length > 0 && text.length === 0
                ? "Clear instructions"
                : "Save instructions"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function ProjectConnectorIcon({
  name,
  url,
}: {
  name: string;
  url?: string;
}) {
  let host = "";
  try {
    if (url) host = new URL(url).hostname;
  } catch {}
  const icon = useFavicons(host ? [host] : [])[host];
  return icon ? (
    <img className="prj-tool-connector-image" src={icon} alt="" />
  ) : (
    <span className="prj-tool-connector-initial" aria-hidden="true">
      {name.trim().at(0)?.toUpperCase()}
    </span>
  );
}
