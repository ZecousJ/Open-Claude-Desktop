import type { AppUpdateStatus } from "../../shared/app-update-api";

/** (live claude.ai bundle, 2026-10-14, index.chunk-BWk6pVUt.js). */
export async function runUpdateMenuAction(options: {
  status: AppUpdateStatus | undefined;
  restart: () => void;
  check: () => Promise<void>;
}) {
  if (options.status?.phase === "ready") options.restart();
  else await options.check();
}
