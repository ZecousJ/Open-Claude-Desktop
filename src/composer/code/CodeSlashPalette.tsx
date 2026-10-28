import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  slashSourceLabels,
  type CodeSlashCommand,
} from "./code-slash-commands";

type Props = {
  commands: CodeSlashCommand[];
  query: string;
  selected: number;
  onSelect: (command: CodeSlashCommand) => void;
  onHover: (index: number) => void;
};
// The original bolds the matched characters; a fuzzy match (letters in order,
// not adjacent) bolds each matched letter.
function MatchedName({ name, query }: { name: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{name}</>;
  const lower = name.toLowerCase();
  const start = lower.indexOf(needle);
  if (start >= 0)
    return (
      <>
        {name.slice(0, start)}
        <mark>{name.slice(start, start + needle.length)}</mark>
        {name.slice(start + needle.length)}
      </>
    );
  const hits = new Set<number>();
  let next = 0;
  for (let i = 0; i < lower.length && next < needle.length; i++)
    if (lower[i] === needle[next]) {
      hits.add(i);
      next++;
    }
  if (next < needle.length) return <>{name}</>;
  return (
    <>
      {[...name].map((character, i) =>
        hits.has(i) ? <mark key={i}>{character}</mark> : character,
      )}
    </>
  );
}
export function CodeSlashPalette({
  commands,
  query,
  selected,
  onSelect,
  onHover,
}: Props) {
  const list = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number } | null>(
    null,
  );
  const [moreBelow, setMoreBelow] = useState(false);
  const current = commands[selected];
  useLayoutEffect(() => {
    const element = list.current;
    const update = () => {
      if (element)
        setMoreBelow(
          element.scrollTop + element.clientHeight < element.scrollHeight - 1,
        );
      const row = element?.querySelector<HTMLElement>(
        `[data-slash-index="${selected}"]`,
      );
      if (!query || !row) {
        setTooltip(null);
        return;
      }
      // Claude's hint sits 4px right of the palette, level with the selected row.
      const rect = row.getBoundingClientRect(),
        width = 250;
      setTooltip({
        left:
          rect.right + 8 + width > window.innerWidth
            ? Math.max(8, rect.left - width - 8)
            : rect.right + 8,
        top: Math.max(8, rect.top + 0.5),
      });
    };
    element
      ?.querySelector<HTMLElement>(`[data-slash-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
    update();
    element?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      element?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [selected, commands, query]);
  return (
    <div className="code-slash-palette">
      <div
        className="code-slash-list"
        role="listbox"
        aria-label="Slash commands"
        ref={list}
        data-more-below={moreBelow}
      >
        {commands.map((command, index) => (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === selected}
            data-slash-index={index}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (index !== selected) onHover(index);
            }}
            onClick={() => onSelect(command)}
          >
            {command.source && slashSourceLabels[command.source] ? (
              <>
                <span className="code-slash-name">
                  <MatchedName name={command.name} query={query} />
                </span>
                <small className="code-slash-source">
                  {slashSourceLabels[command.source]}
                </small>
              </>
            ) : (
              <MatchedName name={command.name} query={query} />
            )}
          </button>
        ))}
      </div>
      {query &&
        current &&
        tooltip &&
        createPortal(
          <div className="code-slash-description" role="note" style={tooltip}>
            {current.description}
          </div>,
          document.body,
        )}
    </div>
  );
}
