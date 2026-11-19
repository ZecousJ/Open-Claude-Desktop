const folders = new WeakMap<object, string>();

export function pickedExtensionFolder(path: string) {
  const selection = {};
  folders.set(selection, path);
  return selection;
}

export function takePickedExtensionFolder(selection: unknown) {
  if (!selection || typeof selection !== "object") return undefined;
  const folder = folders.get(selection);
  folders.delete(selection);
  return folder;
}
