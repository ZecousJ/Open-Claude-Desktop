import type { AppUpdateStatus } from "../../shared/app-update-api";

/** . */
export async function runUpdateMenuAction(options: {
  status: AppUpdateStatus | undefined;
  restart: () => void;
  check: () => Promise<void>;
}) {
  if (options.status?.phase === "ready") options.restart();
  else await options.check();
}
