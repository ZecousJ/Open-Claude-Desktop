import type { Conversation, GeneratedFile } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";

/** Where a presented file opens; the same shape as useDesktopEvents' ArtifactPlacement. */
export interface Placement {
  surface: "artifact" | "file";
  width: number;
  keepPanel: boolean;
}

/** Chat's documents open in the artifact view at 68%, replacing a tool panel. */
const chatPlacement: Placement = {
  surface: "artifact",
  width: 68,
  keepPanel: false,
};

/**
 * Cowork's outputs open in the file viewer at 50%, as they do from the Progress
 * card's Outputs list.
 */
const coworkPlacement: Placement = {
  surface: "file",
  width: 50,
  keepPanel: false,
};

/**
 * Whether a file a reply produced opens by itself. Chat presents documents
 * (HTML and SVG); Cowork presents any output the viewer previews: text files
 * with their content, images and PDFs. Office files only join Cowork's
 * Outputs list, since the viewer has no reliable preview for them.
 */
export function presentable(file: GeneratedFile, mode: Conversation["mode"]) {
  if (file.state !== "ready") return false;
  if (mode === "chat")
    return (
      file.content !== undefined && ["html", "svg"].includes(file.language)
    );
  if (mode !== "cowork") return false;
  if (file.blob)
    return (
      Boolean(file.digest) &&
      (file.mime?.startsWith("image/") === true ||
        file.mime === "application/pdf")
    );
  return file.content !== undefined;
}

