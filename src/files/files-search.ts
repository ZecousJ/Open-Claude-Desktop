const listeners = new Set<(id: string) => void>();
let pending: string | undefined;

/** Focus the ? content filter (live claude.ai bundle, 2026-10-14, c11959232-CiUz9ooX.js). */
export function requestFilesContentSearch(id: string) {
  pending = id;
  for (const listener of listeners) listener(id);
}

export function onFilesContentSearch(id: string, focus: () => void) {
  const listener = (target: string) => {
    if (target !== id) return;
    pending = undefined;
    focus();
  };
  listeners.add(listener);
  if (pending === id) listener(id);
  return () => {
    listeners.delete(listener);
  };
}
