import { artifactDownloadLimit } from "../../shared/artifact-download";

/** Native result reasons. */
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
