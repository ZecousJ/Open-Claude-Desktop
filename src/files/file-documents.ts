import type {
  ProjectFile,
  ProjectWriteResult,
} from "../../shared/project-files";

export const fileAutoSaveDelay = 1000; // O14/cbd02b8f2:2393,2727.
export interface FileDocumentBridge {
  readProjectFile(id: string, path: string): Promise<ProjectFile>;
  writeProjectFile?(
    id: string,
    path: string,
    text: string,
    revision: string,
  ): Promise<ProjectWriteResult>;
}
export type FileSaveProblem =
  "conflict" | "missing" | "denied" | "hook-config" | "failed";
export type FileDocument =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready";
      file: ProjectFile;
      value: string;
      saved: string;
      dirty: boolean;
      saving: boolean;
      problem?: FileSaveProblem;
      reload: number;
    };
export type ReadyFileDocument = Extract<FileDocument, { state: "ready" }>;
export type FileDocumentsSnapshot = Readonly<Record<string, FileDocument>>;

/** Per-panel/session document state. Late reads or saves cannot populate a
 * closed tab, another session or a new account. A save only clears its own text. */
export class FileDocuments {
  private current: Record<string, FileDocument> = {};
  private listeners = new Set<() => void>();
  private reads = new Map<string, number>();
  private writes = new Map<string, Promise<boolean>>();
  private writeTokens = new Map<string, symbol>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private serial = 0;
  private auto = true;
  constructor(
    readonly sessionId: string,
    private bridge: FileDocumentBridge,
  ) {}
  activate() {
    this.disposed = false;
    for (const path of Object.keys(this.current)) this.schedule(path);
  }
  snapshot = (): FileDocumentsSnapshot => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(path: string, document: FileDocument) {
    if (this.disposed) return;
    this.current = { ...this.current, [path]: document };
    for (const listener of this.listeners) listener();
  }
  private cancelTimer(path: string) {
    const timer = this.timers.get(path);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(path);
  }
  private schedule(path: string) {
    this.cancelTimer(path);
    const document = this.current[path];
    if (
      !this.auto ||
      document?.state !== "ready" ||
      !document.dirty ||
      !this.writable(path) ||
      document.problem
    )
      return;
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.save(path);
      }, fileAutoSaveDelay),
    );
  }
  setAutoSave(value: boolean) {
    this.auto = value;
    for (const path of Object.keys(this.current)) {
      this.cancelTimer(path);
      if (value) this.schedule(path);
    }
  }
  writable(path: string) {
    const d = this.current[path];
    return (
      d?.state === "ready" &&
      d.file.writable === true &&
      !!d.file.revision &&
      !!this.bridge.writeProjectFile &&
      !d.file.binary &&
      !d.file.tooLarge &&
      !d.file.invalidEncoding
    );
  }
  async open(path: string, refresh = false) {
    const previous = this.current[path];
    if (
      previous?.state === "ready" &&
      (!refresh || previous.dirty || previous.saving)
    )
      return;
    const token = ++this.serial;
    this.reads.set(path, token);
    if (previous?.state !== "ready") this.update(path, { state: "loading" });
    try {
      const file = await this.bridge.readProjectFile(this.sessionId, path);
      if (
        this.disposed ||
        this.reads.get(path) !== token ||
        !this.current[path]
      )
        return;
      const latest = this.current[path];
      if (latest?.state === "ready" && (latest.dirty || latest.saving)) return;
      const content = file.content ?? "";
      this.update(path, {
        state: "ready",
        file,
        value: content,
        saved: content,
        dirty: false,
        saving: false,
        reload:
          (previous?.state === "ready" ? previous.reload : 0) +
          (refresh ? 1 : 0),
      });
    } catch (error) {
      if (
        !this.disposed &&
        this.reads.get(path) === token &&
        this.current[path]
      )
        this.update(path, {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
    }
  }
  edit(path: string, value: string) {
    const d = this.current[path];
    if (d?.state !== "ready" || !this.writable(path) || value === d.value)
      return;
    this.update(path, {
      ...d,
      value,
      dirty: value !== d.saved,
      problem: undefined,
    });
    this.schedule(path);
  }
  async save(path: string): Promise<boolean> {
    this.cancelTimer(path);
    const pending = this.writes.get(path);
    if (pending) {
      await pending;
      const latest = this.current[path];
      return latest?.state === "ready" && latest.dirty && !latest.problem
        ? this.save(path)
        : latest?.state === "ready" && !latest.dirty;
    }
    const d = this.current[path];
    if (d?.state !== "ready") return false;
    if (!d.dirty) return true;
    if (!this.writable(path)) return false;
    const value = d.value,
      revision = d.file.revision!,
      read = this.reads.get(path);
    const writeToken = Symbol();
    this.writeTokens.set(path, writeToken);
    this.update(path, { ...d, saving: true, problem: undefined });
    const operation = (async () => {
      try {
        const result = await this.bridge.writeProjectFile!(
          this.sessionId,
          path,
          value,
          revision,
        );
        const latest = this.current[path];
        if (
          this.disposed ||
          latest?.state !== "ready" ||
          this.reads.get(path) !== read
        )
          return false;
        if (result?.status === "saved") {
          this.update(path, {
            ...latest,
            file: result.file,
            saved: value,
            dirty: latest.value !== value,
            saving: false,
            problem: undefined,
          });
          if (latest.value !== value) this.schedule(path);
          return true;
        }
        const problem: FileSaveProblem =
          result?.status === "denied"
            ? result.reason === "hook-config"
              ? "hook-config"
              : "denied"
            : result?.status === "conflict"
              ? "conflict"
              : result?.status === "missing"
                ? "missing"
                : "failed";
        this.update(path, { ...latest, saving: false, problem });
        return false;
      } catch {
        const latest = this.current[path];
        if (latest?.state === "ready" && this.reads.get(path) === read)
          this.update(path, { ...latest, saving: false, problem: "failed" });
        return false;
      }
    })();
    const write = operation.finally(() => {
      if (this.writeTokens.get(path) === writeToken) {
        this.writes.delete(path);
        this.writeTokens.delete(path);
      }
    });
    this.writes.set(path, write);
    return write;
  }
  /** Failed autosave stays stable while its error actions receive a click.
   * Retrying on blur would remove Reload/Cancel between pointerdown and click. */
  saveOnBlur(path: string): Promise<boolean> {
    const d = this.current[path];
    return d?.state === "ready" && !d.problem
      ? this.save(path)
      : Promise.resolve(false);
  }
  dirty(paths: readonly string[] = Object.keys(this.current)) {
    return paths.filter((path) => {
      const d = this.current[path];
      return d?.state === "ready" && d.dirty;
    });
  }
  async flush(paths: readonly string[] = Object.keys(this.current)) {
    for (const path of paths)
      if (this.current[path]?.state === "ready") await this.save(path);
    return this.dirty(paths).length === 0;
  }
  async settle() {
    await Promise.all([...this.writes.values()]);
  }
  revert(path: string) {
    this.cancelTimer(path);
    const d = this.current[path];
    if (d?.state === "ready")
      this.update(path, {
        ...d,
        value: d.saved,
        dirty: false,
        problem: undefined,
      });
  }
  close(path: string) {
    this.cancelTimer(path);
    this.reads.delete(path);
    const next = { ...this.current };
    delete next[path];
    this.current = next;
    for (const listener of this.listeners) listener();
  }
  dispose() {
    this.disposed = true;
    for (const path of this.timers.keys()) this.cancelTimer(path);
    this.listeners.clear();
    this.reads.clear();
    this.writes.clear();
    this.writeTokens.clear();
  }
}
