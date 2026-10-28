/** DOM test geometry only. These supplied rectangles exercise the real
 * fallback hook; they are not a browser text-layout or physical IME test. */
export function referenceGeometry(
  window: Window & typeof globalThis,
  document: Document,
) {
  const rect = (left: number, top: number, width: number, height = 21) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  });
  const state = { width: 334, rects: [rect(0, 0, 90)] };
  const previous = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const computed = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    writable: true,
    value: () => ({ paddingLeft: "0px", paddingRight: "0px" }),
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    ...rect(0, 0, state.width, 80),
    x: 0,
    y: 0,
    toJSON() {},
  });
  const createRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = createRange();
    range.getClientRects = () => state.rects as unknown as DOMRectList;
    return range;
  };
  return {
    state,
    rect,
    restore() {
      if (previous)
        Object.defineProperty(
          window.HTMLElement.prototype,
          "getBoundingClientRect",
          previous,
        );
      else
        Reflect.deleteProperty(
          window.HTMLElement.prototype,
          "getBoundingClientRect",
        );
      document.createRange = createRange;
      if (computed)
        Object.defineProperty(globalThis, "getComputedStyle", computed);
      else Reflect.deleteProperty(globalThis, "getComputedStyle");
    },
  };
}
