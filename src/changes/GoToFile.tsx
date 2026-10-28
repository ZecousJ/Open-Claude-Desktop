import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Search as SearchIcon } from "../ui/glyphs";
import { WithTooltip } from "../ui/Tooltip";
import { FileGlyph } from "./ChangedFileSection";
import {
  goToFileLimit,
  goToFileMatches,
  type GoToFileItem,
} from "./changes-keys";

/**
 * Go to file: a square ghost Search button in the Changes header ("Go to file",
 * ⌘P) whose popup searches the changed files ("Search changed files"), at most
 * 100 rows with "{n} more files. Keep typing to narrow." under them and "No
 * matching files" when nothing matches; Enter takes the first match and a
 * picked file scrolls into place. The popup is 22rem wide, aligned to the
 * button's end, below it unless there is less than 200px there and more above.
 * The menus' surface and search row stand in for its styles.
 */
export function GoToFile({
  files,
  open,
  onOpenChange,
  onPick,
  buttonRef,
  search = "Search changed files",
  onQuery,
}: {
  /** The Files pane's files have no counts (additions and deletions left out). */
  files: (
    | GoToFileItem
    | { path: string; additions?: undefined; deletions?: undefined }
  )[];
  /** The field's label: "Search changed files", or the Files pane's "Search files…". */
  search?: string;
  /** Reads what is typed (the Files pane searches its folder as you type). */
  onQuery?: (query: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<{
    right: number;
    top?: number;
    bottom?: number;
  }>();
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const moreId = useId();
  const matches = goToFileMatches(files, query);
  const shown = matches.slice(0, goToFileLimit);
  const more = matches.length - shown.length;

  useLayoutEffect(() => {
    if (!open) return;
    const box = buttonRef.current?.getBoundingClientRect();
    if (!box) return;
    const below = innerHeight - box.bottom;
    const right = Math.max(8, innerWidth - box.right);
    setPlace(
      below < 200 && box.top > below
        ? { right, bottom: innerHeight - box.top + 4 }
        : { right, top: box.bottom + 4 },
    );
    setQuery("");
    setActive(-1);
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        popup.current?.contains(target) ||
        buttonRef.current?.contains(target)
      )
        return;
      onOpenChange(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const pick = (item: { path: string } | undefined) => {
    if (!item) return;
    onOpenChange(false);
    onPick(item.path);
    buttonRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <WithTooltip
        label="Go to file"
        shortcut={["mod", "P"]}
        disabled={open}
        placement="below"
      >
        {(tip) => (
          <button
            {...tip}
            ref={buttonRef}
            type="button"
            className="changes-icon-button"
            aria-label="Go to file"
            aria-keyshortcuts="Meta+P"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
          >
            <SearchIcon size={16} strokeWidth={1.75} />
          </button>
        )}
      </WithTooltip>
      {open && place && (
        <div
          ref={popup}
          className="menu go-to-file u-scroll-fade-y"
          style={place}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
              buttonRef.current?.focus({ preventScroll: true });
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!shown.length) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (current) =>
                  (Math.max(current, step > 0 ? -1 : 0) + step + shown.length) %
                  shown.length,
              );
            } else if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              pick(shown[active] ?? shown[0]);
            }
          }}
        >
          <label className="menu-search">
            <SearchIcon size={16} />
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                active >= 0 ? `${listId}-${active}` : undefined
              }
              aria-describedby={more > 0 ? moreId : undefined}
              aria-label={search}
              placeholder={search}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                onQuery?.(event.target.value);
                setActive(-1);
              }}
            />
          </label>
          {!shown.length && (
            <p className="menu-search-empty">No matching files</p>
          )}
          <div id={listId} role="listbox" aria-label="Changed files">
            {shown.map((item, index) => (
              <button
                key={item.path}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                className={`go-to-file-row${index === active ? " active" : ""}`}
                title={item.path}
                onPointerEnter={() => setActive(index)}
                onClick={() => pick(item)}
              >
                <FileGlyph />
                <span className="go-to-file-path" data-no-translate>
                  {item.path}
                </span>
                {item.additions !== undefined && (
                  <span className="changes-stat">
                    <span className="changes-add">+{item.additions}</span>
                    <span className="changes-del">-{item.deletions}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          {more > 0 && (
            <p id={moreId} className="menu-search-empty">
              {more === 1
                ? "1 more file. Keep typing to narrow."
                : `${more} more files. Keep typing to narrow.`}
            </p>
          )}
        </div>
      )}
    </>
  );
}
