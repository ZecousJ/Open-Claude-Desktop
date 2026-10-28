/**
 * The folder a new local Code session gets when none is chosen: an empty
 * one of its own, `<data>/workspace/sessions/<id>` (electron/engine/
 * engine-send.ts). It is Claudex's, not a place the person picked, so the
 * interface shows such a session as having no folder (Choose folder…).
 */
const scratch =
  /[\\/]workspace[\\/]sessions[\\/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]?$/i;

export function isSessionScratchFolder(cwd: string | undefined) {
  return !!cwd && scratch.test(cwd);
}

/** The folder to show for a session: none for its own scratch folder. */
export function shownFolder(cwd: string | undefined) {
  return cwd && !scratch.test(cwd) ? cwd : undefined;
}
