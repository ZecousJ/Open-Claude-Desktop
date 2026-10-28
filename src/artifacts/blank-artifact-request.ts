import type { AppController } from "../app/AppContext";
/** Creation may finish after navigation. Retire the intent at commit, even if
 * the person later returns to the same Chat; the real pair stays in its library. */
const requests = new Set<{
  owner: object;
  live: boolean;
  current(): boolean;
}>();
export function blankArtifactCreateLease(
  app: AppController,
  includeText = true,
) {
  const owner = app.controllerScope ?? app,
    account = app.accountId,
    scope = app.controllerScope,
    bridge = window.desktop;
  // A later explicit create/send supersedes an earlier deferred intent.
  for (const previous of requests)
    if (previous.owner === owner) {
      previous.live = false;
      requests.delete(previous);
    }
  const location = [
    app.page,
    app.mode,
    app.activeId,
    app.draftSession,
    app.artifactRouteId,
    includeText ? app.text : undefined,
  ] as const;
  const request = {
    owner,
    live: true,
    current: () => {
      const now = app.currentController?.current ?? app;
      return Boolean(
        now &&
        now.accountId === account &&
        now.controllerScope === scope &&
        window.desktop === bridge &&
        [
          now.page,
          now.mode,
          now.activeId,
          now.draftSession,
          now.artifactRouteId,
          includeText ? now.text : undefined,
        ].every((part, index) => part === location[index]),
      );
    },
  };
  requests.add(request);
  return {
    current: () => request.live && request.current(),
    release: () => {
      request.live = false;
      requests.delete(request);
    },
  };
}
export function retireBlankArtifactCreates(owner?: object) {
  for (const request of requests)
    if (owner ? request.owner === owner : !request.current()) {
      request.live = false;
      requests.delete(request);
    }
}
