/** The parts of a React keyboard event the IME checks read. */
type KeyPress = {
  key: string;
  keyCode: number;
  repeat: boolean;
  nativeEvent: { isComposing: boolean };
};

/**
 * True while an input method is composing: the Enter that accepts a pinyin or
 * kana candidate (and the Escape that abandons it) belongs to the IME, not to
 * the field. Safari reports the composing Enter with `isComposing` already
 * false, but with the legacy keyCode 229. The original's inline rename and
 * settings fields skip these keys the same way.
 */
export function isComposingKey(
  event: Pick<KeyPress, "nativeEvent" | "keyCode">,
): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * Enter or Escape that should end an in-place edit: not part of an IME
 * composition and not an auto-repeat of a held key (the original's rename
 * field ignores `e.repeat` too, so holding Enter cannot save and then
 * activate whatever the focus lands on).
 */
export function isEditEndKey(
  event: KeyPress,
  key: "Enter" | "Escape",
): boolean {
  return event.key === key && !isComposingKey(event) && !event.repeat;
}
