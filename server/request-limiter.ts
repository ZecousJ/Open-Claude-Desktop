import type { RequestLimits } from "./operator-limits";
import { localDate } from "../electron/conversations/usage-ledger";
import { weeklyWindow } from "../electron/conversations/weekly-usage";

/** Tokens already reported when the limiter starts: today's and this usage week's. */
export interface LimiterSeed {
  day: string;
  tokens: number;
  weekTokens?: number;
}

/** Per-account policy at the localhost provider boundary. Token quotas are based on reported upstream usage. */
export class RequestLimiter {
  private active = 0;
  private starts: number[] = [];
  private day: string;
  private usedTokens: number;
  private weekStart: number;
  private weekTokens: number;
  constructor(
    private limits: RequestLimits,
    initial: LimiterSeed,
    private now: () => number = Date.now,
  ) {
    this.day = initial.day;
    this.usedTokens = initial.tokens;
    this.weekStart = this.week(this.now()).start;
    this.weekTokens = initial.weekTokens ?? 0;
  }
  private week(at: number) {
    return weeklyWindow(
      at,
      this.limits.weeklyResetDay,
      this.limits.weeklyResetHour,
    );
  }
  private refresh(at: number) {
    const day = localDate(at);
    if (day !== this.day) {
      this.day = day;
      this.usedTokens = 0;
    }
    const week = this.week(at).start;
    if (week !== this.weekStart) {
      this.weekStart = week;
      this.weekTokens = 0;
    }
    const cutoff = at - 60_000;
    while (this.starts.length && this.starts[0] <= cutoff) this.starts.shift();
  }
  acquire() {
    const at = this.now();
    this.refresh(at);
    if (
      this.limits.maxConcurrent !== null &&
      this.active >= this.limits.maxConcurrent
    )
      throw Error(
        "This account has too many requests in progress. Try again shortly.",
      );
    if (
      this.limits.requestsPerMinute !== null &&
      this.starts.length >= this.limits.requestsPerMinute
    )
      throw Error(
        "This account reached its requests-per-minute limit. Try again shortly.",
      );
    if (
      this.limits.dailyTokenLimit !== null &&
      this.usedTokens >= this.limits.dailyTokenLimit
    )
      throw Error("This account reached its daily token limit.");
    if (
      this.limits.weeklyTokenLimit !== null &&
      this.weekTokens >= this.limits.weeklyTokenLimit
    )
      throw Error(
        `This account reached its weekly token limit. It resets ${new Date(this.week(at).end).toLocaleString("en-US")}.`,
      );
    this.active++;
    this.starts.push(at);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  recordUsage(at: number, inputTokens: number, outputTokens: number) {
    this.refresh(this.now());
    if (localDate(at) === this.day)
      this.usedTokens += inputTokens + outputTokens;
    if (at >= this.weekStart) this.weekTokens += inputTokens + outputTokens;
  }
}
