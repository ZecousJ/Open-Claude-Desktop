/**
 * Dictation on the web. The window records 16 kHz mono PCM itself
 * (src/voice/microphone.ts) and hands the chunks to the bridge, as on the
 * desktop; here the bridge streams them straight to the service's realtime
 * transcription socket, `/v1/audio/realtime/transcriptions`, the one the
 * desktop's provider service uses (owner decision 18). The browser holds no
 * gateway key: the socket is authorized by a one-time web ticket in
 * Sec-WebSocket-Protocol (W-VOICE), and the service meters the audio to the
 * account's web key.
 *
 * The protocol is the desktop's: a JSON `start`, binary pcm_s16le chunks, a
 * JSON `finish`, and partial and final transcripts in between.
 */
import {
  dictationRecordingSeconds,
  dictationStartOptions,
  dictationAudioFormat,
  joinSpoken,
  maxDictationChunkBytes,
  maxDictationSeconds,
  type DictationProgress,
  type DictationStart,
} from "../../shared/voice-api";
import { eventsSubprotocols, webAuthRoutes } from "../../shared/web-protocol";
import type { WebAuth } from "./auth";
import {
  socketOpen,
  type SocketLike,
  type WebEnv,
} from "../../shared/web-client/env";
import { bridgeError } from "../../shared/web-client/errors";
import {
  dictationFailure,
  dictationMessages,
  readRealtimeMessage,
} from "./realtime-message";

/** The gateway's realtime transcription route (voice component). */
export const realtimeTranscriptionsPath = "/v1/audio/realtime/transcriptions";
const pcmBytesPerSecond =
  dictationAudioFormat.sampleRate * dictationAudioFormat.bytesPerSample;
/** A session the window stopped feeding (closed, reloaded) ends after this. */
const idleMs = 10_000;
const connectTimeoutMs = 10_000;
/** How long the service may take to send the last transcript after `finish`. */
export const webDictationFinishTimeoutMs = 15_000;

export function webDictationRecordingSeconds(maxSeconds: unknown) {
  const max = typeof maxSeconds === "number" && Number.isFinite(maxSeconds) && maxSeconds > 0
    ? Math.floor(maxSeconds) : null;
  return Math.min(dictationRecordingSeconds(max), max ?? maxDictationSeconds, maxDictationSeconds);
}

interface Session {
  id: string;
  requestId: string;
  socket: SocketLike;
  activation: object;
  text: string;
  partial: string;
  bytes: number;
  maxSeconds: number;
  failure?: Error;
  finishing: boolean;
  settle?: (error?: Error) => void;
  cancelOpening?: (error: Error) => void;
  idle?: unknown;
  observer?: DictationObserver;
}

interface DictationObserver {
  progress(progress: DictationProgress): void;
  fail(): void;
}

export class WebDictation {
  private session?: Session;
  private offAuth: () => void;
  private disposed = false;

  constructor(
    private env: WebEnv,
    private auth: WebAuth,
    private readAvailability: () => Promise<unknown>,
  ) {
    this.offAuth = auth.onChange(() => {
      const session = this.session;
      if (session && session.activation !== auth.activationIdentity)
        this.end(session, new DOMException("The active account changed.", "AbortError"));
    });
  }

