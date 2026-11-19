import type { ChromeImportPresence } from "../../shared/chrome-import";

let activePrompt: Promise<boolean> | undefined;

export async function requestChromeImportPresence(
  prompt: (signal: AbortSignal) => Promise<boolean>,
  lifetime: AbortSignal,
  timeoutMs = 120_000,
): Promise<ChromeImportPresence> {
  if (lifetime.aborted) return "presence_left";
  if (activePrompt) return "busy";

  const deadline = new AbortController();
  const signal = AbortSignal.any([lifetime, deadline.signal]);
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  let endWait = () => {};
  const cancelled = new Promise<boolean>((resolve) => {
    endWait = () => resolve(false);
    signal.addEventListener("abort", endWait, { once: true });
  });
  const pending = Promise.resolve()
    .then(() => !signal.aborted && prompt(signal))
    .catch(() => false);
  activePrompt = pending;
  // The native Touch ID request can outlive the wait. It must settle before
  // another request can present a system prompt.
  void pending.then(() => { activePrompt = undefined; });
  try {
    const granted = await Promise.race([pending, cancelled]);
    if (lifetime.aborted) return "presence_left";
    if (deadline.signal.aborted) return "presence_timed_out";
    return granted ? "granted" : "presence_declined";
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", endWait);
  }
}
