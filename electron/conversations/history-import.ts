import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Conversation } from "../../shared/types";
import type {
  HistoryImportResult,
  HistoryImportRun,
  HistoryRemovePreview,
  HistoryRemoveResult,
  HistorySource,
  HistorySourceProblem,
  HistorySourceScan,
} from "../../shared/history-import";
import {
  type HistoryStore,
  type SourceEntry,
  type RunEntry,
  sourcesFile,
  historyFile,
  maxSources,
  HistorySourceError,
  isDirectory,
  profileFolders,
  type SourceData,
  cache,
  readSource,
  forgetReadHistory,
} from "./history-archive";

/**
 * Importing a Claudex export or a copied data folder (Settings → Import).
 * The locations added are kept in the profile (import-sources.json), and
 * each run in the Import history (import-history.json) with the ids it
 * added, so it can be taken back. A conversation or project that is already
 * here, by id, is never copied again.
 */
export class HistoryImporter {
  constructor(private readonly store: HistoryStore) {}

  private read<T>(name: string): T[] {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(path.join(this.store.root, name), "utf8"),
      );
      return Array.isArray(value) ? (value as T[]) : [];
    } catch {
      return [];
    }
  }
  private write(name: string, value: unknown) {
    const target = path.join(this.store.root, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  private entries() {
    return this.read<SourceEntry>(sourcesFile).filter(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.path === "string" &&
        (entry.kind === "file" || entry.kind === "folder"),
    );
  }
  private runs() {
    return this.read<RunEntry>(historyFile).filter(
      (run) =>
        run &&
        typeof run.runId === "string" &&
        Array.isArray(run.conversationIds) &&
        Array.isArray(run.projectIds),
    );
  }

  private scanOf(data: SourceData): HistorySourceScan {
    const here = new Set(this.store.conversations.map((c) => c.id));
    const projects = new Set(this.store.projects.map((p) => p.id));
    return {
      conversations: data.conversations.map((c) => ({
        id: c.id,
        updatedAt: c.updatedAt,
        sizeBytes: Buffer.byteLength(JSON.stringify(c)),
        alreadyImported: here.has(c.id),
        ...(c.projectId ? { projectId: c.projectId } : {}),
      })),
      projects: data.projects.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        alreadyImported: projects.has(p.id),
      })),
    };
  }

  private async describe(entry: SourceEntry): Promise<HistorySource> {
    const source: HistorySource = {
      id: entry.id,
      kind: entry.kind,
      label: path.basename(entry.path) || entry.path,
      path: entry.path,
      scan: null,
    };
    try {
      source.scan = this.scanOf(await readSource(entry));
    } catch (error) {
      source.problem =
        error instanceof HistorySourceError ? error.problem : "unreadable";
    }
    return source;
  }

  /** The locations added so far, each with what it holds. */
  sources(): Promise<HistorySource[]> {
    return Promise.all(this.entries().map((entry) => this.describe(entry)));
  }

  /**
   * Adds a location the person picked. A problem comes back instead of a
   * source when it is this app's own data folder or holds no history.
   */
  async add(
    kind: "file" | "folder",
    picked: string,
  ): Promise<{ source: HistorySource } | { problem: HistorySourceProblem }> {
    const resolved = path.resolve(picked);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return { problem: "unreadable" };
    }
    if (kind === "folder" && !isDirectory(real))
      return { problem: "unreadable" };
    if (kind === "file" && !fs.statSync(real).isFile())
      return { problem: "unreadable" };
    const own = fs.realpathSync(this.store.root);
    if (
      kind === "folder" &&
      (real === own || profileFolders(real).some((p) => samePath(p, own)))
    )
      return { problem: "self" };
    const entries = this.entries();
    const existing = entries.find((entry) => entry.path === real);
    const entry: SourceEntry = existing ?? {
      id: createHash("sha1").update(real).digest("hex").slice(0, 16),
      kind,
      path: real,
      addedAt: Date.now(),
    };
    const source = await this.describe(entry);
    if (source.problem) return { problem: source.problem };
    if (!existing) {
      if (entries.length >= maxSources) return { problem: "unreadable" };
      this.write(sourcesFile, [...entries, entry]);
    }
    return { source };
  }

  /** Forgets a location (the original's "Remove this source"). */
  removeSource(id: string) {
    const entries = this.entries();
    const entry = entries.find((value) => value.id === id);
    if (!entry) return;
    cache.delete(entry.path);
    this.write(
      sourcesFile,
      entries.filter((value) => value.id !== id),
    );
  }

  /**
   * Copies what is new from the chosen locations: conversations updated since
   * `since` whose id is not here yet, and the projects they use or that were
   * created since. Each location that brought something becomes one entry of
   * the Import history.
   */
  async run(
    sourceIds: string[],
    since: number,
    now = Date.now(),
  ): Promise<HistoryImportResult> {
    const result: HistoryImportResult = {
      ok: true,
      imported: { conversations: 0, projects: 0 },
      skipped: 0,
      failed: 0,
    };
    const chosen = this.entries().filter((entry) =>
      sourceIds.includes(entry.id),
    );
    const runs = this.runs();
    const conversationIds = new Set(this.store.conversations.map((c) => c.id));
    const projectIds = new Set(this.store.projects.map((p) => p.id));
    for (const entry of chosen) {
      let data: SourceData;
      try {
        data = await readSource(entry);
      } catch {
        result.failed += 1;
        continue;
      }
      const added: Conversation[] = [];
      for (const conversation of data.conversations) {
        if (conversation.updatedAt < since) continue;
        if (conversationIds.has(conversation.id)) {
          result.skipped += 1;
          continue;
        }
        conversationIds.add(conversation.id);
        added.push(conversation);
      }
      const used = new Set(
        added.flatMap((c) => (c.projectId ? [c.projectId] : [])),
      );
      const projects = data.projects.filter(
        (project) =>
          !projectIds.has(project.id) &&
          (used.has(project.id) || project.createdAt >= since),
      );
      for (const project of projects) projectIds.add(project.id);
      if (!added.length && !projects.length) continue;
      for (const conversation of added) {
        // A project that is neither here nor coming along is left behind.
        if (conversation.projectId && !projectIds.has(conversation.projectId))
          delete conversation.projectId;
      }
      this.store.projects.push(...projects);
      this.store.conversations.unshift(...added);
      runs.push({
        runId: randomUUID(),
        timestamp: now,
        source: {
          label: path.basename(entry.path) || entry.path,
          kind: entry.kind,
        },
        counts: { conversations: added.length, projects: projects.length },
        conversationIds: added.map((c) => c.id),
        projectIds: projects.map((p) => p.id),
      });
      result.imported.conversations += added.length;
      result.imported.projects += projects.length;
    }
    if (result.imported.conversations || result.imported.projects) {
      this.store.flush();
      this.write(historyFile, runs);
    }
    // What was read now belongs to the store; a later scan reads it again.
    forgetReadHistory();
    result.ok = result.failed === 0 || result.imported.conversations > 0;
    return result;
  }

  /** The Import history, newest first. */
  history(): HistoryImportRun[] {
    return this.runs()
      .map(({ conversationIds: _c, projectIds: _p, ...run }) => run)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  private selected(target: string) {
    return target === "*"
      ? this.runs()
      : this.runs().filter((run) => run.runId === target);
  }

  /** What removing a run (or "*", all of them) would delete. */
  removePreview(target: string): HistoryRemovePreview {
    const preview: HistoryRemovePreview = {
      conversations: 0,
      projects: 0,
      modifiedSinceImport: 0,
    };
    for (const run of this.selected(target)) {
      for (const id of run.conversationIds) {
        const conversation = this.store.conversations.find((c) => c.id === id);
        if (!conversation) continue;
        preview.conversations += 1;
        if (conversation.updatedAt > run.timestamp)
          preview.modifiedSinceImport += 1;
      }
      preview.projects += run.projectIds.filter((id) =>
        this.store.projects.some((p) => p.id === id),
      ).length;
    }
    return preview;
  }

  /**
   * Deletes what a run added (or what every run added). A conversation that
   * is answering is left, and counted as failed; the run stays in the history
   * with what is left of it. `forget` lets the caller release what hangs on a
   * deleted conversation (terminals, ratings, folder grants).
   */
  async remove(
    target: string,
    forget: (conversationId: string) => void | Promise<void> = () => {},
  ): Promise<HistoryRemoveResult> {
    const result: HistoryRemoveResult = { removed: 0, failed: 0 };
    const kept: RunEntry[] = [];
    const targeted = new Set(this.selected(target).map((run) => run.runId));
    for (const run of this.runs()) {
      if (!targeted.has(run.runId)) {
        kept.push(run);
        continue;
      }
      const left: RunEntry = { ...run, conversationIds: [], projectIds: [] };
      for (const id of run.conversationIds) {
        const conversation = this.store.conversations.find((c) => c.id === id);
        if (!conversation) continue;
        if (conversation.turns.some((turn) => turn.status === "inProgress")) {
          result.failed += 1;
          left.conversationIds.push(id);
          continue;
        }
        await forget(id);
        this.store.conversations = this.store.conversations.filter(
          (c) => c.id !== id,
        );
        result.removed += 1;
      }
      for (const id of run.projectIds) {
        if (!this.store.projects.some((p) => p.id === id)) continue;
        this.store.projects = this.store.projects.filter((p) => p.id !== id);
        for (const conversation of this.store.conversations)
          if (conversation.projectId === id) conversation.projectId = undefined;
        result.removed += 1;
      }
      if (left.conversationIds.length) {
        left.counts = {
          conversations: left.conversationIds.length,
          projects: 0,
        };
        kept.push(left);
      }
    }
    this.store.flush();
    this.write(historyFile, kept);
    return result;
  }
}

function samePath(a: string, b: string) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}
