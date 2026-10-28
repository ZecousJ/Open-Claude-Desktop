import type { ReactNode, RefObject } from "react";
import { t } from "../../i18n";

/**
 * Default rail placement follows the main content at narrow widths.. Context
 * at10495 is the files heading, not a separate navigation mode.
 */
export function ProjectContextLayout({
  main,
  children,
  rail,
}: {
  main: ReactNode;
  children: ReactNode;
  rail: RefObject<HTMLElement | null>;
}) {
  return (
    <div className="prj-overview-columns">
      <div className="prj-overview-main">{main}</div>
      <aside
        ref={rail}
        className="prj-overview-side"
        data-stacked="after"
        aria-label={t("Project settings")}
      >
        {children}
      </aside>
    </div>
  );
}
