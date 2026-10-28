import { t } from "../i18n";
import "./artifact-current-user.css";

/** Standalone artifact header identity: captured You avatar28px, no
 * unobserved profile menu. The initial and tooltip use the actual actor. */
export function ArtifactCurrentUser({ name }: { name: string }) {
  const title = name.trim() || t("You");
  return (
    <span
      className="artifact-current-user"
      role="img"
      aria-label={t("You")}
      title={title}
      data-no-translate
    >
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}
