/** The editors Open in ▸ offers. */
export type EditorKind = "vscode" | "cursor" | "zed" | "windsurf" | "xcode";
export const editorKinds: readonly EditorKind[] = [
  "vscode",
  "cursor",
  "zed",
  "windsurf",
  "xcode",
];

export interface EditorInfo {
  kind: EditorKind;
  name: string;
  installed: boolean;
  /** The app's icon, a 32px PNG data URL. */
  icon?: string;
}

/**
 * The editors a session's Open in lists: installed ones without Xcode,
 * by name; Zed has no SSH remote, so a session on an SSH host leaves it out.
 */
export function menuEditors(list: EditorInfo[], ssh: boolean) {
  return list
    .filter(
      (e) => e.installed && e.kind !== "xcode" && !(ssh && e.kind === "zed"),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A path for an editor URL: only slashes stay unescaped; a path that doesn't survive the round trip is refused. */
export function editorUriPath(file: string) {
  const encoded = encodeURIComponent(file).replace(/%2F/g, "/");
  if (decodeURIComponent(encoded) !== file || /["\s<>|^&]/.test(encoded))
    throw Error("This path can't be opened in an editor.");
  return encoded;
}

/**
 * The URL that opens `folder` in the editor: a local folder as
 * `<scheme>file/<path>`, one on an SSH host as a VS Code remote. `windows`: a
 * local Windows path, written with forward slashes.
 */
export function editorUrl(
  protocol: string,
  folder: string,
  ssh?: { destination: string; port?: number },
  windows = false,
) {
  if (ssh) {
    if (!/^[A-Za-z0-9.@_:-]+$/.test(ssh.destination))
      throw Error("This SSH host can't be opened in an editor.");
    const absolute = folder.startsWith("/") ? folder : `/${folder}`;
    // A remote path takes no %, #, ? or backslash (the original refuses them).
    if (/[%#?\\]/.test(absolute))
      throw Error("This path can't be opened in an editor.");
    return `${protocol}vscode-remote/ssh-remote+${ssh.destination}${ssh.port ? `:${ssh.port}` : ""}${editorUriPath(absolute)}`;
  }
  return `${protocol}file/${editorUriPath(windows ? folder.replace(/\\/g, "/") : folder)}`;
}
