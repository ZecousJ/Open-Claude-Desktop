/**
 * Dictation sessions of the signed-in account (package C6). Each session
 * runs in its own provider service child, which holds the key and talks to
 * the service; the main process only relays audio chunks and transcripts
 * and never sees or logs the key.
 */
import { randomUUID } from "node:crypto";
import type {
  ClaudexVoice,
  BootstrapSource,
} from "../../shared/claudex-contract";
import type { Provider } from "../../shared/types";
import {
  dictationRecordingSeconds,
  dictationStartOptions,
  maxDictationChunkBytes,
  maxDictationSeconds,
  type DictationProgress,
  type DictationStart,
  type VoiceAvailability,
} from "../../shared/voice-api";
import {
  maxBufferedSeconds,
  maxDictationBytes,
  pcmBytesPerSecond,
} from "../../server/transcription";
import type { AppContext } from "../app/app-context";
import { ProviderServiceClient } from "../engine/provider-service-client";
import { handleRefusal } from "../remote/host-wiring";

import { voiceOff } from "../../shared/voice-api";
export { voiceOff } from "../../shared/voice-api";
/** A session the window stopped feeding (closed, reloaded) ends after this. */
const idleMs = 10_000;

function activeProvider(ctx: AppContext): Provider | undefined {
  const settings = ctx.store.settings;
  return settings.providers.find(
    (item) => item.id === settings.activeProviderId,
  );
}

/**
 * The bootstrap "voice" section, once the remote host exposes its
 * `BootstrapSource` as `bootstrap` (package C2); undefined before that.
 */
export function remoteVoice(ctx: AppContext): ClaudexVoice | undefined {
  const source = (
    ctx.remote as { bootstrap?: Partial<BootstrapSource> } | undefined
  )?.bootstrap;
  return typeof source?.current === "function"
    ? source.current()?.voice
    : undefined;
}

/**
 * Whether the composer can dictate now: the administrator allows voice, and
 * the Claudex service offers transcription (bootstrap `voice`, or the
 * transcription model the plan gave the provider) or a local service has a
 * transcription model.
 */
export function voiceAvailability(ctx: AppContext): VoiceAvailability {
  const provider = activeProvider(ctx);
  const off: VoiceAvailability = {
    transcription: false,
    maxTranscriptionBytes: null,
    maxSeconds: null,
  };
  if (!provider || !ctx.policy().voice) return off;
  if (provider.backend === "sub2api") {
    const voice = remoteVoice(ctx);
    const available = voice
      ? voice.available.transcription && voice.transcription.enabled
      : Boolean(provider.transcriptionModel);
    const seconds = voice?.transcription.maxSeconds;
    return available
      ? {
          transcription: true,
          maxTranscriptionBytes: null,
          maxSeconds:
            typeof seconds === "number" && seconds > 0
              ? Math.min(Math.floor(seconds), maxDictationSeconds)
              : null,
          streaming: true,
        }
      : off;
  }
  return provider.transcriptionModel
    ? {
        transcription: true,
        maxTranscriptionBytes: maxDictationBytes,
        maxSeconds: maxBufferedSeconds,
        streaming: false,
      }
    : off;
}

interface Session {
  id: string;
  client: ProviderServiceClient;
  /** The account the session was started for; a sign-out ends it. */
  store: AppContext["store"];
  maxBytes: number;
  received: number;
  /** Chunks are sent one after the other, in the order the window sent them. */
  queue: Promise<unknown>;
  idle?: NodeJS.Timeout;
  ending: boolean;
}

/** One dictation at a time for the window. */
export class DictationSessions {
  private session?: Session;
  constructor(private ctx: AppContext) {
    ctx.onAccountDeactivating?.(() => this.end(this.session));
  }

  async start(input?: unknown): Promise<DictationStart> {
    const options = dictationStartOptions(input);
    const ctx = this.ctx;
    if (!ctx.policy().voice) throw Error(voiceOff);
    const availability = voiceAvailability(ctx);
    const provider = activeProvider(ctx);
    if (!availability.transcription || !provider)
      throw Error("Dictation isn't available right now.");
    await this.end(this.session);
    const maxSeconds = Math.min(
      dictationRecordingSeconds(availability.maxSeconds),
      availability.maxSeconds ?? maxDictationSeconds,
    );
    const client = new ProviderServiceClient(
      ctx.providerServiceScript,
      ctx.store.root,
      provider,
      ctx.remote?.sessionKey(provider.id) ?? "",
      ctx.credentials.vaultKey,
      ctx.dataRoot,
      undefined,
      undefined,
      (refusal) => handleRefusal(ctx, refusal),
    );
    const session: Session = {
      id: randomUUID(),
      client,
      store: ctx.store,
      maxBytes: maxSeconds * pcmBytesPerSecond,
      received: 0,
      queue: Promise.resolve(),
      ending: false,
    };
    this.session = session;
    try {
      const started = await client.startDictation(maxSeconds, options);
      if (this.session !== session) throw Error("Dictation was cancelled.");
      this.touch(session);
      return {
        sessionId: session.id,
        streaming: started.streaming,
        maxSeconds: started.maxSeconds,
      };
    } catch (error) {
      await this.end(session);
      throw error;
    }
  }

  audio(sessionId: unknown, pcm: unknown): Promise<DictationProgress> {
    const session = this.current(sessionId);
    if (
      !(pcm instanceof Uint8Array) ||
      pcm.byteLength % 2 !== 0 ||
      pcm.byteLength > maxDictationChunkBytes
    )
      throw Error("Invalid audio.");
    if (session.received + pcm.byteLength > session.maxBytes)
      throw Error("That recording is too long.");
    session.received += pcm.byteLength;
    this.touch(session);
    const sent = session.queue.then(() => session.client.dictationAudio(pcm));
    session.queue = sent.catch(() => {});
    return sent.catch(async (error) => {
      await this.end(session);
      throw error;
    });
  }

  async finish(sessionId: unknown): Promise<string> {
    const session = this.current(sessionId);
    session.ending = true;
    clearTimeout(session.idle);
    try {
      await session.queue;
      return await session.client.finishDictation();
    } finally {
      await this.end(session);
    }
  }

  async cancel(sessionId: unknown) {
    if (this.session?.id === sessionId) await this.end(this.session);
  }

  private current(sessionId: unknown) {
    const session = this.session;
    if (!session || session.id !== sessionId || session.ending)
      throw Error("Dictation has ended.");
    if (session.store !== this.ctx.store) {
      void this.end(session);
      throw Error("Dictation has ended.");
    }
    return session;
  }

  private touch(session: Session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => void this.end(session), idleMs);
    session.idle.unref?.();
  }

  private async end(session: Session | undefined) {
    if (!session) return;
    if (this.session === session) this.session = undefined;
    session.ending = true;
    clearTimeout(session.idle);
    await session.client.cancelDictation().catch(() => {});
    await session.client.close().catch(() => {});
  }
}
