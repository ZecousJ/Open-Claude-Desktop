/**
 * .env text as the Local environment editor takes it: KEY=value lines, `#`
 * comments, an optional `export ` prefix, and values wrapped in quotes, which
 * may span lines.
 */
export const envFileLimit = 20000;

/** Names Claudex sets itself; a .env line for one of them is ignored. */
export const managedEnvNames = [
  "PATH",
  "CODEX_HOME",
  "CLAUDEX_GATEWAY_TOKEN",
  "OPENAI_API_KEY",
];
const reserved = new Set(managedEnvNames);

// The original's .env line.
const envLine =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * What is wrong with the editor's text, as the original says it: a line that is
 * not KEY=value, a name with other characters, or a name Claudex sets itself.
 * While typing, a last line that is only a name is let through.
 */
export function envFileProblem(
  text: string,
  { allowTrailingBareKey = false } = {},
): { message: string; values: Record<string, string> } | undefined {
  if (!text.trim()) return;
  const rest = text.replace(/\r\n?/g, "\n").replace(envLine, "").split("\n");
  for (let index = 0; index < rest.length; index++) {
    const line = rest[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (
      allowTrailingBareKey &&
      index === rest.length - 1 &&
      /^(?:export\s+)?[\w.-]+:?$/.test(line)
    )
      continue;
    return {
      message: "Couldn't parse \u201c{line}\u201d. Use KEY=value format.",
      values: { line },
    };
  }
  const names = new Set<string>();
  const normalized = text.replace(/\r\n?/g, "\n");
  for (const match of normalized.matchAll(envLine)) names.add(match[1]);
  for (const name of names) {
    const values = { name };
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
      return {
        message:
          "Invalid key \u201c{name}\u201d. Use letters, numbers, and underscores only.",
        values,
      };
    if (name === "__proto__")
      return {
        message: "\u201c{name}\u201d can't be used as a variable name.",
        values,
      };
    if (reserved.has(name.toUpperCase()))
      return {
        message:
          "\u201c{name}\u201d is managed by Claudex and cannot be overridden.",
        values,
      };
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/.exec(
      lines[i],
    );
    if (!match) continue;
    const [, name, rest] = match;
    let value = rest.trimStart();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      let body = value.slice(1);
      let end = body.indexOf(quote);
      while (end < 0 && i + 1 < lines.length) {
        body += "\n" + lines[++i];
        end = body.indexOf(quote);
      }
      value = end < 0 ? body : body.slice(0, end);
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    if (!reserved.has(name.toUpperCase())) result[name] = value;
  }
  return result;
}
