/**
 * Dictation (package C6), run in the provider service child so the key
 * never reaches the main process or the window.
 *
 * The window streams 16 kHz mono 16-bit PCM. For the Claudex service it goes
 * over the realtime WebSocket `/v1/audio/realtime/transcriptions` (owner
 * decision 18): a JSON `start`, binary audio chunks, a JSON `finish`, and
 * the service's partial and final transcripts in between. Other model
 * services with a transcription model get the recording as one WAV file at
 * `/v1/audio/transcriptions` when the person stops.
 */
import { randomUUID } from "node:crypto";
import type { Provider } from "../shared/types";
import { dictationStartOptions, joinSpoken } from "../shared/voice-api";
import { endpoint } from "../electron/engine/gateway-chat";
import { describeSub2ApiRefusal, type GatewayRefusal } from "./sub2api-errors";
import {
  connectTranscriptionSocket,
  SocketRefused,
  type TranscriptionSocket,
} from "./transcription-socket";

const formats: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};
/** Largest file sent to `/audio/transcriptions`. */
export const maxDictationBytes = 5 * 1024 * 1024;
export const dictationSampleRate = 16_000;
/** pcm_s16le, 16 kHz, mono. */
export const pcmBytesPerSecond = dictationSampleRate * 2;
const wavHeaderBytes = 44;
/** Longest recording the one-file upload can carry. */
export const maxBufferedSeconds = Math.floor(
  (maxDictationBytes - wavHeaderBytes) / pcmBytesPerSecond,
);
/** How long the service may take to send the last transcript after `finish`. */
const finishTimeoutMs = 15_000;

export class TranscriptionFailure extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export const dictationMessages = {
  unavailable: "Dictation isn't available right now.",
  tooLong: "That recording is too long.",
  disconnected: "Dictation was disconnected. Try again.",
  failed: "Dictation failed. Try again.",
} as const;

async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 1024 * 1024)
        throw new TranscriptionFailure(
          "Transcription response is too large.",
          502,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function transcribeRecordedAudio(
  provider: Provider,
  apiKey: string,
  mimeType: string,
  audio: Uint8Array,
  language?: string,
) {
  const options = dictationStartOptions({ language });
  const model = provider.transcriptionModel;
  if (!model)
    throw new TranscriptionFailure(
      "Dictation is not enabled for this model service.",
      400,
    );
  const format = formats[mimeType];
  if (!format || audio.byteLength < 16 || audio.byteLength > maxDictationBytes)
    throw new TranscriptionFailure("Unsupported or oversized recording.", 400);
  const body = new FormData();
  body.set("model", model);
  if (options.language)
    body.set("language", options.language.split("-")[0].toLowerCase());
  body.set(
    "file",
    new Blob([Uint8Array.from(audio)], { type: mimeType }),
    `dictation.${format}`,
  );
  const response = await fetch(
    endpoint(provider.baseUrl, "audio/transcriptions"),
    {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body,
      signal: AbortSignal.timeout(90_000),
    },
  );
  const raw = await boundedText(response);
  if (!response.ok)
    throw new TranscriptionFailure(
      `Transcription HTTP ${response.status}: ${raw.slice(0, 500)}`,
      response.status,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TranscriptionFailure("Transcription returned invalid JSON.", 502);
  }
  const text = (parsed as { text?: unknown })?.text;
  if (typeof text !== "string" || text.length > 100_000)
    throw new TranscriptionFailure("Transcription returned invalid text.", 502);
  return text.trim();
}

/** A WAV file around 16 kHz mono pcm_s16le samples. */
export function wavFromPcm(pcm: Uint8Array) {
  const header = Buffer.alloc(wavHeaderBytes);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(dictationSampleRate, 24);
  header.writeUInt32LE(pcmBytesPerSecond, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, pcm]));
}

/** What one service message means for the transcript. */
export type RealtimeMessage =
  | { kind: "partial"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "final"; text: string }
  | { kind: "done" }
  | { kind: "error"; code: string; message: string; status?: number }
  | { kind: "ignore" };

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Reads one message of the realtime protocol. Errors are
 * `{"type":"error","code","message"}` (seen from the provider); the transcript
 * messages are read by their type and flags, because their exact names were
 * not yet confirmed against the provider: `text`/`transcript`/`delta`, a
 * type naming partial/interim/delta or final/completed/sentence, and the
 * `final`/`is_final`/`isFinal`/`sentence_end` flags.
 */
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

