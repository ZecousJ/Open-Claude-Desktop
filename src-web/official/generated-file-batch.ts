import { isOfficialUiFileReadPath } from "../../shared/official-ui-web";
import { safeFileName } from "../bridge/browser-methods";

interface BatchFile {
  orgUuid: string;
  fileUuid: string;
  filepath: string;
}

export function createGeneratedFileBatch(options: {
  organization: string;
  fetch: typeof fetch;
  download(name: string, data: Blob): void;
  current(): boolean;
  signal?: AbortSignal;
}) {
  return async (files: readonly BatchFile[]) => {
    const checkCurrent = () => {
      if (!options.current() || options.signal?.aborted)
        throw new DOMException("The account changed.", "AbortError");
    };
    checkCurrent();
    const sources = files.map(({ orgUuid, fileUuid, filepath }) => {
      const url = `/api/organizations/${orgUuid}/files/${encodeURIComponent(fileUuid)}/contents`;
      if (orgUuid !== options.organization || !isOfficialUiFileReadPath(url))
        throw Error("Choose files from the current account.");
      return { url, name: safeFileName(filepath, "attachment") };
    });
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const used = new Set<string>();
    for (const source of sources) {
      checkCurrent();
      const response = await options.fetch(source.url, { signal: options.signal });
      if (!response.ok) throw Error("A file could not be downloaded.");
      const bytes = await response.arrayBuffer();
      checkCurrent();
      const dot = source.name.lastIndexOf(".");
      const stem = dot > 0 ? source.name.slice(0, dot) : source.name;
      const extension = dot > 0 ? source.name.slice(dot) : "";
      let name = source.name;
      for (let number = 2; used.has(name.toLowerCase()); number++)
        name = `${stem} (${number})${extension}`;
      used.add(name.toLowerCase());
      zip.file(name, bytes);
    }
    const archive = await zip.generateAsync({ type: "blob" });
    checkCurrent();
    options.download("Claudex-files.zip", archive);
  };
}
