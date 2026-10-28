/**
 * What signing out forgets of the account on this device, besides its drafts
 * (composer/draft-store.ts): the choices and dismissals kept in the browser's
 * storage under keys of their own, so the next account to sign in does not see
 * the last one's repositories, model names or tips. The original clears a list
 * of such keys, and the persisted-store ones, on sign-out. The language and the
 * theme belong to the device and stay.
 *
 * A store that also holds its state in memory registers a reset with
 * `onForgetAccountData`.
 */
const keys = [
  // The repositories the Code home starts with, and the older single one.
  "claudex.code.repositories",
  "claudex.code.repository",
  "claudex.prAutoArchive",
  "claudex.projects.group-by-type",
  "claudex.projects.sort",
  "sidebar-seen-new-items",
  "claudex.artifacts.view",
  "claudex.transcriptView.v1",
  "claudex.transcriptViewNudge.v1",
  "startCardDismissals",
  "cowork-dismissed-suggested-connectors",
  "claudex.modelLabels",
];
/** The session rail keeps its state under several keys. */
const prefixes = ["claudex.sessionRail."];

const resets = new Set<() => void>();

/** Registers what a store clears from memory when the account is forgotten. */
export function onForgetAccountData(reset: () => void) {
  resets.add(reset);
}

export function forgetAccountLocalData(storage?: Storage) {
  try {
    const store = storage ?? localStorage;
    const names: string[] = [...keys];
    for (let index = 0; index < store.length; index++) {
      const name = store.key(index);
      if (name && prefixes.some((prefix) => name.startsWith(prefix)))
        names.push(name);
    }
    names.forEach((name) => store.removeItem(name));
  } catch {
    /* Blocked storage holds nothing to forget. */
  }
  resets.forEach((reset) => reset());
}
