/** Account trigger fallback (live claude.ai bundle, 2026-10-14, shared-frame-B1JORnF0.js; shared-19-BG_pM4_W.js). */
export function profileInitials(name: string) {
  const words = name.trim().split(/\s+/);
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toLocaleUpperCase() || "?";
}
