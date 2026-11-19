/**
 * The working mark's sprite sheets (live desktop 2.42304.2, the clay
 * "working mark": c8677db5f's SHEETS and SHEET_URLS): each sheet is a strip
 * of 48px frames played at 30 fps; a body comes in, loops and goes out, and
 * "grow" opens it from a single dot. "seams" are loop frames where another
 * body may take over; "rest" is the still frame under reduced motion. The
 * original's "sphere" body is "default", and "compose" is its "quill".
 * Loaded on first use, so the sheets stay out of the first load.
 */
export const sheetFrame = 48;
export const frameMs = 1000 / 30;

export interface SheetInfo {
  frames: number;
  seams?: number[];
  rest?: number;
}

export const sheets: Record<string, SheetInfo> = {
  "blocked.in": { frames: 16 },
  "blocked.loop": { frames: 30, rest: 0 },
  "blocked.out": { frames: 16 },
  "code.in": { frames: 16 },
  "code.loop": { frames: 75, seams: [18, 37, 56], rest: 74 },
  "code.out": { frames: 9 },
  "default.in": { frames: 16 },
  "default.loop": { frames: 40, rest: 38 },
  "default.out": { frames: 14 },
  grow: { frames: 10 },
  "compose.in": { frames: 16 },
  "compose.loop": { frames: 62, rest: 49 },
  "compose.out": { frames: 12 },
  "read.in": { frames: 21 },
  "read.loop": { frames: 60, rest: 44 },
  "read.out": { frames: 19 },
  "search.in": { frames: 16 },
  "search.loop": { frames: 20, rest: 4 },
  "search.out": { frames: 14 },
  "think.in": { frames: 16 },
  "think.loop": { frames: 110, seams: [54], rest: 95 },
  "think.out": { frames: 15 },
  "write.in": { frames: 31 },
  "write.loop": { frames: 60, rest: 36 },
  "write.out": { frames: 14 },
};

export const sheetUrls: Record<string, string> = {
  "blocked.in": new URL("./sheets/blocked.in.webp", import.meta.url).href,
  "blocked.loop": new URL("./sheets/blocked.loop.webp", import.meta.url).href,
  "blocked.out": new URL("./sheets/blocked.out.webp", import.meta.url).href,
  "code.in": new URL("./sheets/code.in.webp", import.meta.url).href,
  "code.loop": new URL("./sheets/code.loop.webp", import.meta.url).href,
  "code.out": new URL("./sheets/code.out.webp", import.meta.url).href,
  "default.in": new URL("./sheets/default.in.webp", import.meta.url).href,
  "default.loop": new URL("./sheets/default.loop.webp", import.meta.url).href,
  "default.out": new URL("./sheets/default.out.webp", import.meta.url).href,
  grow: new URL("./sheets/grow.webp", import.meta.url).href,
  "compose.in": new URL("./sheets/compose.in.webp", import.meta.url).href,
  "compose.loop": new URL("./sheets/compose.loop.webp", import.meta.url).href,
  "compose.out": new URL("./sheets/compose.out.webp", import.meta.url).href,
  "read.in": new URL("./sheets/read.in.webp", import.meta.url).href,
  "read.loop": new URL("./sheets/read.loop.webp", import.meta.url).href,
  "read.out": new URL("./sheets/read.out.webp", import.meta.url).href,
  "search.in": new URL("./sheets/search.in.webp", import.meta.url).href,
  "search.loop": new URL("./sheets/search.loop.webp", import.meta.url).href,
  "search.out": new URL("./sheets/search.out.webp", import.meta.url).href,
  "think.in": new URL("./sheets/think.in.webp", import.meta.url).href,
  "think.loop": new URL("./sheets/think.loop.webp", import.meta.url).href,
  "think.out": new URL("./sheets/think.out.webp", import.meta.url).href,
  "write.in": new URL("./sheets/write.in.webp", import.meta.url).href,
  "write.loop": new URL("./sheets/write.loop.webp", import.meta.url).href,
  "write.out": new URL("./sheets/write.out.webp", import.meta.url).href,
};
