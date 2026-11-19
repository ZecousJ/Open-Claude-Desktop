/**
 * Splits a custom prompt's arguments as Codex custom prompts do: on
 * whitespace, with "double" or 'single' quotes keeping spaces together.
 */
export function splitPromptArguments(text: string) {
  const values: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    values.push(match[1] ?? match[2] ?? match[3] ?? "");
  return values;
}

/**
 * A custom prompt with its arguments filled in: `$1`…`$9` take the
 * positional arguments, `$ARGUMENTS` all of them, `$NAME` a `NAME=value`
 * argument, and `$$` is a literal "$". A prompt without placeholders gets
 * the arguments after it, on a line of their own.
 */
export function expandCustomPrompt(body: string, argumentText: string) {
  const all = argumentText.trim();
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const value of splitPromptArguments(all)) {
    const pair = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(value);
    if (pair) named.set(pair[1], pair[2]);
    else positional.push(value);
  }
  let used = false;
  const expanded = body.replace(
    /\$(\$|[1-9]|[A-Z][A-Z0-9_]*)/g,
    (whole, key: string) => {
      if (key === "$") return "$";
      if (key === "ARGUMENTS") {
        used = true;
        return all;
      }
      if (/^[1-9]$/.test(key)) {
        used = true;
        return positional[Number(key) - 1] ?? "";
      }
      if (named.has(key)) {
        used = true;
        return named.get(key)!;
      }
      return whole;
    },
  );
  const text = expanded.trim();
  if (used || !all) return text;
  return text ? `${text}\n\n${all}` : all;
}

/** The message a skill command sends: Codex reads `$name` as a request to use that skill. */
export function skillMessage(name: string, argumentText: string) {
  const rest = argumentText.trim();
  return rest ? `$${name} ${rest}` : `$${name}`;
}
