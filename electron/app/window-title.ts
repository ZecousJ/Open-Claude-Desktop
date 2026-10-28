/**
 * The main window's title (2.37337.1 OLa): the page's title without its
 * trailing " - Claudex" or " | Claudex", cut to 80 characters, then
 * " — Claudex"; the bare product name when the page names nothing else.
 */
const productSuffix = /(?:^|\s)[-|]\s(?:Claudex Code|Claudex)$/u;
const productNames = new Set(["Claudex", "Claudex Code"]);
const maxLength = 80;

export function mainWindowTitle(pageTitle: string | undefined) {
  const flat = (pageTitle ?? "").replace(/\s+/g, " ").trim();
  const title = productNames.has(flat)
    ? ""
    : flat.replace(productSuffix, "").trim();
  if (!title) return "Claudex";
  const cut =
    [...title].length > maxLength
      ? `${[...title].slice(0, maxLength - 1).join("")}…`
      : title;
  return `${cut} — Claudex`;
}
