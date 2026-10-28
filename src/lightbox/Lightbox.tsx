import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { ChevronLeft, ChevronRight, X } from "../ui/glyphs";
import { ImageActions } from "../ui/ImageActions";
import { formatText, t } from "../i18n";
import { prefersReducedMotion } from "../ui/usePresence";
import {
  clampIndex,
  clampPan,
  clickZoom,
  containedInset,
  counterLabel,
  keyTarget,
  lightboxState,
  setLightboxState,
  subscribeLightbox,
  trackOffset,
  wheelZoom,
  zoomFrame,
  zoomTransform,
  ZOOM_DRAG_SLOP,
  ZOOM_WHEEL_LINE,
  type LightboxImage,
  type Zoom,
} from "./lightbox-model";

export type { LightboxImage } from "./lightbox-model";

/*
 * The image lightbox, after the original's: the window under 80% black with a
 * 40px blur, the picture centred at up to 70% of the height, and for several
 * pictures a carousel of 75vw slides 32px apart that slides 300ms between them,
 * its neighbours at 40% (70% on hover), with ‹ "{current} of {total}" › at the
 * bottom. Arrows, Home and End move, Escape or a click beside the picture
 * closes.
 *
 * Zoom: a click on the picture (or Enter on it) zooms it around the pointer to
 * its natural size, ctrl + wheel zooms in steps, a drag or the wheel pans; a
 * click beside it zooms back out first. A picture with a caption shows it at
 * the bottom left over a fade.
 *
 * Opened from a thumbnail, the picture grows out of it with a view transition
 * (350ms on the snap curve, its inset, corner and shadow following) and shrinks
 * back into it on close (250ms) while the thumbnail is still on screen. Without
 * a thumbnail, without view transitions or with reduced motion, the lightbox
 * fades in and out instead.
 */

const MORPH_NAME = "lightbox-image";
/** The fallback fade out (the backdrop's 200ms). */
const FADE_OUT_MS = 200;
/** How long opening waits for the full picture to decode before morphing. */
const DECODE_WAIT_MS = 100;

let root: Root | undefined;
let closing: ReturnType<typeof setTimeout> | undefined;
/** What had focus before the lightbox opened; it gets it back. */
let returnFocus: HTMLElement | null = null;

/**
 * Shows `images` full screen, starting at `index`. `source` is the
 * thumbnail that was clicked (when the images carry no `origin`), so the
 * picture can grow out of it.
 */
export function openLightbox(
  images: LightboxImage[],
  index = 0,
  source?: HTMLElement | null,
) {
  if (!images.length || typeof document === "undefined") return;
  const start = clampIndex(index, images.length);
  const list = images.map((image, i) =>
    i === start && source && !image.origin
      ? { ...image, origin: source }
      : image,
  );
  mount();
  clearTimeout(closing);
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement ? active : null;
  const open = () => setLightboxState({ images: list, index: start });
  const origin = list[start].origin;
  if (!origin || !canMorph() || !onScreen(origin)) {
    flushSync(open);
    return;
  }
  morph("open", origin, open);
}

/**
 * Opens every picture under `group` (the `img` elements matching
 * `selector`, in page order) at the one inside `clicked`, each growing out
 * of and shrinking back into its own thumbnail. For a row of thumbnails
 * whose owner keeps no list.
 */
export function openImageGroup(
  group: Element | null,
  clicked: Element,
  selector = "img",
  fallbackAlt?: string,
) {
  const pictures = [
    ...(group ?? clicked).querySelectorAll<HTMLImageElement>(selector),
  ].filter((image) => image.currentSrc || image.src);
  const chosen =
    clicked instanceof HTMLImageElement
      ? clicked
      : clicked.querySelector("img");
  const index = chosen ? pictures.indexOf(chosen) : -1;
  if (index < 0) return;
  openLightbox(
    pictures.map((image) => ({
      src: image.currentSrc || image.src,
      alt: image.alt || fallbackAlt,
      origin: image,
    })),
    index,
  );
}

