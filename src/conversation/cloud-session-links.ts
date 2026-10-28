/**
 * A cloud Code session's own links: Copy link copies the session's address,
 * private to its owner, and Open in ▸ Desktop app hands the same session to the
 * desktop app (claude://claude.ai/code/… there; Claudex's
 * claudex://code/continue, shared/deep-links.ts).
 */
export function cloudSessionUrl(id: string, origin = location.origin) {
  return `${origin}/code/${encodeURIComponent(id)}`;
}
export function desktopSessionLink(id: string) {
  return `claudex://code/continue?session=${encodeURIComponent(id)}`;
}
export function openSessionInDesktopApp(id: string) {
  window.location.href = desktopSessionLink(id);
}
