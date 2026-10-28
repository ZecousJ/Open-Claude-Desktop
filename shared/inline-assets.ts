/**
 * An HTML artifact that loads its own stylesheets and scripts from files beside
 * it (index.html with style.css and game.js) runs as one document: the preview
 * frame has no folder to load them from, so each one the conversation made is
 * put inline. Addresses with a scheme or `//`, and files not found, stay as
 * they are.
 */

/** `ref` from the folder of `from`, in `from`'s separators; undefined for a web address. */
export function siblingPath(from: string, ref: string): string | undefined {
  const address = ref.trim().replace(/[?#].*$/, "");
  // A web address, or one from the site's root, which a file has none of.
  if (
    !address ||
    /^[a-z][a-z0-9+.-]*:/i.test(address) ||
    address.startsWith("/")
  )
    return undefined;
  const separator = from.includes("\\") && !from.includes("/") ? "\\" : "/";
  const parts = from.split(/[\\/]/).slice(0, -1);
  for (const part of address.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(decodeSegment(part));
  }
  return parts.join(separator);
}

function decodeSegment(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);

/** `html` with the stylesheets and scripts `read` finds beside `path` inline. */
export function inlineLocalAssets(
  html: string,
  path: string,
  read: (path: string) => string | undefined,
): string {
  const file = (ref: string | undefined) => {
    const target = ref === undefined ? undefined : siblingPath(path, ref);
    return target === undefined ? undefined : read(target);
  };
  // A deferred (or async) script runs once the page is parsed; inline, that
  // attribute means nothing, so it moves to the end of the body instead, in
  // order.
  const later: string[] = [];
  const inlined = html
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\srel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      const css = file(attribute(tag, "href"));
      if (css === undefined) return tag;
      const media = attribute(tag, "media");
      return `<style${media ? ` media="${media}"` : ""}>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
    })
    .replace(
      /<script\b([^>]*)>\s*<\/script\s*>/gi,
      (tag, attributes: string) => {
        const source = attribute(` ${attributes}`, "src");
        const js = file(source);
        if (js === undefined) return tag;
        const deferred =
          /\s(?:defer|async)(?=[\s=>]|$)/i.test(` ${attributes}`) &&
          !/\stype\s*=\s*["']?module/i.test(` ${attributes}`);
        const rest = attributes.replace(
          /\s(?:src|integrity|crossorigin|defer|async)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>]|$)/gi,
          "",
        );
        const script = `<script${rest}>${js.replace(/<\/script/gi, "<\\/script")}</script>`;
        if (!deferred) return script;
        later.push(script);
        return "";
      },
    );
  if (!later.length) return inlined;
  const end = inlined.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return end < 0
    ? inlined + later.join("")
    : inlined.slice(0, end) + later.join("") + inlined.slice(end);
}
