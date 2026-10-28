import { useRef, useState } from "react";
import { ArrowDown } from "../ui/glyphs";
import { useApp } from "../app/AppContext";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { WithTooltip } from "../ui/Tooltip";
import "./pr-branch.css";

/** github.com's page of a branch, each path part escaped. */
export function branchUrl(repository: string, branch: string) {
  return `https://github.com/${repository}/tree/${branch
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** "N commits behind {base}": the ↓ count's tooltip. */
export function behindLabel(count: number, base: string) {
  return count === 1
    ? `1 commit behind ${base}`
    : `${count} commits behind ${base}`;
}

/**
 * The branch row's branch name as a menu button: Copy branch name, and Open
 * branch on GitHub while the session's pull request is open on github.com (the
 * original offers the page of a local session's branch only then). A click or a
 * right click opens the menu; the tooltip stays the chip's.
 */
export function BranchChip({
  branch,
  tooltip,
  detail,
  url,
  openLink,
}: {
  branch: string;
  tooltip: string;
  detail?: string;
  /** The branch's page on GitHub, when it may be offered. */
  url?: string;
  openLink: (url: string) => void;
}) {
  const app = useApp();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const open = () => {
    const box = button.current?.getBoundingClientRect();
    if (menu || !box) return setMenu(undefined);
    setMenu({ left: box.left, bottom: innerHeight - box.top + 6 });
  };
  const entries: MenuEntry[] = [
    {
      label: "Copy branch name",
      onSelect: () =>
        void Promise.resolve()
          .then(() => window.desktop.copyText(branch))
          .then(() => app.notify("Branch name copied to clipboard."))
          .catch(app.report),
    },
    ...(url
      ? [{ label: "Open branch on GitHub", onSelect: () => openLink(url) }]
      : []),
  ];
  return (
    <>
      <WithTooltip label={tooltip} detail={detail} disabled={Boolean(menu)}>
        {(props) => (
          <button
            {...props}
            ref={button}
            type="button"
            className="pr-chip pr-branch pr-branch-button"
            data-no-translate
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={open}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!menu) open();
            }}
          >
            <span>{branch}</span>
          </button>
        )}
      </WithTooltip>
      {menu && (
        <Menu
          label="Branch"
          width={200}
          position={menu}
          anchors={[button]}
          entries={entries}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

/**
 * How many commits the base branch gained since the branch left it: ↓ and the
 * count, with "N commits behind {base}" as its tooltip and name.
 */
export function BehindCount({ count, base }: { count: number; base: string }) {
  const label = behindLabel(count, base);
  return (
    <WithTooltip label={label} size="wrap">
      {(props) => (
        <span {...props} role="img" aria-label={label} className="pr-behind">
          <ArrowDown size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{count}</span>
        </span>
      )}
    </WithTooltip>
  );
}
