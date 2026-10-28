import type { DirectorySubmissionInput } from "../../../shared/directory-submissions";
import {
  connectorConfigurationError,
  templateConnectorUrl,
  type ServerUrlType,
} from "../../../shared/connector-url-configuration";
import { formatText, t } from "../../i18n";
import "./connector-url-editor.css";

// Submission URL configuration.
export default function ConnectorUrlEditor({
  input,
  disabled,
  onChange,
}: {
  input: DirectorySubmissionInput;
  disabled: boolean;
  onChange: (patch: Partial<DirectorySubmissionInput>) => void;
}) {
  const type = input.serverUrlType ?? "universal";
  const change = (patch: Partial<DirectorySubmissionInput>) => {
    onChange({ ...patch, toolsVerified: false });
  };
  const userConfig = input.remoteUserConfig ?? {
    title: "",
    description: "",
    placeholder: "",
    pattern: "^[a-z0-9-]{1,63}$",
  };
  const address =
    type === "regex"
      ? (input.testServerUrl ?? "")
      : type === "template"
        ? templateConnectorUrl(input)
        : input.url;
  const error = connectorConfigurationError(input, address);
  const cards: { value: ServerUrlType; label: string; description: string }[] =
    [
      {
        value: "multiple",
        label: "Multiple URLs",
        description:
          "Users pick from a fixed list of URLs (e.g. regional endpoints).",
      },
      {
        value: "regex",
        label: "URL pattern",
        description:
          "Users enter their own URL matching a regex (e.g. per-tenant subdomain).",
      },
      {
        value: "template",
        label: "Per-customer URL",
        description:
          "Each customer’s URL differs by one part, like a subdomain or org id (e.g. Salesforce My Domain).",
      },
    ];
  const field = (
    key: "remoteUrlRegex" | "testServerUrl" | "remoteUrlTemplate",
    label: string,
    hint: string,
    placeholder: string,
    maxLength: number,
  ) => (
    <label className="directory-submission-field">
      <span>{label}</span>
      <input
        className="connector-url-mono"
        dir="ltr"
        value={input[key] ?? ""}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => change({ [key]: event.target.value })}
      />
      <small>{hint}</small>
    </label>
  );
  return (
    <section className="connector-url-editor">
      <h3>
        <span>URL configuration</span> <small>Optional</small>
      </h3>
      <label>
        <input
          type="checkbox"
          checked={type !== "universal"}
          disabled={disabled}
          onChange={(event) =>
            change({
              serverUrlType: event.target.checked ? "multiple" : "universal",
            })
          }
        />{" "}
        <span>Users connect to different URLs</span>
      </label>
      {type !== "universal" && (
        <div className="connector-url-options">
          <fieldset disabled={disabled}>
            <legend>How do users’ URLs differ?</legend>
            {cards.map((card) => (
              <label className="connector-url-card" key={card.value}>
                <input
                  type="radio"
                  name="server-url-type"
                  value={card.value}
                  checked={type === card.value}
                  onChange={() => change({ serverUrlType: card.value })}
                />
                <span>
                  <strong>{card.label}</strong>
                  <small>{card.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {type === "multiple" && (
            <label className="directory-submission-field">
              <span>Allowed URLs</span>
              <textarea
                dir="ltr"
                rows={4}
                disabled={disabled}
                defaultValue={(input.remoteUrlOptions ?? [])
                  .map((option) => option.url)
                  .join("\n")}
                placeholder={
                  "https://us.mcp.example.com/mcp\nhttps://eu.mcp.example.com/mcp"
                }
                onChange={(event) =>
                  change({
                    remoteUrlOptions: event.target.value
                      .split("\n")
                      .map((url) => url.trim())
                      .filter(Boolean)
                      .map((url) => ({ label: url, url })),
                  })
                }
              />
              <small>One URL per line.</small>
            </label>
          )}
          {type === "regex" && (
            <>
              {field(
                "remoteUrlRegex",
                "URL regex",
                "Anchored regex users’ URLs must match.",
                "^https://[a-z0-9-]+\\.mcp\\.example\\.com/mcp$",
                200,
              )}
              {field(
                "testServerUrl",
                "Test URL",
                "A real URL matching the pattern, used to verify your server during review.",
                "https://acme.mcp.example.com/mcp",
                2048,
              )}
            </>
          )}
          {type === "template" && (
            <>
              {field(
                "remoteUrlTemplate",
                "URL template",
                formatText(
                  "Your server URL, with the part each customer fills in written as {example}.",
                  { example: "${user_config.key}" },
                ),
                "https://${user_config.org}.example.com/mcp",
                400,
              )}
              {(
                [
                  ["title", "Title", 80],
                  ["description", "Description", 120],
                  ["placeholder", "Placeholder", 253],
                ] as const
              ).map(([key, label, maxLength]) => (
                <label className="directory-submission-field" key={key}>
                  <span>{label}</span>
                  <input
                    disabled={disabled}
                    maxLength={maxLength}
                    value={userConfig[key]}
                    onChange={(event) =>
                      change({
                        remoteUserConfig: {
                          ...userConfig,
                          [key]: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
              <label className="directory-submission-field">
                <span>Allowed characters</span>
                <select
                  disabled={disabled}
                  value={
                    userConfig.pattern === "^[a-z0-9-]{1,63}$"
                      ? "lowercase"
                      : userConfig.pattern === "^[A-Za-z0-9-]{1,63}$"
                        ? "mixed"
                        : "custom"
                  }
                  onChange={(event) =>
                    change({
                      remoteUserConfig: {
                        ...userConfig,
                        pattern:
                          event.target.value === "lowercase"
                            ? "^[a-z0-9-]{1,63}$"
                            : event.target.value === "mixed"
                              ? "^[A-Za-z0-9-]{1,63}$"
                              : "",
                      },
                    })
                  }
                >
                  <option value="lowercase">Lowercase</option>
                  <option value="mixed">Mixed case</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {!["^[a-z0-9-]{1,63}$", "^[A-Za-z0-9-]{1,63}$"].includes(
                userConfig.pattern,
              ) && (
                <label className="directory-submission-field">
                  <span>Pattern</span>
                  <input
                    className="connector-url-mono"
                    disabled={disabled}
                    maxLength={200}
                    value={userConfig.pattern}
                    onChange={(event) =>
                      change({
                        remoteUserConfig: {
                          ...userConfig,
                          pattern: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              )}
            </>
          )}
          {error && (
            <p className="error-text" role="alert">
              {t(error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
