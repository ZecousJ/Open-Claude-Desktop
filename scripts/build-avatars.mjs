// Writes avatars/1.svg … 72.svg into public/ (desktop) and public-web/: Claudex's own abstract avatars,
// eight muted backgrounds crossed with nine shapes, each in a darker ink of
// its background. Run: node scripts/build-avatars.mjs
import fs from "node:fs";
import path from "node:path";

const backgrounds = [
  ["#E3DACC", "#8A6F4E"],
  ["#BCD1CA", "#3F6B5E"],
  ["#D8CCE6", "#5E4A80"],
  ["#F2C9B8", "#A0533A"],
  ["#C9D7EB", "#3D5A86"],
  ["#E8DFA9", "#7C6A1E"],
  ["#D9D6CF", "#57544D"],
  ["#F0C9D3", "#94485E"],
];

const shapes = [
  (ink) => `<circle cx="14" cy="14" r="6" fill="${ink}"/>`,
  (ink) =>
    `<rect x="9" y="9" width="10" height="10" rx="2" transform="rotate(45 14 14)" fill="${ink}"/>`,
  (ink) =>
    `<path d="M14 7.5 20.5 19h-13Z" fill="${ink}" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>`,
  (ink) => `<path d="M7.5 15.5a6.5 6.5 0 0 1 13 0Z" fill="${ink}"/>`,
  (ink) => `<circle cx="14" cy="14" r="5.5" stroke="${ink}" stroke-width="3"/>`,
  (ink) =>
    `<path d="M8 10h12M8 14h12M8 18h12" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`,
  (ink) =>
    [10, 18]
      .flatMap((x) =>
        [10, 18].map(
          (y) => `<circle cx="${x}" cy="${y}" r="2.4" fill="${ink}"/>`,
        ),
      )
      .join(""),
  (ink) =>
    `<path d="M14 8v12M8 14h12" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`,
  (ink) =>
    `<path d="M14 7c3 3 3 7 0 7s-3-4 0-7ZM14 21c-3-3-3-7 0-7s3 4 0 7ZM7 14c3-3 7-3 7 0s-4 3-7 0ZM21 14c-3 3-7 3-7 0s4-3 7 0Z" fill="${ink}"/>`,
];

const root = path.join(import.meta.dirname, "..");
const folders = ["public", "public-web"].map((dir) =>
  path.join(root, dir, "avatars"),
);
let n = 0;
for (const make of shapes)
  for (const [fill, ink] of backgrounds) {
    n += 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="14" fill="${fill}"/>${make(ink)}</svg>\n`;
    for (const folder of folders) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${n}.svg`), svg);
    }
  }
console.log(`wrote ${n} avatars`);
