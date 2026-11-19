/** Creation-only lease. Committed-window retirement/cache is a separate transaction. */
export class OfficialWindowCreationCancelled extends Error {
  constructor() {
    super(
      "Official window creation was cancelled because the account or main window changed.",
    );
  }
}

export interface StagedWindow {
  isDestroyed(): boolean;
  destroy(): void;
}
export function stageOfficialWindow<W extends StagedWindow>(options: {
  current(): boolean;
  subscribeRetirement(retire: () => void): () => void;
  main(): W | undefined;
  setMain(window: W): void;
  extra: boolean;
  revoke?(window: W): void;
}) {
  const previous = options.main();
  let candidate: W | undefined,
    committed = false,
    retired = false;
  const disposeCandidate = () => {
    if (!committed && candidate) {
      try {
        options.revoke?.(candidate);
      } finally {
        if (!candidate.isDestroyed()) candidate.destroy();
      }
    }
  };
  const stop = options.subscribeRetirement(() => {
    retired = true;
    disposeCandidate();
  });
  const check = () => {
    if (retired || !options.current())
      throw new OfficialWindowCreationCancelled();
    if (candidate?.isDestroyed())
      throw new Error("Official window closed before loading.");
  };
  return {
    check,
    attach(window: W) {
      candidate = window;
      check();
    },
    commit() {
      check();
      if (!candidate) throw new Error("Official window candidate is missing.");
      if (!options.extra && options.main() !== previous)
        throw new OfficialWindowCreationCancelled();
      committed = true;
      if (!options.extra) options.setMain(candidate);
      stop();
    },
    dispose() {
      stop();
      disposeCandidate();
    },
  };
}

/** Own the activated-listener promise without exposing arbitrary load URLs/errors. */
export async function finishOfficialWindowActivation<
  W extends StagedWindow,
>(options: {
  create(): Promise<W>;
  current(): boolean;
  main(): W | undefined;
  previous: W | undefined;
  close(window: W): void;
  reportFailure(): void;
}) {
  try {
    const created = await options.create();
    if (
      options.current() &&
      options.main() === created &&
      options.previous &&
      options.previous !== created &&
      !options.previous.isDestroyed()
    )
      options.close(options.previous);
  } catch (error) {
    if (
      !(error instanceof OfficialWindowCreationCancelled) &&
      options.current()
    )
      options.reportFailure();
  }
}
