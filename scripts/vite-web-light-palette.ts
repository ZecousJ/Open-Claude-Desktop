import type { Plugin } from "vite";

/**
 * claude.ai's light palette on the web. The stylesheets' light rules carry the
 * desktop app's own light greys; the web page's tokens sit a shade off them. In
 * a web build the text greys inside light-theme rules become the web's three
 * inks, and the dark ink of primary buttons the web's primary ink. Dark rules,
 * layout and every other colour are left as they are.
 */
export const webInk = "#0b0b0b";
export const webSecondary = "#52514e";
export const webMuted = "#898781";

const ink = new Set(["#141413", "#141414", "#050505", "#292927", "#2b2b29"]);
const secondary = new Set([
  "#3d3d3a",
  "#38342e",
  "#4c4b4a",
  "#5d5d5b",
  "#6b6a66",
  "#6e6e6c",
  "#73726c",
]);
const muted = new Set(["#767674", "#82817f", "#81807c", "#9b9a97"]);

function remap(colour: string, text: boolean) {
  const value = colour.toLowerCase();
  if (ink.has(value)) return webInk;
  if (!text) return colour;
  if (secondary.has(value)) return webSecondary;
  if (muted.has(value)) return webMuted;
  return colour;
}

/** The stylesheet with its light-theme rules' greys replaced. */
export function webLightPalette(css: string) {
  return css.replace(
    /([^{}]+)\{([^{}]*)\}/g,
    (rule: string, selector: string, body: string) => {
      if (
        !selector.includes('data-theme="light"') ||
        selector.includes(':not([data-theme="light"])')
      )
        return rule;
      const changed = body.replace(
        /(^|;|\s)(color|background|background-color)\s*:([^;]*)/g,
        (
          declaration: string,
          lead: string,
          property: string,
          value: string,
        ) => {
          const text = property === "color";
          return `${lead}${property}:${value.replace(
            /#[0-9a-fA-F]{6}\b/g,
            (colour) => remap(colour, text),
          )}`;
        },
      );
      return `${selector}{${changed}}`;
    },
  );
}

/** Applies `webLightPalette` to the app's own stylesheets (web builds only). */
export function webLightPalettePlugin(): Plugin {
  return {
    name: "claudex-web-light-palette",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".css") || !file.includes("/src/")) return null;
      const changed = webLightPalette(code);
      return changed === code ? null : { code: changed, map: null };
    },
  };
}
