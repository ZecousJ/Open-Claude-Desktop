/**
 * Quitting must always finish: a step that hangs (an engine that never
 * answers, a share server that never closes) is given up on after its time
 * limit, so the quit goes on to install a staged update and relaunch.
 * No Electron imports.
 */

/** How long one shutdown step may take. */
export const shutdownStepMs = 8_000;
/** How long the whole shutdown may take before the quit goes on anyway. */
export const shutdownTotalMs = 15_000;
/** How long installing a staged update may hold the exit. */
export const installHoldMs = 30_000;

/**
 * Resolves when `work` settles or `ms` pass, whichever is first; never
 * rejects. Returns true when the time ran out.
 */
export async function settleWithin(
  work: Promise<unknown> | undefined,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work).then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the shutdown steps in order, each within `stepMs`, the whole within
 * `totalMs`. Always resolves; `timedOut` lists the steps that were given up on.
 */
export async function runShutdown(
  steps: {
    name: string;
    run: () => Promise<unknown> | unknown;
    cancel?: () => void;
  }[],
  { stepMs = shutdownStepMs, totalMs = shutdownTotalMs } = {},
): Promise<{ timedOut: string[]; failed: string[] }> {
  const timedOut: string[] = [],
    failed: string[] = [];
  let cancelled = false;
  let current: (typeof steps)[number] | undefined;
  const all = (async () => {
    for (const step of steps) {
      if (cancelled) break;
      current = step;
      let work: Promise<unknown>;
      try {
        work = Promise.resolve(step.run()).catch(() => {
          failed.push(step.name);
        });
      } catch {
        failed.push(step.name);
        current = undefined;
        continue;
      }
      if (await settleWithin(work, stepMs)) {
        timedOut.push(step.name);
        step.cancel?.();
      }
      current = undefined;
    }
  })();
  if (await settleWithin(all, totalMs)) {
    timedOut.push("shutdown");
    cancelled = true;
    current?.cancel?.();
  }
  return { timedOut: [...timedOut], failed: [...failed] };
}
