/**
 * How far computer use may drive each app (R10 design §3.1, §6.3):
 * browsers are view-only ("read"), terminals and code editors click-only
 * ("click"), everything else fully ("full"). Some apps are never granted:
 * Claudex itself (the model must not approve its own requests), password
 * managers and the system's settings.
 *
 * Apps are matched by macOS bundle id or Windows program name, never by a
 * window title (a title is text any web page or document can choose).
 */
import type {
  ComputerUseAppRef,
  ComputerUseTier,
} from "../../shared/computer-use";

type Rule = { exact?: string[]; prefix?: string[] };

const macBrowsers: Rule = {
  exact: [
    "com.apple.safari",
    "com.apple.safaritechnologypreview",
    "org.chromium.chromium",
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
    "company.thebrowser.browser",
    "company.thebrowser.dia",
    "com.operasoftware.opera",
    "com.operasoftware.operagx",
    "com.vivaldi.vivaldi",
    "com.kagi.kagimacos",
    "app.zen-browser.zen",
    "com.duckduckgo.macos.browser",
    "ai.perplexity.comet",
    "com.openai.atlas",
    "org.torproject.torbrowser",
    "net.waterfox.waterfox",
    "io.gitlab.librewolf-community",
  ],
  prefix: ["com.google.chrome", "com.microsoft.edgemac", "com.brave.browser"],
};

const macTerminalsAndEditors: Rule = {
  exact: [
    "com.apple.terminal",
    "com.googlecode.iterm2",
    "com.mitchellh.ghostty",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "co.zeit.hyper",
    "com.github.wez.wezterm",
    "org.tabby",
    "com.microsoft.vscode",
    "com.microsoft.vscodeinsiders",
    "com.vscodium",
    "com.todesktop.230313mzl4w4u92",
    "com.exafunction.windsurf",
    "com.apple.dt.xcode",
    "com.panic.nova",
    "dev.zed.zed",
    "dev.zed.zed-preview",
    "com.google.android.studio",
    "com.apple.scripteditor2",
    "com.apple.automator",
    "com.barebones.bbedit",
  ],
  prefix: ["dev.warp.", "com.jetbrains.", "com.sublimetext."],
};

const macNever: Rule = {
  exact: [
    "dev.claudex.desktop",
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword-osx",
    "com.bitwarden.desktop",
    "org.keepassxc.keepassxc",
    "com.lastpass.lastpass",
    "com.dashlane.dashlanephonefinal",
    "com.nordsec.nordpass",
    "me.proton.pass.electron",
    "com.apple.keychainaccess",
    "com.apple.passwords",
    "com.apple.systempreferences",
    "com.apple.settings",
    "com.apple.securityagent",
  ],
  prefix: [
    "com.1password.",
    "com.bitwarden.",
    "com.lastpass.",
    "com.dashlane.",
  ],
};

const winBrowsers: Rule = {
  exact: [
    "msedge",
    "chrome",
    "chromium",
    "firefox",
    "brave",
    "opera",
    "opera_gx",
    "vivaldi",
    "arc",
    "iexplore",
    "zen",
    "librewolf",
    "waterfox",
    "comet",
  ],
};

const winTerminalsAndEditors: Rule = {
  exact: [
    "windowsterminal",
    "wt",
    "openconsole",
    "conhost",
    "cmd",
    "powershell",
    "powershell_ise",
    "pwsh",
    "wsl",
    "wslhost",
    "bash",
    "mintty",
    "alacritty",
    "wezterm-gui",
    "hyper",
    "tabby",
    "code",
    "code - insiders",
    "vscodium",
    "cursor",
    "windsurf",
    "devenv",
    "zed",
    "sublime_text",
    "studio64",
  ],
  prefix: [
    "idea",
    "pycharm",
    "webstorm",
    "rider",
    "clion",
    "goland",
    "phpstorm",
    "rubymine",
    "datagrip",
    "rustrover",
  ],
};

const winNever: Rule = {
  exact: [
    "claudex",
    "1password",
    "bitwarden",
    "keepassxc",
    "keepass",
    "lastpass",
    "dashlane",
    "nordpass",
    "proton pass",
    "systemsettings",
    "credwiz",
    "regedit",
    "mmc",
    "consent",
    "credentialuibroker",
    "lockapp",
  ],
};

const matches = (rule: Rule, key: string) =>
  (rule.exact ?? []).includes(key) ||
  (rule.prefix ?? []).some((prefix) => key.startsWith(prefix));

/** The id used for matching: a lower-case bundle id, or a program name without ".exe". */
export function appKey(id: string) {
  return id
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/** Claudex, password managers and system settings: computer use never acts on them. */
export function neverGranted(app: Pick<ComputerUseAppRef, "id" | "platform">) {
  const key = appKey(app.id);
  return app.platform === "win32"
    ? matches(winNever, key)
    : matches(macNever, key);
}

/** The most computer use may do in an app. */
export function tierFor(
  app: Pick<ComputerUseAppRef, "id" | "platform">,
): ComputerUseTier {
  const key = appKey(app.id);
  if (app.platform === "win32") {
    if (matches(winBrowsers, key)) return "read";
    if (matches(winTerminalsAndEditors, key)) return "click";
    return "full";
  }
  if (matches(macBrowsers, key)) return "read";
  if (matches(macTerminalsAndEditors, key)) return "click";
  return "full";
}

/**
 * Whether a denied list (the administrator's names or the person's apps)
 * names the app: by id or by name, ignoring case and ".exe".
 */
export function onDeniedList(
  app: Pick<ComputerUseAppRef, "id" | "name">,
  denied: readonly string[],
) {
  const keys = new Set([appKey(app.id), appKey(app.name)]);
  return denied.some((entry) => keys.has(appKey(entry)));
}

/** What each tier lets the model do, for error messages and the access card. */
export const tierLabels: Record<ComputerUseTier, string> = {
  read: "view-only",
  click: "click-only",
  full: "full access",
};
