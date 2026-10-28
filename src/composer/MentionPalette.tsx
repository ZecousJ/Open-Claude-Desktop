import { useLayoutEffect, useRef } from "react";
import { File, Folder } from "../ui/glyphs";
import type { MentionFile } from "../../shared/composer-api";

/**
 * The `@` file list above the Code composer. Arrow keys, Enter/Tab and Escape
 * are handled by the composer; the pointer chooses too.
 */
/**
 * The typed characters in bold; when a row matches, the rest of it is dimmed.
 */
function Matched({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  const start = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (start < 0) return <>{text}</>;
  return (
    <>
      <span className="mention-dim">{text.slice(0, start)}</span>
      <mark>{text.slice(start, start + needle.length)}</mark>
      <span className="mention-dim">{text.slice(start + needle.length)}</span>
    </>
  );
}

export function MentionPalette({
  files,
  query,
  selected,
  loading,
  onSelect,
  onHover,
}: {
  files: MentionFile[];
  query: string;
  selected: number;
  loading: boolean;
  onSelect: (file: MentionFile) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, files]);
  return (
    <div className="code-slash-palette mention-palette">
      <div
        className="code-slash-list"
        role="listbox"
        aria-label="Files"
        ref={list}
      >
        {files.length === 0 ? (
          <p>{loading ? "Searching…" : "No matching files"}</p>
        ) : (
          files.map((file, index) => {
            const cut = file.path.lastIndexOf("/");
            const Icon = file.kind === "folder" ? Folder : File;
            return (
              <button
                key={file.path}
                type="button"
                role="option"
                aria-selected={index === selected}
                data-mention-index={index}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== selected) onHover(index);
                }}
                onClick={() => onSelect(file)}
              >
                <Icon size={13} strokeWidth={1.6} aria-hidden="true" />
                <span className="mention-name">
                  <Matched text={file.path.slice(cut + 1)} query={query} />
                </span>
                {cut > 0 && (
                  <span className="mention-folder">
                    <Matched text={file.path.slice(0, cut)} query={query} />
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
