import {
  dictationErrorMs,
  microphoneReason,
  dictationFailureCopy,
} from "../../voice/microphone-guidance";
import { showToast } from "../../ui/toast-store";
import { t } from "../../i18n";
import { useState, useId, useRef, useEffect } from "react";
import type { Microphone } from "../../voice/microphone";
import type { Recognizer } from "../../voice/browser-recognition";
import {
  joinSpoken,
  dictationRecordingSeconds,
  dictationSilenceSeconds,
} from "../../../shared/voice-api";
import { startRecognition } from "../../voice/browser-recognition";
import { dictationOptions } from "../../voice/dictation-language";
import { microphoneDeviceId } from "../../voice/preferences";
import { useDictationButtonActions } from "./useDictationButtonActions";
import type { SpeechEngine } from "../../voice/useSpeechEngine";
import type { DictationPhase } from "./DictationButton";
import type { MicrophoneReason } from "../../voice/microphone-guidance";

/** What useDictationButtonState needs from DictationButton.tsx. */
export interface UseDictationButtonStateKit {
  autoStart: boolean;
  button: React.RefObject<HTMLButtonElement | null>;
  canStart: boolean;
  clearFailure: () => void;
  comment: boolean;
  containTooltip: boolean;
  contextKey: string;
  engine: SpeechEngine;
  errorTimer: React.RefObject<NodeJS.Timeout | undefined>;
  failedStarts: React.RefObject<number>;
  failureToast: React.RefObject<number | undefined>;
  field: React.RefObject<HTMLElement | null> | undefined;
  maxSeconds: number | null;
  onCancel: () => void;
  onLive: (spoken: string) => void;
  onPhase: ((phase: DictationPhase) => void) | undefined;
  onSubmit: ((spoken: string) => void) | undefined;
  onTranscript: (spoken: string) => void;
  phase: DictationPhase;
  platform: string;
  setErrorVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setGuidance: React.Dispatch<React.SetStateAction<false | MicrophoneReason>>;
  setMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPhase: React.Dispatch<React.SetStateAction<DictationPhase>>;
  shortcut: string;
}

