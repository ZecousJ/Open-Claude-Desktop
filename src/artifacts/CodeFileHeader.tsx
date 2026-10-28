import { useRef, useState } from "react";
import {
  EyeOff,
  ListTree,
  Maximize2,
  Minimize2,
  MoreVertical,
  Eye,
  Clock,
  Search,
  X,
} from "../ui/glyphs";
import { IconButton } from "../ui/Controls";
import { Menu, type MenuPosition } from "../ui/Menu";
import { notAvailable } from "../settings/unavailable";
import { acceleratorLabel } from "../../shared/accelerator";
import "./file-viewer-panel.css";

/** The Code file panel's editor options. */
export interface CodeFileOptions {
  wordWrap: boolean;
  showWhitespace: boolean;
  scrollPastEnd: boolean;
  tabSize: 2 | 4 | 8;
}

const storageKey = "claudex.codeFileOptions";
export const defaultCodeFileOptions: CodeFileOptions = {
  wordWrap: true,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 4,
};

/** The options as last chosen on this computer (a per-viewer convenience). */
export function useCodeFileOptions() {
  const [options, setOptions] = useState<CodeFileOptions>(() => {
    try {
      return {
        ...defaultCodeFileOptions,
        ...JSON.parse(localStorage.getItem(storageKey) ?? "{}"),
      };
    } catch {
      return defaultCodeFileOptions;
    }
  });
  const update = (patch: Partial<CodeFileOptions>) =>
    setOptions((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Not kept: the choice lasts this session.
      }
      return next;
    });
  return [options, update] as const;
}

/**
 * A Code session's file panel header: a tab row with the file tree toggle, the
 * file's tab (italic while it is a preview tab) with its ×, then Search, More
 * options, Expand and Close; under it the file's path with the preview (eye)
 * toggle. Claudex opens one file at a time and has no workspace tree or in-file
 * search yet, so those are greyed.
 */
export function CodeFileHeader({
  filename,
  path,
  canPreview,
  preview,
  onPreview,
  expanded,
  onExpand,
  onClose,
  options,
  onOptions,
  platform,
  onHistory,
}: {
  filename: string;
  path: string;
  canPreview: boolean;
  preview: boolean;
  onPreview: (preview: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  options: CodeFileOptions;
  onOptions: (patch: Partial<CodeFileOptions>) => void;
  platform: string;
  onHistory?: () => void;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const more = useRef<HTMLButtonElement>(null);
  return (
    <header className="code-file-header">
      <div className="code-file-tabs">
        <IconButton label={`Show file tree · ${notAvailable}`} disabled>
          <ListTree size={16} strokeWidth={1.6} />
        </IconButton>
        <span className="code-file-tab" title={path}>
          <em>{filename}</em>
          <button
            type="button"
            aria-label={`Close ${filename}`}
            onClick={onClose}
          >
            <X size={12} strokeWidth={1.8} />
          </button>
        </span>
        <span className="code-file-tools">
          {onHistory && (
            <IconButton label="History" onClick={onHistory}>
              <Clock size={16} />
            </IconButton>
          )}
          <IconButton label={`Search · ${notAvailable}`} disabled>
            <Search size={15} strokeWidth={1.6} />
          </IconButton>
          <button
            ref={more}
            type="button"
            className="icon-button"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={() => {
              const rect = more.current!.getBoundingClientRect();
              setMenu(
                menu
                  ? undefined
                  : { right: innerWidth - rect.right, top: rect.bottom + 4 },
              );
            }}
          >
            <MoreVertical size={15} strokeWidth={1.6} />
          </button>
          <IconButton
            label={expanded ? "Collapse" : "Expand"}
            onClick={onExpand}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </span>
      </div>
      <div className="code-file-path">
        <span title={path}>{path}</span>
        {canPreview && (
          <IconButton
            label={preview ? "Show code" : "Preview"}
            onClick={() => onPreview(!preview)}
          >
            {preview ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconButton>
        )}
      </div>
      {menu && (
        <Menu
          label="More options"
          size="regular"
          width={220}
          position={menu}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
          entries={[
            {
              label: "Show file tree",
              value: acceleratorLabel("CommandOrControl+Shift+Y", platform),
              disabled: true,
              title: notAvailable,
            },
            { separator: true },
            {
              label: "Preview tabs",
              checked: true,
              disabled: true,
              title: "Claudex opens one file at a time, as a preview tab",
            },
            {
              label: "Auto save",
              checked: true,
              disabled: true,
              title: "Files here are read-only; the agent writes them",
            },
            { separator: true },
            {
              label: "Word wrap",
              checked: options.wordWrap,
              onSelect: () => onOptions({ wordWrap: !options.wordWrap }),
            },
            {
              label: "Show whitespace",
              checked: options.showWhitespace,
              onSelect: () =>
                onOptions({ showWhitespace: !options.showWhitespace }),
            },
            {
              label: "Scroll past end",
              checked: options.scrollPastEnd,
              onSelect: () =>
                onOptions({ scrollPastEnd: !options.scrollPastEnd }),
            },
            {
              label: "Tab size",
              value: String(options.tabSize),
              submenu: ([2, 4, 8] as const).map((size) => ({
                label: String(size),
                checked: options.tabSize === size,
                onSelect: () => onOptions({ tabSize: size }),
              })),
            },
          ]}
        />
      )}
    </header>
  );
}
