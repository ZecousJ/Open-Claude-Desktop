/** Hidden message headings (1016 shared-10:30506–30546, 30640–30649). */
export function messageSummary(text: string) {
  const lines = text.split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let fence: string | undefined;
  while ((fence = /^\s*(`{3,})[^`]*$/.exec(lines[first] ?? "")?.[1])) {
    for (
      first++;
      first < lines.length && !lines[first].trimStart().startsWith(fence);
    )
      first++;
    for (first++; first < lines.length && !lines[first].trim();) first++;
  }
  const plain = [
    /^[ \t>]*(?:[#]{1,6}|[-*+]|\d+\.)\s+/gm,
    /`([^`]*)`/g,
    /\*\*([^*]+)\*\*/g,
    /__([^_]+)__/g,
    /(?<!\*)\*([^*\n]+)\*(?!\*)/g,
    /(?<!_)_([^_\n]+)_(?!_)/g,
    /!?\[([^\]]*)\]\([^)]*\)/g,
  ]
    .reduce(
      (value, pattern) =>
        value.replace(pattern, (_match, content) =>
          typeof content === "string" ? content : "",
        ),
      lines.slice(first).join("\n").slice(0, 2000),
    )
    .trimStart();
  const summary = (
    (/^[^\n]*?[.!?](?=[\s\p{Pe}\p{Pf}\p{Pi}"']|$)/u.exec(plain) ??
      /^[^\n]*/.exec(plain))?.[0] ?? plain
  ).trim();
  return summary.length > 160 ? `${summary.slice(0, 159)}…` : summary;
}
