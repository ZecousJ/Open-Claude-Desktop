import { initialLocale, setLocale } from "./i18n";
import { startDomTranslation } from "./i18n/dom";
import React, { lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
// Stylesheets that components import themselves. A stylesheet lands where it
// is first imported, so they are listed here, ahead of the app, to keep their
// cascade order from depending on which module imports a component first.
import "./composer/model/model-menu.css";
import "./composer/code/code-effort-slider.css";
import "./composer/composer-add-menu.css";
import "./policy/policy.css";
import "./collections/collections.css";
import { AuthGate } from "./app/AuthGate";
import { installRepeatGuard } from "./ui/repeat-guard";
import { surface } from "../shared/host";
import { parseWebRoute } from "./web/routes";
import "./styles.css";
import "./sidebar/sidebar.css";
import "./ui/menu.css";
import "./ui/sheet.css";
import "./code-home/code-home.css";
import "./composer/workspace-bar.css";
import "./composer/bypass-dialog.css";
import "./composer/usage-limit-banner.css";
import "./settings/settings.css";
import "./settings/appearance.css";
import "./settings/shared-links.css";
import "./transcript/chat-transcript.css";
import "./transcript/selection-reply.css";
import "./transcript/code-transcript.css";
import "./transcript/transcript-text-size.css";
import "./transcript/markdown-media.css";
import "./transcript/transcript-states.css";
import "./conversation/conversation-title.css";
import "./boot/boot.css";
import { lazyPiece } from "./ui/lazy-piece";
import { installEditCommands } from "./transcript/edit-commands";

if (surface === "desktop") installEditCommands(document, window.desktop);
/**
 * Round-two packages add a right panel, an overlay or a separate window's
 * title bar from their own `*.slot.ts(x)` module, which calls
 * `registerRightPanel`, `registerOverlay` or `registerConversationWindowHeader`
 * (src/app). The modules load before the first render and after every
 * stylesheet above, so their styles come last and the order above holds
 * (docs/ui-workpackages.md §9).
 */
const slotModules = import.meta.glob("./**/*.slot.{ts,tsx}");
async function loadSlots() {
  await Promise.all(
    Object.entries(slotModules).map(([name, load]) =>
      load().catch((error: unknown) =>
        console.error(
          `Slot ${name} failed to load:`,
          error instanceof Error ? error.message : String(error),
        ),
      ),
    ),
  );
}
/** Web-only rules key off this (src/styles/95-web.css). */
document.documentElement.dataset.surface = surface;
/** The web app's /downloads page stands outside the app, signed in or not. */
const DownloadsPage = lazyPiece(
  () => import("./downloads/DownloadsPage"),
  "DownloadsPage",
);
const HelpPage = lazyPiece(() => import("./help/HelpPage"), "HelpPage");
const helpPage =
  surface === "web" &&
  parseWebRoute(location.pathname, location.search).kind === "help";
const downloadsPage =
  surface === "web" &&
  parseWebRoute(location.pathname, location.search).kind === "downloads";
// The entry can be re-evaluated by Vite while its asynchronous setup is pending.
const renderer = (import.meta.hot?.data.renderer ?? { generation: 0 }) as {
  root?: Root;
  generation: number;
};
const generation = ++renderer.generation;
import.meta.hot?.dispose((data) => {
  renderer.generation++;
  data.renderer = renderer;
});
async function start() {
  // This device's last language first, so nothing flashes in English.
  await setLocale(initialLocale());
  // Native-only frame rules remain critical: load them before any root paint.
  if (surface !== "web") {
    await import("./code-home/native-code-home.css");
    await import("./sidebar/native-chat-sidebar.css");
    await import("./composer/native-chat-composer.css");
    await import("./cowork/native-chat-activity.css");
  }
  await loadSlots();
  if (generation !== renderer.generation) return;
  installRepeatGuard();
  renderer.root ??= createRoot(document.getElementById("root")!);
  renderer.root.render(
    <React.StrictMode>
      {helpPage ? (
        <Suspense fallback={null}>
          <HelpPage />
        </Suspense>
      ) : downloadsPage ? (
        <Suspense fallback={null}>
          <DownloadsPage />
        </Suspense>
      ) : (
        <AuthGate />
      )}
    </React.StrictMode>,
  );
  startDomTranslation();
}
void start();

import "./transcript/activity-motion.css";
import "./transcript/thinking-motion.css";
import "./transcript/tools/web-search.css";
import "./composer/voice/dictation.css";
import "./composer/voice/voice-mode.css";
import "./composer/voice/cowork-voice.css";
import "./composer/code/code-permission-menu.css";
import "./composer/code/code-composer-footer.css";
import "./composer/code/code-add-menu.css";
import "./composer/code/code-connectors-submenu.css";
import "./composer/code/code-slash-palette.css";
import "./composer/model/code-model-menu.css";

import "./artifacts/file-viewer.css";
import "./home/chat-home.css";
import "./ui/tooltip.css";
import "./ui/resize-handle.css";
import "./ui/segmented-control.css";
import "./incognito/incognito.css";
// Last: the web app's rules override the desktop's at equal specificity.
import "./styles/95-web.css";
import "./styles/chat-phone-parity.css";
