/** Main-process-only authority for staged classic documents. No renderer registration API. */
const leases = new WeakMap<object, () => boolean>();
export function bindStagedDocument(window: object, current: () => boolean) {
  let retired = false;
  const check = () => {
    if (retired) return false;
    try { if (current() !== true) retired = true; } catch { retired = true; }
    return !retired;
  };
  leases.set(window, check);
  return () => { retired = true; };
}
export function stagedDocumentCurrent(window: object) {
  return leases.get(window)?.() ?? true;
}
