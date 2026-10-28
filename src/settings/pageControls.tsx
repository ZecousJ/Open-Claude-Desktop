import { useEffect, useState, type DependencyList } from "react";

/** Loads a value for a page; `reload` runs the loader again. */
export function useLoaded<T>(
  load: () => Promise<T>,
  onError: (error: unknown) => void,
  deps: DependencyList = [],
) {
  const [value, setValue] = useState<T>();
  const [failed, setFailed] = useState(false);
  const run = () =>
    load()
      .then((result) => {
        setValue(result);
        setFailed(false);
      })
      .catch((error) => {
        setFailed(true);
        onError(error);
      });
  useEffect(() => {
    void run();
  }, deps);
  return { value, setValue, failed, reload: run };
}
