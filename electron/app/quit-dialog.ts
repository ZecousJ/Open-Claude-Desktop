/** The question before quitting while tasks run, in the app's language. */
export function quitBusyDialog(
  translate: (text: string) => string,
  sessionCount: number,
) {
  const detail =
    sessionCount === 1
      ? translate(
          "Claudex is working in 1 session. Quitting now will interrupt that work.",
        )
      : translate(
          "Claudex is working in {count} sessions. Quitting now will interrupt that work.",
        ).replace("{count}", String(sessionCount));
  return {
    type: "question" as const,
    message: translate("Claudex is still working"),
    detail,
    buttons: [
      translate("Quit anyway"),
      translate("Wait for Claudex"),
      translate("Cancel"),
    ],
    defaultId: 1,
    cancelId: 2,
  };
}

/** What the answer to that question does. */
export function quitBusyChoice(response: number): "quit" | "wait" | "cancel" {
  return response === 0 ? "quit" : response === 1 ? "wait" : "cancel";
}
