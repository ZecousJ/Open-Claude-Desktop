import { useLayoutEffect, useState } from "react";
import { BackIcon } from "../ui/icons";
import { useLocale } from "../i18n";
import { PluginUploadContents } from "./PluginUploadDialog";
import { usePluginOwner } from "./usePlugins";
import { customizePath } from "../web/customize-route";
import "./plugin-upload-page.css";
/** Current Customize12 page: c76f00e40:976–1195 / c6a2a31c4:628–953.
 * The transport and staged-upload cancellation are shared with Settings. */
export function PluginUploadPage({
  onBack,
  onUploaded,
  backView = "yours",
}: {
  onBack: () => void;
  onUploaded: () => void;
  backView?: "yours" | "discover";
}) {
  useLocale();
  const { scope, current, ownsAccount } = usePluginOwner();
  const [batch, setBatch] = useState(false);
  useLayoutEffect(() => setBatch(false), [scope]);
  const back = () => {
    if (current()) onBack();
  };
  return (
    <div className="plugin-upload-page">
      <div className="plugin-upload-page-column">
        <a
          className="plugin-upload-back"
          href={customizePath({ section: "plugins", view: backView })}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            back();
          }}
        >
          <BackIcon size={16} />
          {backView === "yours" ? "Your plugins" : "Plugins"}
        </a>
        <h2>{batch ? "Upload plugins" : "Upload a plugin"}</h2>
        <PluginUploadContents
          presentation="page"
          notifyCommittedAfterClose
          onClose={back}
          onUploaded={() => {
            if (ownsAccount()) onUploaded();
          }}
          onBatchChange={setBatch}
        />
      </div>
    </div>
  );
}
