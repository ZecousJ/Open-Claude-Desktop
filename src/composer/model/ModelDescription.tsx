import { useLayoutEffect, useRef, useState } from "react";
import { useTooltip } from "../../ui/Tooltip";

/**
 * A model row's one-line description; when the line is cut, hovering it shows
 * the whole description in the app's tooltip.
 */
export function ModelDescription({ text }: { text: string }) {
  const line = useRef<HTMLElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = line.current;
    if (el) setCut(el.scrollWidth > el.clientWidth + 1);
  }, [text]);
  const { props, tooltip } = useTooltip(text, {
    placement: "right",
    size: "wrap",
    disabled: !cut,
  });
  return (
    <>
      <small ref={line} {...props}>
        {text}
      </small>
      {tooltip}
    </>
  );
}
