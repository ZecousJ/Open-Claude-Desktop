/**
 * A project to show on the Projects page, asked for by ⌘K search. A page
 * that is already showing hears it at once; otherwise the page reads it as
 * it mounts and clears it once mounted (reading does not clear it, so
 * React's repeated initialisers in development see the same value). The
 * App's shared state has no slot for it.
 */
let requestedProject: string | undefined;
const listeners = new Set<(id: string | undefined) => void>();

export function requestProject(id?: string) {
  if (listeners.size) for (const listener of listeners) listener(id);
  else requestedProject = id;
}

export function projectRequest() {
  return requestedProject;
}

export function clearProjectRequest() {
  requestedProject = undefined;
}

/** While mounted, the Projects page opens requested projects itself. */
export function onProjectRequest(listener: (id: string | undefined) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A chat shared with the account to show on its page (/shared/<token>, or a
 * row of the history page). The page reads it as it mounts; the last one
 * asked for stays, so a reload of the page's address shows it again.
 */
let requestedShared: string | undefined;
const sharedListeners = new Set<(token: string) => void>();

export function requestSharedChat(token: string) {
  requestedShared = token;
  for (const listener of sharedListeners) listener(token);
}

export function sharedChatRequest() {
  return requestedShared;
}

export function onSharedChatRequest(listener: (token: string) => void) {
  sharedListeners.add(listener);
  return () => {
    sharedListeners.delete(listener);
  };
}

let requestedArtifactSurface: "design" | undefined;
const artifactListeners = new Set<() => void>();
export function requestArtifactDesign() {
  requestedArtifactSurface = "design";
  artifactListeners.forEach((listener) => listener());
}
export function takeArtifactDesignRequest() {
  const requested = requestedArtifactSurface === "design";
  requestedArtifactSurface = undefined;
  return requested;
}
export function onArtifactDesignRequest(listener: () => void) {
  artifactListeners.add(listener);
  return () => {
    artifactListeners.delete(listener);
  };
}
