/**
 * The composer notices outside the app, placed where the reference captures
 * show them, for side-by-side captures at 1164×1049 (2x). The fixture bridge
 * supplies the usage status, policy and announcements; its URL parameters apply
 * (weekly=75, update=required, announcements=1 …).
 *
 * case=chat-conv|cowork-conv|chat-narrow|code-conv|code-narrow picks the frame;
 * kinds=usage,update,… (default usage) picks the notices; theme=light switches
 * the theme.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "../../src/policy/policy.css";
import "../../src/styles.css";
import "../../src/sidebar/sidebar.css";
import "../../src/composer/usage-limit-banner.css";
import { createFixtureDesktop } from "./app-fixture";
import { PolicyProvider } from "../../src/policy/PolicyContext";
import { AnnouncementsProvider } from "../../src/policy/Announcements";
import { ComposerNotices } from "../../src/policy/ComposerNotice";
import type {
  ComposerNoticeKind,
  ComposerNoticeVariant,
} from "../../src/policy/notice-content";
import type { Mode } from "../../shared/types";

const params = new URLSearchParams(location.search);
window.desktop = createFixtureDesktop({}, params);
// warn=<percent>: the administrator's warning threshold (the fixture's is
// 80); the references show 75% used, so they were taken below 75.
const warn = Number(params.get("warn"));
if (warn > 0) {
  const status = window.desktop.weeklyUsageStatus;
  window.desktop.weeklyUsageStatus = async () => {
    const value = await status();
    return value && value.state === "ok" && value.percent >= warn
      ? { ...value, warnPercent: warn, state: "warning" }
      : value;
  };
}

/** Where each reference shows the notice: its box in CSS px of a 1164×1049 window. */
const cases: Record<
  string,
  {
    mode: Mode;
    variant: ComposerNoticeVariant;
    left: number;
    top: number;
    width: number;
  }
> = {
  "chat-conv": {
    mode: "chat",
    variant: "conversation",
    left: 323,
    top: 909,
    width: 768,
  },
  "cowork-conv": {
    mode: "cowork",
    variant: "conversation",
    left: 270,
    top: 909,
    width: 546,
  },
  "chat-narrow": {
    mode: "chat",
    variant: "narrow",
    left: 270,
    top: 873,
    width: 408,
  },
  "code-conv": {
    mode: "code",
    variant: "conversation",
    left: 283,
    top: 901,
    width: 535,
  },
  "code-narrow": {
    mode: "code",
    variant: "narrow",
    left: 267,
    top: 879,
    width: 329,
  },
};
const chosen = cases[params.get("case") ?? "chat-conv"] ?? cases["chat-conv"];
const kinds = (params.get("kinds")?.split(",") ?? [
  "usage",
]) as ComposerNoticeKind[];
if (params.get("theme") === "light")
  document.documentElement.dataset.theme = "light";

async function start() {
  const fonts = (await window.desktop.referenceFonts?.()) ?? [];
  const loaded = await Promise.all(
    fonts.map(async (font) => {
      const face = new FontFace(
        font.family,
        Uint8Array.from(font.data).buffer,
        { style: font.style, weight: "300 800" },
      );
      await face.load();
      document.fonts.add(face);
      return font.family;
    }),
  );
  if (
    loaded.includes("Claudex Reference Serif") &&
    loaded.includes("Claudex Reference Sans")
  )
    document.documentElement.dataset.referenceFonts = "true";
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <PolicyProvider>
        <AnnouncementsProvider>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "var(--bg)",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: chosen.left,
                top: chosen.top,
                width: chosen.width,
              }}
            >
              <ComposerNotices
                kinds={kinds}
                variant={chosen.variant}
                mode={chosen.mode}
              />
            </div>
          </div>
        </AnnouncementsProvider>
      </PolicyProvider>
    </React.StrictMode>,
  );
}
void start();
