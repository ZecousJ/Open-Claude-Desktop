import { artifactDownloadLimit } from "../../shared/artifact-download";

/** Native result reasons (live claude.ai bundle, 2026-10-14, c432ce1d3-BOFg_sH3.js). */
export function artifactDownloadGuard() {
  let busy = false;
  return async <Result>(bytes: number, save: () => Promise<Result>) => {
    if (bytes > artifactDownloadLimit) throw new Error("too_large");
    if (busy) throw new Error("busy");
    busy = true;
    try {
      return await save();
    } finally {
      busy = false;
    }
  };
}
