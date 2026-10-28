import { useState } from "react";
import { Check, ChevronRight } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { SshErrorCode, SshHost, SshHostInput } from "../../shared/ssh-api";
import { Modal } from "../ui/Controls";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import { formatText } from "../i18n";
import { errorExplanation, hostInputError, parsePort } from "./model";
import { sshDiagnosticMessage } from "../../shared/ssh-diagnostics";

type Test =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; platform?: string }
  | { state: "failed"; error: string; code?: SshErrorCode; details?: string };

/** The form's text fields; empty strings are left out of the saved host. */
interface Draft {
  /** The host's address or a ~/.ssh/config alias, without "user@". */
  address: string;
  user: string;
  /** A new password; empty keeps the saved one. */
  password: string;
  label: string;
  port: string;
  identityFile: string;
  defaultFolder: string;
  remoteRoot: string;
  sshPath: string;
}

/** "user@host" as the form's two fields (the last "@": a user may hold one). */
export function splitDestination(destination: string) {
  const at = destination.lastIndexOf("@");
  return at > 0
    ? { user: destination.slice(0, at), address: destination.slice(at + 1) }
    : { user: "", address: destination };
}

const draftOf = (host?: SshHost): Draft => ({
  ...splitDestination(host?.destination ?? ""),
  password: "",
  label: host && host.label !== host.destination ? host.label : "",
  port: host?.port ? String(host.port) : "",
  identityFile: host?.identityFile ?? "",
  defaultFolder: host?.defaultFolder ?? "",
  remoteRoot: host?.remoteRoot ?? "",
  sshPath: host?.sshPath ?? "",
});

/** The host the form describes, as the bridge takes it. */
export function hostInputFrom(draft: Draft, id?: string): SshHostInput {
  const text = (value: string) => value.trim() || undefined;
  const address = draft.address.trim();
  const user = draft.user.trim();
  const destination = user && address ? `${user}@${address}` : address;
  return {
    ...(id ? { id } : {}),
    destination,
    ...(draft.password ? { password: draft.password } : {}),
    label: draft.label.trim() || destination,
    port: parsePort(draft.port),
    identityFile: text(draft.identityFile),
    defaultFolder: text(draft.defaultFolder),
    remoteRoot: text(draft.remoteRoot),
    sshPath: text(draft.sshPath),
  };
}

/** Why a host was refused when its key changed (ssh's own words name a file the person need not open). */
export const hostKeyChangedText =
  "This host's identity changed since you last connected, for example because it was reinstalled. If you trust it, remove the old key and connect again.";

/**
 * Add SSH connection / Edit connection. * Host IP (an address, or an alias from
 * ~/.ssh/config as suggested) and Port, Username and Password, Name; Identity
 * file and Default folder moved into Advanced with where Claudex keeps its
 * files on the host and a different ssh program. The password is saved
 * encrypted on this computer (electron/ssh/password-store.ts) and answers ssh's
 * password question. Test connection reaches the host with the values as typed;
 * Add or Save stores it.
 */
