import { useState } from "react";
import { Spinner } from "../ui/Spinner";
import type { LaunchConfiguration } from "../../shared/browser";
import { Modal } from "../ui/Controls";
import { configFromDraft, draftOf, type ServerDraft } from "./browser-model";
import { formatText } from "../i18n";

/**
 * Add server: Name, Command, Port, URL and Working directory. The command is
 * split into the program and its arguments and never runs through a shell. Save
 * writes `.claude/launch.json` in the session's folder; Save and start also
 * starts it (the dialog shows the command, so the click is the person's
 * approval).
 */
export function AddServerDialog({
  initial,
  note,
  existingNames,
  onSave,
  onClose,
}: {
  /** A detected draft to start from. */
  initial?: LaunchConfiguration;
  /** A line above the form, e.g. "No dev server found in this folder." */
  note?: string;
  existingNames: readonly string[];
  onSave: (config: LaunchConfiguration, start: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ServerDraft>(() => draftOf(initial));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<"save" | "start">();
  const field = (key: keyof ServerDraft) => ({
    value: draft[key],
    spellCheck: false,
    autoCapitalize: "off",
    autoComplete: "off",
    onChange: (event: { target: { value: string } }) => {
      setDraft({ ...draft, [key]: event.target.value });
      setError("");
    },
  });
  const submit = (start: boolean) => {
    if (saving) return;
    const result = configFromDraft(draft, existingNames);
    if (!result.ok) return setError(result.message);
    setSaving(start ? "start" : "save");
    void onSave(result.config, start)
      .then(onClose)
      .catch((reason) => {
        setSaving(undefined);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };
  const port = draft.port.trim();
  return (
    <Modal title="Add server" onClose={onClose}>
      <form
        className="browser-server-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit(false);
        }}
      >
        {note && <p className="browser-form-note">{note}</p>}
        <div className="browser-form-pair">
          <label>
            Name
            <input {...field("name")} maxLength={64} placeholder="web" />
          </label>
          <label className="browser-form-port">
            Port
            <input {...field("port")} inputMode="numeric" placeholder="5173" />
          </label>
        </div>
        <label>
          Command
          <input
            {...field("command")}
            className="mono"
            placeholder="npm run dev"
          />
        </label>
        <label>
          URL
          <input
            {...field("url")}
            placeholder={formatText("Optional, http://localhost:{port}", {
              port: port || "5173",
            })}
          />
        </label>
        <label>
          Working directory
          <input
            {...field("cwd")}
            placeholder="Optional, a folder inside this session's folder"
          />
        </label>
        <p className="browser-form-note">
          Saved to .claude/launch.json in this folder. The server runs on this
          computer, outside the sandbox.
        </p>
        {error && (
          <p className="browser-form-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="secondary"
            disabled={Boolean(saving)}
            onClick={() => submit(true)}
          >
            {saving === "start" && (
              <Spinner inheritColor size={14} className="spin" />
            )}
            Save and start
          </button>
          <button type="submit" className="primary" disabled={Boolean(saving)}>
            {saving === "save" && (
              <Spinner inheritColor size={14} className="spin" />
            )}
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
