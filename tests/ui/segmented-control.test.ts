import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentedControl, thumbFrames } from "../../src/ui/SegmentedControl";

test("the thumb slides and stretches from the old segment to the new one", () => {
  assert.deepEqual(
    thumbFrames({ left: 1, width: 40 }, { left: 41, width: 80 }),
    [
      { transform: "translateX(1px) scaleX(0.5)" },
      { transform: "translateX(41px) scaleX(1)" },
    ],
  );
});

test("a segmented control is a radio group whose chosen segment takes Tab", () => {
  const html = renderToStaticMarkup(
    createElement(SegmentedControl<"day" | "week">, {
      label: "Range",
      className: "routine-segments",
      value: "week",
      segments: [
        { value: "day", label: "Day" },
        { value: "week", label: "Week" },
      ],
      onChange() {},
    }),
  );
  assert.match(html, /class="segmented routine-segments" role="radiogroup"/);
  assert.match(html, /aria-label="Range"/);
  assert.match(html, /<span class="segmented-thumb" aria-hidden="true">/);
  assert.match(
    html,
    /role="radio" aria-checked="false" tabindex="-1">Day<\/button>/,
  );
  assert.match(html, /role="radio" aria-checked="true" tabindex="0">Week/);
});
