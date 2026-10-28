import { helpUrl } from "../../shared/help-links";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Controls";
import { SelectField } from "../settings/controls";
import { api } from "../desktop-api";
import {
  initialCloudEnvironment,
  type CloudEnvironmentConfig,
} from "../../shared/cloud-environments-api";
import { envFileLimit, envFileProblem } from "../../shared/env-file";
import { formatText, t, tc } from "../i18n";
import { showToast } from "../ui/toast-store";
import {
  domainsRequiredMessage,
  invalidDomainMessage,
  validAllowedDomain,
} from "../../shared/allowed-domain";
import {
  closeCloudEnvironmentEditor,
  refreshCloudEnvironments,
  saveCloudEnvironment,
} from "./cloud-environments";
import "./cloud-environment.css";

const variableExample =
  'NODE_ENV=production\nGIT_AUTHOR_NAME=Your Name\n\n# Multiline values - wrap in quotes\nCONFIG="key1=val1\nkey2=val2"';

/** Cloud form, archive and discard. */
export function CloudEnvironmentDialog({
  environment,
  onError,
}: {
  environment?: CloudEnvironmentConfig;
  onError: (error: unknown) => void;
}) {
  const [initial] = useState(
    environment ?? { ...initialCloudEnvironment, name: "" },
  );
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "archive">();
  const [domainsTouched, setDomainsTouched] = useState(false);
  const id = useId();
  const problem = envFileProblem(value.variables, {
    allowTrailingBareKey: true,
  });
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  // Custom access needs at least one domain, each a valid one.
  const domains = value.allowedDomains
    .map((domain) => domain.trim())
    .filter(Boolean);
  const domainsProblem =
    value.network !== "custom"
      ? undefined
      : !domains.length
        ? domainsRequiredMessage
        : domains.some((domain) => !validAllowedDomain(domain))
          ? invalidDomainMessage
          : undefined;
  const defaultList = t(
    "Also include <link>default list</link> of common package managers",
  ).split(/<link>|<\/link>/);
  const update = <Key extends keyof CloudEnvironmentConfig>(
    key: Key,
    next: CloudEnvironmentConfig[Key],
  ) => setValue((previous) => ({ ...previous, [key]: next }));
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirm("discard");
    else closeCloudEnvironmentEditor();
  };
  const perform = async (action: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      closeCloudEnvironmentEditor();
      showToast(t(done));
    } catch (error) {
      onError(error);
      setBusy(false);
    }
  };
  const submit = () => {
    if (!value.name.trim() || envFileProblem(value.variables) || domainsProblem)
      return setDomainsTouched(true);
    const { id: unused, updatedAt, ...input } = value;
    void perform(
      () =>
        saveCloudEnvironment({
          ...input,
          allowedDomains: domains,
          ...(environment ? { id: environment.id } : {}),
        }),
      environment ? "Environment updated." : "Cloud environment created",
    );
  };
  return createPortal(
    <>
      <Modal
        title={environment ? "Edit cloud environment" : "Add cloud environment"}
        className="cloud-environment-modal"
        onClose={requestClose}
        disablePointerDismissal={busy}
        showClose={!busy}
      >
        <form
          className="cloud-environment-editor"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="cloud-environment-fields">
            <div className="cloud-environment-field">
              <label htmlFor={`${id}-name`}>{t("Name")}</label>
              <input
                id={`${id}-name`}
                autoFocus
                required
                autoComplete="off"
                maxLength={200}
                placeholder={t("Default")}
                disabled={busy}
                readOnly={environment?.id === "default"}
                value={value.name}
                onChange={(event) => update("name", event.target.value)}
              />
            </div>
            <div className="cloud-environment-field">
              <span>{t("Network access")}</span>
              <SelectField
                label="Network access"
                value={value.network}
                disabled={busy}
                onChange={(network) => update("network", network)}
                menuWidth={320}
                options={[
                  {
                    value: "none",
                    label: t("None"),
                    description: t(
                      "Blocks internet access for maximum security.",
                    ),
                  },
                  {
                    value: "trusted",
                    label: t("Trusted"),
                    badge: t("Recommended"),
                    description: t("Downloads packages from verified sources."),
                  },
                  {
                    value: "custom",
                    label: t("Custom"),
                    description: t("Create a list of allowed domains."),
                  },
                  {
                    value: "full",
                    label: tc("network access", "Full"),
                    description: t(
                      "Unrestricted internet access for maximum flexibility.",
                    ),
                  },
                ]}
              />
              {value.network === "custom" && (
                <>
                  <label htmlFor={`${id}-domains`}>
                    {t("Allowed domains")}
                  </label>
                  <textarea
                    id={`${id}-domains`}
                    rows={4}
                    placeholder={"example.com\n*.example.com"}
                    disabled={busy}
                    value={value.allowedDomains.join("\n")}
                    aria-invalid={
                      domainsTouched && domainsProblem ? true : undefined
                    }
                    aria-describedby={
                      domainsTouched && domainsProblem
                        ? `${id}-domains-problem`
                        : undefined
                    }
                    onBlur={() => setDomainsTouched(true)}
                    onChange={(event) =>
                      update("allowedDomains", event.target.value.split("\n"))
                    }
                  />
                  {domainsTouched && domainsProblem && (
                    <p id={`${id}-domains-problem`} role="alert">
                      {t(domainsProblem)}
                    </p>
                  )}
                  <label className="cloud-environment-checkbox">
                    <input
                      type="checkbox"
                      checked={value.includeDefaultDomains}
                      disabled={busy}
                      onChange={(event) =>
                        update("includeDefaultDomains", event.target.checked)
                      }
                    />
                    <span>
                      {defaultList[0]}
                      <a
                        href={helpUrl("cloud-environments")}
                        onClick={(event) => {
                          event.preventDefault();
                          void api
                            .openExternal(event.currentTarget.href)
                            .catch(onError);
                        }}
                      >
                        {defaultList[1]}
                      </a>
                      {defaultList[2]}
                    </span>
                  </label>
                </>
              )}
            </div>
            <div className="cloud-environment-field">
              <label htmlFor={`${id}-script`}>{t("Setup script")}</label>
              <p>
                {t(
                  "Bash script that runs when a new session starts, before Claudex Code launches.",
                )}
              </p>
              <textarea
                id={`${id}-script`}
                dir="ltr"
                data-1p-ignore="true"
                data-lpignore="true"
                className="cloud-environment-script"
                rows={10}
                spellCheck={false}
                autoComplete="off"
                placeholder={"#!/bin/bash\nnpm install"}
                disabled={busy}
                value={value.setupScript}
                onChange={(event) => update("setupScript", event.target.value)}
              />
            </div>
            <div className="cloud-environment-field">
              <label htmlFor={`${id}-variables`}>
                {t("Environment variables")}
              </label>
              <textarea
                id={`${id}-variables`}
                dir="ltr"
                data-1p-ignore="true"
                data-lpignore="true"
                rows={6}
                spellCheck={false}
                autoComplete="off"
                placeholder={variableExample}
                maxLength={envFileLimit}
                disabled={busy}
                value={value.variables}
                aria-invalid={problem ? true : undefined}
                onChange={(event) => update("variables", event.target.value)}
              />
              <p>
                {t(
                  "In .env format. These are visible to anyone using this environment — don’t add secrets or credentials.",
                )}
              </p>
              {problem && (
                <p role="alert">
                  {formatText(problem.message, problem.values)}
                </p>
              )}
            </div>
          </div>
          <div className="button-row">
            {environment && environment.id !== "default" && (
              <button
                type="button"
                className="cloud-environment-archive"
                disabled={busy}
                onClick={() => setConfirm("archive")}
              >
                {t("Archive environment")}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={requestClose}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !value.name.trim() ||
                Boolean(envFileProblem(value.variables)) ||
                Boolean(domainsProblem) ||
                Boolean(environment && !dirty)
              }
            >
              {t(
                environment
                  ? "Save changes"
                  : busy
                    ? "Creating..."
                    : "Add environment",
              )}
            </button>
          </div>
        </form>
      </Modal>
      {confirm && (
        <Modal
          title={
            confirm === "discard"
              ? "Discard unsaved changes?"
              : "Archive environment?"
          }
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setConfirm(undefined)}
        >
          <p>
            {t(
              confirm === "discard"
                ? "Your changes haven’t been saved and will be lost."
                : "Archived environments are hidden and can’t be used to start new sessions. Existing sessions will continue to work.",
            )}
          </p>
          {confirm === "archive" && <p>{t("This can’t be undone.")}</p>}
          <div className="button-row">
            <button className="secondary" onClick={() => setConfirm(undefined)}>
              {t(confirm === "discard" ? "Keep editing" : "Cancel")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm === "discard") closeCloudEnvironmentEditor();
                else if (environment)
                  void perform(async () => {
                    await api.archiveCloudEnvironment(environment.id);
                    await refreshCloudEnvironments();
                  }, "Environment archived.");
              }}
            >
              {t(confirm === "discard" ? "Discard" : "Archive")}
            </button>
          </div>
        </Modal>
      )}
    </>,
    document.body,
  );
}
