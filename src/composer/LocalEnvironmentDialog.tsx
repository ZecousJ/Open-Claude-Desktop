import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Controls";
import { api } from "../desktop-api";
import { envFileLimit, envFileProblem } from "../../shared/env-file";
import { formatText, t } from "../i18n";
import "./local-environment.css";

/** The example the original's empty editor shows as its placeholder. */
const example = [
  "NODE_ENV=production",
  "GIT_AUTHOR_NAME=Your Name",
  "",
  "# Multiline values - wrap in quotes",
  'CONFIG="key1=val1',
  'key2=val2"',
].join("\n");

const envFormatUrl =
  "https://github.com/motdotla/dotenv#what-rules-are-there-for-the-syntax-of-env-files";

/**
 * Local ▾ → Edit local environment: one Environment variables field in .env
 * format. The variables reach the agent runtime the next time it starts
 * (electron/engine.ts), so Code sessions on this computer see them. Save
 * changes is always white, as in the cloud editor's capture.
 */
export function LocalEnvironmentDialog({
  value,
  onSave,
  onClose,
}: {
  value: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(value);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const changed = text !== value;
  // The original checks as you type (a last bare name is still being
  // written) and will not save text that does not parse.
  const shown = envFileProblem(text, { allowTrailingBareKey: true });
  const blocked = Boolean(envFileProblem(text));
  const [before, rest = ""] = t(
    "In <a>.env format</a>. These are stored securely and passed to Claudex sessions.",
  ).split("<a>");
  const [linked, after = ""] = rest.split("</a>");
  return createPortal(
    <Modal title="Edit local environment" onClose={onClose}>
      <form
        className="local-environment"
        onSubmit={(event) => {
          event.preventDefault();
          if (saving || blocked) return;
          if (!changed) return onClose();
          setSaving(true);
          void onSave(text)
            .then(onClose)
            .catch(() => setSaving(false));
        }}
      >
        <label htmlFor={id}>Environment variables</label>
        <textarea
          id={id}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          maxLength={envFileLimit}
          placeholder={example}
          value={text}
          aria-invalid={shown ? true : undefined}
          aria-describedby={`${id}-note`}
          onChange={(event) => setText(event.target.value)}
        />
        {shown ? (
          <p id={`${id}-note`} className="local-environment-error" role="alert">
            {formatText(shown.message, shown.values)}
          </p>
        ) : (
          <p id={`${id}-note`} className="local-environment-note">
            {before}
            <a
              href={envFormatUrl}
              onClick={(event) => {
                event.preventDefault();
                void api.openExternal(envFormatUrl);
              }}
            >
              {linked}
            </a>
            {after}
          </p>
        )}
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={saving || blocked}
          >
            Save changes
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
}
