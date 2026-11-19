/**
 * The ZecousAI move dialog, a window-level overlay (shared/zecous-migration-api.ts).
 * Asked once per signed-in account when the window starts; shown while the
 * move is pending. Closing hides it until the next start; confirming moves
 * the account and it never shows again. The dialog and its stylesheet load
 * only when there is something to move.
 */
import { Suspense, useEffect, useState } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { useApp } from "../app/AppContext";
import { formatText } from "../i18n";
import type { ZecousMigration } from "../../shared/zecous-migration-api";
import { lazyPiece } from "../ui/lazy-piece";

const ZecousMigrationDialog = lazyPiece(
  () => import("./ZecousMigrationDialog"),
);

function ZecousMigrationOverlay() {
  const app = useApp();
  const [migration, setMigration] = useState<ZecousMigration>();
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setMigration(undefined);
    setClosed(false);
    if (!app.accountId) return;
    let live = true;
    Promise.resolve(window.desktop?.zecousMigration?.())
      .then((value) => live && value && setMigration(value))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.accountId]);
  if (closed || migration?.state !== "pending") return null;
  return (
    <Suspense fallback={null}>
      <ZecousMigrationDialog
        migration={migration}
        onClose={() => setClosed(true)}
        onConfirm={async () => {
          const done = await window.desktop.confirmZecousMigration();
          setMigration(done);
          // The new balance: the account's models and usage are read again,
          // so the empty-balance notices go away.
          const next = await window.desktop.refreshModels().catch(() => null);
          if (next) {
            app.setSnapshot((s) =>
              s
                ? {
                    ...s,
                    settings: next.settings,
                    modelUnavailable: next.reason,
                  }
                : s,
            );
            const provider = next.settings.providers.find(
              (p) => p.id === next.settings.activeProviderId,
            );
            if (provider?.model) {
              app.setProviderId(provider.id);
              app.setModel(provider.model);
            }
          }
          app.notify(
            formatText("Moved: {amount} added to your Claudex balance.", {
              amount: `$${done.amountUsd.toFixed(2)}`,
            }),
          );
        }}
      />
    </Suspense>
  );
}

registerOverlay("zecous-migration", ZecousMigrationOverlay);
