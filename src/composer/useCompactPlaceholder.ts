import { useLayoutEffect, useState, type RefObject } from "react";

export function placeholderOverflows(
  measuredWidth: number,
  clientWidth: number,
  paddingLeft: string,
  paddingRight: string,
) {
  return (
    measuredWidth >
    clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight)
  );
}

// Fit the full placeholder before falling back.
export function useCompactPlaceholder(
  editor: RefObject<HTMLElement | null>,
  placeholder: string,
  enabled: boolean,
) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = editor.current;
    if (!element || !enabled) {
      setCompact(false);
      return;
    }
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;pointer-events:none";
    probe.setAttribute("aria-hidden", "true");
    probe.textContent = placeholder;
    element.parentElement?.append(probe);
    const measure = () => {
      const style = getComputedStyle(element);
      probe.style.font = style.font;
      probe.style.letterSpacing = style.letterSpacing;
      setCompact(
        placeholderOverflows(
          probe.getBoundingClientRect().width,
          element.clientWidth,
          style.paddingLeft,
          style.paddingRight,
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) measure();
    });
    return () => {
      live = false;
      observer.disconnect();
      probe.remove();
    };
  }, [editor, placeholder, enabled]);
  return compact;
}
