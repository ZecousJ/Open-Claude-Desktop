import type { Artifact } from "../ui/ArtifactTypes";
import { lineEdits } from "../diff/text-diff";

const linesOf = (text: string) => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized ? normalized.split("\n") : [];
};

function fallbackLines(previous: string[], lines: string[]): number[] {
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < lines.length &&
    previous[prefix] === lines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < lines.length - prefix &&
    previous[previous.length - 1 - suffix] === lines[lines.length - 1 - suffix]
  )
    suffix++;
  const oldEnd = previous.length - suffix;
  const newEnd = lines.length - suffix;
  const oldUnique = new Map<string, number>();
  const newUnique = new Map<string, number>();
  for (let index = prefix; index < oldEnd; index++)
    oldUnique.set(previous[index], oldUnique.has(previous[index]) ? -1 : index);
  for (let index = prefix; index < newEnd; index++)
    newUnique.set(lines[index], newUnique.has(lines[index]) ? -1 : index);
  const anchors: [number, number][] = [];
  for (let index = prefix; index < newEnd; index++) {
    const old = oldUnique.get(lines[index]);
    if (old !== undefined && old >= 0 && newUnique.get(lines[index]) === index)
      anchors.push([old, index]);
  }
  const tails: number[] = [];
  const parents: number[] = [];
  anchors.forEach(([old], index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (anchors[tails[middle]][0] < old) low = middle + 1;
      else high = middle;
    }
    parents[index] = low ? tails[low - 1] : -1;
    tails[low] = index;
  });
  const ordered: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = parents[index])
    ordered.push(anchors[index]);
  ordered.reverse();
  const matches = Array<number>(lines.length).fill(-1);
  for (let index = 0; index < prefix; index++) matches[index] = index;
  for (let index = 1; index <= suffix; index++)
    matches[lines.length - index] = previous.length - index;
  let last = prefix - 1;
  ordered.forEach(([old, current], index) => {
    matches[current] = old;
    for (
      let left = old - 1, right = current - 1;
      left > last &&
      right >= prefix &&
      matches[right] === -1 &&
      previous[left] === lines[right];
      left--, right--
    )
      matches[right] = left;
    const nextOld = ordered[index + 1]?.[0] ?? oldEnd;
    const nextNew = ordered[index + 1]?.[1] ?? newEnd;
    let left = old + 1;
    let right = current + 1;
    for (
      ;
      left < nextOld && right < nextNew && previous[left] === lines[right];
      left++, right++
    )
      matches[right] = left;
    last = left - 1;
  });
  return matches;
}

// Attribute unchanged lines to their earlier write, not the version selected.
export function fileLineVersions(versions: Artifact[]): number[] {
  let previous: string[] = [];
  let attribution: number[] = [];
  for (const [index, version] of versions.entries()) {
    const lines = linesOf(version.content);
    const changes = lineEdits(previous, lines);
    const next: number[] = [];
    let oldIndex = 0;
    if (changes) {
      for (const change of changes) {
        if (change.kind === "context") next.push(attribution[oldIndex]);
        else if (change.kind === "add") next.push(index + 1);
        if (change.kind !== "add") oldIndex++;
      }
    } else {
      for (const match of fallbackLines(previous, lines))
        next.push(match >= 0 ? attribution[match] : index + 1);
    }
    previous = lines;
    attribution = next;
  }
  return attribution;
}
