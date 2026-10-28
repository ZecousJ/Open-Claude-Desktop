import { helpUrl } from "../../../shared/help-links";
import { BadgeCheck } from "../../ui/glyphs";
import { useTooltip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import "./connector-directory.css";

export type DirectoryKind = "connector" | "desktop_extension" | "plugin";
export type DirectoryReview =
  "verified" | "community" | "custom" | "organization";

export const reviewTooltips = {
  verified:
    "Verified in the source directory. This is not a new Claudex security audit.",
  verifiedPlugin:
    "Verified in the source directory. This is not a new Claudex security audit.",
  connector: "Community listing. Review tool permissions before connecting.",
  desktop_extension:
    "Community listing. Review tool permissions before installing.",
  plugin: "Community listing. Review tool permissions before installing.",
  custom: "You added this connector. Claudex has not reviewed it.",
  organization: "This extension was uploaded by your organization.",
};

export const communityExplainers: Record<DirectoryKind, string> = {
  connector:
    "Community connectors are not a security guarantee. Only connect developers you trust.",
  desktop_extension:
    "Community extensions are not a security guarantee. Only install developers you trust.",
  plugin:
    "Community plugins are not a security guarantee. Only install developers you trust.",
};

export function DirectoryReviewBadge({
  review,
  kind = "connector",
  iconSize = 16,
}: {
  review: DirectoryReview;
  kind?: DirectoryKind;
  iconSize?: number;
}) {
  const label = {
    verified: "Verified",
    community: "Community",
    custom: "Custom",
    organization: "Your organization",
  }[review];
  const text =
    review === "verified"
      ? kind === "plugin"
        ? reviewTooltips.verifiedPlugin
        : reviewTooltips.verified
      : review === "community"
        ? reviewTooltips[kind]
        : reviewTooltips[review];
  const { props, tooltip } = useTooltip(t(text), { size: "wrap" });
  return (
    <>
      <span
        {...props}
        tabIndex={0}
        aria-label={label}
        className={
          review === "verified"
            ? "connector-verified"
            : "connector-badge directory-review-badge"
        }
      >
        {review === "verified" ? (
          <BadgeCheck size={iconSize} strokeWidth={1.6} aria-hidden="true" />
        ) : (
          label
        )}
      </span>
      {tooltip}
    </>
  );
}

export function CommunityExplainer({
  kind = "connector",
  onError = () => {},
}: {
  kind?: DirectoryKind;
  onError?: (error: unknown) => void;
}) {
  return (
    <p className="directory-community-explainer" role="note">
      {communityExplainers[kind]}{" "}
      <a
        href={helpUrl("connector-review")}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void window.desktop
            .openExternal(helpUrl("connector-review"))
            .catch(onError);
        }}
      >
        Learn more
      </a>
      .
    </p>
  );
}
