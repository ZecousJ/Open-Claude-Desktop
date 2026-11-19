/** A single native installation dialog operation, not persistent file/folder trust. */
interface InstallWindow {
  isDestroyed(): boolean;
  webContents: {
    mainFrame: { url: string };
    on(name: string, listener: (...args: any[]) => void): unknown;
    removeListener(name: string, listener: (...args: any[]) => void): unknown;
  };
}
interface InstallIdentity {
  accountId: string | undefined;
  store: object;
  generation: number;
  window: InstallWindow | undefined;
}
export function captureExtensionInstallLease(
  read: () => InstallIdentity,
  now = Date.now,
) {
  const initial = { ...read() },
    window = initial.window;
  if (!initial.accountId || !window || window.isDestroyed())
    throw Error("Open extension settings again before installing.");
  const location = window.webContents.mainFrame.url,
    until = now() + 5 * 60_000;
  let retired = false,
    disposed = false;
  const revoke = (
    _event: unknown,
    _url: string,
    _inPlace: boolean,
    main: boolean,
  ) => {
    if (main) retired = true;
  };
  const inPage = (_event: unknown, _url: string, main: boolean) => {
    if (main) retired = true;
  };
  window.webContents.on("did-start-navigation", revoke);
  window.webContents.on("did-navigate-in-page", inPage);
  const current = () => {
    try {
      const next = read();
      return (
        !disposed &&
        !retired &&
        now() < until &&
        !window.isDestroyed() &&
        window.webContents.mainFrame.url === location &&
        next.accountId === initial.accountId &&
        next.store === initial.store &&
        next.generation === initial.generation &&
        next.window === window
      );
    } catch {
      return false;
    }
  };
  const assertCurrent = () => {
    if (!current())
      throw Error(
        "The installation expired or its account or window changed. Choose the extension again.",
      );
  };
  return {
    window,
    current,
    assertCurrent,
    async wait<T>(promise: Promise<T>): Promise<T> {
      try {
        const value = await promise;
        assertCurrent();
        return value;
      } catch (error) {
        assertCurrent();
        throw error;
      }
    },
    dispose() {
      disposed = true;
      window.webContents.removeListener("did-start-navigation", revoke);
      window.webContents.removeListener("did-navigate-in-page", inPage);
    },
  };
}
