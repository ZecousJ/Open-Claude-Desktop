import { useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { SettingsModal } from "../settings/controls";
import { presentationId } from "../ui/presentation-id";
import { pluginSlug, pluginNameTaken } from "../../shared/duplicate-name";
import { usePluginOwner, isPluginOperationRetired } from "./usePlugins";
import { sendPluginArchive } from "./plugin-archive";
import { PluginBundleEditor } from "./PluginBundleEditor";
import {
  initialPluginFiles,
  pluginArchiveFiles,
  pluginSkillSeed,
  starterSkillPath,
  type PluginDraftFile,
} from "./plugin-create-files";
import "./plugin-create.css";

type Props = { onClose(): void; onCreated(): void };
export function CreatePluginDialog(props: Props) {
  const owner = usePluginOwner();
  const key = useMemo(() => presentationId(), [owner.scope]);
  return <PluginCreateDraft key={key} {...props} owner={owner} />;
}

function PluginCreateDraft({
  onClose,
  onCreated,
  owner,
}: Props & { owner: ReturnType<typeof usePluginOwner> }) {
  const { bridge, current, ownsAccount } = owner;
  const saving = useRef(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState(initialPluginFiles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [leaving, setLeaving] = useState(false);
  const dirty =
    name !== "" ||
    description !== "" ||
    files.length !== 1 ||
    files[0].path !== starterSkillPath ||
    files[0].content !== pluginSkillSeed();
  const close = () => {
    if (!current() || saving.current) return;
    if (dirty) setLeaving(true);
    else onClose();
  };
  const save = async () => {
    if (
      !current() ||
      saving.current ||
      typeof bridge?.uploadPlugin !== "function"
    )
      return;
    const slug = pluginSlug(name);
    let archiveFiles: PluginDraftFile[];
    try {
      archiveFiles = pluginArchiveFiles(files, name, description);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const { default: JSZip } = await import("jszip");
      if (!current()) return;
      const zip = new JSZip();
      for (const file of archiveFiles)
        zip.file(file.path, file.content, { createFolders: false });
      const archive = new File(
        [
          await zip.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
          }),
        ],
        `${slug}.plugin`,
      );
      if (!current()) return;
      const result = await sendPluginArchive(
        archive,
        false,
        () => !current(),
        bridge,
        ownsAccount,
      );
      if (!current()) return;
      if (result.conflict) {
        setError(pluginNameTaken);
        return;
      }
      if (!result.pluginId) throw new Error(t("No plugins were added."));
      onCreated();
      if (current()) onClose();
    } catch (reason) {
      if (!current() || isPluginOperationRetired(reason)) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saving.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <>
      <SettingsModal
        title="Create a plugin"
        className="plugin-create-dialog"
        onClose={close}
        showClose={false}
      >
        <form
          className="plugin-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="plugin-create-metadata">
            <label className="directory-field">
              <span>{t("Plugin name")}</span>
              <input
                className="settings-input"
                disabled={busy}
                value={name}
                maxLength={64}
                placeholder="deal-desk-helper"
                onChange={(event) => setName(event.target.value)}
                onBlur={() => setName(pluginSlug(name))}
              />
            </label>
            <label className="directory-field">
              <span>{t("Description")}</span>
              <input
                className="settings-input"
                disabled={busy}
                value={description}
                placeholder={t("What this plugin helps with")}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
          <div className="plugin-create-toolbar">
            <span className="plugin-create-version">{t("v1 · draft")}</span>
            <div>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={close}
              >
                {t("Cancel")}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  !files.length ||
                  typeof bridge?.uploadPlugin !== "function"
                }
                aria-busy={busy}
              >
                {t("Save version")}
              </button>
            </div>
          </div>
          {error && (
            <p className="plugin-create-error" role="alert">
              {t(error)}
            </p>
          )}
          <PluginBundleEditor
            files={files}
            onChange={setFiles}
            busy={busy}
            current={current}
            onSave={() => void save()}
            onCancel={close}
          />
        </form>
      </SettingsModal>
      {leaving && (
        <SettingsModal
          title="Discard this draft?"
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setLeaving(false)}
        >
          <p className="confirm-body">
            {t("Your changes haven’t been saved and will be lost.")}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => setLeaving(false)}
            >
              {t("Keep editing")}
            </button>
            <button
              type="button"
              className="primary danger-button"
              onClick={() => {
                if (current() && !saving.current) onClose();
              }}
            >
              {t("Discard")}
            </button>
          </div>
        </SettingsModal>
      )}
    </>
  );
}
