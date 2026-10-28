/**
 * remark-math reads $$…$$; models also write \(…\) and \[…\]. Rewrites those
 * delimiters outside code so every form renders. Single dollars stay text so
 * prices such as "$5 and $10" are not read as math.
 */
export function normalizeMathDelimiters(text: string) {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  // Fenced blocks (to their closing fence or the end) and inline code spans.
  const code = /(```[\s\S]*?(?:\n```|$)|~~~[\s\S]*?(?:\n~~~|$)|`[^`\n]*`)/g;
  return text
    .split(code)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(
              /\\\[([\s\S]+?)\\\]/g,
              (_, body: string) => `\n$$\n${body.trim()}\n$$\n`,
            )
            .replace(
              /\\\(([\s\S]+?)\\\)/g,
              (_, body: string) => `$$${body.trim()}$$`,
            ),
    )
    .join("");
}