/** Closes the lightbox, back into the thumbnail of the picture on screen. */
export function closeLightbox() {
  const state = lightboxState();
  if (!state || state.closing) return;
  const origin = state.images[state.index]?.origin;
  const done = () => {
    setLightboxState(undefined);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };
  if (origin && canMorph() && onScreen(origin)) {
    morph("close", origin, done);
    return;
  }
  // The fade: the overlay is drawn closing, then removed.
  setLightboxState({ ...state, closing: true });
  closing = setTimeout(done, FADE_OUT_MS);
}

function mount() {
  if (root) return;
  const host = document.createElement("div");
  host.className = "lightbox-root";
  document.body.append(host);
  const created = (root = createRoot(host));
  // Committed now, so the first opening can draw into it at once.
  flushSync(() => created.render(<LightboxHost />));
}

function canMorph() {
  return (
    typeof document.startViewTransition === "function" &&
    !prefersReducedMotion()
  );
}

function onScreen(element: HTMLElement) {
  if (!element.isConnected) return false;
  const box = element.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < innerHeight &&
    box.left < innerWidth
  );
}

function currentImage() {
  return document.querySelector<HTMLImageElement>(
    ".lightbox-slide[data-current] img",
  );
}

function setMorphName(element: HTMLElement | null, on: boolean) {
  if (!element) return;
  if (on)
    element.style.setProperty("view-transition-name", MORPH_NAME, "important");
  else element.style.removeProperty("view-transition-name");
}

/**
 * The thumbnail's corner and, for a picture letterboxed in its box, where
 * the picture sits, for the morph's first (or last) frame.
 */
function describeSource(origin: HTMLElement) {
  const style = document.documentElement.style;
  const image =
    origin instanceof HTMLImageElement ? origin : origin.querySelector("img");
  let inset: string | undefined;
  if (image && /contain|scale-down/.test(getComputedStyle(image).objectFit)) {
    const box = image.getBoundingClientRect();
    inset = containedInset(box, {
      width: image.naturalWidth,
      height: image.naturalHeight,
    });
  }
  style.setProperty("--lightbox-source-inset", inset ?? "0%");
  style.setProperty("--lightbox-source-radius", cornerOf(origin));
}

/** The nearest rounded corner at or above `element` that clips it. */
function cornerOf(element: HTMLElement) {
  let node: HTMLElement | null = element;
  for (let depth = 0; node && depth < 5; depth++) {
    const style = getComputedStyle(node);
    const clips =
      node.tagName === "IMG" ||
      style.overflow === "hidden" ||
      style.overflow === "clip";
    if (
      clips &&
      style.borderTopLeftRadius &&
      style.borderTopLeftRadius !== "0px"
    )
      return style.borderTopLeftRadius;
    node = node.parentElement;
  }
  return "8px";
}

function morph(
  kind: "open" | "close",
  origin: HTMLElement,
  update: () => void,
) {
  const html = document.documentElement;
  describeSource(origin);
  html.classList.add("lightbox-morphing");
  html.classList.toggle("lightbox-morph-closing", kind === "close");
  let target: HTMLElement | null = null;
  if (kind === "open") setMorphName(origin, true);
  else setMorphName((target = currentImage()), true);
  const transition = document.startViewTransition(async () => {
    if (kind === "open") {
      setMorphName(origin, false);
      flushSync(update);
      target = currentImage();
      if (target instanceof HTMLImageElement)
        await Promise.race([
          target.decode().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, DECODE_WAIT_MS)),
        ]);
      setMorphName(target, true);
    } else {
      setMorphName(target, false);
      flushSync(update);
      origin.style.removeProperty("visibility");
      setMorphName(origin, true);
    }
  });
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      setMorphName(target, false);
      setMorphName(origin, false);
      html.classList.remove("lightbox-morphing", "lightbox-morph-closing");
    });
}

function LightboxHost() {
  const state = useSyncExternalStore(subscribeLightbox, lightboxState);
  if (!state) return null;
  return <Lightbox key={state.images.map((image) => image.src).join("\n")} />;
}

