import type { QuickEntryBridge } from "../../shared/quick-entry";
import { joinSpoken } from "../../shared/voice-api";
import type { Microphone } from "../voice/microphone";
import { dictationOptions } from "../voice/dictation-language";

export class QuickDictationSession {
  private ended = false;
  private sessionId?: string;
  private microphone?: Microphone;
  private pending = Promise.resolve();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private voice: NonNullable<QuickEntryBridge["voice"]>,
    private openMicrophone: (
      send: (pcm: Uint8Array) => void,
    ) => Promise<Microphone>,
    private callbacks: {
      live: (text: string) => void;
      ready: (stream: MediaStream) => void;
      done: (text: string) => void;
      error: (error: unknown) => void;
    },
  ) {}
  start() {
    return (this.starting ??= this.begin().catch((error: unknown) =>
      this.fail(error),
    ));
  }
  private async begin() {
    if (!(await this.voice.requestMicrophone()))
      throw Error("Microphone access was not granted.");
    if (this.ended) return;
    const session = await this.voice.startDictation(dictationOptions());
    this.sessionId = session.sessionId;
    if (this.ended) {
      await this.voice.cancelDictation(session.sessionId);
      return;
    }
    const microphone = await this.openMicrophone((pcm) => {
      this.pending = this.pending
        .then(async () => {
          if (this.ended) return;
          const progress = await this.voice.dictationAudio(
            session.sessionId,
            pcm,
          );
          if (!this.ended)
            this.callbacks.live(joinSpoken(progress.text, progress.partial));
        })
        .catch((error: unknown) => this.fail(error));
    });
    this.microphone = microphone;
    if (this.ended) return microphone.stop();
    this.callbacks.ready(microphone.stream);
    this.timer = setTimeout(() => void this.stop(), session.maxSeconds * 1000);
  }
  stop() {
    return (this.stopping ??= this.finish());
  }
  private async finish() {
    await this.starting;
    if (this.ended || !this.sessionId) return;
    clearTimeout(this.timer);
    this.microphone?.stop(true);
    try {
      await this.pending;
      if (this.ended) return;
      const text = await this.voice.finishDictation(this.sessionId);
      if (this.ended) return;
      this.ended = true;
      this.callbacks.done(text);
    } catch (error) {
      this.fail(error);
    }
  }
  cancel() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.microphone?.stop();
    if (this.sessionId)
      void this.voice.cancelDictation(this.sessionId).catch(() => {});
  }
  private fail(error: unknown) {
    if (this.ended) return;
    this.cancel();
    this.callbacks.error(error);
  }
}
