import { useEffect, useRef, useState } from "react";
import { loadVoices, speechPreferences } from "../voice/speech";

/**
 * Voice → Style's hover preview: resting on a voice's mark for 150ms plays a
 * sample in that voice, leaving it or closing the list stops it. The original
 * plays a recorded clip of each of its voices; Claudex's voices are this
 * computer's, so the sample is said by the voice itself.
 */
export const previewDelayMs = 150;

/** A short line in the voice's own language (its first two letters). */
const samples: Record<string, string> = {
  en: "Hi, this is how I sound.",
  zh: "你好，这是我的声音。",
  ja: "こんにちは、これが私の声です。",
  ko: "안녕하세요, 제 목소리는 이렇습니다.",
  de: "Hallo, so klinge ich.",
  fr: "Bonjour, voici ma voix.",
  es: "Hola, así suena mi voz.",
  it: "Ciao, questa è la mia voce.",
  pt: "Olá, esta é a minha voz.",
  id: "Halo, beginilah suara saya.",
  hi: "नमस्ते, मेरी आवाज़ ऐसी है।",
};

export function previewSample(lang: string) {
  return samples[lang.slice(0, 2).toLowerCase()] ?? samples.en;
}

/** The voice playing a preview, with start and stop. */
export function useVoicePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const stop = () => {
    current.current = null;
    setPlaying(null);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  };
  const preview = async (name: string) => {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const voice = (await loadVoices()).find((v) => v.name === name);
    if (!voice) return;
    const utterance = new SpeechSynthesisUtterance(previewSample(voice.lang));
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = speechPreferences().rate;
    const end = () => {
      if (current.current === name) {
        current.current = null;
        setPlaying(null);
      }
    };
    utterance.onend = end;
    utterance.onerror = end;
    current.current = name;
    setPlaying(name);
    speechSynthesis.speak(utterance);
  };
  useEffect(() => stop, []);
  return { playing, preview, stop };
}

/** Plays `hovered` after the delay unless it is already playing. */
export function useHoverPreview(
  hovered: string | null,
  { playing, preview, stop }: ReturnType<typeof useVoicePreview>,
) {
  const playingNow = useRef(playing);
  playingNow.current = playing;
  useEffect(() => {
    if (hovered === null) return stop();
    const timer = setTimeout(() => {
      if (playingNow.current !== hovered) void preview(hovered);
    }, previewDelayMs);
    return () => clearTimeout(timer);
  }, [hovered]);
}

/** Bar heights of the original's idle voice mark (6 bars, 4px apart). */
const bars = [6, 10, 16, 10, 16, 6];

/**
 * The voice mark (the original's idle voice glyph, 16px): six bars that
 * ripple once when the pointer arrives (at most every 100ms) and when the
 * voice starts playing.
 */
export function VoiceMark({ playing }: { playing: boolean }) {
  const [ripple, setRipple] = useState(0);
  const last = useRef(0);
  const bump = () => {
    const now = Date.now();
    if (now - last.current < 100) return;
    last.current = now;
    setRipple((n) => n + 1);
  };
  useEffect(() => {
    if (playing) bump();
  }, [playing]);
  return (
    <svg
      className="voice-mark"
      width={16}
      height={16}
      viewBox="0 0 21.2 21.2"
      fill="none"
      aria-hidden="true"
      onMouseEnter={bump}
    >
      <g key={ripple}>
        {bars.map((height, index) => (
          <rect
            key={index}
            x={index * 4}
            y={10.6 - height / 2}
            width={1.2}
            height={height}
            rx={0.6}
            fill="currentColor"
            className={ripple > 0 ? "ripple" : undefined}
            style={
              {
                "--ripple-scale": (height + 4) / height,
                animationDelay: `${index * 50}ms`,
              } as React.CSSProperties
            }
          />
        ))}
      </g>
    </svg>
  );
}
