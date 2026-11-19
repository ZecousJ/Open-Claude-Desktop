/** Main-process identity only. A renderer/service error with the same text is not equivalent. */
const registrationFailures = new WeakSet<object>();
export function shortcutRegistrationFailure(accelerator: string): Error {
  const error = Error(`${accelerator} is used by another app. Choose a different shortcut. (registration-failed)`);
  registrationFailures.add(error);
  return error;
}
export function isShortcutRegistrationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && registrationFailures.has(error);
}
