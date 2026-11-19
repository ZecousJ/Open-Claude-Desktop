import { useEffect, useState } from "react";
import type { Project } from "../../../shared/types";
import { useHost } from "../../host/HostContext";
import { t, useLocale } from "../../i18n";
import { WithTooltip } from "../../ui/Tooltip";
import { folderName, projectDate, projectDateTooltip } from "./project-list";

// Anthropicons sm, regular weight 533.3 (live claude.ai bundle, 2026-10-14, shared-frame-B1JORnF0.js).
const glyphs = {
  Laptop:
    "m4.4 3.03h7.2q.39 0 .69.19q.31.18.49.49q.19.3.19.69v5.6q0 .24-.16.41q-.17.16-.41.16h-8.8q-.24 0-.41-.16q-.16-.17-.16-.41v-5.6q0-.39.19-.69q.18-.31.49-.49q.3-.19.69-.19zm0 1.14q-.09 0-.16.07q-.07.07-.07.16v5.6q0-.24-.16-.41q-.17-.16-.41-.16h8.8q-.24 0-.41.16q-.16.17-.16.41v-5.6q0-.09-.07-.16q-.07-.07-.16-.07zm-2.19 5.26h11.6q.3 0 .53.23q.23.23.23.53v1.01q0 .48-.24.88q-.24.41-.65.65q-.4.24-.88.24h-9.6q-.48 0-.88-.24q-.41-.24-.65-.65q-.24-.4-.24-.88v-1.01q0-.3.23-.53q.23-.23.55-.23zm0 1.14l.36-.38v1.01q0 .26.19.44q.18.19.44.19h9.6q.26 0 .44-.19q.19-.18.19-.44v-1.01l.38.38z",
  Folder:
    "m4.4 5.77q-.24 0-.41-.16q-.16-.17-.16-.41q0-.24.16-.41q.17-.16.41-.16h8.8q.39 0 .69.19q.31.18.49.49q.19.3.19.69v6.4q0 .39-.19.69q-.18.31-.49.49q-.3.19-.69.19h-10.4q-.39 0-.69-.19q-.31-.18-.49-.49q-.19-.3-.19-.69v-8.8q0-.39.19-.69q.18-.31.49-.49q.3-.19.69-.19h4.3q.39 0 .72.2q.34.2.51.55l.98 1.96q.11.22.03.45q-.07.22-.27.32q-.23.11-.45.03q-.23-.07-.33-.28l-.97-1.96q-.07-.13-.22-.13h-4.3q-.09 0-.16.07q-.07.07-.07.16v8.8q0 .09.07.16q.07.07.16.07h10.4q.09 0 .16-.07q.07-.07.07-.16v-6.4q0-.09-.07-.16q-.07-.07-.16-.07z",
};

function FooterIcon({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={glyphs[name]} />
    </svg>
  );
}

/** Date, folder, then Local (live claude.ai bundle, 2026-10-14, c17beaa76-CrQT9ilA.js). */
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
