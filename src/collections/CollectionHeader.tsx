import type { MouseEvent, ReactNode } from "react";

/**
 * Serif page title with its actions on the same 32px line
 * (R-History-全部对话).
 */
export function CollectionHeader({
  title,
  tabs,
  children,
}: {
  title: string;
  /**
   * A tab row under the title: the actions move beside it, at its right end
   * (live claude.ai bundle, 2026-10-12: a page header with tabs puts the
   * title on a line of its own and the tabs and controls on the next).
   */
  tabs?: ReactNode;
  children?: ReactNode;
}) {
  const actions = children && (
    <div className="collection-bar-actions">{children}</div>
  );
  return (
    <header className={tabs ? "collection-bar with-tabs" : "collection-bar"}>
      <div className="collection-bar-line">
        <h1>{title}</h1>
        {!tabs && actions}
      </div>
      {tabs && (
        <div className="collection-bar-line collection-bar-tabs">
          {tabs}
          {actions}
        </div>
      )}
    </header>
  );
}

/** The white filled button at the right end of a page header ("New"). */
export function PrimaryAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" className="collection-primary" onClick={onClick}>
      {children}
    </button>
  );
}
