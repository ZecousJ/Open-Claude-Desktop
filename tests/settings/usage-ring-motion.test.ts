import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  beatMs,
  readLedger,
  ringBand,
  UsageRingMotion,
  UsageRingSvg,
} from "../../src/composer/UsageRingMotion";

test("the ring's bands are the original's: 75, 90 and the limit", () => {
  assert.deepEqual(
    [0, 74, 75, 89, 90, 99, 100].map(ringBand),
    [0, 0, 1, 1, 2, 2, 3],
  );
  // Each beat lasts as its last pulse ends.
  assert.deepEqual(beatMs, { 1: 2300, 2: 1450, 3: 2450 });
});

test("a window's ledger survives only until its reset", () => {
  const store = new Map<string, string>([
    [
      "claudex.usageRingMotion.acct",
      JSON.stringify({ resetsAt: 5, drawn: true, beats: [1, 9, 2] }),
    ],
  ]);
  const storage = { getItem: (key: string) => store.get(key) ?? null };
  assert.deepEqual(readLedger(storage, "acct", 5), {
    resetsAt: 5,
    drawn: true,
    beats: [1, 2],
  });
  assert.deepEqual(readLedger(storage, "acct", 6), {
    resetsAt: 6,
    drawn: false,
    beats: [],
  });
  assert.deepEqual(readLedger(undefined, "acct", 6).beats, []);
});

test("the ring draws a round-capped arc from twelve o'clock inside the motion layers", () => {
  const html = renderToStaticMarkup(
    createElement(
      UsageRingMotion,
      {
        size: 16,
        percent: 50,
        color: "var(--success)",
        ready: false,
        streaming: false,
        windowKey: "acct",
        resetsAt: 5,
      },
      createElement(UsageRingSvg, {
        size: 16,
        percent: 50,
        stroke: "var(--success)",
        trackStroke: "var(--border-strong)",
      }),
    ),
  );
  assert.match(
    html,
    /class="urm" style="--urm-size:16px;--urm-color:var\(--success\);--urm-travel:144deg;--ring-c:43\.98/,
  );
  assert.match(
    html,
    /class="urm__hover"><span class="urm__beat"><span class="urm__glow"><\/span><span class="urm__beat-glow"><\/span><span class="urm__hover-glow"><\/span><span class="urm__breath">/,
  );
  assert.match(html, /data-ring-track=""/);
  assert.match(
    html,
    /stroke-linecap="round" stroke="var\(--success\)" data-ring-arc=""/,
  );
  // Not read yet: no entrance, beat or shimmer.
  assert.doesNotMatch(html, /data-entrance|data-beat|data-shimmer/);
});
