/** Appearance only; never grants model, privacy, connector or general settings writes. */
export const officialAppearanceCapabilitiesPath =
  "/api/claudex/appearance-capabilities/version1";
export const officialAppearanceFonts = [
  "serif",
  "sans",
  "system",
  "dyslexia",
] as const;
export function isOfficialAppearanceAction(method: string, path: string) {
  return (
    (method === "PATCH" && path === "/api/account/settings") ||
    isOfficialLocaleAction(method, path)
  );
}
export function validAppearanceBody(
  body: unknown,
): body is { chat_font: (typeof officialAppearanceFonts)[number] } {
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    Object.prototype.hasOwnProperty.call(body, "chat_font") &&
    officialAppearanceFonts.includes((body as any).chat_font)
  );
}
export interface OfficialAppearanceCapability {
  version: 1;
  accountId: string;
  activationLease: string;
  appearance: {
    state: "ready" | "unavailable";
    reason: "ready" | "disabled" | "session_changed";
  };
  fonts: readonly string[];
  locales?: readonly string[];
}

export const officialSimplifiedChineseLocale = "zh-Hans";
export const officialChineseLocales = [
  officialSimplifiedChineseLocale,
  "zh-Hant",
] as const;

export const officialAppearanceLocales = [
  "en-US",
  "de-DE",
  "fr-FR",
  "ko-KR",
  "ja-JP",
  "es-419",
  "es-ES",
  "it-IT",
  "hi-IN",
  "pt-BR",
  "id-ID",
  ...officialChineseLocales,
] as const;
export function isOfficialLocaleAction(method: string, path: string) {
  return method === "PUT" && path === "/api/account_profile";
}
export function validLocaleBody(
  body: unknown,
): body is { locale: (typeof officialAppearanceLocales)[number] } {
  return (
    !!body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    "locale" in body &&
    Object.hasOwn(body, "locale") &&
    officialAppearanceLocales.some((locale) => locale === body.locale)
  );
}
export function validAppearanceRequest(
  method: string,
  path: string,
  body: unknown,
) {
  return isOfficialLocaleAction(method, path)
    ? validLocaleBody(body)
    : method === "PATCH" &&
        path === "/api/account/settings" &&
        validAppearanceBody(body);
}
