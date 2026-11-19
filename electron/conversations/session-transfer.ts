import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { z } from "zod";
import type {
  Attachment,
  Conversation,
  GeneratedFile,
  Project,
} from "../../shared/types";
import {
  convertCodeTranscript,
  hydrateCodeOutput,
} from "../official-ui/native/code-transcript";
import { GeneratedBlobs } from "../artifacts/generated-blobs";
import { storedAttachmentImage } from "../official-ui/native/code-attachments";
import { organizationUuid } from "../official-ui/api/context";
import { readClaudeTranscript } from "./claude-transcripts";
import {
  hydrateLasmImages,
  lasmMetadata,
  lasmTranscript,
  readLasmSpaces,
  readLasmTranscript,
} from "./lasm-session-transfer";

const markerName = "claude-3p-export.json";
const outputLimit = 100 * 1024 * 1024;
const markerSchema = z.object({
  kind: z.literal("claude-desktop-export"),
  version: z.number(),
  exportedAt: z.string(),
  counts: z.object({
    cowork: z.number().finite(),
    code: z.number().finite(),
    chat: z.number().finite(),
  }),
});
const recordSchema = z.object({
  sessionId: z.string().regex(/^local_[0-9a-fA-F-]{36}$/),
  cliSessionId: z.string().uuid(),
  title: z.string().optional(),
  createdAt: z.number().finite(),
  lastActivityAt: z.number().finite(),
  isArchived: z.boolean().optional(),
  sessionType: z.string().optional(),
  hostLoopMode: z.boolean().optional(),
  spaceId: z.string().optional(),
});
type SessionRecord = z.infer<typeof recordSchema>;
export interface TransferSource {
  id: string;
  label: string;
  rootPath: string;
  origin: "picked" | "bundle";
}
interface SourceSession {
  kind: Conversation["mode"];
  record: SessionRecord;
  accountId: string;
  transcript: Buffer;
  outputs: Map<string, Buffer>;
  decoded: ReturnType<typeof readClaudeTranscript>;
  space?: { id: string; name: string };
}
interface Source {
  descriptor: TransferSource;
  sessions: SourceSession[];
}
interface ImportRun {
  runId: string;
  timestamp: number;
  source: "local3PBundle" | "local1P";
  conversationIds: string[];
  projectIds: string[];
  counts: {
    sessions: number;
    spaces: number;
    attachments: number;
    skipped: number;
  };
}
export type TransferProgress = (
  kind: "import" | "export",
  phase: string,
  done: number,
  total: number,
) => void;
export interface SessionTransferOptions {
  root: string;
  accountId: string;
  appVersion: string;
  conversations(): Conversation[];
  projects(): Project[];
  assertCurrent(): void;
  importConversations(conversations: Conversation[], projects: Project[]): void;
  saveConversation(conversation: Conversation): void | Promise<void>;
  removeConversations(ids: Set<string>, projects: Set<string>): Promise<void>;
  provider(): { id: string; model: string };
  storeImage(name: string, data: Buffer): Attachment;
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function safeEntry(name: string) {
  if (
    path.posix.isAbsolute(name) ||
    name.includes("\\") ||
    name.split("/").some((p) => p === ".." || p === ".")
  )
    throw Error("ZIP_UNREADABLE");
  return name;
}
function outputName(file: GeneratedFile) {
  const stored = file.path.replaceAll("\\", "/");
  const at = stored.indexOf("/outputs/");
  return safeEntry(
    at === -1 ? file.name : stored.slice(at + "/outputs/".length),
  );
}
function sessionRecord(conversation: Conversation): SessionRecord {
  const id = conversation.id.replace(/^claude-ai:/, "");
  return recordSchema.parse({
    sessionId: `local_${id}`,
    cliSessionId: id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    lastActivityAt: conversation.updatedAt,
    isArchived: conversation.archived,
    ...(conversation.mode !== "code"
      ? lasmMetadata(
          conversation,
          conversation.projectId
            ? conversation.importedSessionSpace?.id
            : undefined,
        )
      : {}),
  });
}

function localSessionState(conversation: Conversation, record: SessionRecord) {
  return {
    capturedAt: new Date().toISOString(),
    sessionId: record.sessionId,
    cliSessionId: record.cliSessionId,
    sidebarShownState: null,
    isRunning: conversation.turns.some((turn) => turn.status === "inProgress"),
    hasPendingPermission: null,
    hasLiveWorkflows: null,
    hasBackgroundWork: null,
    wakesSoon: null,
    hasBackgroundActivity: null,
    activeBackgroundTasks: null,
    pendingEchoUuids: null,
    pendingEchoAgesMs: null,
    awaitingTurnResult: null,
    awaitingTurnResultAgeMs: null,
    cliLastTurnMessageWasResult: null,
    cliAtTurnBoundaryHint: null,
    interruptResultPendingSince: null,
    interruptResultPendingCycleArmed: null,
    cliProvablyIdle: null,
    inputStreamHasPending: null,
    nextCycleUuid: null,
    hasPendingCycle: null,
    pendingCycleUserMessageUuid: null,
    deferredSendUuids: null,
    heldSteersUuids: null,
    toolMayBeRunning: null,
    declaredToolCallIds: null,
  };
}
export class SessionTransfer {
  private sources = new Map<string, Source>();
  private exportController?: AbortController;
  private importing = false;
  private exports = new Set<string>();
  constructor(private readonly options: SessionTransferOptions) {}