  private url() {
    const origin = new URL(this.env.origin);
    const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${origin.host}${realtimeTranscriptionsPath}`;
  }

  async start(input?: unknown, observer?: DictationObserver): Promise<DictationStart> {
    const activation = this.auth.activationIdentity;
    if (!activation) throw bridgeError(dictationMessages.disconnected);
    const current = () => {
      if (this.disposed) throw new DOMException("Dictation was cancelled.", "AbortError");
      if (this.auth.activationIdentity !== activation)
        throw new DOMException("The active account changed.", "AbortError");
    };
    current();
    const options = dictationStartOptions(input);
    const availability = await this.readAvailability();
    current();
    if (!availability || typeof availability !== "object" ||
        !("transcription" in availability) || availability.transcription !== true)
      throw bridgeError(dictationMessages.unavailable);
    this.end(this.session);
    const maxSeconds = webDictationRecordingSeconds("maxSeconds" in availability ? availability.maxSeconds : null);
    const { ticket } = await this.auth.ticket(webAuthRoutes.voiceTicket);
    current();
    const socket = this.env.openSocket(this.url(), eventsSubprotocols(ticket));
    socket.binaryType = "arraybuffer";
    const session: Session = {
      id: this.env.randomId(),
      requestId: this.env.randomId(),
      socket,
      activation,
      text: "",
      partial: "",
      bytes: 0,
      maxSeconds,
      finishing: false,
      observer,
    };
    this.session = session;
    await new Promise<void>((resolve, reject) => {
      const timer = this.env.timers.setTimeout(() => {
        session.cancelOpening?.(bridgeError(dictationMessages.disconnected));
      }, connectTimeoutMs);
      session.cancelOpening = (error) => {
        this.env.timers.clearTimeout(timer);
        session.cancelOpening = undefined;
        reject(error);
      };
      socket.onopen = () => {
        this.env.timers.clearTimeout(timer);
        session.cancelOpening = undefined;
        resolve();
      };
      socket.onclose = () => {
        // The upgrade was refused (no ticket, voice off, limits reached):
        // a browser cannot read why.
        session.cancelOpening?.(bridgeError(dictationMessages.disconnected));
      };
      socket.onerror = () => {};
    }).catch((error) => {
      this.end(session);
      throw error;
    });
    current();
    if (this.session !== session) {
      this.end(session);
      throw bridgeError("Dictation was cancelled.");
    }
    socket.onmessage = (message) => {
      if (this.session === session && this.auth.activationIdentity === activation &&
          typeof message.data === "string") this.receive(session, message.data);
    };
    socket.onclose = (event) => this.closed(session, event.code, event.reason);
    socket.send(
      JSON.stringify({
        type: "start",
        requestId: session.requestId,
        ...options,
        audio: {
          format: "pcm_s16le",
          sampleRate: dictationAudioFormat.sampleRate,
          channels: dictationAudioFormat.channels,
        },
        vad: {
          enabled: true,
          threshold: 0.2,
          prefixPaddingMs: 300,
          silenceDurationMs: 800,
        },
      }),
    );
    this.touch(session);
    return { sessionId: session.id, streaming: true, maxSeconds };
  }

  private receive(session: Session, raw: string) {
    const message = readRealtimeMessage(raw);
    switch (message.kind) {
      case "partial":
        session.partial = message.text.trim();
        break;
      case "delta":
        session.partial += message.text;
        break;
      case "final":
        session.text = joinSpoken(session.text, message.text);
        session.partial = "";
        break;
      case "done":
        if (session.observer && !session.finishing)
          this.fail(session, bridgeError(dictationMessages.disconnected));
        else this.done(session);
        return;
      case "error":
        this.fail(
          session,
          bridgeError(
            dictationFailure(message.code, message.status, message.message),
            message.code || undefined,
          ),
        );
        return;
      default:
        return;
    }
    session.observer?.progress({ text: session.text, partial: session.partial });
  }

  private closed(session: Session, code: number, reason: string) {
    if (session.finishing && (!session.observer || code === 1000)) this.done(session);
    else if (!session.failure)
      this.fail(
        session,
        bridgeError(
          code === 1000 || code === 1005 || code === 1006
            ? dictationMessages.disconnected
            : dictationFailure(reason, undefined, ""),
        ),
      );
  }

  private fail(session: Session, error: Error) {
    if (session.failure) return;
    session.failure = error;
    this.closeSocket(session);
    session.settle?.(error);
    session.observer?.fail();
  }

  private done(session: Session) {
    // The segment the service had not closed yet is part of the transcript.
    if (session.partial) {
      session.text = joinSpoken(session.text, session.partial);
      session.partial = "";
    }
    session.settle?.();
    this.closeSocket(session);
  }

  private closeSocket(session: Session) {
    const socket = session.socket;
    socket.onmessage = socket.onopen = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, "done");
    } catch {
      /* already closed */
    }
  }

  private current(sessionId: unknown) {
    const session = this.session;
    if (!session || session.id !== sessionId || session.finishing)
      throw bridgeError("Dictation has ended.");
    return session;
  }

  private touch(session: Session) {
    this.env.timers.clearTimeout(session.idle);
    session.idle = this.env.timers.setTimeout(() => {
      if (session.observer) this.fail(session, bridgeError(dictationMessages.disconnected));
      else this.end(session);
    }, idleMs);
  }

  get bufferedAmount() {
    return this.session?.socket.bufferedAmount ?? 0;
  }

  async audio(sessionId: string, pcm: Uint8Array): Promise<DictationProgress> {
    const session = this.current(sessionId);
    if (
      !(pcm instanceof Uint8Array) ||
      pcm.byteLength % 2 !== 0 ||
      pcm.byteLength > maxDictationChunkBytes
    )
      throw bridgeError("Invalid audio.");
    if (session.failure) {
      const failure = session.failure;
      this.end(session);
      throw failure;
    }
    if (session.bytes + pcm.byteLength > session.maxSeconds * pcmBytesPerSecond)
      throw bridgeError(dictationMessages.tooLong);
    if (session.socket.readyState !== socketOpen) {
      this.end(session);
      throw bridgeError(dictationMessages.disconnected);
    }
    if (session.observer && this.bufferedAmount + pcm.byteLength > pcmBytesPerSecond * 10)
      throw bridgeError(dictationMessages.disconnected);
    session.bytes += pcm.byteLength;
    this.touch(session);
    if (pcm.byteLength) session.socket.send(pcm);
    return { text: session.text, partial: session.partial };
  }

  finish(sessionId: string): Promise<string> {
    const session = this.current(sessionId);
    session.finishing = true;
    this.env.timers.clearTimeout(session.idle);
    if (session.failure) {
      const failure = session.failure;
      this.end(session);
      return Promise.reject(failure);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = this.env.timers.setTimeout(
        () => this.interruptedFinish(session),
        webDictationFinishTimeoutMs,
      );
      session.settle = (error) => {
        this.env.timers.clearTimeout(timer);
        session.settle = undefined;
        if (this.session === session) this.session = undefined;
        if (error) reject(error);
        else resolve(joinSpoken(session.text, session.partial));
      };
      try {
        session.socket.send(
          JSON.stringify({ type: "finish", requestId: session.requestId }),
        );
      } catch {
        this.interruptedFinish(session);
      }
    });
  }

  async cancel(sessionId: string) {
    if (this.session?.id === sessionId) this.end(this.session);
  }

  dispose() {
    this.disposed = true;
    this.offAuth();
    this.end(this.session);
  }

  private interruptedFinish(session: Session) {
    if (session.observer) this.fail(session, bridgeError(dictationMessages.disconnected));
    else this.done(session);
  }

  private end(session: Session | undefined, reason: Error = bridgeError("Dictation was cancelled.")) {
    if (!session) return;
    if (this.session === session) this.session = undefined;
    session.finishing = true;
    session.cancelOpening?.(reason);
    session.settle?.(reason);
    this.env.timers.clearTimeout(session.idle);
    this.closeSocket(session);
  }
}
