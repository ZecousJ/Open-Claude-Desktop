/** Native index.html only: Electron's media query already follows its saved
 * nativeTheme.themeSource. Stamp before renderer CSS can apply dark defaults;
 * loaded useAppearance still owns the account's final theme. */
export function bootstrapNativeTheme(root: HTMLElement, prefersDark: boolean) {
  if (root.hasAttribute("data-theme")) return;
  root.dataset.theme = prefersDark ? "dark" : "light";
}

bootstrapNativeTheme(
  document.documentElement,
  matchMedia("(prefers-color-scheme: dark)").matches,
);
