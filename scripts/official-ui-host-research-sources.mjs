import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const target = "cf454cdcb-ftQjcteO.js";
const inputHash = "594d5d454e0b509ee439c3b717bab82d65c8e8cad3df323329f6854606205370";
export const hostResearchSourcesRevision = "claudex-research-sources-v1";

export function deriveOfficialUiHostResearchSourcesModule(file, source) {
  if (file !== target) return source;
  const digest = createHash("sha256").update(source).digest("hex");
  const anchor = "        expandable: C.length > 0,";
  if (digest !== inputHash || source.split(anchor).length !== 2)
    throw Error("Pinned Research sources panel input mismatch.");
  // The Runner returns one root task. The original source list already reads
  // that task, but the progress step normally expands only for child agents.
  return source.replace(anchor,
    "        expandable: C.length > 0 || (S > 0 && ae(a.agents, m, p).length > 0),");
}

export function applyOfficialUiHostResearchSources(directory) {
  const file = path.join(directory, target);
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, deriveOfficialUiHostResearchSourcesModule(target, source));
  return { revision: hostResearchSourcesRevision };
}
