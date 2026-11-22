import { createRoot } from "react-dom/client";
import { AuthGate } from "./app/AuthGate";
import { initialLocale, setLocale } from "./i18n";
import { startDomTranslation } from "./i18n/dom";
import { loadReferenceFonts } from "./boot/reference-fonts";
import "./styles.css";
import "./boot/boot.css";

async function start() {
  document.documentElement.dataset.surface = "desktop";
  await setLocale(initialLocale());
  await loadReferenceFonts(window.desktop?.referenceFonts);
  createRoot(document.getElementById("root")!).render(<AuthGate />);
  startDomTranslation();
}

void start();
