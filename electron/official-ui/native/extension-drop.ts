import { readPickedExtensionArchive } from "../../connectors/extension-picked-archive";

export function extensionDropPaths(paths: unknown) {
  if (!Array.isArray(paths)) throw Error("Invalid extension drop.");
  return new Set<string>(paths.filter((file): file is string =>
    typeof file === "string" && /\.(?:dxt|mcpb)$/i.test(file),
  ));
}

export function takeExtensionDropFile(files: Set<string>, file: unknown) {
  if (typeof file !== "string" || !files.delete(file))
    throw Error("Drop the extension file again.");
  return readPickedExtensionArchive(file);
}
