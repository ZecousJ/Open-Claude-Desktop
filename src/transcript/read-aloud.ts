import { useSyncExternalStore } from "react";
import { speak as speakText, type Speaking } from "../voice/speech";

/**
 * Where a reply's Read aloud is. Loading is the wait for the window's voices
 * before the first words; the live app's "reconnecting" belongs to its streamed
 * audio, which Claudex does not have.
 */
export type ReadAloudPhase = "idle" | "loading" | "playing" | "paused";

interface Reading {
  key: string;
  phase: ReadAloudPhase;
  run: Speaking;
  /** The first words went to the speech synthesis. */
  begun: boolean;
}

/**
 * One reply is read at a time, as in the live app: Read aloud on another
 * reply stops the one being read and starts that one, whose button then
 * shows Pause while the other's is Read aloud again.
 */
export function createReadAloud(speak: typeof speakText = speakText) {
  let reading: Reading | undefined;
  const listeners = new Set<() => void>();
  const update = (next: Reading | undefined) => {
    reading = next;
    listeners.forEach((listener) => listener());
  };
  const store = {
    phase(key: string): ReadAloudPhase {
      return reading?.key === key ? reading.phase : "idle";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The button: start, pause (also while loading) or resume. */
    toggle(key: string, text: string) {
      if (reading?.key === key) {
        if (reading.phase === "paused") {
          reading.run.resume();
          update({ ...reading, phase: reading.begun ? "playing" : "loading" });
        } else {
          reading.run.pause();
          update({ ...reading, phase: "paused" });
        }
        return;
      }
      store.stop();
      let begun = false;
      const run: Speaking = speak(text, {
        onStart: () => {
          begun = true;
          if (reading?.run !== run) return;
          update({
            ...reading,
            begun: true,
            phase: reading.phase === "loading" ? "playing" : reading.phase,
          });
        },
      });
      update({ key, run, begun, phase: begun ? "playing" : "loading" });
      void run.done.finally(() => {
        if (reading?.run === run) update(undefined);
      });
    },
    /** Stops whatever is being read; with a key, only that reply. */
    stop(key?: string) {
      if (!reading || (key !== undefined && reading.key !== key)) return;
      const { run } = reading;
      update(undefined);
      run.cancel();
    },
  };
  return store;
}

const readAloud = createReadAloud();

/** A reply's Read aloud phase, and its button's actions. */
export function useReadAloud(key: string) {
  const phase = useSyncExternalStore(
    readAloud.subscribe,
    () => readAloud.phase(key),
    () => "idle" as const,
  );
  return {
    phase,
    toggle: (text: string) => readAloud.toggle(key, text),
    stop: () => readAloud.stop(key),
  };
}
