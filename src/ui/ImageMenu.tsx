import { t } from "../i18n";
import { Menu } from "./Menu";
import { showToast } from "./toast-store";
import { copyImage, saveImage } from "./image-operations";
import "./image-menu.css";

export default function ImageMenu({
  src,
  fileName,
  position,
  container,
  onClose,
}: {
  src: string;
  fileName?: string;
  position: { left: number; top: number };
  container?: Element;
  onClose: () => void;
}) {
  return (
    <span
      style={{ display: "contents" }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <Menu
        label="Image"
        position={position}
        width="max-content"
        className="image-context-menu"
        container={container}
        onClose={onClose}
        entries={[
          {
            label: "Copy image",
            onSelect: () => {
              void copyImage(src).then(
                () => showToast(t("Image copied to clipboard.")),
                () => showToast(t("Couldn’t copy image.")),
              );
            },
          },
          {
            label: "Save image",
            onSelect: () => {
              void saveImage(src, fileName).catch(() =>
                showToast(t("Couldn’t save image.")),
              );
            },
          },
        ]}
      />
    </span>
  );
}
