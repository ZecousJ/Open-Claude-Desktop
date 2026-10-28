import { useCallback, useEffect, useRef, useState } from "react";
import { dictationRecordingSeconds, joinSpoken } from "../../shared/voice-api";
import type { AppController } from "../app/AppContext";
import { sendSpoken } from "../app/composer-send";
import { startMicrophone, type Microphone } from "./microphone";
import { microphoneDeviceId } from "./preferences";
import { startRecognition } from "./browser-recognition";
import { dictationOptions } from "./dictation-language";
import type { SpeechEngine } from "./useSpeechEngine";
import { speak, type Speaking } from "./speech";
import { isVoiceConnectionError } from "./connection-error";
import { authIssueOf } from "../../shared/auth-issue";
import { voiceAuthIssue } from "./auth-issue";
import {
  MicSilenceMonitor,
  micSilenceCheckMs,
  type MicSilence,
} from "./mic-silence";

export type VoicePhase =
  "off" | "starting" | "reconnecting" | "listening" | "thinking" | "speaking";

/** Quiet this long after words, and what was said is sent. */
export const silenceMs = 1600;
/** With no words at all for this long, the round is over. */
export const noSpeechMs = 15_000;
/** Rounds with nothing said before voice mode ends by itself. */
export const idleRounds = 2;
/** How long a sent message may go without a turn starting. */
const startWaitMs = 10_000;

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Voice mode: a spoken conversation in the open chat. It listens through the
 * service's dictation, sends what was said once the speaker pauses, waits for
 * the reply to finish, reads it aloud with the window's speech synthesis and
 * listens again. `stop` ends it at any point (also when the composer goes).
 */
