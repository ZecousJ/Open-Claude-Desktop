import { Folder, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../../../shared/types";
import { useHost } from "../../host/HostContext";
import { t, useLocale } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import { folderName, projectDate, projectDateTooltip } from "./project-list";

// The footer's glyphs (Lucide) at 16px.
const glyphs = { Laptop, Folder } as const;

function FooterIcon({ name }: { name: keyof typeof glyphs }) {
  const Icon = glyphs[name];
  return <Icon size={16} strokeWidth={1.75} aria-hidden="true" />;
}

/** Date, folder, then Local. */
export function ProjectCardFooter({
  project,
  timestamp,
}: {
  project: Project;
  timestamp: number;
}) {
  useLocale();
  const host = useHost();
  const local = host.kind === "desktop" && Boolean(project.cwd);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <small>
      <span className="prj-card-date">
        {timestamp > 0 && (
          <WithTooltip label={projectDateTooltip(timestamp)}>
            {(props) => (
              <time {...props} dateTime={new Date(timestamp).toISOString()}>
                {projectDate(timestamp, now)}
              </time>
            )}
          </WithTooltip>
        )}
      </span>
      {local && (
        <span className="prj-card-badges">
          <WithTooltip label={project.cwd!}>
            {(props) => (
              <span {...props} className="prj-card-folder" dir="ltr">
                <FooterIcon name="Folder" />
                <span aria-hidden="true">{folderName(project.cwd!)}</span>
                <span className="sr-only">{project.cwd}</span>
              </span>
            )}
          </WithTooltip>
          <WithTooltip label={t("Runs on this computer")}>
            {(props) => (
              <span {...props} className="prj-card-local">
                <FooterIcon name="Laptop" />
                <span aria-hidden="true">{t("Local")}</span>
                <span className="sr-only">{t("Runs on this computer")}</span>
              </span>
            )}
          </WithTooltip>
        </span>
      )}
    </small>
  );
}
