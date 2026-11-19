import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const chatQueueModule = "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
const inputHash = "cdccb883ae355b5cee903b619b0c0aecceec169fb162888ae334d220065d844f";
const before = "    transportTakesMidTurnSends: B.current?.outcomeAcks ?? Ie,";

export function deriveOfficialChatQueue(file, source) {
  if (path.basename(file) !== chatQueueModule) return source;
  if (createHash("sha256").update(source).digest("hex") !== inputHash ||
      source.split(before).length !== 2)
    throw Error("The shared Chat transport changed; review its queue capability.");
  // The host acknowledges mutations but dispatches one Chat turn at a time on every platform.
  return source.replace(before, "    transportTakesMidTurnSends: false,");
}

export function applyOfficialChatQueue(directory) {
  const file = path.join(directory, chatQueueModule);
  fs.writeFileSync(file, deriveOfficialChatQueue(file, fs.readFileSync(file, "utf8")));
  return true;
}
