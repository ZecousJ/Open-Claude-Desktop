import type { ReactNode } from "react";
import { Pictogram, type PictogramName } from "./Pictogram";
import "./empty-state.css";
import { Spinner } from "./Spinner";

/**
 * The original's one empty state: a pictogram (md, 96px), a headline, a line
 * under it and a secondary button, centred in a column 12px apart. Every empty
 * surface that the original draws with it uses this.
 */
export function EmptyState({
  pictogram,
  headline,
  headlineLevel = 3,
  description,
  ctaLabel,
  onCtaClick,
  ctaBusy = false,
  ctaBusyLabel,
  className,
}: {
  pictogram?: PictogramName;
  headline?: ReactNode;
  headlineLevel?: 2 | 3;
  description?: ReactNode;
  ctaLabel?: ReactNode;
  onCtaClick?: () => void;
  ctaBusy?: boolean;
  ctaBusyLabel?: string;
  className?: string;
}) {
  const Heading = headlineLevel === 2 ? "h2" : "h3";
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"}>
      {pictogram && (
        <Pictogram name={pictogram} className="empty-state-pictogram" />
      )}
      {headline && <Heading>{headline}</Heading>}
      {description && <p>{description}</p>}
      {ctaLabel && onCtaClick && (
        <button
          type="button"
          className="empty-state-cta"
          onClick={onCtaClick}
          disabled={ctaBusy}
          aria-busy={ctaBusy || undefined}
          aria-label={ctaBusy ? ctaBusyLabel : undefined}
        >
          {ctaBusy ? (
            <Spinner size="sm" inheritColor label={ctaBusyLabel} />
          ) : (
            ctaLabel
          )}
        </button>
      )}
    </div>
  );
}
