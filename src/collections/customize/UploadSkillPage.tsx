import { useSettingsRequestScope } from "../../settings/useSettingsRequestScope";
import type { SkillUploadCapabilitiesAPI } from "../../../shared/customize-search";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleCheck, File, Upload, X } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import { formatText } from "../../i18n";
import { WarningIcon } from "../../policy/GlobalLimitToast";
import { ConfirmationDialog } from "../../dialogs/ConfirmationDialog";
import {
  acceptsSkillFile,
  skillFileTypes,
  skillExistsName,
} from "../../../shared/skill-upload";
export { acceptsSkillFile, skillFileTypes } from "../../../shared/skill-upload";
import {
  formatFileSize,
  leftOutMessage,
  previewSkillFile,
  type SkillPreview,
} from "./skill-preview";
import "./upload-skill.css";

/** Files the page takes: a SKILL.md-style .md, or a .zip / .skill archive. */

/**
 * Where a chosen file stands once Upload runs (the original's per-file row:
 * Waiting, Uploading..., Added, a name that is taken with Replace and Skip,
 * a failure with Try again, Skipped).
 */
type FileState =
  | { kind: "waiting" }
  | { kind: "uploading" }
  | { kind: "added"; name: string }
  | { kind: "taken"; name: string }
  | { kind: "failed"; message: string }
  | { kind: "skipped" };

/**
 * Upload a skill: back to Your skills, the title and line, a drop zone that
 * also browses (several files at once), then, once files are chosen, a card per
 * file (icon, name, size, remove), a red banner when a file cannot be a skill,
 * the two format rules, a Preview card with the skill's name and description,
 * the Security scan row, and Upload / Cancel. While uploading the Upload button
 * shows only a spinner and Cancel is disabled. Uploaded contents are checked in
 * the main process before replacing any installed files.
 */
