import { helpUrl } from "../../../shared/help-links";
import { Suspense, useEffect, useState } from "react";
import { lazyPiece } from "../../ui/lazy-piece";
import type { Settings } from "../../../shared/types";
import type {
  DirectorySubmission,
  DirectorySubmissionInput,
} from "../../../shared/directory-submissions";
import {
  directorySubmissionReady,
  directorySubmissionStatusLabels,
  directorySubmissionSteps,
} from "../../../shared/directory-submissions";
import { formatText } from "../../i18n";
import "./directory-submissions.css";

const ConnectorUrlEditor = lazyPiece(() => import("./ConnectorUrlEditor"));

const blank = (kind: "plugin" | "mcp"): DirectorySubmissionInput => ({
  kind,
  name: "",
  slug: "",
  url: "",
  description: "",
  examples: "",
  email: "",
  license: "",
  termsAcknowledged: false,
  toolsVerified: false,
  tools: [],
});

export function DirectorySubmissionsPage({
  settings,
  kind,
  onBack,
}: {
  settings: Settings;
  kind?: "plugin" | "mcp";
  onBack: () => void;
}) {
  const [submissions, setSubmissions] = useState<DirectorySubmission[]>([]);
  const [input, setInput] = useState<DirectorySubmissionInput | undefined>(
    () => (kind ? blank(kind) : undefined),
  );
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = () =>
    window.desktop.listDirectorySubmissions().then(setSubmissions);
  useEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
  }, []);
  const change = (patch: Partial<DirectorySubmissionInput>) =>
    setInput((current) => current && { ...current, ...patch });
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const save = (submit: boolean) =>
    void act(async () => {
      if (!input) return;
      await window.desktop.saveDirectorySubmission(input, submit);
      await refresh();
      setInput(undefined);
    });
  const field = (
    key:
      | "name"
      | "slug"
      | "url"
      | "description"
      | "examples"
      | "email"
      | "license",
    label: string,
    multiline = false,
  ) => (
    <label key={key} className="directory-submission-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={input?.[key] ?? ""}
          disabled={busy}
          onChange={(event) => change({ [key]: event.target.value })}
        />
      ) : (
        <input
          value={input?.[key] ?? ""}
          disabled={busy}
          type={key === "email" ? "email" : "text"}
          onChange={(event) => change({ [key]: event.target.value })}
        />
      )}
    </label>
  );
  return (
    <div className="customize-view">
      <div className="customize-scroll">
        <div className="customize-column directory-submissions">
          <button type="button" onClick={onBack}>
            Back
          </button>
          <h1>
            {input
              ? input.kind === "plugin"
                ? "Submit a plugin"
                : "Submit an MCP connector"
              : "Submissions"}
          </h1>
          {error && <p role="alert">{error}</p>}
          {input ? (
            <>
              <nav aria-label="Submission progress">
                {directorySubmissionSteps.map((label, index) => (
                  <button
                    type="button"
                    key={label}
                    disabled={busy || index > step}
                    aria-current={step === index ? "step" : undefined}
                    onClick={() => setStep(index)}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {step === 0 && (
                <>
                  <p>Submitting this form does not guarantee inclusion.</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={input.termsAcknowledged}
                      disabled={busy}
                      onChange={(event) =>
                        change({ termsAcknowledged: event.target.checked })
                      }
                    />
                    <a
                      href={helpUrl("directory-terms")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Software Directory Terms
                    </a>
                  </label>
                </>
              )}
              {step === 1 && (
                <>
                  {field(
                    "name",
                    input.kind === "plugin" ? "Plugin name" : "Server",
                  )}
                  {field(
                    "url",
                    input.kind === "plugin" ? "Link to plugin" : "Server URL",
                  )}
                  {field("description", "Plugin description", true)}
                  {field("examples", "Example use cases", true)}
                  {input.kind === "mcp" && (
                    <>
                      <Suspense fallback={null}>
                        <ConnectorUrlEditor
                          input={input}
                          disabled={busy}
                          onChange={change}
                        />
                      </Suspense>
                      <label className="directory-submission-field">
                        <span>Server</span>
                        <select
                          value={input.serverName ?? ""}
                          disabled={busy}
                          onChange={(event) => {
                            const serverName = event.target.value;
                            const config = settings.mcpServers[serverName] as
                              { url?: string } | undefined;
                            change({
                              serverName,
                              url: config?.url ?? "",
                              tools: [],
                              toolsVerified: false,
                            });
                          }}
                        >
                          <option value="">Select</option>
                          {Object.entries(settings.mcpServers)
                            .filter(
                              ([, config]) =>
                                typeof (config as { url?: unknown })?.url ===
                                "string",
                            )
                            .map(([name]) => (
                              <option key={name}>{name}</option>
                            ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={busy || !input.serverName}
                        onClick={() =>
                          void act(async () => {
                            const tools =
                              await window.desktop.verifyDirectorySubmissionTools(
                                input.serverName!,
                              );
                            change({ tools, toolsVerified: false });
                          })
                        }
                      >
                        Refresh
                      </button>
                      <ul>
                        {input.tools.map((tool) => (
                          <li key={tool}>{tool}</li>
                        ))}
                      </ul>
                      <label>
                        <input
                          type="checkbox"
                          checked={input.toolsVerified}
                          disabled={busy || !input.tools.length}
                          onChange={(event) =>
                            change({ toolsVerified: event.target.checked })
                          }
                        />
                        I understand
                      </label>
                    </>
                  )}
                </>
              )}
              {step === 2 && (
                <>
                  {field("license", "License type")}
                  {field("email", "Submitter email")}
                </>
              )}
              <div className="directory-submission-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => save(false)}
                >
                  Save draft
                </button>
                {step > 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setStep(step - 1)}
                  >
                    Back
                  </button>
                )}
                {step < 2 ? (
                  <button
                    type="button"
                    disabled={busy || (step === 0 && !input.termsAcknowledged)}
                    onClick={() => setStep(step + 1)}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy || !directorySubmissionReady(input)}
                    onClick={() => save(true)}
                  >
                    Submit for review
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="directory-submission-actions">
                <button
                  type="button"
                  onClick={() => {
                    setInput(blank("plugin"));
                    setStep(0);
                  }}
                >
                  Submit a plugin
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInput(blank("mcp"));
                    setStep(0);
                  }}
                >
                  Submit an MCP connector
                </button>
              </div>
              {!submissions.length ? (
                <p>You haven’t submitted any plugins yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Plugin</th>
                      <th>Status</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {submissions.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.name || entry.slug}</td>
                        <td>
                          {directorySubmissionStatusLabels[entry.status]}
                          {entry.reviewerNote && (
                            <details>
                              <summary>Reviewer notes</summary>
                              <span className="directory-reviewer-note">
                                {entry.reviewerNote}
                              </span>
                            </details>
                          )}
                        </td>
                        <td>
                          {new Date(entry.updatedAt).toLocaleDateString()}
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={
                              busy ||
                              !["draft", "submitted"].includes(entry.status)
                            }
                            onClick={() => {
                              setInput(entry);
                              setStep(0);
                            }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  formatText("Delete {name}?", {
                                    name: entry.name,
                                  }),
                                )
                              )
                                void act(async () => {
                                  await window.desktop.deleteDirectorySubmission(
                                    entry.id,
                                  );
                                  await refresh();
                                });
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
