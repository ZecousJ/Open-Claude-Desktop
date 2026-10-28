/** Current file strip: O14/cfe7c4b3b:724–765; Ctrl or Command + Shift moves a tab. */
export function moveFileTab(tabs: readonly string[], path: string, by: -1 | 1) {
  const from = tabs.indexOf(path),
    to = from + by;
  if (from < 0 || to < 0 || to >= tabs.length) return [...tabs];
  const next = [...tabs];
  next.splice(from, 1);
  next.splice(to, 0, path);
  return next;
}
export function nextFileTab(
  tabs: readonly string[],
  path: string,
  key: string,
  rtl = false,
) {
  if (!tabs.length) return undefined;
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs.at(-1);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  const by = key === (rtl ? "ArrowLeft" : "ArrowRight") ? 1 : -1;
  return tabs[
    (Math.max(0, tabs.indexOf(path)) + by + tabs.length) % tabs.length
  ];
}
export function activeAfterFileClose(
  before: readonly string[],
  remaining: readonly string[],
  active: string | undefined,
) {
  if (active && remaining.includes(active)) return active;
  if (!remaining.length) return undefined;
  const at = active ? before.indexOf(active) : -1;
  return (
    before.slice(at + 1).find((path) => remaining.includes(path)) ??
    [...before.slice(0, at)]
      .reverse()
      .find((path) => remaining.includes(path)) ??
    remaining[0]
  );
}

/** Single click reuses an unkept preview; double click or an edit keeps it. */
export function openFileTab(
  tabs: readonly string[],
  path: string,
  preview: string | undefined,
  previews: boolean,
  keep = false,
) {
  if (tabs.includes(path))
    return {
      tabs: [...tabs],
      preview: keep && preview === path ? undefined : preview,
    };
  const next = [...tabs],
    at = preview ? next.indexOf(preview) : -1;
  if (previews && !keep && at >= 0) next.splice(at, 1, path);
  else next.push(path);
  return { tabs: next, preview: previews && !keep ? path : undefined };
}
