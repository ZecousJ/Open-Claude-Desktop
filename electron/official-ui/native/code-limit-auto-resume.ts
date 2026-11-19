import { z } from "zod";
import type { BrowserWindow } from "electron";
import type { NativeHost } from "./host";

const publicId = z.string().regex(/^local_[0-9a-f-]{36}$/i);

export function registerCodeLimitAutoResumeNative(host: NativeHost) {
  const quota = host.ctx.codeLimitAutoResume;
  if (!quota) return () => {};
  const windows = new Map<BrowserWindow, () => void>();
  const check = () => {
    if (
      host.ctx.isCurrent?.() === false ||
      !host.ctx.account()?.id ||
      host.ctx.readOnly
    )
      throw Error("This account window has retired.");
  };
  const track = (window: BrowserWindow) => {
    if (windows.has(window)) return;
    const release = () => {
      quota.release(window);
      if (!window.isDestroyed())
        window.webContents.off("did-navigate", release);
      window.off("closed", release);
      windows.delete(window);
    };
    windows.set(window, release);
    window.webContents.once("did-navigate", release);
    window.once("closed", release);
  };
  host.on(
    "LimitAutoResume.getLimitAutoResumeState",
    (optOutAccount: unknown) => {
      check();
      const account = z.string().max(256).optional().parse(optOutAccount);
      if (account && account !== host.ctx.account()?.id)
        throw Error("This Code limit preference belongs to another account.");
      if (host.caller) {
        track(host.caller);
        quota.attend(host.caller);
      }
      return quota.state(account);
    },
  );
  host.on(
    "LimitAutoResume.setLimitAutoResumeArmed",
    (session: unknown, enabled: unknown) => {
      check();
      quota.arm(publicId.parse(session), z.boolean().parse(enabled));
    },
  );
  host.on("LimitAutoResume.setLimitAutoResumeHeldSessions", (ids: unknown) => {
    check();
    const window = host.caller;
    if (!window) return;
    track(window);
    quota.hold(window, z.array(publicId).max(256).parse(ids));
  });
  const stop = quota.subscribe((state) =>
    host.emit("LimitAutoResume", "limitAutoResumeChanged", state),
  );
  return () => {
    stop();
    for (const release of [...windows.values()]) release();
  };
}
