/**
 * How long a message's start took, step by step. One line per send in a runner
 * space, or anywhere with CLAUDEX_TIMING=1: [timing] c1234567: setup 2100ms,
 * engine 5400ms (gateway 3, app-server 3900, skills 1200), thread 300ms, turn
 * 80ms, first output 4200ms Each step is measured from the end of the one
 * before.
 */
export class StartTiming {
  private last = Date.now();
  private readonly parts: string[] = [];
  constructor(
    private readonly label: string,
    readonly enabled: boolean,
  ) {}
  mark(step: string, detail?: string) {
    if (!this.enabled) return;
    const now = Date.now();
    this.parts.push(
      `${step} ${now - this.last}ms${detail ? ` (${detail})` : ""}`,
    );
    this.last = now;
  }
  done(step: string) {
    if (!this.enabled) return;
    this.mark(step);
    console.log(`[timing] ${this.label}: ${this.parts.join(", ")}`);
  }
}

/** The engine's own start, step by step, for the next StartTiming line. */
export class StepClock {
  private last = Date.now();
  readonly steps: string[] = [];
  mark(step: string) {
    const now = Date.now();
    this.steps.push(`${step} ${now - this.last}`);
    this.last = now;
  }
}

export const timingWanted = (spaceEngine: boolean) =>
  spaceEngine || process.env.CLAUDEX_TIMING === "1";
