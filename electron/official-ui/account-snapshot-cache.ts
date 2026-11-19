import type { Snapshot } from "../../shared/types";
export interface NativeAccountLease {
  owner: string | undefined;
  store: unknown;
  generation: unknown;
  active: boolean;
}
export function createAccountSnapshotCache<
  T extends Pick<Snapshot, "replyFeedback">,
>(options: {
  current(): NativeAccountLease;
  read(): Promise<T>;
  now?: () => number;
  freshMs?: number;
}) {
  const now = options.now ?? Date.now;
  let cached:
    { lease: NativeAccountLease; at: number; value: Promise<T> } | undefined;
  let latest:
    | { lease: NativeAccountLease; value: Record<string, "up" | "down"> }
    | undefined;
  const same = (a: NativeAccountLease, b: NativeAccountLease) =>
    a.active &&
    b.active &&
    !!a.owner &&
    a.owner === b.owner &&
    a.store != null &&
    a.store === b.store &&
    a.generation != null &&
    a.generation === b.generation;
  const capture = () => {
    const lease = { ...options.current() };
    const check = () => {
      if (!same(lease, options.current()))
        throw Error("The account changed during the snapshot read.");
    };
    check();
    return { lease, check };
  };
  return {
    capture,
    invalidate() {
      cached = undefined;
    },
    age() {
      return cached && same(cached.lease, options.current())
        ? now() - cached.at
        : undefined;
    },
    ratings() {
      return latest && same(latest.lease, options.current())
        ? latest.value
        : {};
    },
    read(fresh = false): Promise<T> {
      const { lease, check } = capture();
      if (
        !fresh &&
        cached &&
        same(cached.lease, lease) &&
        now() - cached.at < (options.freshMs ?? 1500)
      )
        return cached.value;
      // Keep the entry identity so an older completion cannot overwrite a newer read.
      let entry: {
        lease: NativeAccountLease;
        at: number;
        value: Promise<T>;
      };
      const value = Promise.resolve()
        .then(() => {
          check();
          return options.read();
        })
        .then(
          (value) => {
            check();
            if (cached === entry)
              latest = { lease, value: value.replyFeedback ?? {} };
            return value;
          },
          (error) => {
            check();
            throw error;
          },
        );
      entry = { lease, at: now(), value };
      cached = entry;
      void value.catch(() => {
        if (cached === entry) cached = undefined;
      });
      return value;
    },
  };
}
