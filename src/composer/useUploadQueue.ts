import { useCallback, useEffect, useState, type RefObject } from "react";

/**
 * A send pressed while files are still being added waits for them and then goes
 * out. A different draft, or a file that fails, drops the wait.
 * `submit.current` is the composer's latest submit, which the caller keeps up
 * to date.
 */
export function useUploadQueue<Options>(
  pendingCount: number,
  draftIdentity: string,
  submit: RefObject<((options?: Options) => void) | undefined>,
) {
  const [queue, setQueue] = useState<{ options?: Options }>();
  useEffect(() => setQueue(undefined), [draftIdentity]);
  useEffect(() => {
    if (!queue || pendingCount > 0) return;
    setQueue(undefined);
    submit.current?.(queue.options);
  }, [queue, pendingCount]);
  return {
    queued: queue !== undefined,
    wait: useCallback((options?: Options) => setQueue({ options }), []),
    cancel: useCallback(() => setQueue(undefined), []),
  };
}
