/**
 * The realtime transcription protocol's messages, read in the browser. This
 * mirrors `readRealtimeMessage` and `dictationFailure` in
 * server/transcription.ts, which the desktop's provider service uses and
 * which cannot be bundled for the browser (it imports Node modules);
 * tests/web-bridge-dictation.test.ts checks that both read the same samples
 * the same way.
 */

export type RealtimeMessage =
  | { kind: "partial"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "final"; text: string }
  | { kind: "done" }
  | { kind: "error"; code: string; message: string; status?: number }
  | { kind: "ignore" };

export const dictationMessages = {
  unavailable: "Dictation isn't available right now.",
  tooLong: "That recording is too long.",
  disconnected: "Dictation was disconnected. Try again.",
  failed: "Dictation failed. Try again.",
} as const;

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function readRealtimeMessage(raw: string): RealtimeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  const message = record(parsed);
  if (!message) return { kind: "ignore" };
  const type = (str(message.type) ?? str(message.event) ?? "").toLowerCase();
  const error = record(message.error);
  if (type.includes("error") || error) {
    const status = Number(message.status ?? error?.status);
    return {
      kind: "error",
      code: (str(message.code) ?? str(error?.code) ?? str(error?.type) ?? "")
        .slice(0, 100)
        .toUpperCase(),
      message: (
        str(message.message) ??
        str(error?.message) ??
        str(message.error) ??
        ""
      ).slice(0, 500),
      ...(Number.isSafeInteger(status) ? { status } : {}),
    };
  }
  const result = record(message.result);
  const delta = str(message.delta);
  const text =
    str(message.text) ??
    str(message.transcript) ??
    str(result?.text) ??
    str(message.result);
  const flagged = [
    message.final,
    message.is_final,
    message.isFinal,
    message.sentence_end,
    message.sentenceEnd,
    result?.final,
    result?.is_final,
    result?.sentence_end,
  ].some((value) => value === true);
  const flaggedPartial = [
    message.final,
    message.is_final,
    message.isFinal,
  ].some((value) => value === false);
  if (text !== undefined || delta !== undefined) {
    if (
      !flaggedPartial &&
      (flagged || /final|complete|sentence|segment|end/.test(type)) &&
      !/partial|interim|intermediate/.test(type)
    )
      return { kind: "final", text: text ?? delta ?? "" };
    if (text === undefined || (delta !== undefined && /delta/.test(type)))
      return { kind: "delta", text: delta ?? "" };
    return { kind: "partial", text };
  }
  if (
    /^(finish|finished|done|complete|completed|end|ended|stop|stopped|closed)$/.test(
      type,
    ) ||
    /(session|transcript|transcription|request|response|stream)[._](finished|done|completed|ended|stopped|closed)/.test(
      type,
    )
  )
    return { kind: "done" };
  return { kind: "ignore" };
}

/** The sentence the window shows for an error code or status of the service. */
export function dictationFailure(
  code: string,
  status: number | undefined,
  message: string,
) {
  const upper = code.toUpperCase();
  if (
    status === 404 ||
    /AUDIO_DISABLED|MODEL_NOT_FOUND|NOT_AVAILABLE|UNAVAILABLE|NOT_CONFIGURED/.test(
      upper,
    )
  )
    return dictationMessages.unavailable;
  if (status === 413 || /TOO_LARGE|TOO_LONG|DURATION|MAX_SECONDS/.test(upper))
    return dictationMessages.tooLong;
  const shown = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return shown
    ? `Dictation stopped: ${shown.slice(0, 200)}`
    : dictationMessages.failed;
}
