/**
 * The About window's document (about-window.ts shows it): a static page with
 * no script of its own, whose buttons link to in-page addresses the main
 * process hears. No Electron imports, so the unit tests load it.
 */

export const aboutWindowSize = { width: 320, height: 388 };

/** The in-page addresses the page's buttons link to. */
export const aboutActions = {
  copy: "#copy",
  help: "#help",
  support: "#support",
} as const;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/** . */
export function aboutVersionText(
  version: string,
  commitHash?: string,
  channel?: "latest",
) {
  const commit =
    commitHash && commitHash !== "unknown" ? commitHash.slice(0, 6) : "Unknown";
  return `${version} (${commit}${channel ? `, ${channel}` : ""})`;
}

export function copiedAboutVersionText(
  name: string,
  version: string,
  buildDate?: Date,
) {
  return `${name} ${version} ${buildDate?.toISOString() ?? ""}`.trim();
}

/** The window's document. */
export function aboutPage(options: {
  name: string;
  version: string;
  commitHash?: string;
  channel?: "latest";
  buildDate?: Date;
  locale?: string;
  translate?: (text: string) => string;
  icon?: string;
  /** Whether Help and Get support have a page to open. */
  links: boolean;
}) {
  const name = escapeHtml(options.name);
  const translate = options.translate ?? ((text: string) => text);
  const version = aboutVersionText(
    options.version,
    options.commitHash,
    options.channel,
  );
  const versionLabel = escapeHtml(
    translate("Version {version}").replace("{version}", version),
  );
  const copyLabel = escapeHtml(
    translate("Copy version {version} to clipboard").replace(
      "{version}",
      version,
    ),
  );
  const buildDate = options.buildDate ?? new Date(0);
  const buildDateText = escapeHtml(
    buildDate.toLocaleString(options.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  );
  const button = (label: string, href: string) =>
    options.links
      ? `<a class="button" href="${href}">${escapeHtml(translate(label))}</a>`
      : `<span class="button off" aria-disabled="true">${escapeHtml(translate(label))}</span>`;
  return `<!doctype html>
<html lang="${escapeHtml(options.locale ?? "en")}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(translate("About {appName}").replace("{appName}", options.name))}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fcfcfb;
  --text-100: hsl(60 2.6% 7.6%);
  --text-300: hsl(60 2.5% 23.3%);
  --text-400: hsl(51 3.1% 43.7%);
  --rim: hsl(30 3.3% 11.8% / 15%);
  --hover: hsl(50 20.7% 88.6%);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151515;
    --text-100: hsl(48 33.3% 97.1%);
    --text-300: hsl(50 9% 73.7%);
    --text-400: hsl(48 4.8% 59.2%);
    --rim: hsl(51 16.5% 84.5% / 15%);
    --hover: #000;
  }
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; background: var(--bg); }
body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 64px;
  font: 13px/19px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
  color: var(--text-100);
  -webkit-user-select: none;
  user-select: none;
  -webkit-app-region: drag;
}
img { width: 64px; height: 64px; margin: 10px 0; }
h2 {
  margin-top: 16px;
  max-width: 95%;
  font: 500 24px/32px ui-serif, Georgia, "Times New Roman", serif;
}
.version {
  margin-top: 8px;
  font-size: 13px;
  line-height: 19px;
  color: var(--text-400);
  -webkit-app-region: no-drag;
}
.version a { color: inherit; text-decoration: none; cursor: pointer; }
.version a:hover { color: var(--text-300); }
.build-date { min-height: 24px; margin-top: 4px; color: var(--text-400); }
.actions {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  margin-top: 24px;
  padding: 0 64px;
  -webkit-app-region: no-drag;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 36px;
  white-space: nowrap;
  border-radius: 8px;
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--rim);
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  text-align: center;
  color: var(--text-100);
  text-decoration: none;
}
.button:hover { background: var(--hover); box-shadow: none; }
.button:active { transform: scale(0.985); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.button.off { opacity: 0.5; }
</style>
</head>
<body>
${options.icon ? `<img src="${options.icon}" alt="" draggable="false">` : ""}
<h2>${name}&nbsp;<em>for </em>Mac</h2>
<h3 class="version" style="font-weight: 400"><a id="version" href="${aboutActions.copy}" aria-label="${copyLabel}">${versionLabel}</a></h3>
<p class="build-date">${options.buildDate ? `<time datetime="${buildDate.toISOString()}">${buildDateText}</time>` : ""}</p>
<span id="copy-status" class="sr-only" role="status" aria-live="polite"></span>
<div class="actions">
${button("Help", aboutActions.help)}
${button("Get support", aboutActions.support)}
</div>
</body>
</html>`;
}
