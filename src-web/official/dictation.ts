import type { DictationProgress, VoiceAvailability } from "../../shared/voice-api";
import { joinSpoken } from "../../shared/voice-api";
import type { SocketLike, WebEnv } from "../../shared/web-client/env";
import type { AppEvent } from "../../shared/types";
import type { WebAuth } from "../bridge/auth";
import { WebDictation, webDictationFinishTimeoutMs, webDictationRecordingSeconds } from "../bridge/dictation";

type Availability = Pick<VoiceAvailability, "transcription" | "maxSeconds">;

interface DictationHost {
  getSnapshot(): boolean;
  subscribe(change: () => void): () => void;
  recordingMillis(): number;
  readonly drainMillis: number;
  open(address: string): SocketLike;
}

export function createOfficialWebDictation({
  env,
  auth,
  readAvailability,
  isCurrent,
}: {
  env: WebEnv;
  auth: WebAuth;
  readAvailability: () => Promise<VoiceAvailability>;
  isCurrent: () => boolean;
}) {
  let availability: Availability | undefined;
  let revision = 0;
  let disposed = false;
  let active: SocketLike | undefined;
  const listeners = new Set<() => void>();
  const current = () => !disposed && isCurrent();
  const available = () => current() && availability?.transcription === true;
  const publish = (next?: Availability) => {
    const changed = availability?.transcription !== next?.transcription;
    availability = next;
    if (!available()) active?.close();
    if (changed) listeners.forEach((change) => change());
  };
  const refresh = async () => {
    const reading = ++revision;
    const next = await Promise.resolve().then(readAvailability).catch(() => undefined);
    if (current() && reading === revision) publish(next);
  };

  const host: DictationHost = {
    getSnapshot: available,
    drainMillis: webDictationFinishTimeoutMs + 1_000,
    recordingMillis: () => {
      const max = availability?.maxSeconds;
      const seconds = webDictationRecordingSeconds(max);
      return Math.max(1, max === seconds ? seconds - 1 : seconds) * 1_000;
    },
    subscribe(change) {
      listeners.add(change);
      return () => listeners.delete(change);
    },
    open(address) {
      const url = new URL(address, env.origin);
      const origin = new URL(env.origin);
      origin.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
      if (!available() || url.origin !== origin.origin ||
          url.pathname !== "/api/ws/speech_to_text/voice_stream" ||
          url.searchParams.get("encoding") !== "linear16" ||
          url.searchParams.get("sample_rate") !== "16000" ||
          url.searchParams.get("channels") !== "1")
        throw new Error("Dictation is unavailable.");

      active?.close();
      const dictation = new WebDictation(env, auth, readAvailability);
      const language = url.searchParams.get("language");
      type State =
        | { kind: "connecting" }
        | { kind: "recording" | "finishing"; id: string }
        | { kind: "closed" };
      let state: State = { kind: "connecting" };
      const emit = (type: string, fields?: object) => {
        if (available() && active === socket)
          socket.onmessage?.({ data: JSON.stringify({ type, ...fields }) });
      };
      const close = (code: number, reason = "") => {
        if (state.kind === "closed") return;
        state = { kind: "closed" };
        if (active === socket) active = undefined;
        dictation.dispose();
        queueMicrotask(() => socket.onclose?.({ code, reason }));
      };
      const fail = () => {
        if (state.kind === "closed") return;
        if (state.kind === "connecting") socket.onerror?.(new Event("error"));
        else emit("TranscriptError", { error_code: "transcription_failed" });
        close(1011);
      };
      const progress = ({ text, partial }: DictationProgress) => {
        if (state.kind === "recording" || state.kind === "finishing")
          emit("TranscriptInterim", { data: joinSpoken(text, partial) });
      };
      const finish = async (id: string) => {
        try {
          const text = await dictation.finish(id);
          if (state.kind !== "finishing") return;
          emit("TranscriptText", { data: text });
          emit("TranscriptEndpoint");
          close(1000);
        } catch {
          fail();
        }
      };
      const socket: SocketLike = {
        get readyState() {
          return state.kind === "connecting" ? 0 : state.kind === "closed" ? 3 : 1;
        },
        get bufferedAmount() { return dictation.bufferedAmount; },
        protocol: "",
        binaryType: "arraybuffer",
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        close: (code = 1000, reason) => close(code, reason),
        send(data) {
          if (!available() || active !== this || state.kind !== "recording") return;
          if (typeof data === "string") {
            const { type } = JSON.parse(data);
            if (type === "KeepAlive") emit("KeepAliveAck");
            if (type === "CloseStream") {
              const { id } = state;
              state = { kind: "finishing", id };
              void finish(id);
            }
            return;
          }
          const pcm = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          void dictation.audio(state.id, pcm).catch(fail);
        },
      };
      active = socket;
      void dictation.start(language && language !== "auto" ? { language } : undefined, { progress, fail })
        .then(({ sessionId }) => {
          if (state.kind !== "connecting") return;
          if (!available() || active !== socket) return close(1000);
          state = { kind: "recording", id: sessionId };
          socket.onopen?.(new Event("open"));
        }, fail);
      return socket;
    },
  };
  return {
    host,
    refresh,
    observe(event: AppEvent) {
      if (event.type === "policy" && !event.policy.voice) {
        ++revision;
        publish();
      } else if (event.type === "policy" || event.type === "settings" || event.type === "resync") {
        void refresh();
      }
    },
    dispose() {
      disposed = true;
      publish();
      listeners.clear();
    },
  };
}
