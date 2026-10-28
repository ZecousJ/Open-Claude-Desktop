import fs from "node:fs";
import path from "node:path";
import type {
  UsageRange,
  UsageRecord,
  UsageSummary,
  UsageTotals,
} from "../../shared/types";

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function valid(record: unknown): record is UsageRecord {
  if (!record || typeof record !== "object") return false;
  const v = record as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length < 100 &&
    nonnegative(v.at) &&
    typeof v.providerId === "string" &&
    v.providerId.length <= 100 &&
    typeof v.model === "string" &&
    v.model.length <= 200 &&
    ["chat", "responses"].includes(String(v.protocol)) &&
    nonnegative(v.durationMs) &&
    nonnegative(v.statusCode) &&
    typeof v.usageKnown === "boolean" &&
    ["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens"].every(
      (key) => nonnegative(v[key]),
    )
  );
}
function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    successful: 0,
    failed: 0,
    unmetered: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}
/** Local calendar day (YYYY-MM-DD) that usage is bucketed and limited by. */
export function localDate(value: number) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Append-only account-scoped request accounting; never records prompts or credentials. */
export class UsageLedger {
  private readonly folder: string;
  constructor(root: string) {
    this.folder = path.join(root, "usage");
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
  }
  record(value: UsageRecord) {
    if (!valid(value)) throw Error("Invalid usage record.");
    const month = new Date(value.at).toISOString().slice(0, 7);
    const filename = path.join(this.folder, `${month}.jsonl`);
    fs.appendFileSync(filename, JSON.stringify(value) + "\n", { mode: 0o600 });
  }
  /** Reported input + output tokens of requests made in [from, to]. */
  tokens(from: number, to: number) {
    return this.records(from, to).reduce(
      (sum, row) => sum + row.inputTokens + row.outputTokens,
      0,
    );
  }
  private records(cutoff: number, now: number) {
    const rows: UsageRecord[] = [];
    for (const name of fs
      .readdirSync(this.folder)
      .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
      .sort()) {
      const raw = fs.readFileSync(path.join(this.folder, name), "utf8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw Error(
            `Usage log ${name} cannot be read; it has not been overwritten.`,
          );
        }
        if (!valid(parsed))
          throw Error(
            `Usage log ${name} contains an invalid record; it has not been overwritten.`,
          );
        if (parsed.at >= cutoff && parsed.at <= now) rows.push(parsed);
      }
    }
    return rows;
  }
  summary(range: UsageRange = "all", now = Date.now()): UsageSummary {
    if (!["all", "30d", "7d"].includes(range) || !Number.isFinite(now))
      throw Error("Invalid usage range.");
    const cutoff =
      range === "all" ? -Infinity : now - (range === "30d" ? 30 : 7) * 86400000;
    const rows = this.records(cutoff, now);
    const total = emptyTotals();
    const models = new Map<string, UsageTotals>();
    const daily = new Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number }
    >();
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      requests: 0,
    }));
    for (const row of rows) {
      const id = JSON.stringify([row.providerId, row.model]);
      const stats = models.get(id) ?? emptyTotals();
      for (const item of [total, stats]) {
        item.requests++;
        if (row.statusCode >= 200 && row.statusCode < 300) item.successful++;
        else item.failed++;
        if (!row.usageKnown) item.unmetered++;
        item.inputTokens += row.inputTokens;
        item.outputTokens += row.outputTokens;
        item.cachedTokens += row.cachedTokens;
        item.reasoningTokens += row.reasoningTokens;
      }
      models.set(id, stats);
      const date = localDate(row.at),
        day = daily.get(date) ?? {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      day.requests++;
      day.inputTokens += row.inputTokens;
      day.outputTokens += row.outputTokens;
      daily.set(date, day);
      hours[new Date(row.at).getHours()].requests++;
    }
    return {
      range,
      total,
      models: [...models].map(([identity, stats]) => {
        const [providerId, model] = JSON.parse(identity) as [string, string];
        return { providerId, model, ...stats };
      }),
      daily: [...daily]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, stats]) => ({ date, ...stats })),
      hours,
    };
  }
}
