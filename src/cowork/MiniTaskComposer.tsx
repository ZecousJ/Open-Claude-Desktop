import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import type { Attachment, Project } from "../../shared/types";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import { useApp } from "../app/AppContext";
import { api } from "../desktop-api";
import { ModelMenu, ModelName } from "../composer/model/ModelMenu";
import { modelLabel } from "../composer/model/code-model-choices";
import { chatEffortLabels } from "../../shared/chat-effort";
import { useModelCatalog } from "../composer/useComposerServices";
import { CoworkOptions } from "../composer/CoworkOptions";
import { TaskPermissionPicker } from "../composer/TaskPermissionPicker";
import {
  addFile,
  addPastedText,
  dragHasFiles,
  pastesAsCard,
  attachmentPreviewUrl,
} from "../composer/attachment-input";
import {
  attachmentLimitNotice,
  maxAttachmentsFor,
} from "../composer/attachment-limits";
import { MenuSheetScrim } from "../composer/MenuSheetScrim";
import { isComposingKey } from "../ui/ime";
import { AppIcon } from "../ui/app-icon";
import { t } from "../i18n";
import { requestFolderAccess } from "./useFolderAccess";
import { MiniComposerControls } from "./MiniComposerControls";
import {
  MiniComposerAttachments,
  type MiniComposerFile,
} from "./MiniComposerAttachments";

/** Where a new task in a window works: its folder and project. */
export interface MiniTaskPlace {
  cwd?: string;
  setCwd: (cwd?: string) => void;
  project?: Project;
  setProjectId: (id?: string) => void;
}

/**
 * A task window's composer: a 12px rounded field with a 0.5px rim on the raised
 * surface, its rim strong while it has the focus. Above the words, the caution
 * band for a prompt that came from outside and the attachments; the words; then
 * a row with the project or folder (icon only, a badge once chosen) and, for a
 * quick task, the permission mode (icon only), and at its end the model and
 * Send message. Files paste or drop into it. A spun-off task keeps the folder
 * of the task it comes from, and a prompt from outside always asks first, so
 * those show no place or permission picker.
 */
