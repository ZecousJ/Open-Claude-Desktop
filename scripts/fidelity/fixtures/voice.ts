/**
 * Dictation (package C6). By default the fixture's service offers streamed
 * dictation, as a Claudex plan with voice does, so the composer shows its
 * microphone like the references. A recording (the browser's microphone,
 * e.g. Chrome's fake device) is "transcribed" into a fixed sentence, one
 * word about every 300 ms, with the first sentence finished early.
 * `voice=off` is a service without dictation (no microphone).
 */
import type { DictationProgress } from "../../../shared/voice-api";
import type { FixtureDomain } from "./index";

const sentences = [
  "Draft a short note to the design team.",
  "Ask whether Friday's review can move to Monday morning",
];

export const voiceFixture: FixtureDomain = {
  params: {
    voice: "off: the service offers no dictation",
  },
  bridge: ({ params }) => {
    const off = params.get("voice") === "off";
    let session = 0,
      chunks = 0;
    const progress = (): DictationProgress => {
      const words = Math.floor(chunks / 3);
      const first = sentences[0].split(" ");
      if (words < first.length)
        return { text: "", partial: first.slice(0, words).join(" ") };
      const second = sentences[1].split(" ");
      return {
        text: sentences[0],
        partial: second.slice(0, words - first.length).join(" "),
      };
    };
    return {
      voiceAvailability: async () => ({
        transcription: !off,
        maxTranscriptionBytes: null,
        maxSeconds: off ? null : 120,
        ...(off ? {} : { streaming: true }),
      }),
      requestMicrophone: async () => !off,
      startDictation: async () => {
        if (off) throw Error("Dictation isn't available right now.");
        chunks = 0;
        return {
          sessionId: `fixture-${++session}`,
          streaming: true,
          maxSeconds: 120,
        };
      },
      dictationAudio: async () => {
        chunks++;
        return progress();
      },
      finishDictation: async () => {
        const { text, partial } = progress();
        return [text, partial].filter(Boolean).join(" ");
      },
      cancelDictation: async () => {},
    };
  },
};
