/**
 * The Quick Entry composer's page (quick.html; shared/quick-entry.ts). It
 * talks only to `window.quickEntry`, which its own preload provides; the
 * page follows the app's theme through the colour scheme the app sets.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import type { QuickEntryBridge } from "../../shared/quick-entry";
import { initialLocale, setLocale } from "../i18n";
import { startDomTranslation } from "../i18n/dom";
import { QuickEntry } from "./QuickEntry";
import "./quick-entry.css";

declare global {
  interface Window {
    quickEntry?: QuickEntryBridge;
  }
}

async function start() {
  const bridge = window.quickEntry;
  if (!bridge) return;
  await setLocale(initialLocale()).catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QuickEntry bridge={bridge} />
    </React.StrictMode>,
  );
  startDomTranslation();
}
void start();
