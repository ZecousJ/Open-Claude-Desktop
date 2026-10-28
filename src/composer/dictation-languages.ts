/** Current official menu inventory, 2026-10-18. The service accepts BCP47 tags;
 * these are language hints, not a claim about a provider's language accuracy.
 * Labels follow the app language; English fallback is the observed wording.
 */
const languages = [
  ["en", "English"],
  ["en-IN", "English (India)"],
  ["en-GB", "English (United Kingdom)"],
  ["zh", "Chinese (Mandarin)"],
  ["yue", "Cantonese"],
  ["fr", "French"],
  ["fr-CA", "French (Canada)"],
  ["de", "German"],
  ["de-AT", "German (Austria)"],
  ["hi", "Hindi"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["pt", "Portuguese"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["pt-PT", "Portuguese (Portugal)"],
  ["ru", "Russian"],
  ["es", "Spanish"],
  ["es-419", "Spanish (Latin America)"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["am", "Amharic"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["he", "Hebrew"],
  ["id", "Indonesian"],
  ["no", "Norwegian"],
  ["pl", "Polish"],
  ["sw", "Swahili"],
  ["sv", "Swedish"],
] as const;

export function dictationLanguages(locale: string) {
  let names: Intl.DisplayNames | undefined;
  if (!locale.startsWith("en")) {
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {}
  }
  return languages.map(([value, fallback]) => ({
    value,
    label: names?.of(value) ?? fallback,
  }));
}
