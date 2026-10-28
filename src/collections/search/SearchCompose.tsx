import { Paperclip, X, CornerDownLeft } from "../../ui/glyphs";
import { t } from "../../i18n";
import type { composeTargets } from "./search-model";
import { RowIcon } from "./SearchPalette";
import { keyName } from "../../ui/Tooltip";
import type { ZoneDropState } from "../../composer/drop-zones";
import type { Attachment } from "../../../shared/types";

/** What SearchCompose needs from SearchPaletteView.tsx. */
export interface SearchPaletteBlockProps {
  attach: () => undefined;
  compose: React.RefObject<HTMLTextAreaElement | null>;
  composeBox: React.RefObject<HTMLDivElement | null>;
  composeKeys: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  dropState: ZoneDropState;
  files: Attachment[];
  platform: string;
  send: () => void;
  setFiles: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setTarget: React.Dispatch<React.SetStateAction<number>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  target: number;
  /** What a message can start, ↑↓ moving between them. */
  targets: ReturnType<typeof composeTargets>;
  text: string;
}

export function SearchCompose({
  attach,
  compose,
  composeBox,
  composeKeys,
  dropState,
  files,
  platform,
  send,
  setFiles,
  setTarget,
  setText,
  target,
  targets,
  text,
}: SearchPaletteBlockProps) {
  return (
    <div
      className="search-palette compose"
      role="dialog"
      aria-modal="true"
      aria-label="Compose"
    >
      <div ref={composeBox} className="search-compose-box">
        {dropState !== "idle" && (
          <div
            className={`search-compose-drop ${dropState === "on-target" ? "on-target" : ""}`}
          >
            <p>
              <Paperclip size={20} aria-hidden="true" />
              {t("Drop files to attach")}
            </p>
          </div>
        )}
        <textarea
          ref={compose}
          aria-label="Message"
          placeholder="Write a message…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={composeKeys}
        />
        {files.length > 0 && (
          <ul className="search-compose-files" aria-label="Attachments">
            {files.map((file) => (
              <li key={file.path}>
                <span>{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    setFiles((current) =>
                      current.filter((f) => f.path !== file.path),
                    )
                  }
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="search-compose-bar">
          <button
            type="button"
            className="search-compose-attach"
            aria-label="Add files or photos"
            onClick={attach}
          >
            <Paperclip size={16} strokeWidth={1.4} />
          </button>
          <button
            type="button"
            className="search-compose-send"
            aria-label={t("Send")}
            disabled={!text.trim() && !files.length}
            onClick={send}
          >
            <CornerDownLeft size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <div className="search-palette-results" role="listbox" aria-label="Start">
        {targets.map((row, at) => (
          <div
            key={row.key}
            role="option"
            aria-selected={at === target}
            className={`search-row ${at === target ? "active" : ""}`}
            onMouseMove={() => target !== at && setTarget(at)}
            onClick={() => {
              setTarget(at);
              compose.current?.focus();
            }}
          >
            <RowIcon row={row} />
            <span className="search-row-title">{row.title}</span>
            {at === target && (
              <CornerDownLeft
                className="search-row-enter"
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
      <footer className="search-palette-foot">
        <span>
          Send{" "}
          <kbd>
            <CornerDownLeft size={11} strokeWidth={1.8} />
          </kbd>
        </span>
        <span>
          Add files or photos <kbd>{keyName(platform, "mod")}</kbd>
          <kbd>U</kbd>
        </span>
      </footer>
    </div>
  );
}
