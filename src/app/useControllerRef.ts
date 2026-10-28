import { useLayoutEffect, useMemo, useRef } from "react";

/** Async controls follow current render state and stop on account change/unmount. */
export function useControllerRef<T extends { accountId: string }>(
  owner: string,
) {
  const currentController = useRef<T>(undefined);
  const rendered = useRef<T>(undefined);
  const controllerScope = useMemo(() => ({}), [owner]);
  useLayoutEffect(() => {
    currentController.current =
      rendered.current?.accountId === owner ? rendered.current : undefined;
    return () => {
      if (currentController.current?.accountId === owner)
        currentController.current = undefined;
    };
  }, [owner]);
  return {
    currentController,
    controllerScope,
    exposeController: (value: T) => {
      rendered.current = value;
      currentController.current = value;
    },
  };
}
