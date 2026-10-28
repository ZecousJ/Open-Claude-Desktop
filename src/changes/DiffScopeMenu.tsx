import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "../ui/glyphs";
import type { DiffScope, WorkingTreeChanges } from "../../shared/types";
import { Menu, type MenuPosition } from "../ui/Menu";
import { WithTooltip } from "../ui/Tooltip";
import { scopeEntries, scopeText, type BranchList } from "./diff-scope";
import "./diff-scope.css";

/**
 * The Changes header's diff scope: "{base} → working tree" as a ghost button
 * whose menu picks All changes, Uncommitted changes, another base branch or one
 * commit. The branches are asked for each time the menu opens.
 */
export function DiffScopeMenu({
  conversationId,
  data,
  scope,
  onScope,
}: {
  conversationId: string;
  data: WorkingTreeChanges;
  scope: DiffScope;
  onScope: (scope: DiffScope) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const [branches, setBranches] = useState<BranchList>({ state: "loading" });
  const [cut, setCut] = useState(false);
  const request = useRef(0);
  // The tooltip repeats the scope only when the trigger cuts it short.
  useLayoutEffect(() => {
    const node = text.current;
    const next = (
      node ? [node, ...node.querySelectorAll<HTMLElement>("span")] : []
    ).some((part) => part.scrollWidth > part.clientWidth);
    if (next !== cut) setCut(next);
  });
  const base = data.base;
  if (!base) return null;
  const label = scopeText(data, scope, base);

  const open = () => {
    const box = button.current?.getBoundingClientRect();
    if (menu || !box) return setMenu(undefined);
    setMenu({ left: box.left, top: box.bottom + 4 });
    const id = ++request.current;
    setBranches({ state: "loading" });
    Promise.resolve()
      .then(() => window.desktop.gitBranches(conversationId))
      .then(
        (names) => {
          if (id === request.current)
            setBranches({ state: "ready", names: names ?? [] });
        },
        () => {
          if (id === request.current) setBranches({ state: "failed" });
        },
      );
  };
  const entries = scopeEntries({
    data,
    scope,
    base,
    branches,
    onScope,
  });
  return (
    <>
      <WithTooltip label={label} disabled={!cut || Boolean(menu)}>
        {(tip) => (
          <button
            {...tip}
            ref={button}
            type="button"
            className="changes-base changes-scope"
            aria-label={`Diff scope: ${label}`}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={open}
          >
            {data.scope === "branch" || !data.scope ? (
              <span ref={text} className="changes-scope-range">
                <span data-no-translate>{base}</span>
                <ArrowRight size={13} strokeWidth={1.75} aria-label="to" />
                <span data-no-translate={data.head ? true : undefined}>
                  {data.head ?? "working tree"}
                </span>
              </span>
            ) : (
              <span
                ref={text}
                className="changes-scope-text"
                data-no-translate={data.scope === "commit" || undefined}
              >
                {label}
              </span>
            )}
          </button>
        )}
      </WithTooltip>
      {menu && (
        <Menu
          label="Diff scope"
          width={260}
          position={menu}
          anchors={[button]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
