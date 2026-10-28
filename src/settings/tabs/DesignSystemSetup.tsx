import { useState } from "react";
import { ArrowRight, ChevronLeft } from "../../ui/glyphs";
import type {
  DesignSource,
  DesignSystem,
} from "../../../shared/collections-api";
import { notAvailable } from "../unavailable";
import {
  mergeSources,
  nameFromBlurb,
  readDesignSources,
} from "../directory/design-files";
import "../desktop.css";
import "../directory/directory.css";
import { DropZone } from "./DesignSystemEditor";
import { SourceList, SourceRow } from "./DesignSystems";

/**
 * Set up your design system: company blurb, example files and notes. Claude
 * writes the guidelines from these, which takes about a minute; the system
 * is kept as a draft first, so a failed attempt loses nothing.
 */
export function DesignSystemSetup({
  onBack,
  onSaved,
  onError,
}: {
  onBack: () => void;
  onSaved: (system: DesignSystem) => void;
  onError: (error: unknown) => void;
}) {
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");
  const [sources, setSources] = useState<DesignSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const ready = Boolean(company.trim() || notes.trim() || sources.length);
  const generate = async () => {
    setBusy(true);
    setFailure("");
    let saved: DesignSystem | undefined;
    try {
      saved = await window.desktop.saveDesignSystem({
        name: nameFromBlurb(company || notes || sources[0]?.name || ""),
        blurb: company,
        notes,
        sources,
      });
      onSaved(await window.desktop.generateDesignSystem(saved.id));
    } catch (error) {
      // The draft stays; its page offers Generate again.
      if (saved) onSaved(saved);
      else {
        setBusy(false);
        setFailure(error instanceof Error ? error.message : String(error));
        onError(error);
      }
    }
  };
  return (
    <div className="directory-page directory-setup">
      <div className="directory-setup-bar">
        <button
          type="button"
          className="directory-back"
          disabled={busy}
          onClick={onBack}
        >
          <ChevronLeft size={16} />
          Back
        </button>
        <button
          type="button"
          className="settings-button primary regular"
          disabled={!ready || busy}
          onClick={() => void generate()}
        >
          {busy ? "Writing your design system…" : "Continue to generation"}
          {!busy && <ArrowRight size={15} />}
        </button>
      </div>
      <h2 className="directory-setup-title">Set up your design system</h2>
      <p className="directory-setup-lead">
        Tell us about your company and attach any design resources you have.
      </p>
      <p className="directory-unavailable" role="note">
        Claudex writes the design system from your description, notes and the
        style or code files you add. GitHub links, .fig files, fonts and images
        can’t be read yet.
      </p>
      {failure && (
        <p className="directory-warning" role="alert">
          {failure}
        </p>
      )}
      <label className="directory-field">
        <span>Company name and blurb (or name of design system)</span>
        <textarea
          className="settings-textarea"
          rows={3}
          value={company}
          disabled={busy}
          placeholder="e.g. Mission Impastabowl: fast-casual pasta restaurant with in-store touchscreen kiosk, mobile app and website"
          onChange={(event) => setCompany(event.target.value)}
        />
      </label>
      <div className="directory-field">
        <span>
          Provide examples of your design system and products (all optional)
        </span>
        <small>
          What works best: code and designs for your design system and your code
          products.
        </small>
      </div>
      <div className="directory-sources">
        <SourceRow title="Link code from GitHub">
          <div className="directory-inline-input">
            <input
              className="settings-input"
              placeholder="https://github.com/owner/repo"
              aria-label="GitHub repository"
              disabled
              title={notAvailable}
            />
            <button
              type="button"
              className="settings-button regular"
              disabled
              title={notAvailable}
            >
              Add
            </button>
          </div>
        </SourceRow>
        <SourceRow
          title="Link code from your computer"
          note="This doesn't upload the whole codebase: Claudex will copy selected files. For large codebases, we recommend attaching a frontend-focused subfolder."
        >
          <DropZone
            label="Drag a folder here or browse"
            folder
            disabled={busy}
            onFiles={async (files) => {
              const found = await readDesignSources(files);
              if (!found.length)
                setFailure("No style, token or code files were found there.");
              else {
                setFailure("");
                setSources((list) => mergeSources(list, found));
              }
            }}
          />
        </SourceRow>
        <SourceRow
          title="Upload a .fig file"
          note="Parsed locally in your browser — never uploaded."
        >
          <DropZone label="Drop file here or browse" unavailable />
        </SourceRow>
        <SourceRow title="Add fonts, logos and assets">
          <DropZone label="Drop files here or browse" unavailable />
        </SourceRow>
      </div>
      {sources.length > 0 && (
        <SourceList
          sources={sources}
          onRemove={(name) =>
            setSources((list) => list.filter((item) => item.name !== name))
          }
        />
      )}
      <label className="directory-field">
        <span>Any other notes?</span>
        <textarea
          className="settings-textarea"
          rows={3}
          value={notes}
          disabled={busy}
          placeholder="e.g. We like a warm, earthy color palette with rounded corners. Our brand voice is playful but professional…"
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
    </div>
  );
}
