#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const [inputArg, outputArg, ...flags] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error(
    "Usage: node scripts/fidelity/analyze-recording.mjs recording.mov output-directory [--roi=x,y,width,height] [--extract=all|changes|none]",
  );
  process.exit(1);
}
const input = path.resolve(inputArg),
  output = path.resolve(outputArg);
const roi = flags
  .find((v) => v.startsWith("--roi="))
  ?.slice(6)
  .split(",")
  .map(Number);
const extract =
  flags.find((v) => v.startsWith("--extract="))?.slice(10) ?? "changes";
if (!["all", "changes", "none"].includes(extract))
  throw new Error("Invalid extraction mode.");
if (
  roi &&
  (roi.length !== 4 ||
    roi.some((n) => !Number.isInteger(n) || n < 0) ||
    !roi[2] ||
    !roi[3])
)
  throw new Error("ROI must be x,y,width,height in integer source pixels.");
fs.mkdirSync(output, { recursive: true });
const probe = spawnSync(
  "ffprobe",
  [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_streams",
    "-show_frames",
    "-show_entries",
    "stream=codec_name,width,height,avg_frame_rate,r_frame_rate:frame=best_effort_timestamp_time,pkt_duration_time",
    "-of",
    "json",
    input,
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
if (probe.status !== 0) throw new Error(probe.stderr || "ffprobe failed");
const metadata = JSON.parse(probe.stdout),
  stream = metadata.streams?.[0];
if (!stream) throw new Error("No video stream.");
if (roi && (roi[0] + roi[2] > stream.width || roi[1] + roi[3] > stream.height))
  throw new Error("ROI exceeds source dimensions.");
const width = roi?.[2] ?? stream.width,
  height = roi?.[3] ?? stream.height;
const pixelCount = width * height,
  frameBytes = pixelCount * 3;
const filters = roi
  ? ["-vf", `crop=${width}:${height}:${roi[0]}:${roi[1]}`]
  : [];
const processVideo = spawn(
  "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    input,
    ...filters,
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
let frameBuffer = Buffer.allocUnsafe(frameBytes),
  filled = 0,
  previous,
  index = 0,
  stderr = "";
const frames = [],
  threshold = 6;
processVideo.stderr.on("data", (chunk) => {
  stderr += chunk;
});
for await (const chunk of processVideo.stdout) {
  let cursor = 0;
  while (cursor < chunk.length) {
    const take = Math.min(frameBytes - filled, chunk.length - cursor);
    chunk.copy(frameBuffer, filled, cursor, cursor + take);
    filled += take;
    cursor += take;
    if (filled < frameBytes) continue;
    const frame = frameBuffer;
    let absoluteDifference = 0,
      changedPixels = 0,
      minX = width,
      minY = height,
      maxX = -1,
      maxY = -1;
    if (previous)
      for (let pixel = 0; pixel < pixelCount; pixel++) {
        const offset = pixel * 3;
        const r = Math.abs(frame[offset] - previous[offset]),
          g = Math.abs(frame[offset + 1] - previous[offset + 1]),
          b = Math.abs(frame[offset + 2] - previous[offset + 2]);
        absoluteDifference += r + g + b;
        if (Math.max(r, g, b) > threshold) {
          changedPixels++;
          const x = pixel % width,
            y = Math.floor(pixel / width);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    const timestamp = Number(
      metadata.frames?.[index]?.best_effort_timestamp_time,
    );
    frames.push({
      index,
      timestampSeconds: Number.isFinite(timestamp) ? timestamp : null,
      meanAbsoluteDifference: previous ? absoluteDifference / frameBytes : 0,
      changedPixelFraction: changedPixels / pixelCount,
      bounds:
        maxX < 0
          ? null
          : {
              x: minX,
              y: minY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            },
    });
    previous = frame;
    index++;
    frameBuffer = Buffer.allocUnsafe(frameBytes);
    filled = 0;
  }
}
const code = await new Promise((resolve) => {
  if (processVideo.exitCode !== null) resolve(processVideo.exitCode);
  else processVideo.once("close", resolve);
});
if (code !== 0 || filled) throw new Error(stderr || "Incomplete frame decode");
if (frames.length !== metadata.frames.length)
  throw new Error(
    `Decoded ${frames.length} frames but ffprobe reported ${metadata.frames.length}; timestamps are not aligned.`,
  );
const intervals = frames
  .slice(1)
  .map((frame, i) => frame.timestampSeconds - frames[i].timestampSeconds)
  .filter((v) => v > 0)
  .sort((a, b) => a - b);
const medianInterval = intervals[Math.floor(intervals.length / 2)] ?? 0;
const selected = new Set([0, frames.length - 1]);
for (let i = 1; i < frames.length; i++)
  if (frames[i].changedPixelFraction > 0.0005) {
    selected.add(i);
    selected.add(i - 1);
  }
const report = {
  source: input,
  sourceWidth: stream.width,
  sourceHeight: stream.height,
  roi: roi ?? null,
  codec: stream.codec_name,
  declaredFrameRate: stream.r_frame_rate,
  averageFrameRate: stream.avg_frame_rate,
  frameCount: frames.length,
  medianFrameIntervalSeconds: medianInterval,
  largeFrameGaps: frames
    .filter(
      (f, i) =>
        i > 0 &&
        f.timestampSeconds - frames[i - 1].timestampSeconds >
          medianInterval * 1.75,
    )
    .map((f) => f.index),
  pixelChangeThreshold: threshold,
  notes: [
    "Metrics cover every decoded frame, with original media timestamps.",
    "Motion bounds are evidence for inspection, not automatic proof of matching easing or UI state.",
    "Pixel change metrics include video-compression noise. Compare a documented ROI and inspect frames.",
  ],
  frames,
};
fs.writeFileSync(
  path.join(output, "frames.json"),
  JSON.stringify(report, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(output, "frames.csv"),
  "index,timestamp_seconds,mean_absolute_difference,changed_pixel_fraction,x,y,width,height\n" +
    frames
      .map((f) =>
        [
          f.index,
          f.timestampSeconds,
          f.meanAbsoluteDifference,
          f.changedPixelFraction,
          f.bounds?.x ?? "",
          f.bounds?.y ?? "",
          f.bounds?.width ?? "",
          f.bounds?.height ?? "",
        ].join(","),
      )
      .join("\n") +
    "\n",
);
if (extract !== "none") {
  const directory = path.join(output, "frames");
  fs.mkdirSync(directory, { recursive: true });
  // Compact contiguous change frames to avoid FFmpeg expression recursion limits.
  const ranges = [];
  for (const n of [...selected].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === n) last[1] = n;
    else ranges.push([n, n]);
  }
  const selection = ranges
    .map(([a, b]) => (a === b ? `eq(n,${a})` : `between(n,${a},${b})`))
    .join("+");
  const select =
    extract === "all"
      ? []
      : [
          "-vf",
          [
            ...(roi ? [`crop=${width}:${height}:${roi[0]}:${roi[1]}`] : []),
            `select='${selection}'`,
          ].join(","),
        ];
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      ...(extract === "all" ? filters : select),
      "-an",
      "-fps_mode",
      "passthrough",
      path.join(directory, "%06d.png"),
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Frame extraction failed");
  const mapping =
    extract === "all"
      ? frames.map((f) => f.index)
      : [...selected].sort((a, b) => a - b);
  fs.writeFileSync(
    path.join(output, "extracted-frames.json"),
    JSON.stringify(
      mapping.map((frameIndex, i) => ({
        file: `frames/${String(i + 1).padStart(6, "0")}.png`,
        frameIndex,
        timestampSeconds: frames[frameIndex].timestampSeconds,
      })),
      null,
      2,
    ) + "\n",
  );
}
console.log(
  JSON.stringify({
    frameCount: frames.length,
    width,
    height,
    medianIntervalSeconds: medianInterval,
    largeFrameGaps: report.largeFrameGaps.length,
    report: path.join(output, "frames.json"),
  }),
);