  cancelExport() {
    this.exportController?.abort();
  }
  dispose() {
    this.cancelExport();
    this.sources.clear();
    this.exports.clear();
  }
  ownsExport(file: string) {
    return this.exports.has(file);
  }
  private selected(cutoffMs: number) {
    this.options.assertCurrent();
    return this.options
      .conversations()
      .filter(
        (c) =>
          !c.incognito &&
          c.environment?.kind !== "space" &&
          c.updatedAt >= cutoffMs,
      );
  }
  private async contents(conversation: Conversation) {
    const record = sessionRecord(conversation);
    const image = (attachment: Attachment) =>
      storedAttachmentImage(this.options.root, attachment);
    const conversion =
      conversation.mode === "code"
        ? convertCodeTranscript(conversation, image)
        : lasmTranscript(conversation, image);
    const omitted = conversion.unsupported.filter(
      (kind) =>
        !["running-turn", "running-tool-call", "reasoning-summary"].includes(
          kind,
        ),
    );
    if (omitted.length)
      throw Error(`Session history cannot be exported: ${omitted.join(", ")}`);
    const outputs = new Map<string, Buffer>();
    const skippedEntries: { name: string; code: string | null }[] = [];
    const blobs = new GeneratedBlobs(this.options.root);
    for (const turn of conversation.turns)
      for (const item of turn.items)
        for (const file of item.generatedFiles ?? []) {
          if (file.state !== "ready") continue;
          const name = outputName(file);
          if (!name) continue;
          if (file.content !== undefined)
            outputs.set(name, Buffer.from(file.content));
          else if (file.blob && file.digest) {
            try {
              outputs.set(name, blobs.read(file.digest));
            } catch (error) {
              outputs.set(name, Buffer.alloc(0));
              skippedEntries.push({
                name,
                code:
                  error &&
                  typeof error === "object" &&
                  "code" in error &&
                  typeof error.code === "string"
                    ? error.code
                    : "SNAPSHOT_UNAVAILABLE",
              });
            }
          } else skippedEntries.push({ name, code: "SNAPSHOT_UNAVAILABLE" });
        }
    const names = new Map<string, string>();
    const projected = conversion.rows.map((row) => {
      if (!row.codeOutput) return row;
      const turn = conversation.turns.find(
        (turn) => turn.id === row.codeOutput?.turnId,
      );
      const item = turn?.items.find(
        (item) => item.id === row.codeOutput?.itemId,
      );
      const file = item?.generatedFiles?.find(
        (file) => file.id === row.codeOutput?.fileId,
      );
      if (!file) return hydrateCodeOutput(row);
      const name = outputName(file);
      if (typeof row.message.content !== "string")
        for (const block of row.message.content)
          if (block.type === "tool_result")
            names.set(block.tool_use_id, `/outputs/${name}`);
      return hydrateCodeOutput(row, {
        path: `/outputs/${name}`,
        size: outputs.get(name)?.length ?? file.bytes ?? 0,
        isImage: file.mime?.startsWith("image/") ?? false,
        ...(outputs.has(name) ? {} : { unavailable: true }),
      });
    });
    const rows = projected.map((row) => ({
      ...row,
      sessionId: record.cliSessionId,
      cwd: conversation.cwd,
      message: {
        ...row.message,
        content:
          typeof row.message.content === "string"
            ? row.message.content
            : row.message.content.map((block) =>
                block.type === "tool_use" && names.has(block.id)
                  ? { ...block, input: { path: names.get(block.id) } }
                  : block,
              ),
      },
    }));
    const transcript = Buffer.from(
      rows.map((row) => JSON.stringify(row)).join("\n") +
        (rows.length ? "\n" : ""),
    );
    this.options.assertCurrent();
    return { record, transcript, outputs, skippedEntries };
  }
  async preview(cutoffMs: number) {
    let sizeBytes = 0;
    const selected = this.selected(cutoffMs);
    const byKind = { cowork: 0, code: 0, chat: 0 };
    for (const conversation of selected) {
      byKind[conversation.mode]++;
      const { record, transcript, outputs } = await this.contents(conversation);
      const outputBytes = [...outputs.values()].reduce(
        (sum, data) => sum + data.length,
        0,
      );
      sizeBytes +=
        json(record).length +
        transcript.length +
        (outputBytes <= outputLimit ? outputBytes : 0);
    }
    return { count: selected.length, byKind, sizeBytes };
  }
  async export(
    cutoffMs: number,
    downloads: string,
    progress: TransferProgress = () => {},
  ) {
    this.cancelExport();
    const controller = new AbortController();
    this.exportController = controller;
    const check = () => {
      this.options.assertCurrent();
      if (controller.signal.aborted) throw Error("CANCELLED");
    };
    let temporary: string | undefined;
    try {
      const selected = this.selected(cutoffMs),
        zip = new JSZip(),
        skippedOutputs: string[] = [];
      const byKind = { cowork: 0, code: 0, chat: 0 };
      const skippedEntries: { zipPath: string; code: string | null }[] = [];
      const org = organizationUuid(this.options.accountId);
      const spaces = new Map<string, string>();
      let totalBytes = 0;
      for (const conversation of selected) {
        check();
        const {
          record,
          transcript,
          outputs,
          skippedEntries: skipped,
        } = await this.contents(conversation);
        byKind[conversation.mode]++;
        if (
          conversation.mode !== "code" &&
          conversation.projectId &&
          conversation.importedSessionSpace
        )
          spaces.set(
            conversation.importedSessionSpace.id,
            this.options
              .projects()
              .find((project) => project.id === conversation.projectId)?.name ??
              conversation.importedSessionSpace.name,
          );
        const tree =
          conversation.mode === "code"
            ? "claude-code-sessions"
            : "local-agent-mode-sessions";
        const root = `${tree}/${org}/${org}`;
        const prefix = `${root}/${record.sessionId}`;
        for (const entry of skipped)
          skippedEntries.push({
            zipPath: `${prefix}/outputs/${entry.name}`,
            code: entry.code,
          });
        const metadata = json(record);
        zip.file(`${root}/${record.sessionId}.json`, metadata);
        zip.file(
          `${prefix}/.claude/projects/claudex/${record.cliSessionId}.jsonl`,
          transcript,
        );
        totalBytes += metadata.length + transcript.length;
        const outputBytes = [...outputs.values()].reduce(
          (sum, data) => sum + data.length,
          0,
        );
        if (outputBytes > outputLimit) skippedOutputs.push(record.sessionId);
        else
          for (const [name, data] of outputs) {
            zip.file(`${prefix}/outputs/${name}`, data);
            totalBytes += data.length;
          }
        await tick();
      }
      check();
      if (spaces.size) {
        const data = json({
          spaces: [...spaces].map(([id, name]) => ({ id, name })),
        });
        zip.file(`local-agent-mode-sessions/${org}/${org}/spaces.json`, data);
        totalBytes += data.length;
      }
      const now = Date.now();
      zip.file(
        markerName,
        json({
          kind: "claude-desktop-export",
          version: 1,
          exportedAt: new Date(now).toISOString(),
          appVersion: this.options.appVersion,
          window:
            cutoffMs <= 0
              ? "all"
              : Math.round((now - cutoffMs) / 86400000) <= 45
                ? "30d"
                : "90d",
          cutoffMs,
          counts: { ...byKind, totalBytes },
          skippedOutputs,
          skippedEntries,
        }),
      );
      const names = Object.keys(zip.files).filter(
        (name) => !zip.files[name].dir,
      );
      const archive = await zip.generateAsync(
        {
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        },
        (metadata) => {
          check();
          progress(
            "export",
            "writing",
            metadata.currentFile
              ? Math.max(0, names.indexOf(metadata.currentFile))
              : names.length,
            names.length,
          );
        },
      );
      check();
      const basename = `claude-desktop-export-${new Date(now).toISOString().slice(0, 10).replaceAll("-", "")}`;
      let writtenPath = path.join(downloads, `${basename}.zip`);
      for (
        let n = 2;
        await fs.stat(writtenPath).then(
          () => true,
          () => false,
        );
        n++
      )
        writtenPath = path.join(downloads, `${basename}-${n}.zip`);
      temporary = `${writtenPath}.${randomUUID()}.partial`;
      await fs.writeFile(temporary, archive, { flag: "wx", mode: 0o600 });
      check();
      await fs.rename(temporary, writtenPath);
      temporary = undefined;
      this.exports.add(writtenPath);
      return {
        ok: true,
        writtenPath,
        count: selected.length,
        sizeBytes: archive.length,
        skippedOutputs: skippedOutputs.length,
      };
    } catch (error) {
      return {
        ok: false,
        errorCode: controller.signal.aborted
          ? "CANCELLED"
          : error instanceof Error
            ? error.message
            : "WRITE_FAILED",
      };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      if (this.exportController === controller)
        this.exportController = undefined;
    }
  }
  async share(id: string, downloads: string) {
    const conversation = this.selected(0).find(
      (c) => c.mode === "code" && c.id === id.replace(/^local_/, ""),
    );
    if (!conversation) return { success: false, error: "Session not found" };
    try {
      const { record, transcript } = await this.contents(conversation);
      const zip = new JSZip()
        .file("transcript.jsonl", transcript)
        .file(`${record.cliSessionId}.jsonl`, transcript)
        .file("metadata.json", json(record))
        .file(
          "local-session-state.json",
          json(localSessionState(conversation, record)),
        );
      const archive = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
      });
      this.options.assertCurrent();
      const filePath = path.join(downloads, `session-export-${Date.now()}.zip`);
      await fs.writeFile(filePath, archive, { flag: "wx", mode: 0o600 });
      this.exports.add(filePath);
      return { success: true, filePath, bytes: archive.length };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Export failed",
      };
    }
  }
  private async archive(file: string) {
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const marker = zip.file(markerName);
    if (!marker) throw Error("NOT_AN_EXPORT");
    const manifest = markerSchema.parse(
      JSON.parse(await marker.async("string")),
    );
    const entries = new Map<string, Buffer>();
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const name = safeEntry(entry.unsafeOriginalName ?? entry.name);
      const data = await entry.async("nodebuffer");
      total += data.length;
      if (total > 20 * 1024 ** 3) throw Error("ZIP_TOO_LARGE");
      entries.set(name, data);
    }
    return { manifest, entries };
  }
  async peek(file: string) {
    try {
      const { manifest } = await this.archive(file);
      return {
        ok: true,
        kind: "desktop3p",
        sizeBytes: (await fs.stat(file)).size,
        sessionCount:
          manifest.counts.code + manifest.counts.cowork + manifest.counts.chat,
        exportedAt: manifest.exportedAt,
        manifestVersionNewer: manifest.version > 1,
      };
    } catch (error) {
      return {
        ok: false,
        errorCode:
          error instanceof Error && error.message === "NOT_AN_EXPORT"
            ? "NOT_AN_EXPORT"
            : "ZIP_UNREADABLE",
      };
    }
  }
  async add(file: string) {
    this.options.assertCurrent();
    const existing = [...this.sources.values()].find(
      (source) => source.descriptor.rootPath === file,
    );
    if (existing) return { source: existing.descriptor };
    try {
      const stat = await fs.stat(file);
      const entries = stat.isDirectory()
        ? await this.folder(file)
        : (await this.archive(file)).entries;
      const sessions: SourceSession[] = [];
      for (const [name, data] of entries) {
        const match =
          /^(claude-code-sessions|local-agent-mode-sessions)\/([0-9a-fA-F-]{8,36})\/([^/]+)\/(local_[0-9a-fA-F-]{36})\.json$/.exec(
            name,
          );
        if (!match) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString("utf8"));
        } catch {
          continue;
        }
        const parsed = recordSchema.safeParse(raw);
        if (!parsed.success) continue;
        const record = parsed.data;
        const prefix = name.slice(0, -5);
        if (record.sessionId !== match[4]) continue;
        const transcript = [...entries].find(
          ([name]) =>
            name.startsWith(`${prefix}/.claude/projects/`) &&
            name.endsWith(`/${record.cliSessionId}.jsonl`),
        )?.[1];
        if (!transcript) continue;
        const kind =
          match[1] === "claude-code-sessions"
            ? "code"
            : record.sessionType === "chat"
              ? "chat"
              : "cowork";
        const decoded =
          kind === "code"
            ? readClaudeTranscript(
                transcript.toString("utf8"),
                record.cliSessionId,
              )
            : readLasmTranscript(transcript, record.cliSessionId);
        if (kind === "code" && (!decoded.cwd || !path.isAbsolute(decoded.cwd)))
          continue;
        const outputs = new Map(
          [...entries]
            .filter(([name]) => name.startsWith(`${prefix}/outputs/`))
            .map(([name, data]) => [
              name.slice(`${prefix}/outputs/`.length),
              data,
            ]),
        );
        const spaces = entries.get(`${path.posix.dirname(name)}/spaces.json`);
        const spaceName =
          spaces && record.spaceId
            ? readLasmSpaces(spaces).get(record.spaceId)
            : undefined;
        sessions.push({
          kind,
          record,
          transcript,
          outputs,
          accountId: match[2],
          decoded,
          ...(record.spaceId && spaceName !== undefined
            ? { space: { id: record.spaceId, name: spaceName } }
            : {}),
        });
      }
      if (!sessions.length) return { errorCode: "SOURCE_UNKNOWN_SHAPE" };
      this.options.assertCurrent();
      const descriptor: TransferSource = {
        id: randomUUID(),
        label: path.basename(file),
        rootPath: file,
        origin: stat.isDirectory() ? "picked" : "bundle",
      };
      this.sources.set(descriptor.id, { descriptor, sessions });
      return { source: descriptor };
    } catch (error) {
      return {
        errorCode:
          error instanceof Error && error.message === "SOURCE_IS_SELF"
            ? "SOURCE_IS_SELF"
            : "ZIP_UNREADABLE",
      };
    }
  }
  private async folder(root: string) {
    if (path.resolve(root) === path.resolve(this.options.root))
      throw Error("SOURCE_IS_SELF");
    const entries = new Map<string, Buffer>();
    const read = async (relative: string) => {
      for (const entry of await fs.readdir(path.join(root, relative), {
        withFileTypes: true,
      })) {
        const name = path.posix.join(relative, entry.name);
        const segments = name.split("/");
        const sessionTree =
          segments.length >= 4 && /^local_[0-9a-fA-F-]{36}$/.test(segments[3]);
        const outputs = sessionTree && segments[4] === "outputs";
        const transcript =
          sessionTree &&
          segments[4] === ".claude" &&
          (segments.length === 5 || segments[5] === "projects");
        if (
          entry.isDirectory() &&
          (segments.length <= 3 ||
            (sessionTree && segments.length === 4) ||
            outputs ||
            transcript)
        )
          await read(name);
        else if (
          entry.isFile() &&
          (outputs ||
            (transcript && name.endsWith(".jsonl")) ||
            (segments.length === 4 &&
              (entry.name === "spaces.json" ||
                /^local_[0-9a-fA-F-]{36}\.json$/.test(entry.name))))
        )
          entries.set(name, await fs.readFile(path.join(root, name)));
      }
    };
    for (const tree of ["claude-code-sessions", "local-agent-mode-sessions"])
      await read(tree).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    return entries;
  }
  enumerate() {
    this.options.assertCurrent();
    return [...this.sources.values()].map((source) => source.descriptor);
  }
  scan(sourceId: string) {
    this.options.assertCurrent();
    const source = this.sources.get(sourceId);
    const imported = new Set(
      this.options
        .conversations()
        .flatMap((c) => [
          c.id.replace(/^claude-ai:/, ""),
          ...(c.importedCliSessionId ? [c.importedCliSessionId] : []),
        ]),
    );
    return {
      sourceId,
      shape: source ? "userData" : "unknown",
      sessions:
        source?.sessions.map(({ kind, record, transcript, accountId }) => ({
          sessionId: record.sessionId,
          title: record.title ?? "Untitled session",
          kind,
          lastActivityAt: record.lastActivityAt,
          sizeBytes: transcript.length,
          accountId,
          alreadyImported: imported.has(record.cliSessionId),
        })) ?? [],
    };
  }
  async run(
    cutoffMs: number,
    ids: string[],
    progress: TransferProgress = () => {},
  ) {
    if (this.importing) throw Error("IMPORT_IN_PROGRESS");
    this.importing = true;
    let imported = 0,
      skipped = 0;
    const createdFolders: string[] = [];
    try {
      this.options.assertCurrent();
      const sessions = ids
        .flatMap((sourceId) =>
          (this.sources.get(sourceId)?.sessions ?? []).map((session) => ({
            ...session,
            sourceId,
          })),
        )
        .filter((s) => s.record.lastActivityAt >= cutoffMs);
      const existing = new Set(
        this.options
          .conversations()
          .flatMap((c) => [
            c.id.replace(/^claude-ai:/, ""),
            ...(c.importedCliSessionId ? [c.importedCliSessionId] : []),
          ]),
      );
      const additions: Conversation[] = [];
      const projects = new Map<string, Project>();
      const provider = this.options.provider();
      for (const session of sessions) {
        this.options.assertCurrent();
        if (existing.has(session.record.cliSessionId)) {
          skipped++;
          continue;
        }
        const decoded = structuredClone(session.decoded);
        const id = randomUUID();
        const conversation: Conversation = {
          id,
          title: session.record.title ?? decoded.title ?? "Untitled session",
          mode: session.kind,
          cwd: session.kind === "code" ? decoded.cwd : undefined,
          providerId: provider.id,
          model: provider.model,
          environment: { kind: "local" },
          createdAt: session.record.createdAt,
          updatedAt: session.record.lastActivityAt,
          pinned: false,
          archived: session.record.isArchived ?? false,
          turns: decoded.turns,
          importedCliSessionId: session.record.cliSessionId,
          importedHistory: true,
          importedSessionResumePending: true,
          importedCodeSource: `local-1p-${session.kind}`,
          sessionAuthors: {
            viewerAccountUuid: this.options.accountId,
            ownerAccountUuid: this.options.accountId,
          },
        };
        if (session.space) {
          const key = `${session.sourceId}:${session.space.id}`;
          let project = projects.get(key);
          if (!project) {
            project = {
              id: randomUUID(),
              name: session.space.name,
              description: "",
              instructions: "",
              createdAt: Date.now(),
            };
            projects.set(key, project);
          }
          conversation.projectId = project.id;
          conversation.importedSessionSpace = session.space;
        }
        const folder = path.join(this.options.root, "session-imports", id);
        await fs.mkdir(folder, { recursive: true });
        createdFolders.push(folder);
        hydrateLasmImages(conversation.turns, (name, data) => {
          const attachment = this.options.storeImage(name, data);
          createdFolders.push(path.dirname(attachment.path));
          return attachment;
        });
        await fs.writeFile(
          path.join(folder, "transcript.jsonl"),
          session.transcript,
          { mode: 0o600 },
        );
        for (const [name, data] of session.outputs) {
          const target = path.join(folder, "outputs", safeEntry(name));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, data, { mode: 0o600 });
        }
        const blobs = new GeneratedBlobs(this.options.root);
        for (const turn of conversation.turns)
          for (const item of turn.items) {
            if (item.type !== "dynamicToolCall" || item.tool !== "SendUserFile")
              continue;
            const input = z.object({ path: z.string() }).safeParse(item.input);
            if (!input.success) continue;
            let name = input.data.path.replace(/^.*\/outputs\//, "");
            if (!session.outputs.has(name)) {
              const matches = [...session.outputs.keys()].filter(
                (entry) =>
                  path.posix.basename(entry) === path.posix.basename(name),
              );
              if (matches.length !== 1) continue;
              name = matches[0];
            }
            const data = session.outputs.get(name);
            if (!data) continue;
            const digest = createHash("sha256").update(data).digest("hex");
            blobs.put(digest, data);
            const fileId = randomUUID();
            item.generatedFiles = [
              {
                id: fileId,
                name: path.posix.basename(name),
                path: `/outputs/${name}`,
                language: path.posix.extname(name).slice(1),
                operation: "create",
                state: "ready",
                blob: true,
                digest,
                bytes: data.length,
              },
            ];
            for (const row of turn.importedCodeTranscript ?? []) {
              if (typeof row.message.content === "string") continue;
              if (
                row.message.content.some(
                  (block) =>
                    block.type === "tool_result" &&
                    block.tool_use_id === item.id,
                )
              )
                row.codeOutput = { turnId: turn.id, itemId: item.id, fileId };
            }
          }
        additions.push(conversation);
        existing.add(session.record.cliSessionId);
        progress(
          "import",
          "registering",
          additions.length + skipped,
          sessions.length,
        );
        await tick();
      }
      this.options.assertCurrent();
      if (additions.length) {
        const run = {
          runId: randomUUID(),
          timestamp: Date.now(),
          source: "local3PBundle",
          skipped,
        } as const;
        for (const conversation of additions)
          conversation.importedSessionRun = {
            ...run,
            recordId: conversation.id,
          };
        for (const project of projects.values())
          project.importedSessionRun = { ...run, recordId: project.id };
        this.options.assertCurrent();
        this.options.importConversations(additions, [...projects.values()]);
        imported = additions.length;
      }
      return { imported, skipped };
    } finally {
      if (!imported)
        for (const folder of createdFolders)
          await fs.rm(folder, { recursive: true, force: true });
      this.importing = false;
    }
  }
  async confirm(id: string) {
    this.options.assertCurrent();
    const conversation = this.options
      .conversations()
      .find((c) => c.id === id.replace(/^local_/, ""));
    if (!conversation?.importedSessionResumePending) return false;
    await this.options.saveConversation({
      ...conversation,
      importedSessionResumePending: undefined,
    });
    return true;
  }
  private historyRecords(): ImportRun[] {
    const runs = new Map<string, ImportRun>();
    const get = (record: NonNullable<Conversation["importedSessionRun"]>) => {
      let run = runs.get(record.runId);
      if (!run) {
        run = {
          runId: record.runId,
          timestamp: record.timestamp,
          source: record.source,
          conversationIds: [],
          projectIds: [],
          counts: {
            sessions: 0,
            spaces: 0,
            attachments: 0,
            skipped: record.skipped,
          },
        };
        runs.set(run.runId, run);
      }
      return run;
    };
    for (const conversation of this.options.conversations()) {
      const record = conversation.importedSessionRun;
      if (!record || record.recordId !== conversation.id) continue;
      const run = get(record);
      run.conversationIds.push(conversation.id);
      run.counts.sessions++;
      run.counts.attachments += conversation.turns.reduce(
        (count, turn) => count + turn.attachments.length,
        0,
      );
    }
    for (const project of this.options.projects()) {
      const record = project.importedSessionRun;
      if (!record || record.recordId !== project.id) continue;
      const run = get(record);
      run.projectIds.push(project.id);
      run.counts.spaces++;
    }
    return [...runs.values()];
  }
  async history() {
    return this.historyRecords()
      .map(({ conversationIds: _, projectIds: __, ...run }) => run)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  async removePreview(id: string) {
    const runs = this.historyRecords().filter(
      (run) => id === "*" || run.runId === id,
    );
    const targets = this.options
      .conversations()
      .filter((c) => runs.some((run) => run.conversationIds.includes(c.id)));
    const spaceIds = new Set(runs.flatMap((run) => run.projectIds));
    return {
      sessionCount: targets.length,
      spaceCount: this.options
        .projects()
        .filter((project) => spaceIds.has(project.id)).length,
      modifiedSinceImport: targets.filter((c) =>
        runs.some(
          (run) =>
            run.conversationIds.includes(c.id) && c.updatedAt > run.timestamp,
        ),
      ).length,
    };
  }
  async remove(id: string) {
    this.options.assertCurrent();
    const selected = this.historyRecords().filter(
      (run) => id === "*" || run.runId === id,
    );
    const ids = new Set(selected.flatMap((run) => run.conversationIds));
    await this.options.removeConversations(
      ids,
      new Set(selected.flatMap((run) => run.projectIds)),
    );
    for (const id of ids) {
      if (
        this.options
          .conversations()
          .some((conversation) => conversation.id === id)
      )
        continue;
      await fs.rm(path.join(this.options.root, "session-imports", id), {
        recursive: true,
        force: true,
      });
    }
    return { removed: ids.size, failed: 0 };
  }
}
