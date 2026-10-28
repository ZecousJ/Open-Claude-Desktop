import type { Mode } from "../../shared/types";
import type { HostInfo } from "../../shared/host";

/**
 * Whether Cowork can run in this host: on the desktop it runs on this
 * computer; on the web only once the service offers cloud Cowork
 * (capability `cloudCowork`, web plan Q19: phase B).
 */
export function coworkAvailable(host: HostInfo) {
  return host.kind === "desktop" || host.capabilities.cloudCowork;
}

/**
 * The execution kind for a new session. Both non-Code kinds use the same
 * chat interface; retaining the stored Cowork kind keeps its tools and old
 * conversations compatible. On a host without task execution, a new
 * session uses Chat. The Code page always shows, as on
 * claude.ai/code: before cloud Code runs, its composer says it cannot send
 * yet (src/composer/CloudWorkspaceBar.tsx).
 */
export function homeMode(mode: Mode, host: HostInfo, incognito = false): Mode {
  if (mode === "code") return mode;
  // An incognito chat stays a chat: tasks keep folders and history.
  return coworkAvailable(host) && !incognito ? "cowork" : "chat";
}
