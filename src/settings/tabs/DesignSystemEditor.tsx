import { useRef, useState, type DragEvent } from "react";
import { ChevronLeft } from "../../ui/glyphs";
import type { DesignSystem } from "../../../shared/collections-api";
import { notAvailable } from "../unavailable";
import {
  filesFromDrop,
  mergeSources,
  readDesignSources,
} from "../directory/design-files";
import { Toggle } from "../controls";
import "../desktop.css";
import "../directory/directory.css";
import { dateOf, SourceList } from "./DesignSystems";

/**
 * A design system's page: the name, the switch that puts it to use, the
 * description, notes and example files it was made from, and its guidelines
 * (Markdown, editable). Generate writes the guidelines again from the rest.
 */
export function DesignSystemEditor({
  system,
  inUse,
  onUse,
  onBack,
  onChanged,
  onError,
}: {
  system: DesignSystem;
  inUse: boolean;
  onUse: () => void;
  onBack: () => void;
  onChanged: (system: DesignSystem) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(system.name);
  const [blurb, setBlurb] = useState(system.blurb);
  const [notes, setNotes] = useState(system.notes);
  const [guidelines, setGuidelines] = useState(system.guidelines);
  const [sources, setSources] = useState(system.sources);
  const [busy, setBusy] = useState<"" | "save" | "generate">("");
  const [failure, setFailure] = useState("");
  const dirty =
    name !== system.name ||
    blurb !== system.blurb ||
    notes !== system.notes ||
    guidelines !== system.guidelines ||
    sources !== system.sources;
  const persist = async () =>
    window.desktop.saveDesignSystem({
      id: system.id,
      name,
      blurb,
      notes,
      sources,
      guidelines,
    });
  const run = async (kind: "save" | "generate") => {
    setBusy(kind);
    setFailure("");
    try {
      let next = await persist();
      if (kind === "generate")
        next = await window.desktop.generateDesignSystem(system.id);
      setGuidelines(next.guidelines);
      setSources(next.sources);
      onChanged(next);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      onError(error);
    } finally {
      setBusy("");
    }
  };
  const canGenerate = Boolean(blurb.trim() || notes.trim() || sources.length);
  return (
    <div className="directory-page directory-setup design-system-editor">
      <div className="directory-setup-bar">
        <button type="button" className="directory-back" onClick={onBack}>
          <ChevronLeft size={16} />
          Back
        </button>
        <button
          type="button"
          className="settings-button primary regular"
          disabled={!dirty || busy !== "" || !name.trim()}
          onClick={() => void run("save")}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
      <h2 className="directory-setup-title">{system.name}</h2>
      {failure && (
        <p className="directory-warning" role="alert">
          {failure}
        </p>
      )}
      <div className="design-system-use">
        <div>
          <strong>Use in chats</strong>
          <p>
            {system.guidelines
              ? "New chats and Cowork tasks follow these guidelines when they make designs."
              : "Write the guidelines first, then it can be used."}
          </p>
        </div>
        <Toggle
          label="Use in chats"
          checked={inUse}
          disabled={!system.guidelines}
          onChange={onUse}
        />
      </div>
      <label className="directory-field">
        <span>Name</span>
        <input
          className="settings-input"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="directory-field">
        <span>Company name and blurb</span>
        <textarea
          className="settings-textarea"
          rows={3}
          value={blurb}
          onChange={(event) => setBlurb(event.target.value)}
        />
      </label>
      <div className="directory-field">
        <span>Example files</span>
        <DropZone
          label="Drag a folder here or browse"
          folder
          onFiles={async (files) => {
            const found = await readDesignSources(files);
            if (found.length) setSources((list) => mergeSources(list, found));
            else setFailure("No style, token or code files were found there.");
          }}
        />
        {sources.length > 0 && (
          <SourceList
            sources={sources}
            onRemove={(file) =>
              setSources((list) => list.filter((item) => item.name !== file))
            }
          />
        )}
      </div>
      <label className="directory-field">
        <span>Any other notes?</span>
        <textarea
          className="settings-textarea"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <div className="directory-field">
        <span>Guidelines</span>
        <small>
          Markdown. Claudex reads this before it makes a design. Edit it, or
          have Claudex write it again from the description above.
        </small>
        <textarea
          className="settings-textarea design-guidelines"
          rows={22}
          value={guidelines}
          aria-label="Guidelines"
          placeholder="No guidelines yet."
          onChange={(event) => setGuidelines(event.target.value)}
        />
        <div className="design-system-actions">
          <button
            type="button"
            className="settings-button regular"
            disabled={!canGenerate || busy !== ""}
            onClick={() => void run("generate")}
          >
            {busy === "generate"
              ? "Writing…"
              : guidelines
                ? "Write again with Claudex"
                : "Write with Claudex"}
          </button>
          {system.generatedAt && (
            <small>Last written {dateOf(system.generatedAt)}</small>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A file target. `onFiles` receives what was dropped (folders opened) or
 * picked; without it (`unavailable`) the target refuses drops, as its
 * service does not exist in Claudex.
 */
export function DropZone({
  label,
  folder,
  disabled,
  unavailable,
  onFiles,
}: {
  label: string;
  folder?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  onFiles?: (files: File[]) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const off = unavailable || disabled || !onFiles;
  const drop = async (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (off) return;
    await onFiles!(
      await filesFromDrop(event.dataTransfer.items, event.dataTransfer.files),
    );
  };
  return (
    <div
      className={`directory-dropzone ${over ? "over" : ""}`}
      role={off ? undefined : "button"}
      tabIndex={off ? undefined : 0}
      aria-disabled={off ? "true" : undefined}
      title={unavailable ? notAvailable : undefined}
      onClick={() => !off && input.current?.click()}
      onKeyDown={(event) => {
        if (!off && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = off ? "none" : "copy";
        if (!off) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => void drop(event)}
    >
      {label}
      {!off && (
        <input
          ref={input}
          type="file"
          multiple
          hidden
          {...(folder ? { webkitdirectory: "" } : {})}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            void onFiles!(files);
          }}
        />
      )}
    </div>
  );
}
