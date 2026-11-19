import fs from "node:fs";

const mark = fs.readFileSync(
  new URL("../public-web/favicon.svg", import.meta.url),
  "utf8",
);
const [, viewBox] = mark.match(/viewBox="([^"]+)"/);
const paths = [...mark.matchAll(/<path d="([^"]+)"\/>/g)].map(([, d]) => d);

export const officialBrandImages = {
  "images/claude_spark_icon_clay_bg.svg": "build/icon.svg",
  "images/icon-512x512.png": "build/icon.iconset/icon_512x512.png",
};

export function brandedOfficialDocument(html) {
  return html.replace(
    "<title>Claude Frontend Development</title>",
    "<title>Claudex</title>",
  );
}

export function brandedQuickWindow(html) {
  return html.replace(
    /      <!--\s+Inlined Claude starburst logo\.[\s\S]*?      <\/div>/,
    `      <div class="app-logo" aria-hidden="true">
        <svg width="18px" height="18px" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
          ${mark.match(/<g[\s\S]*?<\/g>/)[0]}
        </svg>
      </div>`,
  );
}

export function brandedDesktopShell(text) {
  return text
    .replace("Couldn't connect to Claude", "Couldn't connect to Claudex")
    .replace('"Restart Claude"', '"Restart Claudex"')
    .replace('(0, l.useState)("Claude")', '(0, l.useState)("Claudex")');
}

function markElement(jsx, stroke) {
  return `${jsx}("g", {
    fill: "none",
    stroke: "${stroke}",
    strokeWidth: 56,
    strokeLinejoin: "round",
    children: [${paths.map((d) => `${jsx}("path", { d: ${JSON.stringify(d)} })`).join(", ")}],
  })`;
}

export function brandedOfficialLogos(name, text) {
  if (name === "shared-frame-DH1u5uQk.js") {
    return text
      .replace(/  S5 =\n    "[^"]+",\n/, "")
      .replace('gl("path", { d: S5 })', markElement("gl", "inherit"))
      .replace(
        'viewBox: "0 0 100 100",\n            width: i,',
        `viewBox: "${viewBox}",\n            width: i,`,
      )
      .replace(
        'fill: a,\n            "aria-hidden": !0,\n            children: l,',
        'stroke: a,\n            "aria-hidden": !0,\n            children: l,',
      );
  }
  if (name !== "shared-l-p-m-w-4-BkeeGGW7.js") return text;
  return text
    .replace(
      /var EH =\n[\s\S]*?  Ks = kV\(ow\),/,
      `var ow = Cu(({ variant = "lockup", height = 24, className, ...props }, ref) => {
    const lockup = variant === "lockup";
    return aC("svg", {
      ref,
      "data-cds": "ClaudeLogo",
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: lockup ? "0 0 112 24" : "0 0 84 24",
      height,
      fill: "currentColor",
      role: "img",
      "aria-label": "Claudex",
      ...props,
      className: XZ("text-primary", className),
      children: [
        lockup && It("svg", {
          width: 24,
          height: 24,
          viewBox: "${viewBox}",
          style: { color: "var(--cds-clay, #d97757)" },
          children: ${markElement("aC", "currentColor")},
        }),
        It("text", {
          x: lockup ? 30 : 2,
          y: 19,
          fontSize: 21,
          fontFamily: "Georgia, serif",
          children: "Claudex",
        }),
      ],
    });
  }),
  Ks = kV(ow),`,
    )
    .replace("`Claude ${r}`", "`Claudex ${r}`")
    .replace(
      /var f3 = Cu\(\(e, t\) => \{[\s\S]*?  go = kV\(f3\);/,
      `var f3 = Cu(({ height = 14, ...props }, ref) =>
    It("svg", {
      ref,
      "data-cds": "AnthropicLogo",
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "0 0 69 14",
      height,
      fill: "currentColor",
      role: "img",
      "aria-label": "ZecousAI",
      ...props,
      children: It("text", {
        x: 0,
        y: 11,
        fontSize: 14,
        fontFamily: "system-ui, sans-serif",
        fontWeight: 650,
        children: "ZecousAI",
      }),
    })),
  go = kV(f3);`,
    );
}
