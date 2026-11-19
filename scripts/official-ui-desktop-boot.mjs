export const mainWindowSource = "src/renderer/desktop/main_window/";
export const desktopBootSource = "src/renderer/index.html";

export function desktopBootDocument(document, desktopSource) {
  const head = desktopSource.match(
    /(try\{var desktopBootPlaceholder=[\s\S]*?)<\/script>(<style>html\[data-desktop-boot-placeholder\][\s\S]*?<\/style>)/,
  );
  const dragStrip = '<div id="desktop-boot-drag-strip"></div>';
  if (
    !head ||
    !desktopSource.includes(dragStrip) ||
    !document.includes('data-mode="dark"') ||
    !document.includes("<head>") ||
    !document.includes('<div id="root"></div>')
  )
    throw Error("The pinned desktop startup document could not be derived.");
  const boot = head[1].replace(
    "globalThis.desktopBootFeatures&&globalThis.desktopBootFeatures.bootPlaceholder",
    '{status:"supported"}',
  );
  return document
    .replace(
      'data-mode="dark"',
      'data-mode="system" data-desktop-boot-placeholder',
    )
    .replace("<head>", `<head>\n    <script>${boot}</script>${head[2]}`)
    .replace(
      '<div id="root"></div>',
      `${dragStrip}\n    <div id="root"></div>`,
    );
}