/** The sentence the window shows for an error code or HTTP status of the service. */
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

export interface DictationState {
  /** Finished segments, joined. */
  text: string;
  /** The segment still being spoken, as the service hears it now. */
  partial: string;
}

/** One dictation session inside the provider service child. */
export interface DictationSession {
  readonly streaming: boolean;
  /** Longest recording the session takes, in seconds. */
  readonly maxSeconds: number;
  append(pcm: Uint8Array): DictationState;
  /** Resolves to the whole transcript once the service sent the last of it. */
  finish(): Promise<string>;
  cancel(): void;
}

function checkChunk(pcm: Uint8Array, received: number, maxSeconds: number) {
  if (pcm.byteLength % 2 !== 0)
    throw new TranscriptionFailure("Invalid audio.", 400);
  if (received + pcm.byteLength > maxSeconds * pcmBytesPerSecond)
    throw new TranscriptionFailure(dictationMessages.tooLong, 413);
}

/** Collects the recording and uploads it as one WAV file when finished. */
export class BufferedDictation implements DictationSession {
  readonly streaming = false;
  readonly maxSeconds: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private cancelled = false;
  constructor(
    private provider: Provider,
    private apiKey: string,
    maxSeconds = maxBufferedSeconds,
    private language?: string,
  ) {
    if (!provider.transcriptionModel)
      throw new TranscriptionFailure(
        "Dictation is not configured for this model service.",
        400,
      );
    this.maxSeconds = Math.min(maxSeconds, maxBufferedSeconds);
  }
  append(pcm: Uint8Array) {
    if (this.cancelled) throw new TranscriptionFailure("Dictation ended.", 400);
    checkChunk(pcm, this.bytes, this.maxSeconds);
    this.chunks.push(pcm);
    this.bytes += pcm.byteLength;
    return { text: "", partial: "" };
  }
  async finish() {
    if (this.cancelled) throw new TranscriptionFailure("Dictation ended.", 400);
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.byteLength < pcmBytesPerSecond / 10) return "";
    return await transcribeRecordedAudio(
      this.provider,
      this.apiKey,
      "audio/wav",
      wavFromPcm(pcm),
      this.language,
    );
  }
  cancel() {
    this.cancelled = true;
    this.chunks = [];
  }
}

export interface RealtimeOptions {
  provider: Provider;
  apiKey: string;
  headers: Record<string, string>;
  maxSeconds: number;
  language?: string;
  /** A Sub2API refusal, for the usage banner and a new device key. */
  onRefusal?: (refusal: GatewayRefusal) => void;
}

/**
 * Streams the recording to the Claudex service's realtime transcription
 * WebSocket and keeps the transcript it sends back.
 */
export class RealtimeDictation implements DictationSession {
  readonly streaming = true;
  readonly maxSeconds: number;
  private readonly requestId = randomUUID();
  private socket?: TranscriptionSocket;
  private state: DictationState = { text: "", partial: "" };
  private bytes = 0;
  private failure?: TranscriptionFailure;
  private finishing = false;
  private settle?: (error?: TranscriptionFailure) => void;
  private constructor(private options: RealtimeOptions) {
    this.maxSeconds = options.maxSeconds;
  }

  static async open(options: RealtimeOptions) {
    dictationStartOptions({ language: options.language });
    const session = new RealtimeDictation(options);
    await session.connect();
    return session;
  }

