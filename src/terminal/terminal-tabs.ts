/*
 * What the terminal tabs remember besides the terminals themselves (which live
 * in the main process): the order each was opened in and the name a tab was
 * given. After the original's tab strip: a tab shows its name when it has one,
 * else "Terminal" while it is the only one and "Terminal N" with several, N
 * being the number it got when it was opened, so closing one renames none of
 * the others. Kept for the life of the window; a terminal reopened in a new
 * window numbers from the order the main process lists them.
 */
const lastNumber = new Map<string, number>();
const numbers = new Map<string, number>();
const names = new Map<string, string>();
const key = (conversationId: string, id: string) => `${conversationId}\0${id}`;

/** The number of a terminal, given the first time it is asked for in opening order. */
export function tabNumber(conversationId: string, id: string) {
  const at = key(conversationId, id);
  let number = numbers.get(at);
  if (number === undefined) {
    number = (lastNumber.get(conversationId) ?? 0) + 1;
    lastNumber.set(conversationId, number);
    numbers.set(at, number);
  }
  return number;
}

/**
 * Names a tab: control characters and blanks folded as the artifact name
 * field does; nothing left puts the default label back. Answers the name.
 */
export function cleanTabName(
  conversationId: string,
  id: string,
  value: string,
) {
  const name = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name) names.set(key(conversationId, id), name);
  else names.delete(key(conversationId, id));
  return name || undefined;
}

/** The tab's label: its name, else Terminal, or Terminal N when there are several. */
export function tabLabel(
  conversationId: string,
  id: string,
  count: number,
  number: number,
) {
  return (
    names.get(key(conversationId, id)) ??
    (count > 1 ? `Terminal ${number}` : "Terminal")
  );
}

/** Whether the tab was given a name (shown as typed, never translated). */
export function hasTabName(conversationId: string, id: string) {
  return names.has(key(conversationId, id));
}

/** Forgets a closed terminal's name and number. */
export function forgetTab(conversationId: string, id: string) {
  names.delete(key(conversationId, id));
  numbers.delete(key(conversationId, id));
}

/** A restarted shell's tab keeps the old tab's number and name. */
export function inheritTab(
  conversationId: string,
  fromId: string,
  toId: string,
) {
  const from = key(conversationId, fromId);
  const to = key(conversationId, toId);
  const number = numbers.get(from);
  if (number !== undefined) numbers.set(to, number);
  const name = names.get(from);
  if (name !== undefined) names.set(to, name);
  numbers.delete(from);
  names.delete(from);
}
