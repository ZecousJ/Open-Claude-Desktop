import type { LightboxImage } from "./lightbox-model";

/*
 * The image lightbox's entry points for the rest of the app. The viewer
 * itself (Lightbox.tsx) loads on first use, so it stays out of the first
 * load; once loaded it opens at once.
 */

const load = () => import("./Lightbox");

/** Shows `images` full screen from `index`, grown out of `source`. */
export function openLightbox(
  images: LightboxImage[],
  index = 0,
  source?: HTMLElement | null,
) {
  void load().then((module) => module.openLightbox(images, index, source));
}

/**
 * Every picture under `group` matching `selector`, from the one clicked.
 * `fallbackAlt` names a picture whose thumbnail has no alt text ("Attached
 * image" for an attachment).
 */
export function openImageGroup(
  group: Element | null,
  clicked: Element,
  selector = "img",
  fallbackAlt?: string,
) {
  void load().then((module) =>
    module.openImageGroup(group, clicked, selector, fallbackAlt),
  );
}

export type { LightboxImage };
