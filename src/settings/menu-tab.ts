/**
 * The page Settings… (⌘,) opens: Claudex Code's from a Code page, System's
 * otherwise. A host without that page opens General (nav.tsx openableTab). Kept
 * apart from nav.tsx so the app shell does not load the page icons with it.
 */
export function menuSettingsTab(onCodePage: boolean): "code" | "system" {
  return onCodePage ? "code" : "system";
}
