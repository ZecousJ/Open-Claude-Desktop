import { Suspense, useEffect, useState } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { lazyPiece } from "../ui/lazy-piece";
import { surface } from "../../shared/host";
import { useApp } from "../app/AppContext";

const SupportBundleDialog = lazyPiece(() => import("./SupportBundleDialog"));
const RoutedLinkDialog = lazyPiece(() => import("./RoutedLinkDialog"));
const OfficeAddinDialog = lazyPiece(() => import("./OfficeAddinDialog"));

function SupportBundleOverlay() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [office, setOffice] = useState(false);
  const [request, setRequest] = useState<{ requestId: string; url: string }>();
  useEffect(
    () =>
      window.desktop.onEvent((event) => {
        if (event.type === "support-bundle-requested") setOpen(true);
        if (event.type === "routed-link-confirm")
          setRequest((current) => {
            if (current) {
              void window.desktop.resolveRoutedLinkConfirm(
                event.requestId,
                false,
              );
              return current;
            }
            return event;
          });
      }),
    [],
  );
  useEffect(() => {
    if (surface !== "desktop") return;
    void window.desktop.setRoutedLinkConfirmReady?.(true);
    return () => {
      void window.desktop.setRoutedLinkConfirmReady?.(false);
    };
  }, []);
  useEffect(() => {
    const show = () => setOpen(true);
    const showOffice = () => setOffice(true);
    window.addEventListener("claudex:support-bundle", show);
    window.addEventListener("claudex:office-addin", showOffice);
    return () => {
      window.removeEventListener("claudex:support-bundle", show);
      window.removeEventListener("claudex:office-addin", showOffice);
    };
  }, []);
  useEffect(() => {
    if (
      surface !== "desktop" ||
      !window.desktop.officeUpdateActiveConversationSummary
    )
      return;
    const active = app.active;
    const summary = active
      ? {
          conversationId: active.id,
          taskTitle: active.title,
          isStreaming: app.running,
          summary: active.turns
            .slice(-5)
            .flatMap((turn) => [
              turn.prompt,
              ...turn.items
                .filter((item) => item.type === "agentMessage")
                .map((item) => item.text ?? ""),
            ])
            .join("\n\n")
            .slice(-100_000),
        }
      : null;
    const timer = setTimeout(() => {
      void window.desktop
        .officeUpdateActiveConversationSummary(summary)
        .catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [app.active, app.running]);
  return (
    <Suspense fallback={null}>
      {open && <SupportBundleDialog onClose={() => setOpen(false)} />}
      {office && <OfficeAddinDialog onClose={() => setOffice(false)} />}
      {request && (
        <RoutedLinkDialog
          request={request}
          onClose={() => {
            void window.desktop.resolveRoutedLinkConfirm(
              request.requestId,
              false,
            );
            setRequest(undefined);
          }}
        />
      )}
    </Suspense>
  );
}

registerOverlay("support-bundle", SupportBundleOverlay);
