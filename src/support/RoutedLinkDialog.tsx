import { useEffect, useState } from "react";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import { formatText, useT } from "../i18n";
import { previewLinkLabel } from "../../shared/preview-link-label";

export default function RoutedLinkDialog({
  request,
  onClose,
}: {
  request: { requestId: string; url: string };
  onClose(): void;
}) {
  const t = useT();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const enable = setTimeout(() => setReady(true), 1000);
    const timeout = setTimeout(onClose, 120_000);
    return () => {
      clearTimeout(enable);
      clearTimeout(timeout);
    };
  }, [onClose]);
  return (
    <ConfirmationDialog
      confirmation={{
        title: t("Open this link in your browser?"),
        body: formatText(
          t(
            "This link is part of the previewed file. It will open in your default browser: {url}",
          ),
          { url: previewLinkLabel(request.url) },
        ),
        confirm: t("Open"),
        confirmFocus: "cancel",
        danger: true,
        action: async () => {
          if (ready)
            await window.desktop.resolveRoutedLinkConfirm(
              request.requestId,
              true,
            );
        },
      }}
      onClose={onClose}
      onError={onClose}
      confirmDisabled={!ready}
    />
  );
}
