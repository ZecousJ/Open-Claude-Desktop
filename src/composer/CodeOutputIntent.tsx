import { useRef, useState } from "react";
import type { ArtifactOutputKind } from "../../shared/artifact-output";
import { t, formatText } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { AppIcon } from "../ui/app-icon";
import "./code-output-intent.css";

const labels: Record<ArtifactOutputKind, string> = {
  docs: "Claudex Docs",
  slides: "Claudex Slides",
  design: "Claudex Design",
  dashboard: "Dashboard",
};
const removeLabels: Record<ArtifactOutputKind, string> = {
  docs: "Remove document",
  slides: "Remove presentation",
  design: "Remove design",
  dashboard: "Remove dashboard",
};
/** Current source output chip and324px top/start single-row remove menu. */
export function CodeOutputIntent({
  kind,
  onRemove,
}: {
  kind: ArtifactOutputKind;
  onRemove: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<MenuPosition>();
  const label = formatText("Output: {name}", { name: t(labels[kind]) });
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="code-output-intent"
        aria-label={label}
        aria-pressed="true"
        aria-haspopup="menu"
        aria-expanded={!!position}
        onClick={() => {
          const box = anchor.current!.getBoundingClientRect();
          setPosition(
            position
              ? undefined
              : {
                  left: Math.max(8, Math.min(box.left, innerWidth - 332)),
                  bottom: innerHeight - box.top + 6,
                },
          );
        }}
      >
        {t(labels[kind])}
      </button>
      {position && (
        <Menu
          label={label}
          entries={[
            {
              label: removeLabels[kind],
              icon: <AppIcon name="XBase" size={16} />,
              onSelect: onRemove,
            },
          ]}
          width={324}
          position={position}
          anchors={[anchor]}
          className="code-output-remove-menu"
          onClose={() => setPosition(undefined)}
        />
      )}
    </>
  );
}
