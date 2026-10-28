export const fileTransitionEvent = "claudex-before-file-navigation";
export interface FileTransition {
  resume: () => void;
  scope: "session" | "pane";
  cancel?: () => void;
}
/** A mounted editor may defer navigation until its real dirty buffer is resolved. */
export function deferFileTransition(
  resume: () => void,
  scope: FileTransition["scope"] = "session",
  cancel?: () => void,
) {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<FileTransition>(fileTransitionEvent, {
    cancelable: true,
    detail: { resume, scope, ...(cancel ? { cancel } : {}) },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