  private async connect() {
    const { provider, apiKey, headers } = this.options;
    try {
      this.socket = await connectTranscriptionSocket(
        endpoint(provider.baseUrl, "audio/realtime/transcriptions"),
        {
          ...headers,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        {
          onText: (text) => this.receive(text),
          onClose: (code, reason) => this.closed(code, reason),
          onError: () =>
            this.fail(
              new TranscriptionFailure(dictationMessages.disconnected, 502),
            ),
        },
      );
    } catch (error) {
      if (error instanceof SocketRefused)
        throw this.refused(error.status, error.body);
      throw new TranscriptionFailure(dictationMessages.disconnected, 502);
    }
    this.socket.sendText(
      JSON.stringify({
        type: "start",
        requestId: this.requestId,
        ...dictationStartOptions({ language: this.options.language }),
        audio: {
          format: "pcm_s16le",
          sampleRate: dictationSampleRate,
          channels: 1,
        },
        vad: {
          enabled: true,
          threshold: 0.2,
          prefixPaddingMs: 300,
          silenceDurationMs: 800,
        },
      }),
    );
  }

  /** A refused upgrade: a Sub2API refusal is reported and shown in its own words. */
  private refused(status: number, body: string) {
    const refusal =
      this.options.provider.backend === "sub2api"
        ? describeSub2ApiRefusal(status, body)
        : undefined;
    if (refusal) {
      this.options.onRefusal?.(refusal);
      return new TranscriptionFailure(refusal.message, status);
    }
    let code = "",
      message = "";
    try {
      const parsed = record(JSON.parse(body));
      const nested = record(parsed?.error);
      code = str(parsed?.code) ?? str(nested?.code) ?? str(nested?.type) ?? "";
      message = str(parsed?.message) ?? str(nested?.message) ?? "";
    } catch {}
    return new TranscriptionFailure(
      message || code || status === 404 || status === 413
        ? dictationFailure(code, status, message)
        : dictationMessages.failed,
      status,
    );
  }

  private receive(raw: string) {
    const message = readRealtimeMessage(raw);
    switch (message.kind) {
      case "partial":
        this.state = { ...this.state, partial: message.text.trim() };
        break;
      case "delta":
        this.state = {
          ...this.state,
          partial: this.state.partial + message.text,
        };
        break;
      case "final":
        this.state = {
          text: joinSpoken(this.state.text, message.text),
          partial: "",
        };
        break;
      case "done":
        this.done();
        break;
      case "error": {
        const refusal =
          this.options.provider.backend === "sub2api"
            ? describeSub2ApiRefusal(
                message.status ?? 400,
                JSON.stringify({
                  code: message.code,
                  message: message.message,
                }),
              )
            : undefined;
        if (refusal) this.options.onRefusal?.(refusal);
        this.fail(
          new TranscriptionFailure(
            refusal?.message ??
              dictationFailure(message.code, message.status, message.message),
            message.status ?? 502,
          ),
        );
        break;
      }
    }
  }

  private closed(code: number, reason: string) {
    if (this.finishing) this.done();
    else if (!this.failure)
      this.fail(
        new TranscriptionFailure(
          code === 1000 || code === 1005 || code === 1006
            ? dictationMessages.disconnected
            : dictationFailure(reason, undefined, ""),
          502,
        ),
      );
  }

  private fail(error: TranscriptionFailure) {
    if (this.failure) return;
    this.failure = error;
    this.socket?.destroy();
    this.settle?.(error);
  }

  private done() {
    // The segment the service had not closed yet is part of the transcript.
    if (this.state.partial)
      this.state = {
        text: joinSpoken(this.state.text, this.state.partial),
        partial: "",
      };
    this.settle?.();
    this.socket?.close();
  }

  append(pcm: Uint8Array): DictationState {
    if (this.failure) throw this.failure;
    if (this.finishing || !this.socket?.open)
      throw new TranscriptionFailure(dictationMessages.disconnected, 502);
    checkChunk(pcm, this.bytes, this.maxSeconds);
    this.bytes += pcm.byteLength;
    if (pcm.byteLength) this.socket.sendBinary(pcm);
    return { ...this.state };
  }

  current(): DictationState {
    if (this.failure) throw this.failure;
    return { ...this.state };
  }

  finish(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.finishing)
      return Promise.reject(
        new TranscriptionFailure("Dictation is already finishing.", 409),
      );
    this.finishing = true;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.done(), finishTimeoutMs);
      this.settle = (error) => {
        clearTimeout(timer);
        this.settle = undefined;
        if (error) reject(error);
        else resolve(joinSpoken(this.state.text, this.state.partial));
      };
      try {
        this.socket!.sendText(
          JSON.stringify({ type: "finish", requestId: this.requestId }),
        );
      } catch {
        this.done();
      }
    });
  }

  cancel() {
    this.finishing = true;
    this.settle = undefined;
    if (this.socket?.open) this.socket.close();
  }
}
