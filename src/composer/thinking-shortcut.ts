/** Toggle thinking. */
export function thinkingShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "isComposing"
    | "repeat"
  >,
  platform: string,
) {
  const mac = platform === "darwin";
  return (
    event.key.toLowerCase() === "e" &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    event.shiftKey &&
    !event.altKey &&
    !event.isComposing &&
    !event.repeat
  );
}
