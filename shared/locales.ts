/**
 * The languages the interface can be shown in (the menu Language, as on
 * claude.ai, plus Simplified Chinese). `id` is a BCP 47 tag; `native` is the
 * language's own name and `english` its name in English, shown under it.
 * The list is in the order of the choice dialog.
 */
export interface LocaleInfo {
  id: string;
  native: string;
  english: string;
}

export const locales: readonly LocaleInfo[] = [
  {
    id: "en-US",
    native: "English (United States)",
    english: "English (United States)",
  },
  { id: "zh-CN", native: "简体中文", english: "Simplified Chinese" },
  { id: "fr-FR", native: "Français (France)", english: "French (France)" },
  { id: "de-DE", native: "Deutsch (Deutschland)", english: "German (Germany)" },
  { id: "hi-IN", native: "हिन्दी (भारत)", english: "Hindi (India)" },
  {
    id: "id-ID",
    native: "Indonesia (Indonesia)",
    english: "Indonesian (Indonesia)",
  },
  { id: "it-IT", native: "Italiano (Italia)", english: "Italian (Italy)" },
  { id: "ja-JP", native: "日本語 (日本)", english: "Japanese (Japan)" },
  { id: "ko-KR", native: "한국어(대한민국)", english: "Korean (South Korea)" },
  { id: "pt-BR", native: "Português (Brasil)", english: "Portuguese (Brazil)" },
  {
    id: "es-419",
    native: "Español (Latinoamérica)",
    english: "Spanish (Latin America)",
  },
  { id: "es-ES", native: "Español (España)", english: "Spanish (Spain)" },
];

/** The language the source texts are written in; it needs no catalog. */
export const sourceLocale = "en-US";

/** The language until a person chooses another: Simplified Chinese. */
export const defaultLocale = "zh-CN";

export const localeIds = locales.map((locale) => locale.id) as [
  string,
  ...string[],
];

/** The nearest supported locale for a browser language such as "zh-Hans-CN" or "pt-PT". */
export function nearestLocale(tag: string | undefined | null): string {
  const value = (tag ?? "").trim().toLowerCase();
  if (!value) return defaultLocale;
  const exact = locales.find((locale) => locale.id.toLowerCase() === value);
  if (exact) return exact.id;
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("es"))
    return value.includes("es-es") ? "es-ES" : "es-419";
  const base = value.split("-")[0];
  return (
    locales.find((locale) => locale.id.toLowerCase().split("-")[0] === base)
      ?.id ?? defaultLocale
  );
}
