/**
 * Voice mode's speaking half: what a reply sounds like and how it is said.
 * The words are read by the browser's (or the desktop window's) own speech
 * synthesis, so nothing is sent anywhere and no service is needed; which
 * voices exist depends on the computer. The choices (voice, speed,
 * language) belong to this browser and are kept in its own storage.
 */

/** A reply as plain speech: no code, links, markup or table furniture. */
export function speakableText(markdown: string): string {
  return (
    markdown
      // Fenced and indented code is not read out.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/~~~[\s\S]*?(~~~|$)/g, " ")
      .replace(/<[^>\n]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, " ")
      .replace(/\|/g, ", ")
      .replace(/(\*\*|__|\*|_|~~)/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  );
}

/**
 * Pieces of at most `max` characters, cut at sentence ends where they can
 * be: browsers stop a long utterance part-way, so a reply is spoken in turns.
 */
export function speechChunks(text: string, max = 200): string[] {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*[ \t]*|\n+/g) ?? [
    text,
  ];
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.startsWith("\n")) {
      push();
      continue;
    }
    if (sentence.length > max) {
      push();
      // A sentence with no stop: cut at spaces or commas, else anywhere.
      for (let rest = sentence; rest.length;) {
        let cut = rest.length <= max ? rest.length : max;
        if (rest.length > max) {
          const at = Math.max(
            rest.lastIndexOf(" ", max),
            rest.lastIndexOf("，", max),
            rest.lastIndexOf(",", max),
          );
          if (at > max / 2) cut = at + 1;
        }
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      continue;
    }
    if ((current + sentence).length > max) push();
    current += sentence;
  }
  push();
  return chunks.filter(Boolean);
}

/** The language a piece of text is written in, as a BCP 47 tag. */
export function guessLanguage(text: string): string {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  if (/[぀-ヿ]/.test(text)) return "ja-JP";
  if (/[가-힯]/.test(text)) return "ko-KR";
  if (cjk > text.replace(/\s/g, "").length * 0.2) return "zh-CN";
  return "en-US";
}

export interface VoiceLike {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
}

/**
 * The voice to use: the chosen one when it speaks the language, else the
 * default of that language (a local one first), else none (the browser's own).
 */
export function pickVoice<T extends VoiceLike>(
  voices: T[],
  lang: string,
  chosen?: string,
): T | undefined {
  const base = lang.slice(0, 2).toLowerCase();
  const speaks = (voice: T) => voice.lang.slice(0, 2).toLowerCase() === base;
  const named = chosen
    ? voices.find((voice) => voice.name === chosen)
    : undefined;
  if (named && speaks(named)) return named;
  const candidates = voices.filter(speaks);
  return (
    candidates.find(
      (voice) =>
        voice.lang.toLowerCase() === lang.toLowerCase() && voice.default,
    ) ??
    candidates.find((voice) => voice.default) ??
    candidates.find((voice) => voice.localService) ??
    candidates[0]
  );
}

export const speechRates = [0.8, 1, 1.2, 1.5] as const;
export const speechLanguages: { value: string; label: string }[] = [
  { value: "", label: "Match the reply" },
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "中文" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
];

const keys = {
  voice: "claudex.speech.voice",
  rate: "claudex.speech.rate",
  language: "claudex.speech.language",
};
const memory = new Map<string, string>();
function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? "";
  } catch {
    return memory.get(key) ?? "";
  }
}
function write(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage keeps the choice for this page only.
  }
  dispatchEvent(new Event("claudex-speech-preferences"));
}

export interface SpeechPreferences {
  voice: string;
  rate: number;
  language: string;
}
export function speechPreferences(): SpeechPreferences {
  const rate = Number(read(keys.rate));
  return {
    voice: read(keys.voice),
    rate: (speechRates as readonly number[]).includes(rate) ? rate : 1,
    language: read(keys.language),
  };
}
export const setSpeechVoice = (name: string) => write(keys.voice, name);
export const setSpeechRate = (rate: number) => write(keys.rate, String(rate));
export const setSpeechLanguage = (lang: string) => write(keys.language, lang);

/** Whether this window can speak at all. */
export const canSpeak = () =>
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof SpeechSynthesisUtterance !== "undefined";

/** The installed voices; they arrive a moment after the page loads. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!canSpeak()) return Promise.resolve([]);
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((done) => {
    const finish = () => done(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, 1500);
  });
}

export interface Speaking {
  /** Resolves when the last piece was spoken or speech was cancelled. */
  done: Promise<void>;
  cancel: () => void;
  /** Holds the voice where it is; `resume` carries on from there. */
  pause: () => void;
  resume: () => void;
}

/**
 * Says the text in the person's chosen voice, speed and language.
 * `onStart` is called once the voices are loaded and the first words are
 * handed to the speech synthesis.
 */
export function speak(
  text: string,
  { onStart }: { onStart?: () => void } = {},
): Speaking {
  const prefs = speechPreferences();
  const plain = speakableText(text);
  const chunks = speechChunks(plain);
  let cancelled = false;
  let paused = false;
  const done = (async () => {
    if (!canSpeak() || !chunks.length) return;
    const voices = await loadVoices();
    const lang = prefs.language || guessLanguage(plain);
    const voice = pickVoice(voices, lang, prefs.voice);
    let started = false;
    for (const chunk of chunks) {
      if (cancelled) return;
      if (!started) {
        started = true;
        onStart?.();
      }
      await new Promise<void>((next) => {
        const utterance = new SpeechSynthesisUtterance(chunk);
        utterance.lang = voice?.lang ?? lang;
        if (voice) utterance.voice = voice;
        utterance.rate = prefs.rate;
        // Some hosts never report the end (no voice installed): move on
        // after about as long as the words take, but not while paused.
        const wait = () =>
          setTimeout(
            () => {
              if (paused) limit = wait();
              else next();
            },
            (chunk.length * 130) / Math.max(prefs.rate, 0.5) + 4000,
          );
        let limit = wait();
        const finish = () => {
          clearTimeout(limit);
          next();
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        speechSynthesis.speak(utterance);
      });
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      paused = false;
      if (canSpeak()) speechSynthesis.cancel();
    },
    pause() {
      paused = true;
      if (canSpeak()) speechSynthesis.pause();
    },
    resume() {
      paused = false;
      if (canSpeak()) speechSynthesis.resume();
    },
  };
}
