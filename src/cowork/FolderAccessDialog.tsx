import { Fragment, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder } from "../ui/glyphs";
import { formatText, useLocale } from "../i18n";
import "./folder-access.css";
import {
  useFolderAccessRequest,
  type FolderAccessChoice,
} from "./useFolderAccess";

// Non-modal folder request.
export function FolderAccessDialog({
  folder,
  paths,
  addition = false,
  reason,
  deviceName,
  keyboardEnabled = true,
  busy,
  error,
  onCancel,
  onAllow,
}: {
  folder: string;
  name: string;
  platform: string;
  home?: boolean;
  paths?: string[];
  addition?: boolean;
  reason?: string;
  deviceName?: string;
  keyboardEnabled?: boolean;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onAllow: () => void;
  onAlwaysAllow?: () => void;
}) {
  useLocale();
  const titleId = useId();
  useEffect(() => {
    if (!keyboardEnabled) return;
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        busy ||
        event.defaultPrevented ||
        target?.closest("input, textarea, button, [contenteditable=true]")
      )
        return;
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        if (event.key === "Escape") onCancel();
        else onAllow();
      }
    };
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, [busy, onCancel, onAllow, keyboardEnabled]);
  const folders = paths?.length ? paths : [folder];
  return (
    <div className="cowork-access-floating">
      <div
        className="cowork-access-dialog"
        role="region"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
      >
        <div className="cowork-access-content">
          <Folder size={20} aria-hidden="true" />
          <div className="cowork-access-description">
            <span id={titleId}>
              {addition
                ? formatText(
                    folders.length > 1
                      ? "Claudex would like to add these folders to the session:"
                      : "Claudex would like to add this folder to the session:",
                  )
                : formatText("Claudex would like to Cowork in:")
                    .split("Cowork")
                    .map((part, index) => (
                      <Fragment key={index}>
                        {index > 0 && <strong>Cowork</strong>}
                        {part}
                      </Fragment>
                    ))}
            </span>
            {folders.map((path, index) => (
              <span
                className="cowork-access-path"
                dir="ltr"
                key={index}
                title={path}
              >
                {/^(?:[A-Za-z]:\\|\\\\)/.test(path)
                  ? path.replace(/\\/g, "/")
                  : path}
              </span>
            ))}
            {deviceName && (
              <p className="cowork-access-note">
                {formatText("On {deviceName}", { deviceName })}
              </p>
            )}
            {reason && (
              <>
                <p className="cowork-access-note">
                  {formatText("Claudex’s reason")}
                </p>
                <blockquote>{reason}</blockquote>
              </>
            )}
          </div>
        </div>
        {error && (
          <p className="cowork-access-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button disabled={busy} onClick={onCancel}>
            {formatText(addition ? "Not now" : "Deny")}
          </button>
          <button
            className="cowork-access-allow"
            disabled={busy}
            onClick={onAllow}
          >
            {formatText(
              addition
                ? folders.length > 1
                  ? "Add folders"
                  : "Add folder"
                : "Allow",
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Shows the access dialog for the folder request waiting now
 * (`requestFolderAccess`). Mounted once, by the composer's host.
 */
export function FolderAccessHost({ platform }: { platform: string }) {
  const request = useFolderAccessRequest();
  const shown = useRef(request);
  shown.current = request;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setBusy(false);
    setError(undefined);
  }, [request]);
  if (!request) return null;
  const answer = (choice: FolderAccessChoice) => {
    setBusy(true);
    setError(undefined);
    request.answer(choice).then(
      () => {
        if (shown.current === request) setBusy(false);
      },
      (e: unknown) => {
        // A newer request's dialog never shows an older one's failure.
        if (shown.current !== request) return;
        setBusy(false);
        setError(
          (e instanceof Error ? e.message : String(e)).replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            "",
          ),
        );
      },
    );
  };
  return createPortal(
    <FolderAccessDialog
      key={request.path}
      folder={request.access.folder}
      name={request.access.name}
      platform={platform}
      home={request.access.home}
      addition={Boolean(request.target.conversationId)}
      busy={busy}
      error={error}
      onCancel={() => answer("cancel")}
      onAllow={() => answer("allow")}
    />,
    document.body,
  );
}
