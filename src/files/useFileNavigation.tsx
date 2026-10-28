import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui/Controls";
import { formatText, t } from "../i18n";
import type { FileDocuments } from "./file-documents";
import { fileTransitionEvent, type FileTransition } from "./file-transitions";

type Intent = {
  resume: () => void;
  paths: readonly string[];
  scope: "session" | "pane" | "tab";
  cancel?: () => void;
};
/** A pending save must settle before a tab/session can discard its buffer.
 * Source: O14/cccc2cf0a:9317 and pendingFileTabIntent. */
export function useFileNavigation(
  documents: FileDocuments,
  autoSave: boolean,
  focusEditor: () => void,
) {
  const [intent, setIntent] = useState<Intent>();
  const [busy, setBusy] = useState(false);
  const latest = useRef({ autoSave, focusEditor });
  latest.current = { autoSave, focusEditor };
  const pending = useRef(false),
    alive = useRef(true);
  const run = (
    resume: () => void,
    paths = Object.keys(documents.snapshot()),
    scope: Intent["scope"] = "tab",
    cancel?: () => void,
  ) => {
    if (pending.current) {
      cancel?.();
      return;
    }
    if (!documents.dirty(paths).length) return resume();
    pending.current = true;
    setBusy(true);
    void (async () => {
      await documents.settle();
      if (latest.current.autoSave) await documents.flush(paths);
      if (!alive.current) return;
      if (!documents.dirty(paths).length) {
        pending.current = false;
        setBusy(false);
        resume();
      } else {
        setBusy(false);
        setIntent({ resume, paths, scope, cancel });
      }
    })();
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    alive.current = true;
    const navigation = (event: Event) => {
      if (event.defaultPrevented || !documents.dirty().length) return;
      const detail = (event as CustomEvent<FileTransition>).detail;
      event.preventDefault();
      runRef.current(detail.resume, undefined, detail.scope, detail.cancel);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (documents.dirty().length) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden" && latest.current.autoSave)
        void documents.flush();
    };
    window.addEventListener(fileTransitionEvent, navigation);
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      window.removeEventListener(fileTransitionEvent, navigation);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [documents]);
  const cancel = () => {
    intent?.cancel?.();
    pending.current = false;
    setIntent(undefined);
    requestAnimationFrame(() => latest.current.focusEditor());
  };
  const path = intent && documents.dirty(intent.paths)[0];
  const prompt = intent && (
    <Modal
      title="Discard unsaved changes?"
      onClose={cancel}
      variant="confirm"
      confirmFocus="cancel"
    >
      <p className="confirm-body">
        {formatText(
          intent.scope === "session"
            ? "Your edits to {name} have not been saved. Leaving this session discards them."
            : "Your edits to {name} have not been saved. Leaving this tab discards them.",
          { name: path?.split("/").at(-1) ?? "" },
        )}
      </p>
      <div className="button-row">
        <button className="secondary" onClick={cancel}>
          {t("Keep editing")}
        </button>
        <button
          className="primary danger-button"
          onClick={() => {
            const next = intent;
            for (const path of next.paths) documents.revert(path);
            pending.current = false;
            setIntent(undefined);
            next.resume();
          }}
        >
          {t("Discard")}
        </button>
      </div>
    </Modal>
  );
  return { run, busy, prompt };
}
