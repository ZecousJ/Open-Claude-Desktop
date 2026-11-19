import { useEffect, useState } from "react";
import { Anthropicon } from "../ui/anthropicons";
import type { KnowledgeBaseInfo } from "../../shared/knowledge-api";
import { WithTooltip } from "../ui/Tooltip";
import "../research/research.css";

/**
 * Knowledge bases in the composer (owner, 2026-10-07: ZecousAI's Hiwonder
 * base, for every account, off until a chat turns it on). The rows sit in the
 * "+" menus like Web search; a chat with bases on shows a chip right of "+"
 * as Research does, which turns them off.
 */

/** The bases the service offers, read when the composer mounts and every minute. */
export function useKnowledgeBases(): KnowledgeBaseInfo[] {
  const [bases, setBases] = useState<KnowledgeBaseInfo[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void window.desktop
        .knowledgeBases()
        .then((list) => live && setBases(list))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return bases;
}

/**
 * The bases as rows of a Connectors submenu, after the account's own
 * connectors and in their style: glyph, name, switch. `switchClass` is the
 * submenu's switch (Chat/Cowork `composer-add-switch`, Code
 * `code-connector-switch`).
 */
export function KnowledgeMenuItems({
  bases,
  active,
  onToggle,
  onUnavailable,
  switchClass,
  rowProps,
}: {
  bases: KnowledgeBaseInfo[];
  active: readonly string[];
  onToggle: (id: string) => void;
  onUnavailable: (message: string) => void;
  switchClass: string;
  /** Extra props per row (the Code submenu's highlight). */
  rowProps?: (index: number) => Record<string, unknown>;
}) {
  return (
    <>
      {bases.map((base, index) => {
        const on = active.includes(base.id);
        // One that is off and can't be reached can't be turned on; one that
        // is on can always be turned off.
        const usable = on || base.available;
        return (
          <button
            key={base.id}
            className="composer-add-knowledge"
            role="menuitemcheckbox"
            aria-checked={on}
            aria-disabled={!usable}
            title={
              usable
                ? base.description || undefined
                : "This knowledge base can't be reached right now."
            }
            {...rowProps?.(index)}
            onClick={() =>
              usable
                ? onToggle(base.id)
                : onUnavailable(
                    "This knowledge base can't be reached right now.",
                  )
            }
          >
            <Anthropicon name="Library" />
            <span data-no-translate>{base.name}</span>
            <i className={switchClass} data-enabled={on} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}

export function KnowledgeChip({
  names,
  onClick,
  disabled,
}: {
  names: string[];
  onClick: () => void;
  disabled?: boolean;
}) {
  const label = names.join(", ");
  return (
    <WithTooltip label={label} placement="above">
      {(tooltip) => (
        <button
          {...tooltip}
          type="button"
          className="research-chip knowledge-chip"
          aria-label={label}
          aria-pressed="true"
          disabled={disabled}
          onClick={onClick}
        >
          <Anthropicon name="Library" />
        </button>
      )}
    </WithTooltip>
  );
}
