import test from "node:test";
import assert from "node:assert/strict";
import { webLightPalette } from "../../scripts/vite-web-light-palette";

test("light rules take the web's inks; dark rules and other colours stay", () => {
  const css = `
:root[data-theme="light"] .a { color: #141413; background: #141413; border-color: #141413; }
:root[data-theme="light"] .b { color: #4c4b4a; }
:root[data-theme="light"] .c { color: #82817f; background: #82817f; }
:root:not([data-theme="light"]) .d { color: #141413; }
.e { color: #141413; }
@media (max-width: 600px) { :root[data-theme="light"] .f { color: #6b6a66; background: #fff; } }
`;
  const out = webLightPalette(css);
  // The ink, in text and buttons; not in borders.
  assert.match(
    out,
    /\.a \{ color:\s*#0b0b0b; background:\s*#0b0b0b; border-color: #141413;/,
  );
  assert.match(out, /\.b \{ color:\s*#52514e;/);
  // Muted text becomes the web's muted; a muted background is not text.
  assert.match(out, /\.c \{ color:\s*#898781; background:\s*#82817f;/);
  // Dark rules and rules without a theme are untouched.
  assert.match(out, /\.d \{ color: #141413; \}/);
  assert.match(out, /\.e \{ color: #141413; \}/);
  assert.match(out, /\.f \{ color:\s*#52514e; background:\s*#fff;/);
});