export function useDictationButtonState(kit: UseDictationButtonStateKit) {
  const {
    autoStart,
    button,
    canStart,
    clearFailure,
    comment,
    containTooltip,
    contextKey,
    engine,
    errorTimer,
    failedStarts,
    failureToast,
    field,
    maxSeconds,
    onCancel,
    onLive,
    onPhase,
    onSubmit,
    onTranscript,
    phase,
    platform,
    setErrorVisible,
    setGuidance,
    setMenuOpen,
    setPhase,
    shortcut,
  } = kit;
  const reportError = (error: unknown) => {
    clearTimeout(errorTimer.current);
    setErrorVisible(true);
    errorTimer.current = setTimeout(
      () => setErrorVisible(false),
      dictationErrorMs,
    );
    const starting =
      phaseRef.current === "requesting" || phaseRef.current === "idle";
    if (starting) failedStarts.current += 1;
    const reason = microphoneReason(error, starting, failedStarts.current);
    if (reason) {
      clearFailure();
      setTooltipVisible(false);
      setGuidance(reason);
    } else {
      const reason =
        phaseRef.current === "requesting" || phaseRef.current === "idle"
          ? null
          : String(
              (error as { code?: string } | null)?.code ?? "connection_lost",
            );
      const copy = dictationFailureCopy(reason, Boolean(spoken.current));
      clearFailure();
      failureToast.current = showToast(t(copy.title), {
        description: copy.description && t(copy.description),
        variant: "warning",
        timeout: Infinity,
        action: {
          label: t("Dictate again"),
          onSelect: () => clickRef.current(true),
        },
      });
    }
  };
  /** The recording hit its time limit or heard no words for a minute: it stops and says so. */
  const stopItself = (reason: "auto_silence" | "auto_max_duration") => {
    if (selfStopped.current) return;
    selfStopped.current = true;
    const copy = dictationFailureCopy(reason, Boolean(spoken.current));
    clearFailure();
    failureToast.current = showToast(t(copy.title), {
      description: t(copy.description!),
      timeout: Infinity,
      action: {
        label: t("Dictate again"),
        onSelect: () => clickRef.current(true),
      },
    });
  };
  /** The recording's input while it lasts, for the live level bars. */
  const [stream, setStream] = useState<MediaStream>();
  const [tooltipVisible, setTooltipVisible] = useState(false),
    tooltipId = useId();
  const released = useRef(false),
    submitAfterStop = useRef(false),
    microphone = useRef<Microphone | undefined>(undefined),
    sessionId = useRef<string | undefined>(undefined),
    /** The browser's recognition, while it is the engine and listening. */
    recognizer = useRef<Recognizer | undefined>(undefined),
    /** Bumped by every start, stop and cancel; stale replies are dropped. */
    generation = useRef(0),
    spoken = useRef(""),
    /** When the transcript last grew; a minute without a new word stops dictation. */
    wordsAt = useRef(0),
    /** Set once the recording stopped itself, so its notice shows once. */
    selfStopped = useRef(false),
    pending = useRef<Promise<unknown>>(Promise.resolve()),
    mounted = useRef(true);
  const callbacks = useRef({
    onLive,
    onTranscript,
    onCancel,
    onError: reportError,
    onSubmit,
  });
  callbacks.current = {
    onLive,
    onTranscript,
    onCancel,
    onError: reportError,
    onSubmit,
  };
  const complete = (text: string) => {
    callbacks.current.onTranscript(text);
    if (submitAfterStop.current) {
      submitAfterStop.current = false;
      callbacks.current.onSubmit?.(text);
    }
  };
  const phaseCallback = useRef(onPhase);
  phaseCallback.current = onPhase;
  useEffect(() => phaseCallback.current?.(phase), [phase]);
  useEffect(() => () => phaseCallback.current?.("idle"), []);
  const ticker = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    tooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Ends the recording without a transcript; `notify` tells the composer to drop it. */
  const abandon = (notify: boolean) => {
    submitAfterStop.current = false;
    released.current = false;
    generation.current++;
    clearInterval(ticker.current);
    microphone.current?.stop();
    microphone.current = undefined;
    if (mounted.current) setStream(undefined);
    recognizer.current?.abort();
    recognizer.current = undefined;
    const id = sessionId.current;
    sessionId.current = undefined;
    if (id) void window.desktop.cancelDictation(id).catch(() => {});
    if (mounted.current) {
      setPhase("idle");
    }
    if (notify) callbacks.current.onCancel();
  };
  /** The service failed mid-recording: what it transcribed is kept. */
  const fail = (error: unknown) => {
    abandon(false);
    if (!mounted.current) return;
    if (spoken.current) callbacks.current.onTranscript(spoken.current);
    else callbacks.current.onCancel();
    callbacks.current.onError(error);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(tooltipTimer.current);
      clearTimeout(errorTimer.current);
      clearFailure();
      abandon(false);
    };
  }, []);
  // Another conversation: the recording stops, its text stays where it was.
  useEffect(() => {
    abandon(false);
    setGuidance(false);
    setMenuOpen(false);
    clearFailure();
    clearTimeout(errorTimer.current);
    setErrorVisible(false);
  }, [contextKey]);
  useEffect(() => {
    if (!stream) return;
    const ended = () =>
      fail(
        Object.assign(new Error("Microphone stopped"), { code: "mic_lost" }),
      );
    const tracks = stream.getAudioTracks();
    tracks.forEach((track) => track.addEventListener("ended", ended));
    return () =>
      tracks.forEach((track) => track.removeEventListener("ended", ended));
  }, [stream]);
  useEffect(() => {
    if (phase === "idle") return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (comment) event.stopPropagation();
        abandon(true);
      }
    };
    document.addEventListener("keydown", key, comment);
    return () => document.removeEventListener("keydown", key, comment);
  }, [phase, comment]);

  const send = (id: string, round: number, pcm: Uint8Array) => {
    pending.current = pending.current
      .then(() => window.desktop.dictationAudio(id, pcm))
      .then((progress) => {
        if (generation.current !== round) return;
        const next = joinSpoken(progress.text, progress.partial);
        if (next !== spoken.current) {
          spoken.current = next;
          wordsAt.current = Date.now();
          callbacks.current.onLive(next);
        }
      })
      .catch((error) => {
        if (generation.current === round) fail(error);
      });
  };

  /** The browser's own recognition: the same phases, no service session. */
  const startBrowser = () => {
    const round = ++generation.current;
    spoken.current = "";
    callbacks.current.onLive("");
    const began = Date.now();
    wordsAt.current = began;
    selfStopped.current = false;
    const limit = dictationRecordingSeconds(maxSeconds);
    recognizer.current = startRecognition({
      onText: (text) => {
        if (generation.current !== round) return;
        if (text !== spoken.current) wordsAt.current = Date.now();
        spoken.current = text;
        callbacks.current.onLive(text);
      },
      onEnd: (text) => {
        if (generation.current !== round || !mounted.current) return;
        clearInterval(ticker.current);
        recognizer.current = undefined;
        setPhase("idle");
        complete(text || spoken.current);
      },
      onError: (error) => {
        if (generation.current !== round) return;
        fail(error);
      },
    });
    failedStarts.current = 0;
    setPhase("recording");
    ticker.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      if (selfStopped.current) return;
      if (elapsed >= limit) stopItself("auto_max_duration");
      else if (Date.now() - wordsAt.current >= dictationSilenceSeconds * 1000)
        stopItself("auto_silence");
      else return;
      recognizer.current?.stop();
    }, 250);
  };

  const start = async () => {
    setGuidance(false);
    clearTimeout(errorTimer.current);
    setErrorVisible(false);
    if (engine === "browser") return startBrowser();
    const round = ++generation.current;
    setPhase("requesting");
    spoken.current = "";
    pending.current = Promise.resolve();
    const granted = await window.desktop.requestMicrophone();
    if (generation.current !== round) return;
    if (!granted) throw Error("Microphone access was not granted.");
    const session = await window.desktop.startDictation(dictationOptions());
    if (generation.current !== round) {
      void window.desktop.cancelDictation(session.sessionId).catch(() => {});
      return;
    }
    sessionId.current = session.sessionId;
    const limit = Math.min(
      session.maxSeconds,
      dictationRecordingSeconds(maxSeconds),
    );
    const { startMicrophone } = await import("../../voice/microphone");
    if (generation.current !== round) return;
    const mic = await startMicrophone(
      (pcm) => send(session.sessionId, round, pcm),
      microphoneDeviceId(),
    );
    if (generation.current !== round) {
      mic.stop();
      return;
    }
    microphone.current = mic;
    setStream(mic.stream);
    failedStarts.current = 0;
    setPhase("recording");
    callbacks.current.onLive("");
    const began = Date.now();
    wordsAt.current = began;
    selfStopped.current = false;
    ticker.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      if (elapsed >= limit) stopItself("auto_max_duration");
      else if (Date.now() - wordsAt.current >= dictationSilenceSeconds * 1000)
        stopItself("auto_silence");
      else return;
      void stop();
    }, 250);
    // "Hold to record": the key was let go while the microphone was opening.
    if (released.current) {
      released.current = false;
      void stop();
    }
  };

  const stop = async () => {
    if (recognizer.current) {
      setPhase("finishing");
      recognizer.current.stop();
      return;
    }
    const id = sessionId.current;
    if (!id || !microphone.current) return;
    const round = ++generation.current;
    clearInterval(ticker.current);
    setPhase("finishing");
    // The last partial chunk still reaches the service; its replies are no longer shown live.
    microphone.current.stop(true);
    microphone.current = undefined;
    setStream(undefined);
    // Chunks sent with the older generation are still awaited in order.
    try {
      await pending.current;
      const text = await window.desktop.finishDictation(id);
      if (generation.current !== round || !mounted.current) return;
      complete(text || spoken.current);
    } catch (error) {
      if (generation.current !== round || !mounted.current) return;
      submitAfterStop.current = false;
      if (spoken.current) callbacks.current.onTranscript(spoken.current);
      else callbacks.current.onCancel();
      callbacks.current.onError(error);
    } finally {
      if (sessionId.current === id) sessionId.current = undefined;
      if (generation.current === round && mounted.current) {
        setPhase("idle");
      }
    }
  };

  useEffect(() => {
    const element = field?.current;
    if (!comment || !element || phase === "idle") return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (phase === "finishing") return;
      submitAfterStop.current = true;
      if (phase === "recording") void stop();
      else released.current = true;
    };
    element.addEventListener("keydown", key, true);
    return () => element.removeEventListener("keydown", key, true);
  }, [comment, field, phase]);

  const click = (retry = false) => {
    if (phase === "recording") {
      void stop();
      return;
    }
    if (phase !== "idle" || (!canStart && !retry)) return;
    clearFailure();
    const round = generation.current + 1;
    void start().catch((error) => {
      if (generation.current !== round) return;
      abandon(false);
      if (mounted.current) {
        callbacks.current.onCancel();
        callbacks.current.onError(error);
      }
    });
  };
  const clickRef = useRef(click);
  clickRef.current = click;
  const phaseRef = useRef(phase);
  const { tooltip, pointerDown, pointerHold, tooltipRef, coarse, recording } =
    useDictationButtonActions({
      autoStart,
      button,
      click,
      clickRef,
      comment,
      containTooltip,
      phase,
      phaseRef,
      platform,
      released,
      shortcut,
      tooltipVisible,
    });
  return {
    tooltip,
    tooltipVisible,
    tooltipId,
    tooltipTimer,
    setTooltipVisible,
    pointerDown,
    pointerHold,
    click,
    tooltipRef,
    coarse,
    recording,
    stream,
    abandon,
    stop,
  } as const;
}
