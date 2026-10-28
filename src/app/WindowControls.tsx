import { useEffect, useRef, useState } from "react";

/**
 * Whether the window fills the work area. The main process has no event for
 * it and the page only needs the icon, so the window's own size decides
 * (a maximized window fills the screen's available area).
 */
function useMaximized() {
  const read = () =>
    window.outerWidth >= screen.availWidth - 1 &&
    window.outerHeight >= screen.availHeight - 1;
  const [maximized, setMaximized] = useState(read);
  useEffect(() => {
    const update = () => setMaximized(read());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return maximized;
}

/**
 * Minimize, maximize (restore once maximized) and close for the frameless
 * window outside macOS. The glyphs are Windows' own thin caption glyphs, 10px
 * with 1px lines, on 46px buttons.
 */
const glyph = {
  width: 10,
  height: 10,
  viewBox: "0 0 10 10",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1,
  "aria-hidden": true,
} as const;
/**
 * Whether Windows draws the caption buttons (electron/caption-overlay.ts):
 * the window controls overlay is on. Then the page keeps only their place
 * and tells the system the colours under them.
 */
function nativeCaption() {
  return Boolean(
    (navigator as { windowControlsOverlay?: { visible?: boolean } })
      .windowControlsOverlay?.visible,
  );
}

/** A computed colour as #rrggbb, or undefined when it is transparent. */
function hexColor(value: string) {
  const parts = value.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3 || (parts.length > 3 && parts[3] === 0))
    return undefined;
  return (
    "#" +
    parts
      .slice(0, 3)
      .map((n) => Math.round(n).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** The first opaque background under a point, and the page's text colour. */
function captionColors(x: number, y: number) {
  let node = document.elementFromPoint(x, y);
  let background: string | undefined;
  for (; node && !background; node = node.parentElement)
    background = hexColor(getComputedStyle(node).backgroundColor);
  background ??= hexColor(getComputedStyle(document.body).backgroundColor);
  const app = document.querySelector(".app") ?? document.body;
  const symbol = hexColor(getComputedStyle(app).color);
  return background && symbol ? { background, symbol } : undefined;
}

/** Keeps the system's caption buttons in the colours under them. */
function NativeCaption() {
  const place = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let last = "";
    const sync = () => {
      const box = place.current?.getBoundingClientRect();
      if (!box) return;
      const colors = captionColors(box.left + box.width / 2, box.top + 18);
      const key = JSON.stringify(colors);
      if (!colors || key === last) return;
      last = key;
      void window.desktop.windowAction("caption", colors).catch(() => {});
    };
    sync();
    // The theme and the window's size change it at once; the page under the
    // buttons (another view) is read again every second.
    const watch = new MutationObserver(sync);
    watch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    window.addEventListener("resize", sync);
    const timer = window.setInterval(sync, 1000);
    return () => {
      watch.disconnect();
      window.removeEventListener("resize", sync);
      window.clearInterval(timer);
    };
  }, []);
  return <div className="window-controls native" ref={place} aria-hidden />;
}

export function WindowControls() {
  const api = window.desktop;
  const maximized = useMaximized();
  if (nativeCaption()) return <NativeCaption />;
  return (
    <div className="window-controls">
      <button
        aria-label="Minimize"
        onClick={() => void api.windowAction("minimize")}
      >
        <svg {...glyph}>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void api.windowAction("maximize")}
      >
        {maximized ? (
          <svg {...glyph}>
            <path d="M2.5 2.5v-2h7v7h-2M0.5 2.5h7v7h-7z" />
          </svg>
        ) : (
          <svg {...glyph}>
            <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
          </svg>
        )}
      </button>
      <button aria-label="Close" onClick={() => void api.windowAction("close")}>
        <svg {...glyph}>
          <path d="M0 0l10 10M10 0L0 10" />
        </svg>
      </button>
    </div>
  );
}