export function MiniTaskComposer({
  placeholder,
  text,
  setText,
  attachments,
  setAttachments,
  focus,
  unsafe,
  starting,
  onStart,
  place,
  permission,
  providerId,
  model,
  onModel,
}: {
  placeholder: string;
  text: string;
  setText: (text: string) => void;
  attachments: Attachment[];
  setAttachments: (update: (list: Attachment[]) => Attachment[]) => void;
  /** Takes the focus while it shows. */
  focus: boolean;
  unsafe: boolean;
  starting: boolean;
  onStart: () => void;
  /** A quick task's project or folder; absent for a spun-off task. */
  place?: MiniTaskPlace;
  /** Offers the permission mode (a quick task whose prompt is its own). */
  permission: boolean;
  providerId: string;
  model: string;
  onModel: (providerId: string, model: string) => void;
}) {
  const app = useApp();
  const catalog = useModelCatalog();
  const settings = app.snapshot.settings;
  const field = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState<MiniComposerFile[]>([]);
  const [queued, setQueued] = useState(false);
  const removed = useRef(new Set<string>());
  const previews = useRef(new Map<string, string>());
  useEffect(
    () => () => {
      for (const preview of previews.current.values())
        URL.revokeObjectURL(preview);
    },
    [],
  );
  const [modelMenu, setModelMenu] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [focus]);
  // The words grow the field up to 12rem, then it scrolls.
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  const limit = maxAttachmentsFor("cowork");
  const attachmentsAllowed = app.policy.attachments.types.length > 0;
  const addFiles = async (files: File[], pastedText?: string) => {
    const room = limit - attachments.length - pending.length;
    if (room <= 0) return app.notify(attachmentLimitNotice(limit));
    const jobs = [
      ...(pastedText
        ? [
            {
              id: crypto.randomUUID(),
              name: "Pasted text",
              run: () => addPastedText(pastedText),
            },
          ]
        : []),
      ...files
        .slice(0, Math.max(0, room - (pastedText ? 1 : 0)))
        .map((file) => ({
          id: crypto.randomUUID(),
          name: file.name || "Pasted image",
          preview: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
          run: () => addFile(file),
        })),
    ].slice(0, room);
    for (const job of jobs) {
      if ("preview" in job && job.preview)
        previews.current.set(job.id, job.preview);
    }
    setPending((value) => [
      ...value,
      ...jobs.map((job) => ({ ...job, status: "uploading" as const })),
    ]);
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const added = await job.run();
          if (removed.current.has(job.id)) return;
          const preview = previews.current.get(job.id);
          if (preview) {
            previews.current.delete(job.id);
            previews.current.set(added.id, preview);
          }
          setAttachments((value) => [...value, added].slice(0, limit));
          setPending((value) => value.filter((item) => item.id !== job.id));
        } catch (error) {
          if (removed.current.has(job.id)) return;
          setQueued(false);
          setPending((value) =>
            value.map((item) =>
              item.id === job.id ? { ...item, status: "error" } : item,
            ),
          );
          app.report(error);
        }
      }),
    );
  };
  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      if (!attachmentsAllowed)
        return app.notify(t("Your administrator has turned off attachments"));
      void addFiles(files);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    if (
      pastesAsCard(pasted) &&
      !attachmentRefusal(
        "Pasted text.txt",
        new TextEncoder().encode(pasted).byteLength,
        app.policy,
      )
    ) {
      event.preventDefault();
      void addFiles([], pasted);
    }
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!dragHasFiles(Array.from(event.dataTransfer.types))) return;
    event.preventDefault();
    event.stopPropagation();
    if (!attachmentsAllowed)
      return app.notify(t("Your administrator has turned off attachments"));
    void addFiles(Array.from(event.dataTransfer.files));
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !isComposingKey(event)) {
      event.preventDefault();
      submit();
    }
  };
  // Queue while uploads finish.
  const uploading = pending.some((file) => file.status === "uploading");
  const uploadFailed = pending.some((file) => file.status === "error");
  const hasContent = Boolean(text.trim() || attachments.length || uploading);
  const submit = () => {
    if (starting || !hasContent) return;
    if (uploading) return setQueued(!uploadFailed);
    setQueued(false);
    onStart();
  };
  useEffect(() => {
    if (!queued || uploading || starting) return;
    setQueued(false);
    if (pending.some((file) => file.status === "error")) return;
    if (text.trim() || attachments.length) onStart();
  }, [queued, uploading, starting, pending, text, attachments, onStart]);

  const pickFolder = async () => {
    if (!place) return;
    try {
      const folder = await api.chooseFolder();
      if (!folder) return;
      // Cowork asks before it uses a folder; Cancel keeps the previous one.
      if (
        (await requestFolderAccess(folder, { notify: app.notify })) !==
        "granted"
      )
        return;
      place.setCwd(folder);
    } catch (error) {
      app.report(error);
    }
  };

  return (
    <fieldset
      className="mini-composer"
      onPasteCapture={onPaste}
      onDragOver={(event) => {
        if (dragHasFiles(Array.from(event.dataTransfer.types)))
          event.preventDefault();
      }}
      onDrop={onDrop}
      onClick={(event) => {
        // A click on the field's empty space puts the caret in the words.
        if (event.target === event.currentTarget) field.current?.focus();
      }}
    >
      {unsafe && (
        <div className="mini-composer-caution" role="status" aria-live="polite">
          <AppIcon name="Warning" />
          <span>
            Use caution before running this prompt. Malicious content could
            trick Claudex into attempting harmful actions or sharing your data.
          </span>
        </div>
      )}
      <MiniComposerAttachments
        files={[
          ...attachments.map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            status: "done" as const,
            preview:
              previews.current.get(attachment.id) ??
              attachmentPreviewUrl(attachment.id),
          })),
          ...pending,
        ]}
        onRemove={(id) => {
          setQueued(false);
          removed.current.add(id);
          const preview = previews.current.get(id);
          if (preview) URL.revokeObjectURL(preview);
          previews.current.delete(id);
          setPending((list) => list.filter((item) => item.id !== id));
          setAttachments((list) => list.filter((item) => item.id !== id));
        }}
      />
      <div className="mini-composer-words">
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Write your prompt to Claudex"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={keyDown}
        />
      </div>
      <div className="mini-composer-row">
        {place && (
          <CoworkOptions
            collapsed
            platform={app.snapshot.platform as NodeJS.Platform}
            cwd={place.cwd}
            setCwd={place.setCwd}
            project={place.project}
            projects={app.snapshot.projects}
            onProject={(id) => place.setProjectId(id)}
            onCreateProject={() => app.startProject()}
            pickFolder={pickFolder}
          />
        )}
        {permission && (
          <TaskPermissionPicker
            iconOnly
            settings={settings}
            onChange={(taskPermission) =>
              void app.updatePreference({ taskPermission }).catch(app.report)
            }
          />
        )}
        <div className="mini-composer-end">
          <div className="popover-anchor mini-composer-model">
            <button
              type="button"
              className="mini-composer-model-button"
              aria-haspopup="menu"
              aria-expanded={modelMenu}
              aria-label={`Model: ${model ? modelLabel(catalog, model) : "Select model"}`}
              onClick={() => setModelMenu((open) => !open)}
            >
              <span className="model-button-name">
                <ModelName model={model} />
              </span>
              <span className="model-button-effort">
                {chatEffortLabels[settings.effort]}
              </span>
            </button>
            {modelMenu && (
              <MenuSheetScrim onClose={() => setModelMenu(false)} />
            )}
            {modelMenu && (
              <ModelMenu
                providers={settings.providers}
                providerId={providerId}
                model={model}
                effort={settings.effort}
                onSelect={onModel}
                onEffort={(effort) =>
                  void app.updatePreference({ effort }).catch(app.report)
                }
                onManage={() => {
                  setModelMenu(false);
                  app.setPage("api");
                }}
                onClose={() => setModelMenu(false)}
              />
            )}
          </div>
          <MiniComposerControls
            start
            hasContent={hasContent}
            disabled={starting}
            busy={starting}
            waiting={queued}
            onSend={submit}
          />
        </div>
      </div>
    </fieldset>
  );
}
