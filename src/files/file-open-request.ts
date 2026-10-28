const listeners = new Set<(id: string, path: string) => void>();
let pending: { id: string; path: string } | undefined;

/**
 * Opens a file in a session's file pane from elsewhere. A pane that mounts
 * after the request picks it up.
 */
export function requestFileOpen(id: string, path: string) {
  pending = { id, path };
  for (const listener of listeners) listener(id, path);
}

export function onFileOpenRequest(id: string, open: (path: string) => void) {
  const listener = (target: string, path: string) => {
    if (target !== id) return;
    pending = undefined;
    open(path);
  };
  listeners.add(listener);
  if (pending?.id === id) listener(id, pending.path);
  return () => {
    listeners.delete(listener);
  };
}
