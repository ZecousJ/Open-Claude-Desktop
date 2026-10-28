import { timeOf, validRepeat } from "../../shared/routines";
import {
  proposeSchedule,
  type ScheduleProposal,
} from "../../shared/routine-proposals";
import type { Prompt } from "../memory/prompts";

/** "2026-10-13T12:00": a moment as the local date and time the model is told and answers in. */
function localMoment(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${timeOf(at)}`;
}

/** The request that has the model write a scheduled task from a sentence. */
export const scheduleProposalPrompt = (
  description: string,
  now = Date.now(),
): Prompt => ({
  instructions: [
    "You turn a person's request into a scheduled task for an AI assistant.",
    'Reply with one JSON object and nothing else: {"name": string, "instructions": string, "repeat": {...}}.',
    "name: two to five words. instructions: what the assistant should do on each run, written to the assistant in the second person, complete enough to run without asking anything, in the language of the request.",
    'repeat is one of {"kind":"manual"}, {"kind":"once","at":"YYYY-MM-DDTHH:MM"}, {"kind":"hourly","minute":0-59}, {"kind":"daily","time":"HH:MM"}, {"kind":"weekdays","time":"HH:MM"}, {"kind":"weekly","time":"HH:MM","day":0-6} (0 is Sunday), {"kind":"monthly","time":"HH:MM","dayOfMonth":1-31}. Times are 24-hour local. Use manual when the request names no time, and do not invent one.',
    `Use once, with the local date and time, when the request is for a single run ("tomorrow at 3pm", "in two hours", "on October 14 at 9"). The local time now is ${localMoment(now)}; the moment must be after it.`,
  ].join("\n"),
  input: description,
});

/**
 * The model's answer as a proposal, or the schedule read from the words when
 * the answer is not usable (or `answer` is undefined: no model was reachable).
 */
export function scheduleProposalFrom(
  description: string,
  answer: string | undefined,
  now = Date.now(),
): ScheduleProposal {
  const fallback = () => proposeSchedule(description, now);
  if (!answer) return fallback();
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback();
  try {
    const value = JSON.parse(answer.slice(start, end + 1));
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const prompt =
      typeof value.instructions === "string" ? value.instructions.trim() : "";
    if (!name || !prompt) return fallback();
    // A single run is named by its local date and time; a moment that has passed is not one.
    const rule = value.repeat;
    if (rule?.kind === "once" && typeof rule.at === "string") {
      const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rule.at)
        ? new Date(rule.at).getTime()
        : Number.NaN;
      if (!Number.isFinite(at) || at <= now) return fallback();
      rule.at = at;
    }
    return {
      name: name.slice(0, 120),
      prompt: prompt.slice(0, 20_000),
      repeat: validRepeat(rule),
    };
  } catch {
    return fallback();
  }
}