/** Tracks live notifications, not rendering: revisiting saved history must never open a pane. */
export class ArtifactPresentation {
  private conversations = new Map<
    string,
    { threadId?: string; turnId?: string; running: boolean; seen: Set<string> }
  >();
  private presented = new Set<string>();
  /** Cowork outputs produced live and not opened yet, by conversation (paths). */
  private unopened = new Map<string, { turnKey: string; paths: Set<string> }>();
  /** Turns whose Outputs section already opened itself once. */
  private expanded = new Set<string>();
  /** Conversations whose Progress card is on screen (ProgressPanel reports it). */
  private progressShown = new Map<string, number>();
  /** Conversations whose Progress card comes back when the viewer closes. */
  private restore = new Set<string>();
  /** Session-only Activity disclosure state; no file contents or preferences. */
  private activitySections = new Map<string, Record<string, boolean>>();
  private turnKey(c: Conversation) {
    return JSON.stringify([c.id, c.threadId, c.turns.at(-1)?.id]);
  }
  private fileKey(file: GeneratedFile) {
    return JSON.stringify([file.id, file.path, file.digest, file.state]);
  }
  seed(conversations: Conversation[]) {
    this.conversations.clear();
    this.presented.clear();
    this.unopened.clear();
    this.expanded.clear();
    this.restore.clear();
    this.activitySections.clear();
    for (const c of conversations) this.remember(c);
  }
  private remember(c: Conversation) {
    const turn = c.turns.at(-1);
    this.conversations.set(c.id, {
      threadId: c.threadId,
      turnId: turn?.id,
      running: turn?.status === "inProgress",
      seen: new Set(
        c.turns.flatMap((t) =>
          t.items.flatMap((i) =>
            (i.generatedFiles ?? []).map((f) => this.fileKey(f)),
          ),
        ),
      ),
    });
  }
  dismiss(c: Conversation) {
    this.presented.add(this.turnKey(c));
  }
  observe(c: Conversation, visible: boolean): GeneratedFile | undefined {
    const previous = this.conversations.get(c.id),
      turn = c.turns.at(-1);
    const sameTurn =
      previous?.threadId === c.threadId && previous?.turnId === turn?.id;
    const live =
      turn?.status === "inProgress" || (sameTurn && previous?.running);
    const fresh =
      turn?.items
        .flatMap((i) => i.generatedFiles ?? [])
        .filter((f) => !previous?.seen.has(this.fileKey(f))) ?? [];
    this.remember(c);
    if (live && c.mode === "cowork") this.noteOutputs(c, fresh);
    if (!live || !visible || this.presented.has(this.turnKey(c))) return;
    const file = fresh.find((f) => presentable(f, c.mode));
    if (file) this.presented.add(this.turnKey(c));
    return file;
  }
  /** Remembers a live Cowork turn's new outputs, for the Outputs list's marks. */
  private noteOutputs(c: Conversation, fresh: GeneratedFile[]) {
    const turnKey = this.turnKey(c);
    let entry = this.unopened.get(c.id);
    if (entry?.turnKey !== turnKey) {
      entry = { turnKey, paths: new Set() };
      this.unopened.set(c.id, entry);
    }
    for (const f of fresh)
      if (f.state === "ready") entry.paths.add(f.path);
      else entry.paths.delete(f.path);
  }
  /**
   * Where the file `observe` returned opens. Cowork never replaces a file the
   * person is viewing from elsewhere (null keeps it; the output is marked new
   * in the Outputs list instead), and an open Progress card comes back when
   * the viewer closes.
   */
  presentationFor(
    c: Conversation,
    viewing: Artifact | undefined,
  ): Placement | null {
    if (c.mode !== "cowork") return chatPlacement;
    if (viewing && (viewing.conversationId !== c.id || !viewing.sourcePath))
      return null;
    if (this.progressShown.get(c.id)) this.restore.add(c.id);
    else if (!viewing) this.restore.delete(c.id);
    return coworkPlacement;
  }
  /** The Progress card of this conversation mounted (true) or unmounted (false). */
  progressVisible(conversationId: string, shown: boolean) {
    const count =
      (this.progressShown.get(conversationId) ?? 0) + (shown ? 1 : -1);
    if (count > 0) this.progressShown.set(conversationId, count);
    else this.progressShown.delete(conversationId);
  }
  /**
   * Whether the Progress card comes back when the viewer being opened closes:
   * only when that viewer replaces it. Switching documents inside the same
   * viewer preserves that wish; another conversation or panel forgets it.
   */
  restoreProgressAfterClose(
    conversationId: string,
    replacesProgress = true,
    continuesViewer = false,
  ) {
    const restore =
      replacesProgress || (continuesViewer && this.restore.has(conversationId));
    this.restore.clear();
    if (restore) this.restore.add(conversationId);
  }
  /** Whether closing this conversation's viewer brings the Progress card back (asks once). */
  takeRestore(conversationId: string) {
    return this.restore.delete(conversationId);
  }
  activitySectionsFor(conversationId: string) {
    return this.activitySections.get(conversationId);
  }
  rememberActivitySections(
    conversationId: string,
    sections: Record<string, boolean>,
  ) {
    this.activitySections.set(conversationId, { ...sections });
  }
  /** Deletion can happen while a viewer has unmounted the Activity panel. */
  retainActivitySections(conversations: readonly Pick<Conversation, "id">[]) {
    const existing = new Set(
      conversations.map((conversation) => conversation.id),
    );
    for (const id of this.activitySections.keys())
      if (!existing.has(id)) this.activitySections.delete(id);
  }
  /** An output was opened: it is no longer new. */
  opened(conversationId: string, path: string | undefined) {
    if (path) this.unopened.get(conversationId)?.paths.delete(path);
  }
  /** The live turn's outputs that were not opened yet. */
  newOutputs(c: Conversation): ReadonlySet<string> {
    const entry = this.unopened.get(c.id);
    return entry?.turnKey === this.turnKey(c) ? entry.paths : new Set();
  }
  /**
   * Whether the Outputs section opens by itself now: once per turn, when that
   * turn has new outputs.
   */
  expandOutputs(c: Conversation) {
    if (!this.outputsPending(c)) return false;
    this.expanded.add(this.turnKey(c));
    return true;
  }
  /** Whether `expandOutputs` would open the section (asks without consuming). */
  outputsPending(c: Conversation) {
    return !this.expanded.has(this.turnKey(c)) && this.newOutputs(c).size > 0;
  }
}
