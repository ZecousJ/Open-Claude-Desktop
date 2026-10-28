/** The execution host advertises only the picker it actually supports. */
export type TaskFolderBrowser =
  { kind: "native" } | { kind: "execution"; root: string; initialPath: string };

export interface TaskFolderSnapshot {
  primary?: string;
  extra: string[];
  /** Absent on older hosts, or when this session cannot add folders. */
  browser?: TaskFolderBrowser;
}

/** Paths are execution-side absolute paths, canonicalized by the backend. */
export interface TaskFolderDirectory {
  path: string;
  /** Absent at the execution root: navigation cannot leave it. */
  parent?: string;
  /** Immediate child names, joined to the canonical execution-side path. */
  directories: string[];
}

export interface TaskFolderBrowserAPI {
  listTaskFolderDirectory(
    conversationId: string,
    path: string,
  ): Promise<TaskFolderDirectory>;
}

export function folderPathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function folderPathParts(value: string, separator: string) {
  const index = value.lastIndexOf(separator);
  return {
    directory: index < 0 ? "" : value.slice(0, index + 1),
    query: value.slice(index + 1),
  };
}

export function folderPathWithSeparator(path: string, separator: string) {
  return path.endsWith(separator) ? path : path + separator;
}
