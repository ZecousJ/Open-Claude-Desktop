/**
 * Scheduled-task e-mail through the Claudex service (backend
 * internal/claudex/routinemail): whether the service can send it, and the
 * mail for one run, always to the signed-in person's own address. The
 * desktop and the web runner each pass their signed-in session.
 */
import { requestJson } from "../sub2api/http";

type Fetch = typeof fetch;

export interface RoutineMailSession {
  baseUrl(): string | undefined;
  authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T>;
}

export type RoutineMailOutcome = "completed" | "failed" | "needs_attention";

const statusTtlMs = 5 * 60_000;

export function routineMailer(
  session: () => RoutineMailSession | undefined,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
) {
  let cached: { at: number; base: string; value: boolean } | undefined;
  const url = (base: string) => `${base}/api/v1/claudex/routines/email`;
  async function available() {
    const current = session();
    const base = current?.baseUrl();
    if (!current || !base) return false;
    if (cached && cached.base === base && now() - cached.at < statusTtlMs)
      return cached.value;
    let value = false;
    try {
      const body = (await current.authorized((token) =>
        requestJson(fetchImpl, url(base), { token }),
      )) as { available?: unknown } | undefined;
      value = body?.available === true;
    } catch {
      value = false;
    }
    cached = { at: now(), base, value };
    return value;
  }
  async function send(input: {
    task: string;
    outcome: RoutineMailOutcome;
    summary?: string;
    link?: string;
  }) {
    const current = session();
    const base = current?.baseUrl();
    if (!current || !base) return false;
    const body = (await current.authorized((token) =>
      requestJson(fetchImpl, url(base), {
        method: "POST",
        token,
        body: {
          task: input.task.slice(0, 200),
          outcome: input.outcome,
          ...(input.summary ? { summary: input.summary.slice(0, 2000) } : {}),
          ...(input.link ? { link: input.link } : {}),
        },
      }),
    )) as { sent?: unknown } | undefined;
    return body?.sent === true;
  }
  return { available, send };
}

/**
 * Whether a run's end mails: the person's "Scheduled tasks by email" switch
 * covers every task (the live app's one account-level routines.enable_email),
 * and a task's own Email choice mails it even with the switch off. A new
 * task saves email off, so the switch must not be read as overridden by it.
 */
export function routineRunMails(
  task: { notifyOnCompletion?: { email: boolean } },
  accountSwitch: boolean,
) {
  return Boolean(task.notifyOnCompletion?.email) || accountSwitch;
}
