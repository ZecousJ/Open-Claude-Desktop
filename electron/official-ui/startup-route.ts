import { inAdapterScope, type AdapterScope } from "./api/scope";
import { readState } from "./api/state";

export function officialStartupRoute(scope: AdapterScope) {
  const preferences = inAdapterScope(scope, () =>
    readState<{ sidebarMode?: unknown } | null>("preferences", null),
  );
  const mode = preferences?.sidebarMode;
  if (mode === "code" || mode === "epitaxy") return "/epitaxy?coldLaunch=1";
  // The pinned renderer uses the shared Chat and Cowork homepage.
  return "/new";
}
