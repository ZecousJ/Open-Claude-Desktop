import { useEffect, useLayoutEffect } from "react";
import type { Settings } from "../../shared/types";
import { surface } from "../../shared/host";
import { writeBootHints } from "../boot/boot-hints";
import { transcriptTextSize } from "../transcript/transcript-text-size";
import { preference } from "../../shared/settings-extras";
import {
  applyCodeTheme,
  clearCodeTheme,
  codeThemeForMode,
} from "./code-theme-palettes";

/** Quotes one font family name for use in a CSS font-family list. */
export function cssFamily(name: string) {
  return `"${name.trim().replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Applies window-only preferences to the document: theme (following the
 * system when asked), chat font, reduced motion, a custom code font, the
 * transcript text size and width, and the interface font.
 */
export function useAppearance(settings: Settings | undefined) {
  const theme = settings?.theme ?? "dark";
  // The web app's next first paint uses it (src/boot/boot-hints.ts).
  useEffect(() => {
    if (surface === "web" && settings) writeBootHints({ theme });
  }, [theme, Boolean(settings)]);
  const loaded = Boolean(settings);
  const codeLightTheme = settings?.codeLightTheme;
  const codeDarkTheme = settings?.codeDarkTheme;
  useLayoutEffect(() => {
    // Until the settings arrive the first paint's theme stays (web.html:
    // the device's, or the one chosen here before); applying the default
    // "dark" meanwhile flashed a light phone dark, then light again.
    if (!loaded) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const shown =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      const root = document.documentElement;
      root.dataset.theme = shown;
      applyCodeTheme(
        root,
        codeThemeForMode(shown, codeLightTheme, codeDarkTheme),
      );
      // A phone browser paints its bars in the page's colour (web.html).
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", shown === "dark" ? "#151515" : "#fcfcfb");
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      clearCodeTheme(document.documentElement);
    };
  }, [theme, loaded, codeLightTheme, codeDarkTheme]);

  const chatFont = settings?.chatFont ?? "serif";
  const motion = settings?.motion ?? "system";
  const codeFont = settings?.codeFont?.trim() ?? "";
  const textSize = transcriptTextSize(settings);
  const width = settings ? preference(settings, "transcriptWidth") : "s";
  const interfaceFont = settings
    ? preference(settings, "interfaceFont")
    : "anthropic";
  useLayoutEffect(() => {
    if (!loaded) return;
    const root = document.documentElement;
    root.dataset.chatFont = chatFont;
    root.dataset.motion = motion;
    // The original sets it on the document too (dataset.chatTextSize);
    // src/transcript-text-size.css.
    root.dataset.chatTextSize = textSize;
    root.dataset.transcriptWidth = width;
    root.dataset.interfaceFont = interfaceFont;
    // Prepended to each monospace stack; the trailing comma keeps the fallbacks.
    if (codeFont)
      root.style.setProperty("--code-font-custom", `${cssFamily(codeFont)},`);
    else root.style.removeProperty("--code-font-custom");
  }, [loaded, chatFont, motion, codeFont, textSize, width, interfaceFont]);
}
