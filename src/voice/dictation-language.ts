/** Input language is independent of the language used to read replies aloud.
 * O14/shared-7: YV keeps dictation_language_code separate from voice_language_code.
 */
const key = "claudex.dictation.language";
const changed = "claudex-dictation-language";
let fallback = "";

export function selectedDictationLanguage(): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setDictationLanguage(language: string) {
  fallback = language;
  try {
    localStorage.setItem(key, language);
  } catch {
    // A blocked store keeps the choice for this window.
  }
  dispatchEvent(new Event(changed));
}

export function subscribeDictationLanguage(listener: () => void) {
  addEventListener(changed, listener);
  addEventListener("storage", listener);
  return () => {
    removeEventListener(changed, listener);
    removeEventListener("storage", listener);
  };
}

export const dictationOptions = () => {
  const language = selectedDictationLanguage();
  return language ? { language } : undefined;
};
