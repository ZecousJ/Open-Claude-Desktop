import {
  cleanEdit,
  looksSecret,
  memoryMessages,
  type MemoryLimits,
} from "./types";

/** Validate the entire replacement before a store removes any existing edit. */
export function cleanControls(values: readonly string[], limits: MemoryLimits) {
  if (values.length > limits.editsPerScope)
    throw new Error(memoryMessages.full);
  return values.map((raw) => {
    const value = cleanEdit(raw);
    if (!value) throw new Error(memoryMessages.emptyEdit);
    if ([...value].length > limits.editChars)
      throw new Error(memoryMessages.editTooLong);
    if (looksSecret(value)) throw new Error(memoryMessages.sensitive);
    return value;
  });
}