export function UploadSkillPage({
  onBack,
  onUploaded,
}: {
  onBack: () => void;
  onUploaded: (names: string[]) => void;
}) {
  const requestScope = useSettingsRequestScope();
  const [scan, setScan] = useState<{ key: number; enabled: boolean }>();
  useEffect(() => {
    const request = requestScope.capture();
    const bridge = request.bridge as typeof request.bridge &
      Partial<SkillUploadCapabilitiesAPI>;
    if (!bridge?.skillUploadCapabilities) return;
    void bridge
      .skillUploadCapabilities()
      .then((value) => {
        if (request.current())
          setScan({
            key: requestScope.key,
            enabled: value?.securityScan === true,
          });
      })
      .catch(() => {
        if (request.current())
          setScan({ key: requestScope.key, enabled: false });
      });
  }, [requestScope.key]);
  const scanning = scan?.key === requestScope.key && scan.enabled;
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Per-file progress once Upload has run; a file not in it is not sent yet. */
  const [states, setStates] = useState<Map<File, FileState>>(new Map());
  const [phase, setPhase] = useState<"editing" | "saving" | "done">("editing");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [replacing, setReplacing] = useState<{ file: File; name: string }>();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [previews, setPreviews] = useState<Map<File, SkillPreview>>(new Map());
  /** The banner's message once its cross was pressed. */
  const [dismissed, setDismissed] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const peeked = useRef(new Set<File>());
  // Each chosen file is peeked at once for its Preview card and any plain
  // defect; the installation still checks everything again in the main process.
  useEffect(() => {
    for (const file of files) {
      if (peeked.current.has(file)) continue;
      peeked.current.add(file);
      void previewSkillFile(file).then((preview) =>
        setPreviews((current) => new Map(current).set(file, preview)),
      );
    }
  }, [files]);
  const add = (list: FileList | null) => {
    if (!list) return;
    const chosen = [...list];
    const refused = chosen.filter((file) => !acceptsSkillFile(file.name));
    if (
      files.length +
        chosen.filter((file) => acceptsSkillFile(file.name)).length >
      20
    ) {
      setError("You can upload up to 20 skill files at a time.");
      setDismissed("");
      return;
    }
    setError(
      refused.length ? leftOutMessage(refused.length, chosen.length) : "",
    );
    setDismissed("");
    setFiles((current) => [
      ...current,
      ...chosen.filter(
        (file) =>
          acceptsSkillFile(file.name) &&
          !current.some((known) => known.name === file.name),
      ),
    ]);
  };
  const setState = (file: File, state: FileState) =>
    setStates((current) => new Map(current).set(file, state));
  /** Sends one file; a name that is taken stays a row to decide on. */
  const send = async (
    file: File,
    replace = false,
  ): Promise<string | undefined> => {
    setState(file, { kind: "uploading" });
    try {
      const [name] = await window.desktop.installSkillFiles(
        [{ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }],
        replace ? { replace: true } : undefined,
      );
      if (mounted.current) setState(file, { kind: "added", name });
      return name;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const taken = skillExistsName(message);
      if (mounted.current)
        setState(
          file,
          taken ? { kind: "taken", name: taken } : { kind: "failed", message },
        );
    }
  };
  /** The names added so far, in the order of the files. */
  const addedNames = (current: Map<File, FileState>) =>
    files.flatMap((file) => {
      const state = current.get(file);
      return state?.kind === "added" ? [state.name] : [];
    });
  const upload = async () => {
    setBusy(true);
    setPhase("saving");
    setError("");
    setDismissed("");
    const remaining = files.filter((file) => !settled(states.get(file)));
    setStates(
      (current) =>
        new Map([
          ...current,
          ...remaining.map(
            (file) => [file, { kind: "waiting" } as FileState] as const,
          ),
        ]),
    );
    const added: string[] = [];
    for (const [index, file] of remaining.entries()) {
      if (!mounted.current) return;
      setProgress({ current: index + 1, total: remaining.length });
      const name = await send(file);
      if (name) added.push(name);
    }
    if (!mounted.current) return;
    setBusy(false);
    setPhase("done");
    // Everything went in: back to the list at once.
    if (added.length === remaining.length)
      onUploaded([...addedNames(states), ...added]);
  };
  /** Try again on a failed row, or Replace on a taken one. */
  const resend = async (file: File, replace: boolean) => {
    setBusy(true);
    const name = await send(file, replace);
    if (!mounted.current) return;
    setBusy(false);
    if (name && files.every((f) => f === file || settled(states.get(f))))
      onUploaded([...addedNames(states), name]);
  };
  /** A row that needs nothing more from the person. */
  const settled = (state?: FileState) =>
    state?.kind === "added" || state?.kind === "skipped";
  const finish = () => {
    const names = addedNames(states);
    if (names.length) onUploaded(names);
    else onBack();
  };
  // The banner names the first thing wrong: the last refusal, else the first
  // chosen file that plainly is not a skill.
  const banner =
    error ||
    files
      .map((file) => previews.get(file)?.error)
      .find((message): message is string => !!message) ||
    "";
  return (
    <div className="upload-skill">
      <button type="button" className="upload-skill-back" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.6} />
        Your skills
      </button>
      <h1>{files.length > 1 ? "Upload skills" : "Upload a skill"}</h1>
      <p className="upload-skill-lead">
        {files.length > 1
          ? "Add skills to your workspace."
          : "Add a skill to your workspace."}
      </p>
      <h2>Skill file</h2>
      {files.length === 0 && (
        <div
          className={`upload-skill-drop ${over ? "over" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Choose skill files"
          onClick={() => input.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            add(event.dataTransfer.files);
          }}
        >
          <Upload size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>
            Drag and drop skill files here, or browse — you can add several at
            once
          </span>
        </div>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={skillFileTypes.join(",")}
        onChange={(event) => {
          add(event.target.files);
          event.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="upload-skill-files" aria-label="Chosen files">
          {files.map((file) => (
            <li key={file.name}>
              <File size={16} strokeWidth={1.3} aria-hidden="true" />
              <span className="upload-skill-file-name">{file.name}</span>
              <small>{formatFileSize(file.size)}</small>
              {phase !== "editing" && (
                <FileStatus
                  state={states.get(file)}
                  busy={busy}
                  fileName={file.name}
                  onReplace={(name) => setReplacing({ file, name })}
                  onSkip={() => setState(file, { kind: "skipped" })}
                  onRetry={() => void resend(file, false)}
                />
              )}
              {phase === "editing" && (
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  disabled={busy}
                  onClick={() => {
                    setFiles((current) => current.filter((f) => f !== file));
                    setError("");
                  }}
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {phase === "done" && (
        <UploadSummary
          added={addedNames(states).length}
          attention={
            files.filter((file) => {
              const kind = states.get(file)?.kind;
              return kind === "taken" || kind === "failed";
            }).length
          }
          onOpenList={finish}
        />
      )}
      {banner && banner !== dismissed && (
        <div className="upload-skill-banner" role="alert">
          <WarningIcon />
          <span>{banner}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(banner)}
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      )}
      <ul className="upload-skill-rules">
        <li>
          .md file must contain skill name and description formatted in YAML
        </li>
        <li>.zip or .skill file must include a SKILL.md file</li>
      </ul>
      {files.length > 0 && (
        <>
          <h2>Preview</h2>
          {files.map((file) => {
            const preview = previews.get(file);
            return (
              <div
                className="upload-skill-card upload-skill-preview"
                key={file.name}
              >
                <span>{preview?.name ?? file.name}</span>
                {preview?.description && <p>{preview.description}</p>}
              </div>
            );
          })}
        </>
      )}
      {scanning && (
        <div className="upload-skill-card upload-skill-scan">
          <span>Security scan</span>
          <small>
            {phase === "saving"
              ? "Running as each skill is uploaded"
              : phase === "done"
                ? "Started for each skill as it was uploaded"
                : files.length > 1
                  ? "Each skill is scanned when you upload"
                  : files.length
                    ? "Ready — runs when you upload"
                    : "Runs when you upload"}
          </small>
        </div>
      )}
      <div className="upload-skill-actions">
        <button
          type="button"
          className={`upload-skill-primary ${busy ? "busy" : ""}`}
          disabled={!files.length || busy}
          aria-busy={busy}
          onClick={() =>
            phase === "done" &&
            !files.some((file) => states.get(file)?.kind === "failed")
              ? finish()
              : void upload()
          }
        >
          <span>
            {phase === "done"
              ? files.some((file) => states.get(file)?.kind === "failed")
                ? formatText("Upload remaining {count}", {
                    count: files.filter(
                      (file) => states.get(file)?.kind === "failed",
                    ).length,
                  })
                : "Done"
              : "Upload"}
          </span>
          {busy && <Spinner inheritColor size="sm" className="spin" />}
        </button>
        {phase !== "done" && (
          <button
            type="button"
            className="upload-skill-cancel"
            disabled={busy}
            onClick={onBack}
          >
            Cancel
          </button>
        )}
        {!files.length && <span>Choose a file to continue.</span>}
        {phase === "saving" && (
          <span role="status">
            {formatText("Uploading {current} of {total}…", progress)}
          </span>
        )}
      </div>
      {replacing && (
        <ConfirmationDialog
          confirmation={{
            title: formatText("Replace {name}?", { name: replacing.name }),
            body: formatText(
              "The skill you have installed is replaced by the one in {file}.",
              { file: replacing.file.name },
            ),
            confirm: "Replace",
            danger: false,
            action: async () => {
              const { file } = replacing;
              void resend(file, true);
            },
          }}
          onClose={() => setReplacing(undefined)}
          onError={(reason) =>
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        />
      )}
    </div>
  );
}

/** A file row's status once Upload has run, with the actions its state offers. */
function FileStatus({
  state,
  busy,
  fileName,
  onReplace,
  onSkip,
  onRetry,
}: {
  state?: FileState;
  busy: boolean;
  fileName: string;
  onReplace: (name: string) => void;
  onSkip: () => void;
  onRetry: () => void;
}) {
  if (!state) return null;
  switch (state.kind) {
    case "waiting":
      return <span className="upload-skill-status">Waiting</span>;
    case "uploading":
      return (
        <span className="upload-skill-status" role="status">
          <Spinner inheritColor size={14} className="spin" />
          Uploading...
        </span>
      );
    case "added":
      return (
        <span className="upload-skill-status added">
          <CircleCheck size={14} />
          Added
        </span>
      );
    case "skipped":
      return <span className="upload-skill-status">Skipped</span>;
    case "taken":
      return (
        <>
          <span className="upload-skill-status failed">
            <AppIcon name="WarningCircle" size={14} />
            <span data-no-translate>
              {formatText("A skill named {name} already exists", {
                name: state.name,
              })}
            </span>
          </span>
          <button
            type="button"
            className="upload-skill-row-action"
            disabled={busy}
            aria-label={formatText("Replace the existing skill with {file}", {
              file: fileName,
            })}
            onClick={() => onReplace(state.name)}
          >
            Replace
          </button>
          <button
            type="button"
            className="upload-skill-row-action"
            disabled={busy}
            aria-label={formatText("Skip {file}", { file: fileName })}
            onClick={onSkip}
          >
            Skip
          </button>
        </>
      );
    case "failed":
      return (
        <>
          <span className="upload-skill-status failed">
            <AppIcon name="WarningCircle" size={14} />
            <span>{state.message}</span>
          </span>
          <button
            type="button"
            className="upload-skill-row-action"
            disabled={busy}
            aria-label={formatText("Try uploading {file} again", {
              file: fileName,
            })}
            onClick={onRetry}
          >
            Try again
          </button>
        </>
      );
  }
}

/** The result once every file was tried: how many went in, and how many need a look. */
function UploadSummary({
  added,
  attention,
  onOpenList,
}: {
  added: number;
  attention: number;
  onOpenList: () => void;
}) {
  return (
    <div
      className={`upload-skill-summary ${added > 0 ? "added" : ""}`}
      role="status"
    >
      {added > 0 ? (
        <CircleCheck size={16} />
      ) : (
        <AppIcon name="WarningCircle" size={16} />
      )}
      <span>
        {added === 0 ? (
          "No skills were added."
        ) : (
          <>
            <b>
              {formatText(
                added === 1 ? "{count} skill added" : "{count} skills added",
                { count: added },
              )}
            </b>
            {" — "}
            <button type="button" onClick={onOpenList}>
              {added === 1 ? "view it in Skills" : "view them in Skills"}
            </button>
            .
          </>
        )}
        {attention > 0 &&
          ` ${formatText(
            attention === 1
              ? "{count} needs your attention in the list."
              : "{count} need your attention in the list.",
            { count: attention },
          )}`}
      </span>
    </div>
  );
}
