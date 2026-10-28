const catalogs: Record<
  string,
  () => Promise<{ default: Record<string, string> }>
> = {
  "zh-CN": () => import("../../shared/i18n/catalogs/zh-CN"),
  "ja-JP": () => import("../../shared/i18n/catalogs/ja-JP"),
  "ko-KR": () => import("../../shared/i18n/catalogs/ko-KR"),
  "de-DE": () => import("../../shared/i18n/catalogs/de-DE"),
  "fr-FR": () => import("../../shared/i18n/catalogs/fr-FR"),
  "es-ES": () => import("../../shared/i18n/catalogs/es-ES"),
  "es-419": () => import("../../shared/i18n/catalogs/es-419"),
  "it-IT": () => import("../../shared/i18n/catalogs/it-IT"),
  "pt-BR": () => import("../../shared/i18n/catalogs/pt-BR"),
  "id-ID": () => import("../../shared/i18n/catalogs/id-ID"),
  "hi-IN": () => import("../../shared/i18n/catalogs/hi-IN"),
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The catalog's texts as a translator: an exact text, or a text that fits a
 * catalog entry with {holes} ("Failed to check for updates: {error}" for
 * "Failed to check for updates: no network"), the holes carried over as they
 * are. The most specific template (the longest fixed text) wins.
 */
export function catalogTranslator(catalog: Record<string, string>) {
  const templates = Object.keys(catalog)
    .filter((key) => /\{\w+\}/.test(key))
    .map((key) => {
      const parts = key.split(/\{(\w+)\}/);
      const names = parts.filter((_, index) => index % 2 === 1);
      const literal = parts.filter((_, index) => index % 2 === 0);
      const source = literal.map(escapeRegExp).join("(.+?)");
      return {
        pattern: new RegExp(`^${source}$`, "s"),
        names,
        to: catalog[key],
        weight: literal.join("").length,
      };
    })
    .sort((a, b) => b.weight - a.weight);
  return (text: string) => {
    const found = catalog[text];
    if (found !== undefined) return found;
    for (const { pattern, names, to } of templates) {
      const match = pattern.exec(text);
      if (!match) continue;
      return to.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const index = names.indexOf(name);
        return index < 0 ? whole : match[index + 1];
      });
    }
    return text;
  };
}

export async function nativeTranslator(locale: string) {
  return catalogTranslator((await catalogs[locale]?.())?.default ?? {});
}
