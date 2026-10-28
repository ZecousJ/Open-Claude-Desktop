/**
 * Windows draws the app windows' caption buttons (minimize, maximize, close)
 * itself: Electron's titleBarOverlay. A button of the page could not be clicked
 * in a conversation on Windows while every check on the page and on macOS found
 * it clickable; the system's own buttons answer the system's hit test, which no
 * app region of the page can cover. The buttons keep the page's 36px caption
 * row, and the page reports the colours under them (windowAction "caption").
 */
export const captionHeight = 36;

export function captionOverlay(background: string, symbol: string) {
  return { color: background, symbolColor: symbol, height: captionHeight };
}

/** Before the page reports its colours: the window's own background. */
export function initialCaptionOverlay(dark: boolean) {
  return dark
    ? captionOverlay("#151515", "#f0efec")
    : captionOverlay("#fcfcfb", "#141413");
}
