import { useSyncExternalStore } from "react";
import {
  defaultLocale,
  locales,
  nearestLocale,
  sourceLocale,
} from "../../shared/locales";

/**
 * The interface language. Strings are written in English in the source and
 * looked up by their English text: `t("Settings")` gives "设置" in Simplified
 * Chinese, and the English text itself when the language has no entry (or is
 * English), so a page can be translated one string at a time and nothing is
 * ever blank. Each language's catalog is a separate file loaded when the
 * language is chosen. The choice is kept in the account's settings and, for
 * a first paint in the right language, in localStorage.
 */
type Catalog = Record<string, string>;

const storageKey = "claudex.locale";

const loaders: Record<string, () => Promise<{ default: Catalog }>> = {
  "zh-CN": () => import("../../shared/i18n/catalogs/zh-CN"),
  "fr-FR": () => import("../../shared/i18n/catalogs/fr-FR"),
  "de-DE": () => import("../../shared/i18n/catalogs/de-DE"),
  "hi-IN": () => import("../../shared/i18n/catalogs/hi-IN"),
  "id-ID": () => import("../../shared/i18n/catalogs/id-ID"),
  "it-IT": () => import("../../shared/i18n/catalogs/it-IT"),
  "ja-JP": () => import("../../shared/i18n/catalogs/ja-JP"),
  "ko-KR": () => import("../../shared/i18n/catalogs/ko-KR"),
  "pt-BR": () => import("../../shared/i18n/catalogs/pt-BR"),
  "es-419": () => import("../../shared/i18n/catalogs/es-419"),
  "es-ES": () => import("../../shared/i18n/catalogs/es-ES"),
};

let current = sourceLocale;
let catalog: Catalog = {};
/** Catalog entries with {name} holes ("Thought for {n}s"), compiled to patterns. */
let templates: { pattern: RegExp; to: string }[] = [];
let version = 0;
let chosen = false;
let localeRequest = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => version;

function validLocale(id: string | undefined): string {
  return locales.some((locale) => locale.id === id)
    ? (id as string)
    : defaultLocale;
}

/** The language chosen on this device before, else the default (Simplified Chinese). */
export function initialLocale(): string {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return validLocale(stored);
  } catch {
    /* no storage */
  }
  return defaultLocale;
}

export function currentLocale(): string {
  return current;
}

/** Suggested language from the browser (for a first visit): the nearest supported one. */
export function browserLocale(): string {
  return nearestLocale(
    typeof navigator === "undefined" ? undefined : navigator.language,
  );
}

