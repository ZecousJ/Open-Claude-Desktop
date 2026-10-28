import type { ProjectCatalogRead } from "../../composer/useProjectCatalogState";
import { t } from "../../i18n";
import { EmptyState } from "../../ui/EmptyState";
import { CardsSkeleton, Skeleton, SkeletonGroup } from "../../ui/Skeleton";
import type { ProjectDetailRead } from "./project-detail-read";

/**
 * Eight two-column-aware placeholders, then a recoverable failed-read view,
 * never the genuine-empty CTA.
 */
export function ProjectReadState({ read }: { read: ProjectCatalogRead }) {
  if (read.status === "failed" || read.failed)
    return (
      <div className="prj-read-state" role="alert">
        <EmptyState
          headline={t("Couldn’t load your projects")}
          description={t("They’re still here. Try again to reload them.")}
          ctaLabel={t("Try again")}
          onCtaClick={read.retry}
          ctaBusy={read.status === "pending"}
          ctaBusyLabel={t("Retrying…")}
        />
      </div>
    );
  if (read.status !== "pending") return null;
  // The label is for screen readers only, as in the original.
  if (read.cached)
    return (
      <p className="sr-only" role="status">
        {t("Loading")}
      </p>
    );
  return (
    <div className="prj-read-state prj-loading-grid">
      <CardsSkeleton count={8} />
    </div>
  );
}

/**
 * An unresolved project is its own page, never the Projects list or its
 * genuine-empty creation surface.
 */
export function ProjectDetailReadState({
  read,
  onBack,
  backHref,
}: {
  read: Exclude<ProjectDetailRead, { status: "list" | "ready" }>;
  onBack(): void;
  backHref?: string;
}) {
  return (
    <div className="prj-view">
      <div className="prj-column">
        <nav className="prj-crumbs" aria-label="Breadcrumb">
          {backHref ? (
            <a
              className="prj-crumb-back"
              href={backHref}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onBack();
              }}
            >
              {t("Projects")}
            </a>
          ) : (
            <button type="button" onClick={onBack}>
              {t("Projects")}
            </button>
          )}
        </nav>
        {read.status === "pending" ? (
          <SkeletonGroup label={t("Loading project")}>
            <Skeleton width="45%" height={24} />
            <Skeleton height={96} />
            <Skeleton width="70%" height={16} />
          </SkeletonGroup>
        ) : read.status === "failed" ? (
          <div className="prj-read-state" role="alert">
            <EmptyState
              headline={t("Couldn’t load this project")}
              ctaLabel={t("Try again")}
              onCtaClick={read.retry}
              ctaBusy={read.retrying}
              ctaBusyLabel={t("Retrying…")}
            />
          </div>
        ) : read.status === "forbidden" ? (
          <div className="prj-read-state" role="alert">
            <EmptyState
              headline={t("You don’t have access to this project")}
              ctaLabel={t("Go to all projects")}
              onCtaClick={onBack}
            />
          </div>
        ) : (
          <div className="prj-read-state" role="status">
            <EmptyState
              headline={t("Project not found")}
              ctaLabel={t("Try again")}
              onCtaClick={read.retry}
            />
          </div>
        )}
      </div>
    </div>
  );
}
