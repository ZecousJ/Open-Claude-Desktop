import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { BrowserWindow } from "electron";
import {
  dictationAudioFormat,
  dictationStartOptions,
  joinSpoken,
  maxDictationChunkBytes,
  type VoiceAvailability,
} from "../../../shared/voice-api";
import { acceptTranscriptionSocket } from "../../../server/transcription-socket";
import type { DictationSessions } from "../../voice/dictation";
import type { NativeHost } from "./host";

const protocol = "claude.dictation.v1";
const streamPath = "/api/ws/speech_to_text/voice_stream";
const ticketLifetime = 30_000;
const nativeCookie = "claudex_native_dictation";
const nativeSampleRate = 48_000;

interface StreamCredential {
  url: string;
  ticket: string;
  maxSeconds?: number;
}

export function registerOfficialDictation(
  host: NativeHost,
  availability: () => VoiceAvailability,
  credential: (window: BrowserWindow) => StreamCredential | null,
) {
  const managedConfig = () => ({
    deploymentMode: "1p",
    dictationAvailable: availability().transcription,
  });
  host.on(
    "ManagedConfig.managedRendererConfig_$store$_getState",
    managedConfig,
  );
  host.on(
    "ManagedConfig.managedRendererConfig_$store$_getStateSync",
    managedConfig,
  );
  host.on("Dictation.getStreamCredential", () =>
    host.caller ? credential(host.caller) : null,
  );
  return host.ctx.onEvent((event) => {
    if (
      event.type === "policy" ||
      event.type === "settings" ||
      event.type === "resync"
    )
      host.emit(
        "ManagedConfig",
        "managedRendererConfig_$store$_update",
        managedConfig(),
      );
  });
}

export function createOfficialDictation(
  sessions: Pick<DictationSessions, "start" | "audio" | "finish" | "cancel">,
  availability: () => VoiceAvailability,
  current: () => boolean,
) {
  const tickets = new Map<string, number>();
  const sockets = new Set<Duplex>();
  let nativeTicket: string | undefined;

  return {
    nativeCredential(origin: string) {
      if (!current() || !availability().transcription) return null;
      nativeTicket ??= randomUUID();
      return { baseURL: origin, cookie: `${nativeCookie}=${nativeTicket}` };
    },

    credential(origin: string): StreamCredential | null {
      if (!current()) return null;
      const voice = availability();
      if (!voice.transcription) return null;
      const now = Date.now();
      for (const [ticket, expires] of tickets)
        if (expires <= now) tickets.delete(ticket);
      const ticket = randomUUID();
      tickets.set(ticket, now + ticketLifetime);
      const address = new URL(streamPath, origin);
      address.protocol = "ws:";
      return {
        url: address.href,
        ticket,
        ...(voice.maxSeconds === null ? {} : { maxSeconds: voice.maxSeconds }),
      };
    },

    upgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      origin: string,
      browser: boolean,
    ) {
      const address = URL.parse(request.url ?? "/", origin);
      const protocols =
        request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((part) => part.trim()) ?? [];
      const ticket = protocols
        .find((part) => part.startsWith("ticket."))
        ?.slice("ticket.".length);
      const expires = ticket && tickets.get(ticket);
      const native =
        !!nativeTicket &&
        request.headers.origin === undefined &&
        !protocols.length &&
        request.headers.cookie
          ?.split(";")
          .some((value) => value.trim() === `${nativeCookie}=${nativeTicket}`);
      const ticketed =
        protocols.includes(protocol) &&
        ticket !== undefined &&
        typeof expires === "number" &&
        expires > Date.now();
      const web =
        browser &&
        request.headers.origin === origin &&
        (!protocols.length || ticketed);
      if (
        address?.pathname !== streamPath ||
        !current() ||
        !availability().transcription ||
        (!native && !web)
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (ticket) tickets.delete(ticket);

      let options;
      try {
        const language = address.searchParams.get("language");
        const encoding = address.searchParams.get("encoding");
        const channels = address.searchParams.get("channels");
        const sampleRate = address.searchParams.get("sample_rate");
        if (
          (encoding && encoding !== "linear16") ||
          (channels && channels !== String(dictationAudioFormat.channels)) ||
          (sampleRate && sampleRate !== String(native ? nativeSampleRate : dictationAudioFormat.sampleRate))
        )
          throw Error("Unsupported dictation audio format.");
        options = dictationStartOptions({
          language: language === "auto" ? undefined : (language ?? undefined),
        });
      } catch {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      let recording: Promise<string>;
      let stopping = false;
      let previous = "";
      let resampleOffset = 0;
      let resampleSum = 0;
      const nativeRatio = nativeSampleRate / dictationAudioFormat.sampleRate;
      const fail = () => {
        if (!connection?.open) return;
        send({ type: "TranscriptError", error_code: "transcription_failed" });
        connection.close(1011);
      };
      const send = (message: Record<string, string>) => {
        if (current() && connection?.open)
          connection.sendText(JSON.stringify(message));
      };
      const connection = acceptTranscriptionSocket(
        request,
        socket,
        head,
        ticketed ? protocol : undefined,
        {
          onText(text) {
            let type: unknown;
            try {
              type = JSON.parse(text)?.type;
            } catch {
              return;
            }
            if (type === "KeepAlive") send({ type: "KeepAliveAck" });
            if (type !== "CloseStream" || stopping) return;
            stopping = true;
            void recording
              .then(async (id) => {
                const text = await sessions.finish(id);
                send({ type: "TranscriptText", data: text });
                send({ type: "TranscriptEndpoint" });
                connection?.close();
              })
              .catch(fail);
          },
          onBinary(bytes) {
            if (stopping || !current()) return;
            if (native) {
              const width = dictationAudioFormat.bytesPerSample;
              if (bytes.length % width !== 0) return fail();
              const samples = bytes.length / width;
              const downsampled = Buffer.allocUnsafe(
                Math.floor((samples + resampleOffset) / nativeRatio) * width,
              );
              let written = 0;
              for (let offset = 0; offset < bytes.length; offset += width) {
                resampleSum += bytes.readInt16LE(offset);
                if (++resampleOffset !== nativeRatio) continue;
                downsampled.writeInt16LE(
                  Math.round(resampleSum / nativeRatio),
                  written,
                );
                written += width;
                resampleSum = 0;
                resampleOffset = 0;
              }
              bytes = downsampled;
            }
            void recording
              .then(async (id) => {
                if (!connection?.open || !current()) return;
                const chunks = [];
                for (
                  let offset = 0;
                  offset < bytes.length;
                  offset += maxDictationChunkBytes
                )
                  chunks.push(
                    sessions.audio(
                      id,
                      bytes.subarray(offset, offset + maxDictationChunkBytes),
                    ),
                  );
                const progress = (await Promise.all(chunks)).at(-1);
                if (!progress) return;
                const text = joinSpoken(progress.text, progress.partial);
                if (stopping || text === previous) return;
                previous = text;
                send({ type: "TranscriptInterim", data: text });
              })
              .catch(fail);
          },
          onClose() {
            stopping = true;
            void recording.then((id) => sessions.cancel(id)).catch(() => {});
          },
          onError: fail,
        },
      );
      if (!connection) return;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      recording = sessions.start(options).then(({ sessionId }) => sessionId);
      void recording.catch(fail);
    },

    close() {
      nativeTicket = undefined;
      tickets.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
