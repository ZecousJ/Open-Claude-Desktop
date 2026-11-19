#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [videoArg, framesArg, outputArg, ...flags] = process.argv.slice(2);
if (!videoArg || !framesArg || !outputArg) {
  console.error(
    "Usage: measure-effort-track.mjs video.mov analyzed-frames.json output.json --roi=x,y,w,h --flat=x,y",
  );
  process.exit(1);
}
const option = (name) =>
  flags
    .find((flag) => flag.startsWith(`--${name}=`))
    ?.split("=")[1]
    ?.split(",")
    .map(Number);
const roi = option("roi"),
  flat = option("flat");
if (
  !roi ||
  roi.length !== 4 ||
  !flat ||
  flat.length !== 2 ||
  [...roi, ...flat].some((n) => !Number.isInteger(n)) ||
  roi.some((n) => n < 0) ||
  roi[2] <= 0 ||
  roi[3] <= 0 ||
  flat[0] < 0 ||
  flat[1] < 0 ||
  flat[0] >= roi[2] ||
  flat[1] >= roi[3]
) {
  throw new Error(
    "ROI and flat-point coordinates must be nonnegative integers within the crop.",
  );
}
const source = path.resolve(videoArg),
  analysis = JSON.parse(fs.readFileSync(framesArg, "utf8"));
if (
  analysis.source !== source ||
  roi[0] + roi[2] > analysis.sourceWidth ||
  roi[1] + roi[3] > analysis.sourceHeight
) {
  throw new Error(
    "The analyzed frame timeline must match the input recording and crop.",
  );
}
const [x, y, width, height] = roi,
  frameBytes = width * height * 3;
const ffmpeg = spawn(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    source,
    "-vf",
    `crop=w=${width}:h=${height}:x=${x}:y=${y}:exact=1`,
    "-an",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let frame = Buffer.allocUnsafe(frameBytes),
  filled = 0,
  index = 0,
  stderr = "";
const samples = [];
ffmpeg.stderr.on("data", (chunk) => {
  stderr += chunk;
});
for await (const chunk of ffmpeg.stdout) {
  let cursor = 0;
  while (cursor < chunk.length) {
    const length = Math.min(frameBytes - filled, chunk.length - cursor);
    chunk.copy(frame, filled, cursor, cursor + length);
    filled += length;
    cursor += length;
    if (filled !== frameBytes) continue;
    const flatOffset = (flat[1] * width + flat[0]) * 3;
    const flatRgb = Array.from(frame.subarray(flatOffset, flatOffset + 3));
    let count = 0,
      left = width,
      red = 0,
      green = 0,
      blue = 0;
    for (let offset = 0; offset < frameBytes; offset += 3) {
      const r = frame[offset],
        g = frame[offset + 1],
        b = frame[offset + 2];
      if (b - r > 12 && b - g > 20 && b > 65) {
        count++;
        left = Math.min(left, (offset / 3) % width);
        red += r;
        green += g;
        blue += b;
      }
    }
    samples.push({
      index,
      timestampSeconds: analysis.frames[index]?.timestampSeconds,
      flatRgb,
      purpleCount: count,
      purpleLeftmost: count ? left : null,
      purpleMeanRgb: count
        ? [red, green, blue].map((value) => Math.round(value / count))
        : null,
    });
    index++;
    frame = Buffer.allocUnsafe(frameBytes);
    filled = 0;
  }
}
const exit = await new Promise((resolve) =>
  ffmpeg.exitCode !== null
    ? resolve(ffmpeg.exitCode)
    : ffmpeg.once("close", resolve),
);
if (exit !== 0 || filled || samples.length !== analysis.frameCount)
  throw new Error(
    `Frame stream mismatch: exit=${exit}, decoded=${samples.length}, expected=${analysis.frameCount}, remainder=${filled}, stderr=${stderr.slice(-250)}`,
  );
fs.writeFileSync(
  outputArg,
  JSON.stringify(
    {
      source,
      roi,
      flat,
      purpleRule: "B-R>12, B-G>20, B>65 (RGB24)",
      frames: samples,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    frames: samples.length,
    purpleFrames: samples.filter((sample) => sample.purpleCount).length,
    output: outputArg,
  }),
);
