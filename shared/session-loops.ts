export interface SessionLoop {
  id: string;
  conversationId: string;
  prompt: string;
  cron: string;
  recurring: boolean;
  createdAt: number;
  nextRunAt: number;
}

export interface SessionLoopInput {
  prompt: string;
  cron: string;
  recurring?: boolean;
}

export function loopCommand(text: string): SessionLoopInput {
  if (/^\d+[mhd]$/.test(text.trim())) throw Error("/loop [interval] <prompt>");
  const match = /^(?:(\d+)(m|h|d)\s+)?([\s\S]+)$/.exec(text.trim());
  if (!match) throw Error("/loop [interval] <prompt>");
  const amount = match[1] ? Number(match[1]) : 10;
  const unit = match[2] ?? "m";
  if (amount < 1 || amount > (unit === "m" ? 59 : unit === "h" ? 23 : 30))
    throw Error("/loop [interval] <prompt>");
  return {
    prompt: match[3].trim(),
    cron:
      unit === "m"
        ? `*/${amount} * * * *`
        : unit === "h"
          ? `0 */${amount} * * *`
          : `0 0 */${amount} * *`,
    recurring: true,
  };
}

// Session loops expire after thirty days.
export const sessionLoopLifetime = 2_592_000_000;

export function loopNextRun(loop: SessionLoop, now: number) {
  if (!loop.recurring || loop.nextRunAt > now) return loop.nextRunAt;
  const fields = loop.cron.trim().split(/\s+/);
  const step = (field: string) => Number(/^\*\/(\d+)$/.exec(field)?.[1]);
  const interval =
    step(fields[0]) * 60000 ||
    (fields[0] === "0" && step(fields[1]) * 3600000) ||
    (fields[0] === "0" && fields[1] === "0" && step(fields[2]) * 86400000);
  return interval
    ? loop.nextRunAt +
        (Math.floor((now - loop.nextRunAt) / interval) + 1) * interval
    : undefined;
}
