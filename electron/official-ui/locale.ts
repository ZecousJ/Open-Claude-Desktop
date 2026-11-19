/** Locale data comes from recovered official catalogs, never generated text. */
import fs from "node:fs";
import path from "node:path";
import type { AdapterContext } from "./api/context";
import { sourceLocale } from "../../shared/locales";
import {
  officialAppearanceLocales,
  officialSimplifiedChineseLocale,
} from "../../shared/official-appearance-capability";

export function officialLocales(root: string): string[] {
  if (!root) return [];
  const directory = path.join(root, "ui", "i18n");
  return officialAppearanceLocales.filter(
    (locale) =>
      fs.existsSync(path.join(directory, `${locale}.json`)) &&
      fs.existsSync(path.join(directory, "dynamic", `${locale}.json`)),
  );
}

export function requireOfficialLocale(root: string, raw: unknown): string {
  if (typeof raw !== "string" || !officialLocales(root).includes(raw))
    throw Error(
      "The official translation catalog for that language is not available in this build.",
    );
  return raw;
}

type LocaleContext = Pick<AdapterContext, "root" | "settings">;

export function officialLocaleSelection(ctx: LocaleContext): {
  locale: string;
  source?: "user_choice";
} {
  const saved = ctx.settings().locale;
  const locale =
    saved === undefined || saved === "zh-CN"
      ? officialSimplifiedChineseLocale
      : saved;
  if (officialLocales(ctx.root).includes(locale))
    return { locale, source: saved === undefined ? undefined : "user_choice" };
  return { locale: sourceLocale };
}

export function officialLocale(ctx: LocaleContext): string {
  return officialLocaleSelection(ctx).locale;
}

export function officialLocaleMessages(
  root: string,
  locale: string,
): Record<string, string> {
  requireOfficialLocale(root, locale);
  const directory = path.join(root, "ui", "i18n");
  const read = (file: string) => {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((v) => typeof v !== "string")
    )
      throw Error("The official translation catalog is invalid.");
    return value as Record<string, string>;
  };
  return {
    ...read(path.join(directory, `${locale}.json`)),
    ...read(path.join(directory, "dynamic", `${locale}.json`)),
  };
}
