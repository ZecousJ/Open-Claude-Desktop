import { useEffect, useId, useRef, useState } from "react";
import { Copy, Check } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { MemoryDocView } from "../../shared/memory-api";
import { formatText, useT } from "../i18n";
import { SettingsModal } from "../settings/controls";
import { showToast } from "../ui/toast-store";
import {
  ManageMemoryContent,
  applyMemoryEdits,
  manageMemoryTitle,
} from "./ManageMemoryDialog";
import {
  globalScope,
  memoryError,
  memoryImportBytes,
  utf8Bytes,
} from "./useMemory";
import "./manage-memory.css";
import "./memory.css";

/**
 * The prompt Import memory offers to copy into another assistant. The live
 * claude.ai app reads its prompt from runtime configuration, which the bundle
 * does not carry, so Claudex writes its own to the same end.
 */
export const memoryExportPrompt = `I'm moving to another AI assistant and want to bring along what you know about me. List every memory you have stored about me, and any context you've learned about me from our past conversations.

Put everything in a single code block so I can copy it easily. Write each entry on its own line as: [date saved, if known] - what you remember.

Include:
- Instructions I've given you about how to respond (tone, format, style)
- Personal details: name, location, work, family, interests
- Projects, goals and topics I come back to
- Tools, languages and frameworks I use
- Preferences and corrections I've made

Don't summarize, group or leave anything out.`;

type View = "import" | "result";

/**
 * Import memory, as the reference design draws it. Step 1 offers a prompt to
 * copy into another AI assistant (click the box or Copy); step 2 takes what it
 * answered. Add to memory turns the dialog into Manage memory's view: the
 * memory box shows "Updating memory..." (the dialog cannot close meanwhile),
 * then the memory with the import merged in, its pencil and Manage edits. When
 * the import fails, the dialog returns to the pasted text.
 *
 * The original files the pasted text as a memory edit and regenerates the
 * memory; Claudex's memory merges it in with the account's model and saves the
 * result (`previewMemoryImport`, then `saveMemoryDoc`). Step texts and the
 * button's label are fetched at run time by the original (gated messages, not
 * in the bundle); these are Claudex's.
 */
export function MemoryImportDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => void;
}) {
  useT();
  const [view, setView] = useState<View>("import");
  const [memoryView, setMemoryView] = useState<"synthesis" | "edits">(
    "synthesis",
  );
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [doc, setDoc] = useState<MemoryDocView>();
  const [copied, setCopied] = useState(false);
  const live = useRef(true);
  const pasteLabel = useId();
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const busy = importing || updating;
  const close = () => {
    if (!busy) onClose();
  };
  const tooLong = utf8Bytes(text) > memoryImportBytes;
  const copy = () =>
    void window.desktop
      .copyText(memoryExportPrompt)
      .then(() => live.current && setCopied(true))
      .catch((cause) => showToast(memoryError(cause)));
  const submit = async () => {
    const pasted = text.trim();
    if (!pasted || tooLong || busy) return;
    setImporting(true);
    setView("result");
    try {
      const { merged, revision } =
        await window.desktop.previewMemoryImport(pasted);
      const saved = await window.desktop.saveMemoryDoc(
        globalScope,
        merged,
        revision,
      );
      if (!live.current) return;
      setDoc(saved);
      setText("");
      showToast("Memory updated");
      onChanged?.();
    } catch (cause) {
      if (!live.current) return;
      showToast(
        memoryError(cause) || "Something went wrong while updating memory",
      );
      setView("import");
    } finally {
      if (live.current) setImporting(false);
    }
  };
  if (view === "result")
    return (
      <SettingsModal
        title={formatText(manageMemoryTitle(globalScope, memoryView))}
        className="manage-memory-modal"
        onClose={close}
      >
        <ManageMemoryContent
          scope={globalScope}
          doc={
            doc ??
              // While the import runs the box shows "Updating memory...".
              {
                content: "",
                revision: 0,
                edits: [],
                updatedAt: 0,
                source: "imported",
              }
          }
          view={memoryView}
          onView={setMemoryView}
          updating={busy}
          onUpdate={(change) => {
            setUpdating(true);
            void applyMemoryEdits(globalScope, change).then((next) => {
              if (!live.current) return;
              setUpdating(false);
              if (next) setDoc(next);
              if (next !== undefined) onChanged?.();
            });
          }}
        />
      </SettingsModal>
    );
  return (
    <SettingsModal title="Import memory" onClose={close}>
      <div className="memory-import">
        <div className="memory-import-step memory-import-step-first">
          <div className="memory-import-step-label">
            <span className="memory-import-step-number">
              {(1).toLocaleString()}
            </span>
            Copy this prompt into a chat with your other AI provider
          </div>
          <div className="memory-import-prompt">
            <div className="memory-import-prompt-copy">
              <button type="button" className="secondary" onClick={copy}>
                {copied ? (
                  <Check size={16} aria-hidden="true" />
                ) : (
                  <Copy size={16} aria-hidden="true" />
                )}
                Copy
              </button>
            </div>
            <div className="memory-import-prompt-fade" aria-hidden="true" />
            <div
              className="memory-import-prompt-text"
              role="button"
              tabIndex={0}
              aria-label="Copy prompt"
              data-no-translate
              onClick={copy}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  copy();
                }
              }}
            >
              {memoryExportPrompt}
            </div>
          </div>
        </div>
        <div className="memory-import-step">
          <div className="memory-import-step-label">
            <span className="memory-import-step-number">
              {(2).toLocaleString()}
            </span>
            <span id={pasteLabel}>
              Paste the results below to add them to Claudex’s memory
            </span>
          </div>
          <div className="memory-import-paste">
            <textarea
              aria-labelledby={pasteLabel}
              rows={6}
              value={text}
              placeholder="Paste your memory details here"
              aria-invalid={tooLong || undefined}
              onChange={(event) => setText(event.target.value)}
            />
            {tooLong && (
              <p className="memory-edit-note error-text" role="alert">
                This is too long to import. Shorten it and try again.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="primary memory-busy-button"
          disabled={!text.trim() || tooLong || busy}
          aria-busy={busy || undefined}
          onClick={() => void submit()}
        >
          {busy && (
            <Spinner
              inheritColor
              className="spin"
              size={14}
              aria-hidden="true"
            />
          )}
          Add to memory
        </button>
      </div>
    </SettingsModal>
  );
}
