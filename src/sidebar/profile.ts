/** Account trigger fallback. */
export function profileInitials(name: string) {
  const words = name.trim().split(/\s+/);
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toLocaleUpperCase() || "?";
}
