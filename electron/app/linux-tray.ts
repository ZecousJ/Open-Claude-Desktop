import { execFile } from "node:child_process";

/**
 * Whether this Linux desktop shows tray icons: a StatusNotifier host is
 * registered on the session bus (KDE, most others; GNOME only with an
 * AppIndicator extension). The original's Menu bar row says "Closing the window
 * quits Claude because your desktop doesn’t show tray icons." where it does
 * not. Without gdbus the answer is unknown and taken as yes.
 */
export function linuxTraySupported(
  run: typeof execFile = execFile,
): Promise<boolean> {
  return new Promise((resolve) => {
    run(
      "gdbus",
      [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.DBus",
        "--object-path",
        "/org/freedesktop/DBus",
        "--method",
        "org.freedesktop.DBus.NameHasOwner",
        "org.kde.StatusNotifierWatcher",
      ],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(true);
        resolve(!/\(false,?\)/.test(String(stdout)));
      },
    );
  });
}