/** Switches the interface language; resolves once its catalog is loaded. */
export async function setLocale(id: string | undefined): Promise<void> {
  const request = ++localeRequest;
  const next = validLocale(id);
  if (next === current && chosen) return;
  let loaded: Catalog = {};
  const load = loaders[next];
  if (load) {
    try {
      loaded = (await load()).default;
    } catch {
      // The language file couldn't be read: show English rather than blank.
      loaded = {};
    }
  }
  // A slower catalog must not overwrite a more recent language choice.
  if (request !== localeRequest) return;
  current = next;
  catalog = loaded;
  templates = Object.entries(loaded)
    .filter(([english]) => /\{\w+\}/.test(english) && isPattern(english))
    .map(([english, to]) => {
      const source = english
        .split(/(\{\w+\})/)
        .map((part) =>
          /^\{\w+\}$/.test(part)
            ? // {n} and {count} are always counts: they never swallow words
              // ("Check the notes" is not "{n} notes", "Developer tools" is
              // not "{count} tools").
              part === "{n}" || part === "{count}"
              ? `(?<${part.slice(1, -1)}>\\d[\\d,.]*(?:\\s?[KkMmBb])?)`
              : `(?<${part.slice(1, -1)}>.+?)`
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      const literal = english.replace(/\{\w+\}/g, "").length;
      return { pattern: new RegExp(`^${source}$`), to, literal };
    })
    // The most specific template wins: "searched the web {n} times" before
    // "searched {n} times".
    .sort((a, b) => b.literal - a.literal);
  chosen = true;
  version++;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* the account's setting still holds it */
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

/** Calls back after the language changed (the document translator uses it). */
export function subscribeLocale(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * The text in the current language; the English text when it has no entry.
 * A catalog entry with {holes} matches texts with anything in them
 * ("Thought for 12s" for "Thought for {n}s"); what fills a hole is translated
 * too when it is itself a known text.
 */
export function t(text: string): string {
  return translate(text, 0);
}

/**
 * A word whose translation depends on where it is used: the catalog keeps
 * it as "context|text" ("state|On" for a switch's state, where "On" alone is
 * the routine editor's "On Monday"). English shows `text`.
 */
export function tc(context: string, text: string): string {
  return catalog[`${context}|${text}`] ?? text;
}

/** Small words that make a hole a clause ("the stale lock file", "Settings to use it"), never a name. */
const clauseWords = new Set(
  "a an the of on in at to for from with by is are was were it this that your my our and or be do if when not all as up out has have can will".split(
    " ",
  ),
);

/**
 * Whether a text can fill a {hole} of a template: a text the catalog knows
 * ("Add Writing"), or one shaped like a name: at most six words, no
 * sentence end, no small word of a clause, and every word with a capital,
 * a digit or a symbol in it; a single word needs a digit, a symbol, capitals
 * only ("PR") or a hump ("iPhone") ("Google Drive", "package.json",
 * "Claude 4.6"; not "answer" in "Show answer", "Connection" in "Connection
 * failed" or "lock file" in "Remove the stale lock file."). A {n} or
 * {count} hole takes only a number and is not asked.
 */
function fitsHole(value: string): boolean {
  if (Object.prototype.hasOwnProperty.call(catalog, value)) return true;
  const text = value.trim();
  if (/[.!?。！？](\s|$)/.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length > 6 || words.some((word) => clauseWords.has(word)))
    return false;
  return words.length === 1
    ? /[^A-Za-z]|^[A-Z]{2,}$|[a-z][A-Z]/.test(text)
    : words.every((word) => /[^a-z]/.test(word));
}

/**
 * Whether a catalog sentence can be a pattern at all. One whose own words
 * are only the small words between its holes ("{row} in {section}",
 * "{client} on {os}", "{used} of {limit}", "{date} at {time}") would take
 * apart any "X in Y": it is filled by formatText and never matched.
 */
function isPattern(english: string): boolean {
  const words = english
    .replace(/\{\w+\}/g, " ")
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  return words.length > 0 && !words.every((word) => clauseWords.has(word));
}

function translate(text: string, depth: number): string {
  const found = catalog[text];
  if (found !== undefined) return found;
  if (templates.length && text.length < 240)
    for (const { pattern, to } of templates) {
      const match = pattern.exec(text);
      // A hole holds a name, never a clause: "{client} on {os}" must not take
      // "Turn on Allow … in Settings to use it." apart.
      if (
        match &&
        Object.entries(match.groups ?? {}).some(
          ([name, value]) =>
            name !== "n" && name !== "count" && !fitsHole(value),
        )
      )
        continue;
      if (match)
        return to.replace(/\{(\w+)\}/g, (_, name) => {
          const value = match.groups?.[name] ?? "";
          // What fills a hole is translated too when it is a known text ("Add Writing").
          return depth < 2 && /[A-Za-z]{2}/.test(value)
            ? translate(value, depth + 1)
            : value;
        });
    }
  return text;
}

/** A sentence with holes filled: `tf("Created {when}", { when })`; the values are translated too. */
export function tf(
  template: string,
  values: Record<string, string | number>,
): string {
  return (catalog[template] ?? template).replace(/\{(\w+)\}/g, (whole, name) =>
    name in values ? t(String(values[name])) : whole,
  );
}

/** Interpolate a complete UI sentence without translating user-provided values. */
export function formatText(
  template: string,
  values: Record<string, string | number> = {},
): string {
  return (catalog[template] ?? template).replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : whole,
  );
}

/** A note after a phrase: a space before it, none before a full-width bracket ("（1 个失败）"). */
export function spaced(note: string): string {
  return /^[（【「]/.test(note) ? note : ` ${note}`;
}

/** What joins the parts of a list in the current language. */
export function listSeparator(): string {
  return current.startsWith("zh") ? "，" : ", ";
}

/** `t` for a component: it renders again when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return t;
}

/** The current language id, for a component that shows it. */
export function useLocale(): string {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return current;
}
