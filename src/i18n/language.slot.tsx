/**
 * The Language dialog (account menu → Language) and the sync that applies the
 * account's saved language. A window-level overlay loaded by src/main.tsx;
 * the dialog and its stylesheet load only when it is opened.
 */
import { Suspense, useEffect } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { useApp } from "../app/AppContext";
import { setLocale, currentLocale } from "./index";
import { openLanguageDialog, useLanguageDialog } from "./language-dialog";
import { lazyPiece } from "../ui/lazy-piece";

const LanguageDialog = lazyPiece(() => import("./LanguageDialog"));

function LanguageOverlay() {
  const app = useApp();
  const open = useLanguageDialog();
  const saved = app.snapshot.settings.locale;
  // The account's own choice wins over what this device remembered.
  useEffect(() => {
    if (saved) void setLocale(saved);
  }, [saved]);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LanguageDialog
        value={saved ?? currentLocale()}
        onClose={() => openLanguageDialog(false)}
        onChoose={(id) => {
          void setLocale(id);
          void app.updatePreference({ locale: id });
          openLanguageDialog(false);
        }}
      />
    </Suspense>
  );
}

registerOverlay("language", LanguageOverlay);