export function useVoiceMode(
  app: AppController,
  maxSeconds: number | null,
  engine: SpeechEngine = "service",
) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  /** What has been heard so far in this round. */
  const [heard, setHeard] = useState("");
  /** No sound, or a muted input, while listening (until dismissed). */
  const [micNotice, setMicNotice] = useState<MicSilence | null>(null);
  const noticeDismissed = useRef(false);
  const latest = useRef(app);
  latest.current = app;
  const generation = useRef(0);
  const cleanup = useRef<(() => void) | undefined>(undefined);
  const mounted = useRef(true);

  const stop = useCallback(() => {
    generation.current++;
    if (voiceAuthIssue.read() === "retrying") voiceAuthIssue.set(null);
    cleanup.current?.();
    cleanup.current = undefined;
    noticeDismissed.current = false;
    if (mounted.current) {
      setPhase("off");
      setHeard("");
      setMicNotice(null);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
      voiceAuthIssue.set(null);
    };
  }, [stop]);

  /** One round of listening; the words said, or "" when there were none. */
  const listenWithBrowser = async (round: number): Promise<string> => {
    let spoken = "";
    let changedAt = Date.now();
    let finished = false;
    let failure: Error | undefined;
    let release: (() => void) | undefined;
    const recognizer = startRecognition({
      onText: (text) => {
        if (text !== spoken) {
          spoken = text;
          changedAt = Date.now();
          if (mounted.current && generation.current === round) setHeard(text);
        }
      },
      onEnd: () => {
        finished = true;
        release?.();
      },
      onError: (error) => {
        failure ??= error;
        release?.();
      },
    });
    cleanup.current = () => {
      finished = true;
      recognizer.abort();
      release?.();
    };
    setPhase("listening");
    setHeard("");
    const began = Date.now();
    const limit = dictationRecordingSeconds(maxSeconds) * 1000;
    await new Promise<void>((done) => {
      release = done;
      const ticker = setInterval(() => {
        const now = Date.now();
        if (
          finished ||
          failure ||
          generation.current !== round ||
          now - began >= limit ||
          (spoken && now - changedAt >= silenceMs) ||
          (!spoken && now - began >= noSpeechMs)
        ) {
          clearInterval(ticker);
          done();
        }
      }, 200);
      release = () => {
        clearInterval(ticker);
        done();
      };
    });
    if (generation.current !== round) {
      recognizer.abort();
      return "";
    }
    // Stopping lets the last words arrive before the round ends.
    if (!finished) {
      recognizer.stop();
      await pause(400);
    }
    if (failure && !spoken) throw failure;
    return spoken.trim();
  };

  const listen = async (round: number): Promise<string> => {
    if (engine === "browser") return listenWithBrowser(round);
    if (!(await window.desktop.requestMicrophone()))
      throw new Error("Microphone access was not granted.");
    if (generation.current !== round) return "";
    const session = await window.desktop.startDictation(dictationOptions());
    let microphone: Microphone | undefined;
    let pending: Promise<unknown> = Promise.resolve();
    let spoken = "";
    let changedAt = Date.now();
    let ticker: ReturnType<typeof setInterval> | undefined;
    let ended = false;
    /** Lets the wait for the pause go when the round is ended from outside. */
    let release: (() => void) | undefined;
    /** Ends the microphone silence check (set once listening starts). */
    let stopSilence = () => {};
    const end = (cancel: boolean) => {
      if (ended) return;
      ended = true;
      stopSilence();
      clearInterval(ticker);
      release?.();
      microphone?.stop(!cancel);
      microphone = undefined;
      if (cancel)
        void window.desktop.cancelDictation(session.sessionId).catch(() => {});
    };
    cleanup.current = () => end(true);
    try {
      let failure: unknown;
      const silence = new MicSilenceMonitor(Date.now());
      microphone = await startMicrophone((pcm) => {
        silence.hear(pcm);
        pending = pending
          .then(() => window.desktop.dictationAudio(session.sessionId, pcm))
          .then((progress) => {
            if (ended) return;
            const next = joinSpoken(progress.text, progress.partial);
            if (next !== spoken) {
              spoken = next;
              changedAt = Date.now();
              if (mounted.current && generation.current === round)
                setHeard(next);
            }
          })
          .catch((error) => {
            failure ??= error;
          });
      }, microphoneDeviceId());
      if (generation.current !== round) {
        end(true);
        return "";
      }
      setPhase("listening");
      setHeard("");
      const track = microphone.stream.getAudioTracks()[0];
      const silenceTicker = setInterval(() => {
        if (ended || generation.current !== round) return;
        const notice = silence.check(Date.now(), track?.muted === true);
        if (mounted.current && !noticeDismissed.current) setMicNotice(notice);
      }, micSilenceCheckMs);
      stopSilence = () => {
        clearInterval(silenceTicker);
        if (mounted.current) setMicNotice(null);
      };
      const began = Date.now();
      const limit =
        Math.min(session.maxSeconds, dictationRecordingSeconds(maxSeconds)) *
        1000;
      // Until the speaker pauses (or nothing is said, or the limit passes).
      await new Promise<void>((done) => {
        release = done;
        ticker = setInterval(() => {
          const now = Date.now();
          if (
            generation.current !== round ||
            failure ||
            now - began >= limit ||
            (spoken && now - changedAt >= silenceMs) ||
            (!spoken && now - began >= noSpeechMs)
          ) {
            clearInterval(ticker);
            done();
          }
        }, 200);
      });
      if (generation.current !== round) {
        end(true);
        return "";
      }
      end(false);
      await pending;
      if (failure && !spoken) throw failure;
      const text = await window.desktop.finishDictation(session.sessionId);
      return (text || spoken).trim();
    } catch (error) {
      end(true);
      throw error;
    }
  };

  /**
   * Waits for the message sent at `sentAt` to be answered; the reply's text.
   * The turn is found by when it began, so a reply that was already done by
   * the first look is not missed.
   */
  const reply = async (round: number, sentAt: number): Promise<string> => {
    const began = Date.now();
    for (;;) {
      await pause(250);
      if (generation.current !== round) return "";
      const current = latest.current;
      const turn = current.active?.turns.at(-1);
      const ours = turn && turn.createdAt >= sentAt - 2000;
      if (
        ours &&
        turn.status !== "inProgress" &&
        !current.running &&
        !current.sending
      ) {
        if (turn.status === "failed")
          throw new Error(turn.error || "The reply failed.");
        return turn.items
          .filter((item) => item.type === "agentMessage" && item.text)
          .map((item) => item.text)
          .join("\n\n");
      }
      if (!ours && Date.now() - began > startWaitMs)
        throw new Error("The message wasn't sent.");
    }
  };

  const start = useCallback(async () => {
    if (generation.current > 0 && phase !== "off") return;
    const round = ++generation.current;
    voiceAuthIssue.set(null);
    setPhase("starting");
    let quiet = 0;
    try {
      while (generation.current === round) {
        let said = "";
        for (let attempt = 0; ; attempt++) {
          try {
            said = await listen(round);
            voiceAuthIssue.set(null);
            break;
          } catch (error) {
            if (generation.current !== round) return;
            const authIssue = authIssueOf(error);
            if (attempt >= 2 || (!authIssue && !isVoiceConnectionError(error)))
              throw error;
            if (authIssue) voiceAuthIssue.set("retrying");
            setPhase("reconnecting");
            await pause(500 * (attempt + 1));
            if (generation.current !== round) return;
          }
        }
        if (generation.current !== round) return;
        if (!said) {
          if (++quiet >= idleRounds) break;
          continue;
        }
        quiet = 0;
        setPhase("thinking");
        setHeard(said);
        const sentAt = Date.now();
        await sendSpoken(latest.current, said);
        const answer = await reply(round, sentAt);
        if (generation.current !== round) return;
        if (!answer) continue;
        setPhase("speaking");
        let speaking: Speaking | undefined = speak(answer);
        cleanup.current = () => speaking?.cancel();
        await speaking.done;
        speaking = undefined;
      }
    } catch (error) {
      if (generation.current === round) {
        const authIssue = authIssueOf(error);
        if (authIssue) voiceAuthIssue.set(authIssue);
        else latest.current.report(error);
      }
    } finally {
      if (generation.current === round) {
        cleanup.current = undefined;
        if (mounted.current) {
          setPhase("off");
          setHeard("");
        }
      }
    }
    // `listen` and `reply` read only refs and stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, maxSeconds, engine]);

  /** Ends the reading aloud and goes back to listening. */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const skip = useCallback(() => {
    if (phaseRef.current === "speaking") cleanup.current?.();
  }, []);

  /** Hides the microphone notice for the rest of this voice session. */
  const dismissMicNotice = useCallback(() => {
    noticeDismissed.current = true;
    setMicNotice(null);
  }, []);

  return { phase, heard, micNotice, dismissMicNotice, start, stop, skip };
}
