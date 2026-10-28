/**
 * /feedback: asks the Send feedback button to do what pressing it does. The
 * button knows whether the account may send feedback for the session, so it
 * answers; true when something took the request.
 */
export const codeFeedbackEvent = "claudex:code-feedback";

export function requestCodeFeedback() {
  const detail = { handled: false };
  window.dispatchEvent(new CustomEvent(codeFeedbackEvent, { detail }));
  return detail.handled;
}
