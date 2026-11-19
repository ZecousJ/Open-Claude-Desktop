/** Measured behaviour from c9d397622-DX28hmOj:46–62,164–212,287–397.
 * Functional parameters and equations are kept separate from rendering. */
export const textureParameters = {
  cell: 6.5,
  glyph: 9,
  base: 0.26,
  rest: 0.03,
  headroom: 3,
  frameMs: 40,
  rippleFrameMs: 10,
  backoffMs: 83,
  reveal: 4,
  budget: 180,
  settle: 8,
  resume: 3,
  tapLife: 3.6,
  wakeLife: 2.4,
} as const;
export const glyphAlphabet =
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join("") +
  "·";
export const glyphLooks = {
  mixed: "ab0cAde1fEgh2iGjk3lHmn4oKpq5rMst6uRvw7xSyz8nT9eW",
  lettered: "abcd3efgRhijk7lmnAopqr0stuEvwxy5zaeKiou2gcS9",
  figured: "0a1b2C3d4e5F6g7h8i9J0k1m2N3p4q5R6s7t8U9v0w1X2y3z",
};
export type TextureLook = keyof typeof glyphLooks;
export const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
function mixHash(value: number) {
  let n = value >>> 0;
  n = Math.imul(n ^ (n >>> 16), 569420461);
  n = Math.imul(n ^ (n >>> 15), 1935289751);
  return (n ^ (n >>> 15)) >>> 0;
}
export function seededRandom(seed: number, salt: string) {
  let state = mixHash(seed);
  for (const c of salt) state = mixHash(state ^ c.charCodeAt(0));
  return () => {
    state = (state + 2654435769) >>> 0;
    return mixHash(state) / 4294967296;
  };
}
export function chooseLook(seed: number, recent: string[]): TextureLook {
  const all = Object.keys(glyphLooks) as TextureLook[];
  const unused = all.filter((k) => !recent.includes(k));
  const alternatives = all.filter((k) => k !== recent[0]);
  const pool = unused.length
    ? unused
    : alternatives.length
      ? alternatives
      : all;
  return pool[Math.floor(seededRandom(seed, "look")() * pool.length)];
}
export function windForSeed(seed: number) {
  const random = seededRandom(seed, "wind");
  const direction = random();
  const acute =
    Math.PI / 10 + (Math.PI / 4.3 - Math.PI / 10) * ((direction * 2) % 1);
  const between = (lo: number, hi: number) => lo + (hi - lo) * random();
  return {
    heading: direction < 0.5 ? acute : Math.PI - acute,
    speed: between(42, 64),
    length: between(380, 560),
    width: between(120, 190),
    bend: between(60, 110),
    bendScale: between(300, 440),
  };
}
export function textureGrid(
  deviceWidth: number,
  deviceHeight: number,
  scale: number,
) {
  if (!(deviceWidth > 0 && deviceHeight > 0 && scale > 0)) return null;
  const cellWidth = Math.max(5, Math.round(6.5 * scale));
  const cellHeight = cellWidth * 2;
  let columns = Math.ceil(deviceWidth / cellWidth),
    rows = Math.ceil(deviceHeight / cellHeight);
  if (columns < 24 || rows < 8) return null;
  const ratio = (columns * cellWidth * rows * cellHeight) / 21e6;
  if (ratio > 1) {
    columns = Math.floor(columns / Math.sqrt(ratio));
    rows = Math.floor(rows / Math.sqrt(ratio));
  }
  return {
    cellWidth,
    cellHeight,
    columns,
    rows,
    left: Math.round((deviceWidth - columns * cellWidth) / 2),
    top: Math.round((deviceHeight - rows * cellHeight) / 2),
    scale,
  };
}
export type TextureGrid = NonNullable<ReturnType<typeof textureGrid>>;
type Tap = { x: number; y: number; at: number; force: number };
type Wake = Tap & { dx: number; dy: number };
export class TextureHand {
  private taps: Tap[] = [];
  private wakes: Wake[] = [];
  private previous?: { x: number; y: number; at: number };
  private anchor?: { x: number; y: number; at: number };
  private speed = 0;
  private count = 0;
  tap(x: number, y: number, now: number) {
    const force = ++this.count % 3 === 0 ? -1.15 : 1;
    this.taps = [...this.taps.slice(-5), { x, y, at: now, force }];
  }
  move(x: number, y: number, now: number) {
    const point = { x, y, at: now };
    if (!this.previous || !this.anchor || now - this.previous.at > 0.25) {
      this.previous = this.anchor = point;
      this.speed = 0;
      return false;
    }
    const dt = Math.max(now - this.previous.at, 1 / 240);
    this.speed +=
      (Math.hypot(x - this.previous.x, y - this.previous.y) / dt - this.speed) *
      Math.min(1, dt / 0.08);
    this.previous = point;
    const distance = Math.hypot(x - this.anchor.x, y - this.anchor.y);
    if (distance < 18 || now - this.anchor.at < 0.035) return false;
    const strength = smooth((this.speed - 60) / (800 - 60));
    const from = this.anchor;
    this.anchor = point;
    if (strength < 0.04) return false;
    this.wakes = [
      ...this.wakes.slice(-47),
      {
        x: (x + from.x) / 2,
        y: (y + from.y) / 2,
        at: now,
        force: (strength * distance) / (distance + 90),
        dx: (x - from.x) / 2,
        dy: (y - from.y) / 2,
      },
    ];
    return true;
  }
  leave() {
    this.previous = undefined;
  }
  busy(now: number) {
    return (
      this.taps.some((p) => now - p.at < 3.6) ||
      this.wakes.some((p) => now - p.at < 2.4)
    );
  }
  rippling(now: number) {
    return this.taps.some((p) => now - p.at < 3.6);
  }
  frame(now: number) {
    this.taps = this.taps.filter((p) => now - p.at < 3.6);
    this.wakes = this.wakes.filter((p) => now - p.at < 2.4);
    const taps = new Float32Array(24),
      wakes = new Float32Array(192),
      ways = new Float32Array(192);
    this.taps.forEach((p, i) => taps.set([p.x, p.y, p.at, p.force], i * 4));
    let wakeCount = 0;
    this.wakes.forEach((p, index) => {
      const age = Math.max(0, now - p.at);
      const strength =
        p.force *
        Math.min(1, (index + 1 + 48 - this.wakes.length) / 8) *
        (1 - Math.exp(-age / 0.05)) *
        Math.exp(-age / 0.65);
      if (strength < 0.002) return;
      const radius = 50 + 40 * age,
        length = Math.hypot(p.dx, p.dy);
      wakes.set([p.x, p.y, strength, 1 / (radius * radius)], wakeCount * 4);
      ways.set(
        [p.dx / (length || 1), p.dy / (length || 1), length, 0],
        wakeCount * 4,
      );
      wakeCount++;
    });
    return { now, tapCount: this.taps.length, wakeCount, taps, wakes, ways };
  }
}
export type TextureTouchFrame = ReturnType<TextureHand["frame"]>;
export const textureInteractiveSelector = [
  "a,button,input,textarea,select,label,summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[draggable='true']",
  "[tabindex]:not([tabindex='-1'])",
  ..."button link textbox combobox listbox option menu menuitem tab switch checkbox radio slider dialog"
    .split(" ")
    .map((role) => `[role='${role}']`),
].join(",");

export function textureReceivesTap(
  target: Element | null,
  parent: Element,
  button: number,
) {
  if (button !== 0) return false;
  const control = target?.closest(textureInteractiveSelector);
  return !(control && control !== parent && parent.contains(control));
}