export function AddSshHostDialog({
  host,
  suggestions,
  onTest,
  onSave,
  onForgetHostKey,
  onClose,
  onDelete,
  onDisconnect,
}: {
  host?: SshHost;
  suggestions: string[];
  onTest: (
    input: Pick<SshHost, "destination" | "port" | "identityFile"> & {
      sshPath?: string;
      password?: string;
      id?: string;
    },
  ) => Promise<{
    ok: boolean;
    platform?: string;
    error?: string;
    code?: SshErrorCode;
    details?: string;
  }>;
  onSave: (input: SshHostInput) => Promise<void>;
  /** Removes the host's old key from known_hosts (its key changed). */
  onForgetHostKey?: (
    input: Pick<SshHost, "destination" | "port" | "sshPath">,
  ) => Promise<unknown>;
  onClose: () => void;
  onDelete?: () => Promise<void>;
  onDisconnect?: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState(() => draftOf(host));
  const [advanced, setAdvanced] = useState(
    Boolean(
      host?.remoteRoot ||
      host?.sshPath ||
      host?.identityFile ||
      host?.defaultFolder,
    ),
  );
  /** Edit: the saved password is removed on Save. */
  const [clearPassword, setClearPassword] = useState(false);
  const [test, setTest] = useState<Test>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState("");
  const input = {
    ...hostInputFrom(draft, host?.id),
    ...(clearPassword && !draft.password ? { clearPassword: true } : {}),
  };
  const invalid = hostInputError(input);
  const field = (key: keyof Draft) => ({
    value: draft[key],
    spellCheck: false,
    autoCapitalize: "off",
    autoComplete: "off",
    onChange: (event: { target: { value: string } }) => {
      setDraft({ ...draft, [key]: event.target.value });
      setTest({ state: "idle" });
      setError("");
    },
  });
  const runTest = async () => {
    if (invalid) return setError(invalid);
    setTest({ state: "testing" });
    try {
      const result = await onTest({
        destination: input.destination,
        port: input.port,
        identityFile: input.identityFile,
        sshPath: input.sshPath,
        ...(draft.password ? { password: draft.password } : {}),
        ...(host && !clearPassword ? { id: host.id } : {}),
      });
      setTest(
        result.ok
          ? { state: "ok", platform: result.platform }
          : {
              state: "failed",
              error: result.error || "Couldn't connect to this host.",
              code: result.code,
              details: result.details,
            },
      );
    } catch (reason) {
      setTest({
        state: "failed",
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };
  const offered = suggestions.filter(
    (alias) =>
      alias !== draft.address &&
      alias.toLowerCase().includes(draft.address.trim().toLowerCase()),
  );
  if (deleting && host && onDelete)
    return (
      <ConfirmationDialog
        confirmation={{
          title: "Delete SSH connection?",
          body: formatText(
            "“{connectionName}” will be permanently deleted. This can’t be undone.",
            { connectionName: host.label },
          ),
          action: onDelete,
          confirm: "Delete",
          confirmFocus: "cancel",
        }}
        onClose={() => setDeleting(false)}
        onError={(reason) => {
          setDeleting(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }}
      />
    );
  return (
    <Modal
      title={host ? "Edit SSH connection" : "Add SSH connection"}
      onClose={onClose}
    >
      <form
        className="ssh-host-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving) return;
          if (invalid) return setError(invalid);
          setSaving(true);
          void onSave(input)
            .then(onClose)
            .catch((reason) => {
              setSaving(false);
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            });
        }}
      >
        <p className="ssh-host-intro">
          Claudex uses your computer's OpenSSH. A password is saved encrypted on
          this computer; an SSH key (Advanced) connects without one.
        </p>
        <div className="ssh-host-pair">
          <label>
            Host IP
            <input
              {...field("address")}
              required
              autoFocus
              maxLength={255}
              placeholder="e.g. 192.168.1.10"
            />
          </label>
          <label className="ssh-port">
            Port
            <input {...field("port")} inputMode="numeric" placeholder="22" />
          </label>
        </div>
        {offered.length > 0 && !host && (
          <div
            className="ssh-suggestions"
            aria-label="Hosts in your SSH config"
          >
            {offered.slice(0, 6).map((alias) => (
              <button
                key={alias}
                type="button"
                onClick={() => {
                  setDraft({ ...draft, ...splitDestination(alias) });
                  setTest({ state: "idle" });
                }}
              >
                {alias}
              </button>
            ))}
          </div>
        )}
        <div className="ssh-host-pair ssh-host-credentials">
          <label>
            Username
            <input {...field("user")} maxLength={100} placeholder="e.g. root" />
          </label>
          <label>
            Password
            <input
              {...field("password")}
              type="password"
              maxLength={1024}
              autoComplete="new-password"
              placeholder={
                host?.hasPassword && !clearPassword ? "Saved" : "Optional"
              }
            />
          </label>
        </div>
        {host?.hasPassword && !draft.password && (
          <button
            type="button"
            className="ssh-password-clear"
            onClick={() => setClearPassword(!clearPassword)}
          >
            {clearPassword
              ? "Keep the saved password"
              : "Remove the saved password"}
          </button>
        )}
        <label>
          Name
          <input
            {...field("label")}
            maxLength={100}
            placeholder={input.destination || "Optional"}
          />
        </label>
        <button
          type="button"
          className="ssh-advanced-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          <ChevronRight size={14} className={advanced ? "open" : ""} />
          Advanced
        </button>
        {advanced && (
          <>
            <label>
              Identity file
              <input
                {...field("identityFile")}
                placeholder="Optional, e.g. ~/.ssh/id_ed25519"
              />
            </label>
            <label>
              Default folder
              <input
                {...field("defaultFolder")}
                placeholder="Optional, e.g. ~/projects/app"
              />
            </label>
            <label>
              Remote folder for Claudex
              <input {...field("remoteRoot")} placeholder="~/.claudex-remote" />
            </label>
            <label>
              SSH program
              <input
                {...field("sshPath")}
                placeholder="The system's ssh, e.g. /usr/bin/ssh"
              />
            </label>
          </>
        )}
        {(error || test.state === "ok" || test.state === "failed") && (
          <p
            className={`ssh-test-result ${error || test.state === "failed" ? "failed" : "ok"}`}
            role="status"
          >
            {error ? (
              error
            ) : test.state === "ok" ? (
              <>
                <Check size={14} strokeWidth={2} />
                {test.platform ? `Connected · ${test.platform}` : "Connected"}
              </>
            ) : test.state === "failed" ? (
              test.code === "host-key-changed" ? (
                hostKeyChangedText
              ) : test.code && sshDiagnosticMessage(test.code) ? (
                errorExplanation(test.code, input.label || input.destination)
              ) : (
                test.error
              )
            ) : null}
          </p>
        )}
        {test.state === "failed" && test.details && (
          <details className="ssh-technical-details">
            <summary>Technical details</summary>
            <div data-no-translate>{test.details}</div>
          </details>
        )}
        {!error &&
          test.state === "failed" &&
          test.code === "host-key-changed" &&
          onForgetHostKey && (
            <button
              type="button"
              className="secondary ssh-forget-key"
              disabled={forgetting}
              onClick={() => {
                setForgetting(true);
                void onForgetHostKey({
                  destination: input.destination,
                  port: input.port,
                  sshPath: input.sshPath,
                })
                  .then(() => runTest())
                  .catch((reason) =>
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    ),
                  )
                  .finally(() => setForgetting(false));
              }}
            >
              {forgetting && (
                <Spinner inheritColor size={14} className="spin" />
              )}
              Remove the old key and try again
            </button>
          )}
        <div className="button-row">
          {host && onDelete && (
            <button
              type="button"
              className="secondary ssh-delete-connection"
              onClick={() => setDeleting(true)}
            >
              Delete connection
            </button>
          )}
          {onDisconnect && (
            <button type="button" className="secondary" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="secondary"
            disabled={test.state === "testing" || !draft.address.trim()}
            onClick={() => void runTest()}
          >
            {test.state === "testing" && (
              <Spinner inheritColor size={14} className="spin" />
            )}
            Test connection
          </button>
          <button
            type="submit"
            className="primary"
            disabled={saving || !draft.address.trim()}
          >
            {host ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
