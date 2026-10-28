import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SettingsModal } from "../settings/controls";
import { formatText, t } from "../i18n";
import { showToast } from "../ui/toast-store";
import {
  acceptsPluginArchive,
  pluginArchiveRule,
} from "../../shared/plugin-upload";
import { usePluginOwner } from "./usePlugins";
import "./plugin-upload.css";
import { sendPluginArchive, previewPluginArchive } from "./plugin-archive";
import { pluginUploadView } from "./PluginUploadView";

export type Row = {
  file: File;
  state:
    | "ready"
    | "waiting"
    | "uploading"
    | "added"
    | "taken"
    | "failed"
    | "skipped";
  message?: string;
};

/** Upload plugins. */
export function PluginUploadDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: () => void;
}) {
  const { current } = usePluginOwner();
  const [batch, setBatch] = useState(false);
  const close = () => {
    if (current()) onClose();
  };
  return (
    <SettingsModal
      title={batch ? "Upload plugins" : "Upload a plugin"}
      className="plugin-upload-modal"
      onClose={close}
    >
      <PluginUploadContents
        onClose={close}
        onUploaded={onUploaded}
        onBatchChange={setBatch}
      />
    </SettingsModal>
  );
}

export function UploadPageGroup({
  page,
  className,
  children,
}: {
  page: boolean;
  className: string;
  children: ReactNode;
}) {
  return page ? <div className={className}>{children}</div> : <>{children}</>;
}

export function PluginUploadContents({
  onClose,
  onUploaded,
  onBatchChange,
  presentation = "dialog",
  notifyCommittedAfterClose = false,
}: {
  onClose: () => void;
  onUploaded: () => void;
  onBatchChange?: (batch: boolean) => void;
  presentation?: "dialog" | "page";
  /** Page caller supplies an account-owned refresh, never a navigation. */
  notifyCommittedAfterClose?: boolean;
}) {
  const { scope, bridge, current: ownsUpload, ownsAccount } = usePluginOwner();
  const [rows, setRows] = useState<Row[]>([]);
  useLayoutEffect(() => {
    setRows([]);
    setFailure("");
    setPhase("editing");
    setReplacing(undefined);
    setPreview(undefined);
    if (input.current) input.current.value = "";
  }, [scope]);
  useEffect(
    () => onBatchChange?.(rows.length > 1),
    [rows.length, onBatchChange],
  );
  const [phase, setPhase] = useState<"editing" | "saving" | "done">("editing");
  const [failure, setFailure] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [replacing, setReplacing] = useState<Row>();
  const [preview, setPreview] =
    useState<Awaited<ReturnType<typeof previewPluginArchive>>>();
  const file = rows.length === 1 ? rows[0].file : undefined;
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    if (file)
      void previewPluginArchive(file).then((value) => {
        if (active && ownsUpload()) setPreview(value);
      });
    return () => {
      active = false;
    };
  }, [file, scope]);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const update = (file: File, state: Row["state"], message?: string) => {
    if (mounted.current && ownsUpload())
      setRows((current) =>
        current.map((row) =>
          row.file === file ? { file, state, message } : row,
        ),
      );
  };
  const pick = (files: File[]) => {
    if (!ownsUpload()) return;
    const accepted = files.filter(acceptsPluginArchive);
    const excluded = files.length - accepted.length;
    if (rows.length + accepted.length > 20) {
      setFailure("You can upload up to 20 plugin files at a time.");
      return;
    }
    setFailure(
      excluded
        ? accepted.length === 0
          ? pluginArchiveRule
          : formatText(
              excluded === 1
                ? "1 file was left out: each must be a .zip or .plugin file under 200 MB."
                : "{count} files were left out: each must be a .zip or .plugin file under 200 MB.",
              { count: excluded },
            )
        : "",
    );
    setRows((current) => [
      ...current,
      ...accepted.map((file): Row => ({ file, state: "ready" })),
    ]);
  };
  const send = async (row: Row, overwrite = false) => {
    update(row.file, "uploading");
    try {
      const result = await sendPluginArchive(
        row.file,
        overwrite,
        () => !mounted.current || !ownsUpload(),
        bridge,
        ownsAccount,
      );
      if (!result.conflict && !result.pluginId)
        throw new Error(t("No plugins were added."));
      update(row.file, result.conflict ? "taken" : "added", result.conflict);
      return Boolean(result.pluginId);
    } catch (error) {
      update(
        row.file,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  };
  const run = async (batch: Row[], overwrite = false) => {
    if (!ownsUpload() || phase === "saving" || !batch.length) return;
    setPhase("saving");
    setFailure("");
    batch.forEach((row) => update(row.file, "waiting"));
    let added = 0;
    let completed = 0;
    for (const row of batch) {
      if (!mounted.current || !ownsUpload()) break;
      setProgress({ current: completed + 1, total: batch.length });
      const installed = await send(row, overwrite);
      if (installed) added++;
      if (!mounted.current && !installed) break;
      completed++;
    }
    if (ownsAccount() && !mounted.current && completed < batch.length)
      showToast(
        formatText(
          batch.length - completed === 1
            ? "Upload stopped — 1 plugin was not uploaded"
            : "Upload stopped — {remaining} plugins were not uploaded",
          { remaining: batch.length - completed },
        ),
      );
    if (!ownsUpload()) {
      if (notifyCommittedAfterClose && added && ownsAccount()) onUploaded();
      return;
    }
    if (added) {
      showToast(
        formatText(
          added === batch.length
            ? added === 1
              ? "1 plugin installed and ready to use."
              : "{count} plugins installed and ready to use."
            : "Uploaded {count} of {total} plugins.",
          { count: added, total: batch.length },
        ),
      );
      onUploaded();
    }
    if (!ownsUpload()) return;
    if (
      mounted.current &&
      added === batch.length &&
      rows.every((row) => row.state === "added" || batch.includes(row))
    )
      onClose();
    if (mounted.current) setPhase("done");
  };
  const ready = rows.filter((row) => row.state === "ready");
  const retry = rows.filter(
    (row) => row.state === "failed" || row.state === "waiting",
  );
  const added = rows.filter((row) => row.state === "added").length;
  const attention = rows.filter(
    (row) =>
      row.state === "taken" ||
      row.state === "failed" ||
      row.state === "waiting",
  ).length;
  const busy = phase === "saving";
  const replaceNote = t(
    "To keep both, you can rename your local plugin in its <code>plugin.json</code> before uploading.",
  ).split(/<code>|<\/code>/);
  const FileHeading = presentation === "page" ? "h3" : "strong";
  const pluginUploadViewView = pluginUploadView({
    FileHeading,
    added,
    attention,
    busy,
    failure,
    input,
    onClose,
    ownsUpload,
    phase,
    pick,
    presentation,
    preview,
    progress,
    ready,
    replaceNote,
    replacing,
    retry,
    rows,
    run,
    setFailure,
    setReplacing,
    setRows,
    update,
  });
  return pluginUploadViewView;
}
