/**
 * Apps that reach beyond themselves: a terminal or editor runs commands, a file
 * manager touches any file, system settings change the system. The access card
 * warns under these rows.
 */
import type { ComputerUseAppRef } from "../../shared/computer-use";

export type SentinelKind = "shell" | "filesystem" | "system_settings";

const macShell = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.microsoft.VSCode",
  "dev.warp.Warp-Stable",
  "com.github.wez.wezterm",
  "org.alacritty",
  "io.alacritty",
  "net.kovidgoyal.kitty",
  "co.zeit.hyper",
  "com.mitchellh.ghostty",
  "com.todesktop.230313mzl4w4u92",
  "com.vscodium",
  "com.exafunction.windsurf",
  "dev.zed.Zed",
  "org.tabby",
  "com.jetbrains.intellij",
  "com.jetbrains.pycharm",
  "com.raphaelamorim.rio",
  "org.contourterminal.Contour",
  "com.neovide.neovide",
]);
const macFiles = new Set(["com.apple.finder"]);
const macSettings = new Set(["com.apple.systempreferences"]);
const winShell = new Set(
  "cmd.exe,powershell.exe,pwsh.exe,wt.exe,windowsterminal.exe,code.exe,cursor.exe,vscodium.exe,windsurf.exe,zed.exe,alacritty.exe,wezterm-gui.exe,warp.exe,hyper.exe,tabby.exe,idea64.exe,pycharm64.exe,conemu.exe,conemu64.exe,rio.exe,contour.exe,pterm.exe,putty.exe,puttytel.exe,mobaxterm.exe,mintty.exe,ttermpro.exe,securecrt.exe,mremoteng.exe,mlterm.exe,gvim.exe,neovide.exe,autohotkey.exe,autohotkey32.exe,autohotkey64.exe,autohotkeyu32.exe,autohotkeyu64.exe,regedit.exe".split(
    ",",
  ),
);
const winShellPackages = [
  "Microsoft.WindowsTerminal_",
  "Microsoft.WindowsTerminalPreview_",
  "Microsoft.PowerShell_",
];
const winFiles = new Set(["explorer.exe"]);
const winSettings = new Set(["systemsettings.exe"]);
const winSettingsPackages = ["windows.immersivecontrolpanel_"];
const linuxShell = new Set(
  "gnome-terminal-server,kgx,ptyxis,konsole,yakuake,xfce4-terminal,mate-terminal,lxterminal,qterminal,terminator,tilix,guake,tilda,xterm,uxterm,rxvt,urxvt,urxvtd,st,alacritty,kitty,wezterm-gui,foot,ghostty,warp,hyper,tabby,code,codium,cursor,windsurf,zed,idea,pycharm,emacs,neovide,putty,puttytel,intellij-idea-community,intellij-idea-ultimate,pycharm-community,pycharm-professional,blackbox,wezterm,org.gnome.console,gnome-builder,builder,spyder,spyder3,idle,idle3,idle-python,thonny,jupyter-qtconsole,sakura,terminology,roxterm,cool-retro-term,contour,rio,autokey-gtk,autokey-qt,gnome-session-properties,mate-session-properties,xfce4-session-settings,lxqt-config-session,dconf-editor,deepin-terminal,io.elementary.terminal,mlterm,zutty,pterm".split(
    ",",
  ),
);
const linuxFiles = new Set([
  "nautilus",
  "dolphin",
  "nemo",
  "thunar",
  "caja",
  "pcmanfm",
  "pcmanfm-qt",
]);
const linuxSettings = new Set([
  "gnome-control-center",
  "systemsettings",
  "cinnamon-settings",
  "xfce4-settings-manager",
  "mate-control-center",
  "gnome-tweaks",
  "org.gnome.tweaks",
]);

const baseName = (id: string) => id.toLowerCase().split(/[\\/]/).pop() ?? "";

/** A Linux program's names to match: itself, without a version, a snap's or flatpak's short name. */
function linuxNames(id: string) {
  const base = baseName(id);
  const names = [base, base.replace(/[-.]?\d+(\.\d+)*$/, "")];
  const lower = id.toLowerCase();
  if (lower.startsWith("/snap/bin/") && base.includes("."))
    names.push(base.split(".")[0]);
  else if (lower.includes("/exports/bin/") && base.includes("."))
    names.push(base.split(".").pop() ?? base);
  return names;
}

/** What an app can reach beyond itself, or null for an ordinary app. */
export function sentinelKind(app: ComputerUseAppRef): SentinelKind | null {
  const id = app.id;
  if (macShell.has(id)) return "shell";
  if (macFiles.has(id)) return "filesystem";
  if (macSettings.has(id)) return "system_settings";
  if (winShellPackages.some((prefix) => id.startsWith(prefix))) return "shell";
  if (winSettingsPackages.some((prefix) => id.startsWith(prefix)))
    return "system_settings";
  // Windows ids are program names, with or without ".exe".
  const base = baseName(id);
  const exe = base.endsWith(".exe") ? base : `${base}.exe`;
  if (winShell.has(exe)) return "shell";
  if (winFiles.has(exe)) return "filesystem";
  if (winSettings.has(exe)) return "system_settings";
  for (const name of linuxNames(id)) {
    if (linuxShell.has(name)) return "shell";
    if (linuxFiles.has(name)) return "filesystem";
    if (linuxSettings.has(name)) return "system_settings";
  }
  return null;
}

export const sentinelWarnings: Record<SentinelKind, string> = {
  shell: "Can run commands on your computer",
  filesystem: "Can open, change, or delete any file, and run apps and scripts",
  system_settings: "Can change system settings",
};
