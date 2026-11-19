import { View, type BrowserWindow, type WebContents } from "electron";

export function coverSigningOutWindow(win: BrowserWindow, dark: boolean) {
  const cover = new View();
  cover.setBackgroundColor(dark ? "#111111" : "#faf9f5");
  const fit = () => {
    const { width, height } = win.getContentBounds();
    cover.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  win.contentView.addChildView(cover);
  win.on("resize", fit);
}

export async function waitForSignIn(contents: WebContents) {
  await contents.executeJavaScript(`new Promise(resolve => {
    const ready = () => !!document.querySelector(".signin-desktop, .boot-error, .window-error");
    const done = () => {
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    };
    const check = () => {
      if (!ready()) return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(done));
    };
    const observer = new MutationObserver(check);
    const timeout = setTimeout(done, 8000);
    observer.observe(document.body, { childList: true, subtree: true });
    check();
  })`);
}
