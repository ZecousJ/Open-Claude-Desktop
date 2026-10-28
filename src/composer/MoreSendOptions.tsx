import { useRef, useState } from "react";
import { ChevronDown } from "../ui/glyphs";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { t } from "../i18n";

/**
 * More send options beside a mid-turn Send on a touch screen: Queue for later
 * (not in Bash mode), a rule, then Stop.
 */
export function MoreSendOptions({
  canQueue,
  onQueue,
  onStop,
}: {
  canQueue: boolean;
  onQueue: () => void;
  onStop: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const entries: MenuEntry[] = [
    ...(canQueue
      ? [
          { label: "Queue for later", onSelect: onQueue },
          { separator: true as const },
        ]
      : []),
    { label: "Stop", onSelect: onStop },
  ];
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="send-button more-send-options"
        aria-label={t("More send options")}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => {
          if (menu) return setMenu(undefined);
          const box = trigger.current!.getBoundingClientRect();
          setMenu({
            right: window.innerWidth - box.right,
            bottom: window.innerHeight - box.top + 4,
          });
        }}
      >
        <ChevronDown size={14} strokeWidth={1.75} />
      </button>
      {menu && (
        <Menu
          label="More send options"
          entries={entries}
          position={menu}
          width={180}
          anchors={[trigger]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
