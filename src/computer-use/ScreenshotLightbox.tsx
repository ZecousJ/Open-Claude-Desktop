import { useEffect, useState } from "react";
import { Modal } from "../ui/Controls";
import type { ResultShot } from "./labels";

/** Loads a screenshot the transcript refers to; null once it was removed. */
export function useScreenshot(shot: ResultShot, size: "thumb" | "full") {
  const [url, setUrl] = useState<string | null | undefined>(
    "url" in shot ? shot.url : undefined,
  );
  const id = "id" in shot ? shot.id : undefined;
  const source = "url" in shot ? shot.url : undefined;
  useEffect(() => {
    if (!id) {
      setUrl(source);
      return;
    }
    let live = true;
    setUrl(undefined);
    // A host without computer use (the web app) has no saved screenshots.
    if (!window.desktop?.computerUseScreenshot) {
      setUrl(null);
      return;
    }
    window.desktop
      .computerUseScreenshot(id, size)
      .then((found) => live && setUrl(found))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [id, source, size]);
  return url;
}

/** A screenshot at full size, over the window (Esc or the close button closes it). */
export function ScreenshotLightbox({
  shot,
  title,
  onClose,
}: {
  shot: ResultShot;
  title: string;
  onClose: () => void;
}) {
  const url = useScreenshot(shot, "full");
  return (
    <Modal title={title} wide onClose={onClose}>
      <div className="cu-lightbox">
        {url ? (
          <img src={url} alt={title} />
        ) : (
          <p className="cu-shot-missing">
            {url === null ? "Screenshot no longer available" : "Loading…"}
          </p>
        )}
      </div>
    </Modal>
  );
}
