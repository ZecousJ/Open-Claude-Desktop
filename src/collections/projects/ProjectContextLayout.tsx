import type { ReactNode, RefObject } from "react";
import { t } from "../../i18n";

/** Default rail placement follows the main content at narrow widths.
 * c71dee58b-CHt5Ijkk:9212–9246,10325–10467 (Wp stacked="after").
 * Context at10495 is the files heading, not a separate navigation mode. */
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
