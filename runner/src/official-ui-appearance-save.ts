/** Atomic cosmetic mutation: no asynchronous context lookup and no renderer full-settings payload. */
import type { Settings } from "../../shared/types";
import { settingsRefusal } from "../../shared/client-policy";
import {
  validAppearanceBody,
  validLocaleBody,
} from "../../shared/official-appearance-capability";
export async function saveAppearanceFont(input: {
  font: unknown;
  current(): boolean;
  store: { settings: Settings; persistAppearancePreference(): Promise<void> };
  policy: Parameters<typeof settingsRefusal>[2];
  changed(settings: Settings): void;
}) {
  if (!validAppearanceBody({ chat_font: input.font }) || !input.current())
    throw Error("Appearance settings are unavailable.");
  const previous = input.store.settings;
  const next = { ...previous, chatFont: input.font } as Settings;
  const refusal = settingsRefusal(previous, next, input.policy);
  if (refusal) throw Error(refusal);
  if (!input.current() || input.store.settings !== previous)
    throw Error("The account or settings changed.");
  input.store.settings = next;
  // Await service-confirmed persistence; a queued CloudStore flush is not a saved result.
  try {
    await input.store.persistAppearancePreference();
  } catch (error) {
    // Restore only our still-current in-memory assignment. Disk outcome may be unknown; never retry.
    if (input.current() && input.store.settings === next)
      input.store.settings = previous;
    throw error;
  }
  if (!input.current())
    throw Error("The account activation changed after saving.");
  if (input.store.settings.chatFont !== input.font)
    throw Error(
      "The response font was superseded before confirmation; reload its current value.",
    );
  input.changed(input.store.settings);
}

/** Exact locale-only sibling of font saving, with the same service-confirmed persistence. */
export async function saveAppearanceLocale(input: {
  locale: unknown;
  current(): boolean;
  store: { settings: Settings; persistAppearancePreference(): Promise<void> };
  policy: Parameters<typeof settingsRefusal>[2];
  changed(settings: Settings): void;
}) {
  if (!validLocaleBody({ locale: input.locale }) || !input.current())
    throw Error("Language changes are not available on this host.");
  const previous = input.store.settings;
  const next = { ...previous, locale: input.locale } as Settings;
  const refusal = settingsRefusal(previous, next, input.policy);
  if (refusal) throw Error(refusal);
  if (!input.current() || input.store.settings !== previous)
    throw Error("The account or settings changed.");
  input.store.settings = next;
  try {
    await input.store.persistAppearancePreference();
  } catch (error) {
    if (input.current() && input.store.settings === next)
      input.store.settings = previous;
    throw error;
  }
  if (
    !input.current() ||
    (input.store.settings as Settings & { locale?: string }).locale !==
      input.locale
  )
    throw Error("The account or settings changed.");
  input.changed(input.store.settings);
}
