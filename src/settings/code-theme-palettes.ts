import type {
  CodeDarkTheme,
  CodeLightTheme,
} from "../../shared/settings-extras";

export type CodeThemeId = CodeLightTheme | CodeDarkTheme;
export type CodeThemeMode = "light" | "dark";

/** Extracted from highlight.js 11.11.2 styles/github.css and github-dark.css.
 * GitHub palette attribution: github.com / @Hirse, updated 2021-05-15.
 * BSD-3-Clause, Copyright (c) 2006 Ivan Sagalaev; full notice and upstream
 * paths retained in THIRD_PARTY_NOTICES.md. No asynchronous style asset is
 * needed: the active palette is applied before the browser paints. */
export const githubCodePalettes = {
  "github-light": {
    foreground: "#24292e",
    background: "#ffffff",
    keyword: "#d73a49",
    entity: "#6f42c1",
    constant: "#005cc5",
    string: "#032f62",
    variable: "#e36209",
    comment: "#6a737d",
    tag: "#22863a",
    heading: "#005cc5",
    bullet: "#735c0f",
    addition: "#22863a",
    "addition-background": "#f0fff4",
    deletion: "#b31d28",
    "deletion-background": "#ffeef0",
  },
  "github-dark": {
    foreground: "#c9d1d9",
    background: "#0d1117",
    keyword: "#ff7b72",
    entity: "#d2a8ff",
    constant: "#79c0ff",
    string: "#a5d6ff",
    variable: "#ffa657",
    comment: "#8b949e",
    tag: "#7ee787",
    heading: "#1f6feb",
    bullet: "#f2cc60",
    addition: "#aff5b4",
    "addition-background": "#033a16",
    deletion: "#ffdcd7",
    "deletion-background": "#67060c",
  },
} as const;

const assetRoles = Object.keys(
  githubCodePalettes["github-light"],
) as (keyof (typeof githubCodePalettes)["github-light"])[];
export const codeColorRoles = [...assetRoles, "addition-word", "deletion-word"];

/** Defensive at runtime too: a bad stored ID never activates a partial theme. */
export function codeThemeForMode(
  mode: CodeThemeMode,
  light: unknown,
  dark: unknown,
): CodeThemeId {
  return mode === "light"
    ? light === "github-light"
      ? light
      : "claudex-light"
    : dark === "github-dark"
      ? dark
      : "claudex-dark";
}

/** A preview resets inherited variables so the other mode's active theme
 * cannot tint a default Claudex preview. `initial` makes var() use its own
 * existing renderer fallback rather than an inherited GitHub colour. */
export function codeThemePreviewVariables(theme: CodeThemeId) {
  const palette =
    theme === "github-light" || theme === "github-dark"
      ? githubCodePalettes[theme]
      : undefined;
  const variables = Object.fromEntries(
    assetRoles.map((role) => [`--code-${role}`, palette?.[role] ?? "initial"]),
  );
  // Retain the renderer's existing word-change alpha (15% light, 20% dark)
  // with the selected asset's actual addition/deletion foreground colours.
  for (const kind of ["addition", "deletion"] as const)
    variables[`--code-${kind}-word`] = palette
      ? `color-mix(in srgb, ${palette[kind]} ${theme === "github-light" ? 15 : 20}%, transparent)`
      : "initial";
  return variables;
}

export function clearCodeTheme(root: HTMLElement) {
  for (const role of codeColorRoles)
    root.style.removeProperty(`--code-${role}`);
  delete root.dataset.codeTheme;
}

/** All roles are written or removed together in the caller's layout effect. */
export function applyCodeTheme(root: HTMLElement, theme: CodeThemeId) {
  clearCodeTheme(root);
  if (theme === "github-light" || theme === "github-dark")
    for (const [name, value] of Object.entries(
      codeThemePreviewVariables(theme),
    ))
      root.style.setProperty(name, value);
  root.dataset.codeTheme = theme;
}
