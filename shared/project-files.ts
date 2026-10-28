/** The Files pane's shapes (electron/project-files.ts reads them). */

export interface ProjectSearchResult {
  matches: { path: string; line: number; preview: string }[];
  truncated: boolean;
}

export interface ProjectEntry {
  name: string;
  /** Relative to the session's folder, with "/" between parts. */
  path: string;
  kind: "file" | "folder";
}

export interface ProjectFile {
  path: string;
  bytes: number;
  /** The text, when the file is text and small enough. */
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  /** The biggest file shown, for "Maximum size is {limit} MB". */
  limitBytes?: number;
  /** Hash of the exact bytes read. Required for a conditional editor save. */
  revision?: string;
  /** Actual local write capability; absent on legacy/read-only bridges. */
  writable?: boolean;
  invalidEncoding?: boolean;
}

export type ProjectWriteResult =
  | { status: "saved"; file: ProjectFile }
  | { status: "conflict"; currentRevision: string }
  | { status: "missing" }
  | {
      status: "denied";
      reason:
        "read-only" | "git-metadata" | "hook-config" | "unsupported-encoding";
    };