function Lightbox() {
  const state = useSyncExternalStore(subscribeLightbox, lightboxState)!;
  const { images, index } = state;
  const many = images.length > 1;
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const zoomRef = useRef<Zoom | null>(null);
  zoomRef.current = zoom;
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    tx: number;
    ty: number;
  } | null>(null);
  const dragged = useRef(false);
  const go = (next: number) =>
    setLightboxState({ ...state, index: clampIndex(next, images.length) });
  useEffect(() => setZoom(null), [index]);
  const frameOf = (picture: HTMLImageElement | null) => {
    if (
      !picture ||
      picture.getAnimations?.().some((a) => a.playState === "running")
    )
      return null;
    return zoomFrame(
      picture.getBoundingClientRect(),
      picture.naturalWidth,
      stage.current?.getBoundingClientRect(),
    );
  };
  const toggleZoom = (
    picture: HTMLImageElement | null,
    pointer?: { clientX: number; clientY: number },
  ) => {
    if (zoomRef.current) return setZoom(null);
    const frame = frameOf(picture);
    if (frame) setZoom(clickZoom(frame, pointer));
  };
  // Ctrl + wheel zooms (and the wheel pans while zoomed); not passive, so
  // the page does not zoom or scroll under the lightbox.
  useEffect(() => {
    const box = dialog.current;
    if (!box) return;
    const wheel = (event: WheelEvent) => {
      const picture = currentImage();
      const over =
        event.target instanceof Node && !!stage.current?.contains(event.target);
      const line =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? ZOOM_WHEEL_LINE : 1;
      const page = event.deltaMode === WheelEvent.DOM_DELTA_PAGE;
      if (event.ctrlKey) {
        event.preventDefault();
        if (!over) return;
        setZoom((current) =>
          wheelZoom(
            current,
            current ? null : frameOf(picture),
            event.deltaY * line,
            event,
          ),
        );
        return;
      }
      if (!over || !zoomRef.current) return;
      event.preventDefault();
      const stepX = page ? stage.current?.clientWidth || ZOOM_WHEEL_LINE : line;
      const stepY = page
        ? stage.current?.clientHeight || ZOOM_WHEEL_LINE
        : line;
      setZoom((current) => {
        if (!current) return current;
        const tx = clampPan(current.tx - event.deltaX * stepX, current.maxTx);
        const ty = clampPan(current.ty - event.deltaY * stepY, current.maxTy);
        return tx === current.tx && ty === current.ty
          ? current
          : { ...current, tx, ty, idealTx: tx, idealTy: ty };
      });
    };
    box.addEventListener("wheel", wheel, { passive: false });
    return () => box.removeEventListener("wheel", wheel);
  }, []);
  const pointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!zoom || event.button !== 0 || drag.current) return;
    dragged.current = false;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tx: zoom.tx,
      ty: zoom.ty,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const held = drag.current;
    if (!held || !zoom || held.pointerId !== event.pointerId) return;
    const dx = event.clientX - held.startX;
    const dy = event.clientY - held.startY;
    if (!dragged.current && Math.hypot(dx, dy) < ZOOM_DRAG_SLOP) return;
    dragged.current = true;
    held.tx = clampPan(zoom.tx + dx, zoom.maxTx);
    held.ty = clampPan(zoom.ty + dy, zoom.maxTy);
    event.currentTarget.style.transform = zoomTransform({
      ...zoom,
      tx: held.tx,
      ty: held.ty,
    });
  };
  const pointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const held = drag.current;
    if (!held || held.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!dragged.current) return;
    setZoom(
      (current) =>
        current && {
          ...current,
          tx: held.tx,
          ty: held.ty,
          idealTx: held.tx,
          idealTy: held.ty,
        },
    );
    // The click that ends a drag does not zoom out.
    setTimeout(() => (dragged.current = false), 0);
  };
  const caption = images[index]?.caption;
  // The thumbnail of the picture on screen hides, so the picture reads as
  // lifted out of the page; it comes back when another is shown or on close.
  useLayoutEffect(() => {
    const origin = images[index]?.origin;
    if (!origin || state.closing) return;
    origin.style.setProperty("visibility", "hidden");
    return () => {
      origin.style.removeProperty("visibility");
    };
  }, [images, index, state.closing]);
  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
  }, []);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Nothing behind the lightbox hears its keys.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeLightbox();
      return;
    }
    if (event.key === "Tab") {
      // Focus stays in the lightbox.
      const stops = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          "button:not([aria-disabled='true'])",
        ) ?? []),
      ];
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? at <= 0
          ? stops.length - 1
          : at - 1
        : at === stops.length - 1
          ? 0
          : at + 1;
      event.preventDefault();
      stops[next]?.focus();
      return;
    }
    const target = keyTarget(event.key, index, images.length);
    if (target === undefined) return;
    event.preventDefault();
    go(target);
  };
  return (
    <div
      ref={dialog}
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      tabIndex={-1}
      data-state={state.closing ? "closed" : "open"}
      onKeyDown={keyDown}
      onClick={() => (zoom ? setZoom(null) : closeLightbox())}
    >
      <div className="lightbox-top">
        <button
          type="button"
          className="lightbox-close"
          aria-label="Close"
          onClick={(event) => {
            event.stopPropagation();
            closeLightbox();
          }}
        >
          <X size={16} />
        </button>
      </div>
      <div className="lightbox-stage" ref={stage}>
        <div
          className="lightbox-track"
          style={{ transform: trackOffset(index) }}
        >
          {images.map((image, i) => (
            <div
              key={i}
              className="lightbox-slide"
              data-current={i === index || undefined}
              aria-hidden={i !== index}
              onClick={(event) => {
                if (i === index) return;
                // A neighbour comes to the middle instead of closing.
                event.stopPropagation();
                go(i);
              }}
            >
              <ImageActions src={image.src} fileName={image.alt}>
                <img
                  src={image.src}
                  alt={image.alt ?? ""}
                  decoding={i === index ? "sync" : "async"}
                  draggable={false}
                  role={i === index ? "button" : undefined}
                  tabIndex={i === index ? 0 : undefined}
                  aria-pressed={i === index ? !!zoom : undefined}
                  aria-label={
                    i === index
                      ? image.alt
                        ? formatText("Zoom image: {name}", { name: image.alt })
                        : t("Zoom image")
                      : undefined
                  }
                  data-zoomed={(i === index && !!zoom) || undefined}
                  style={
                    i === index && zoom
                      ? { transform: zoomTransform(zoom) }
                      : undefined
                  }
                  onClick={(event) => {
                    if (i !== index) return;
                    event.stopPropagation();
                    if (dragged.current) return;
                    toggleZoom(event.currentTarget, event);
                  }}
                  onKeyDown={(event) => {
                    if (
                      i !== index ||
                      (event.key !== "Enter" && event.key !== " ")
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    toggleZoom(event.currentTarget);
                  }}
                  onPointerDown={i === index ? pointerDown : undefined}
                  onPointerMove={i === index ? pointerMove : undefined}
                  onPointerUp={pointerUp}
                  onPointerCancel={pointerUp}
                />
              </ImageActions>
            </div>
          ))}
        </div>
        {caption && <div className="lightbox-bottom-fade" />}
        {caption && (
          <bdi className="lightbox-caption" title={caption}>
            {caption}
          </bdi>
        )}
        {many && (
          <div
            className="lightbox-pager"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Previous image"
              aria-disabled={index === 0}
              onClick={() => go(index - 1)}
            >
              <ChevronLeft size={20} />
            </button>
            <span aria-live="polite" aria-atomic="true">
              {counterLabel(index, images.length)}
            </span>
            <button
              type="button"
              aria-label="Next image"
              aria-disabled={index === images.length - 1}
              onClick={() => go(index + 1)}
            >
              <ChevronRight size={20} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
