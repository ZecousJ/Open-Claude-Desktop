/**
 * The find bar's page (find.html; shared/find-in-page.ts). It talks only
 * to `window.findBar`, which its own preload provides; the page follows
 * the app's theme through the system colour scheme the app sets.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import type { FindBarBridge } from "../../shared/find-in-page";
import { initialLocale, setLocale } from "../i18n";
import { startDomTranslation } from "../i18n/dom";
import { FindBar } from "./FindBar";
import "./find-bar.css";

declare global {
  interface Window {
    findBar?: FindBarBridge;
  }
}

async function start() {
  const bridge = window.findBar;
  if (!bridge) return;
  await setLocale(initialLocale()).catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <FindBar bridge={bridge} />
    </React.StrictMode>,
  );
  startDomTranslation();
}
void start();
