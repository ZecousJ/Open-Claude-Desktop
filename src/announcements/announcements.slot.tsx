/**
 * The announcement pop-up, a window-level overlay. Loaded by src/main.tsx
 * before the first render; the dialog and its stylesheet load only when
 * there is an announcement to show, so nothing here weighs on the first load.
 */
import { Suspense } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { useApp } from "../app/AppContext";
import { useAnnouncements } from "./useAnnouncements";
import { lazyPiece } from "../ui/lazy-piece";

const AnnouncementDialog = lazyPiece(() => import("./AnnouncementDialog"));

function AnnouncementOverlay() {
  const app = useApp();
  const { items, close } = useAnnouncements(app.accountId);
  const current = items[0];
  if (!current) return null;
  return (
    <Suspense fallback={null}>
      <AnnouncementDialog
        key={current.id}
        announcement={current}
        onClose={(action) => close(current, action)}
      />
    </Suspense>
  );
}

registerOverlay("announcements", AnnouncementOverlay);
