import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  knowledgeDocumentExtensions,
  checkedKnowledgeEncoding,
  knowledgeEncodingPreviewChars,
} from "../../shared/project-knowledge-encoding";
import type {
  PendingKnowledgeFile,
  KnowledgeUploadCapabilities,
} from "../../shared/project-knowledge-pending";
import type { ProjectCapabilities } from "../../shared/project-access";
import type { ProjectKnowledge } from "../../shared/collections-api";
import {
  ProjectKnowledgeStore,
  knowledgeFileLimit,
  knowledgeProjectLimit,
  knowledgeFileCount,
  knowledgePath,
} from "./project-knowledge";
import { documentText } from "../workspace/document-text";
import { unzipSkill } from "../skills/skill-folder";

interface StoredPending extends Omit<PendingKnowledgeFile, "status"> {
  status: PendingKnowledgeFile["status"] | "completed";
  document: boolean;
  encoding?: string;
  outputName?: string;
}
type Snapshot = ProjectKnowledge & {
  capabilities: ProjectCapabilities;
  pending: PendingKnowledgeFile[];
  uploadCapabilities: KnowledgeUploadCapabilities;
};
export interface ProjectKnowledgeUploadOwner {
  owner(): object;
  canEdit?(projectId: string): boolean;
}
const activeConversions = new Set<string>();
const pendingId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const extension = (name: string) => path.extname(name).slice(1).toLowerCase();

/** Actual uploads stay in the owning profile/project until confirmed. A
 * pending encoding is never silently interpreted or inserted into context.
 * Successful conversions keep their choice/status in the private journal. */
export class ProjectKnowledgeUploads {
  private readonly boundOwner: object;
  constructor(
    private readonly store: ProjectKnowledgeStore,
    private readonly deps: ProjectKnowledgeUploadOwner,
  ) {
    this.boundOwner = deps.owner();
  }
  private assertOwner(owner = this.boundOwner): void {
    if (owner !== this.boundOwner || this.deps.owner() !== owner)
      throw new Error("The signed-in account changed. Try again.");
  }
  private check(projectId: string, owner = this.boundOwner) {
    this.assertOwner(owner);
    this.store.assertCanEdit(projectId);
    if (this.deps.canEdit && this.deps.canEdit(projectId) !== true)
      throw new Error(
        "You do not have permission to edit this project's context.",
      );
    return owner;
  }
  private folder(projectId: string, create = false): string {
    this.store.folder(projectId); // Validates the authenticated project ID.
    let current = fs.realpathSync(this.store.root);
    for (const part of ["projects", projectId, "knowledge-pending"]) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error("This project's upload folder cannot be used.");
      if (!stat && create) fs.mkdirSync(current, { mode: 0o700 });
    }
    return current;
  }
  private read(projectId: string): StoredPending[] {
    const file = path.join(this.folder(projectId), "records.json");
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw Error("Invalid pending uploads.");
      const buffer = Buffer.alloc(stat.size + 1),
        length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (length > stat.size)
        throw Error("Pending uploads changed. Try again.");
      const data = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (
        data?.version !== 1 ||
        !Array.isArray(data.records) ||
        data.records.length > 400
      )
        throw Error("Invalid pending uploads.");
      const seen = new Set<string>();
      for (const record of data.records) {
        if (
          !record ||
          !pendingId.test(record.id) ||
          seen.has(record.id) ||
          typeof record.name !== "string" ||
          !Number.isSafeInteger(record.bytes) ||
          record.bytes < 0 ||
          record.bytes > knowledgeFileLimit ||
          typeof record.document !== "boolean" ||
          !["encoding", "extracting", "failed", "completed"].includes(
            record.status,
          ) ||
          (record.error !== undefined && typeof record.error !== "string")
        )
          throw Error("Invalid pending uploads.");
        seen.add(record.id);
      }
      return data.records;
    } finally {
      fs.closeSync(descriptor);
    }
  }
  private write(projectId: string, records: StoredPending[]): void {
    const folder = this.folder(projectId, true),
      temporary = path.join(folder, "records.json.tmp"),
      target = path.join(folder, "records.json");
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_TRUNC |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, records }));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, target);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
  private data(projectId: string, record: StoredPending): Buffer {
    const descriptor = fs.openSync(
      path.join(this.folder(projectId), `${record.id}.bin`),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.size !== record.bytes ||
        stat.size > knowledgeFileLimit
      )
        throw Error("This pending file changed. Upload it again.");
      const buffer = Buffer.alloc(stat.size + 1),
        length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      if (length !== stat.size)
        throw Error("This pending file changed. Upload it again.");
      return buffer.subarray(0, length);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  list(projectId: string): Snapshot {
    this.assertOwner();
    const knowledge = this.store.list(projectId);
    const records = this.read(projectId);
    for (const record of records.filter(
      (entry) => entry.status === "completed",
    )) {
      try {
        fs.unlinkSync(path.join(this.folder(projectId), `${record.id}.bin`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return {
      ...knowledge,
      capabilities: {
        ...this.store.capabilities(projectId),
        canEditKnowledgeBase:
          this.store.capabilities(projectId).canEditKnowledgeBase &&
          (!this.deps.canEdit || this.deps.canEdit(projectId) === true),
      },
      pending: records
        .filter((record) => record.status !== "completed")
        .map((record) => {
          const live = activeConversions.has(
            path.join(this.folder(projectId), record.id),
          );
          const interrupted = record.status === "extracting" && !live;
          return {
            id: record.id,
            name: record.name,
            bytes: record.bytes,
            status: live
              ? "extracting"
              : interrupted
                ? "failed"
                : (record.status as PendingKnowledgeFile["status"]),
            ...(interrupted
              ? {
                  error:
                    "Document extraction was interrupted. Retry this file.",
                }
              : record.error && !live
                ? { error: record.error }
                : {}),
          };
        }),
      uploadCapabilities: { encodingSelection: true, documentExtraction: true },
    };
  }
  async stageFiles(
    projectId: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<Snapshot> {
    const owner = this.check(projectId);
    if (!Array.isArray(files) || !files.length || files.length > 12)
      throw Error("Choose up to 12 project files at a time.");
    const current = this.store.list(projectId),
      before = this.read(projectId);
    const records = before.filter(
      (record) =>
        record.status !== "completed" ||
        current.files.some((file) => file.name === record.outputName),
    );
    if (before.length !== records.length) this.write(projectId, records);
    const checked = files.map((file) => {
      if (
        !file ||
        typeof file.name !== "string" ||
        !(file.data instanceof Uint8Array) ||
        file.data.byteLength > knowledgeFileLimit
      )
        throw Error("Project files can be up to 10 MB.");
      const document = (
        knowledgeDocumentExtensions as readonly string[]
      ).includes(extension(file.name));
      const outputName = knowledgePath(
        document ? `${file.name}.txt` : file.name,
      );
      return {
        name: document ? outputName.slice(0, -4) : outputName,
        outputName,
        document,
        data: Buffer.from(file.data),
      };
    });
    const pending = records.filter((record) => record.status !== "completed");
    if (
      current.files.length + pending.length + checked.length >
        knowledgeFileCount ||
      current.bytes +
        pending.reduce((sum, record) => sum + record.bytes, 0) +
        checked.reduce((sum, file) => sum + file.data.length, 0) >
        knowledgeProjectLimit
    )
      throw Error(
        "Project file storage is full. Remove a file before adding more.",
      );
    for (const file of checked) {
      this.check(projectId, owner);
      if (!file.document) {
        if (extension(file.name) === "pdf") {
          this.store.add(projectId, [{ name: file.name, data: file.data }]);
          continue;
        }
        let needsEncoding = false;
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(file.data);
        } catch {
          needsEncoding = true;
        }
        if (!needsEncoding) {
          this.store.add(projectId, [{ name: file.name, data: file.data }]);
          continue;
        }
      }
      const record: StoredPending = {
        id: randomUUID(),
        name: file.name,
        bytes: file.data.length,
        document: file.document,
        status: file.document ? "extracting" : "encoding",
      };
      const target = path.join(
        this.folder(projectId, true),
        `${record.id}.bin`,
      );
      const descriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(descriptor, file.data);
      } finally {
        fs.closeSync(descriptor);
      }
      try {
        this.write(projectId, [...this.read(projectId), record]);
      } catch (error) {
        fs.unlinkSync(target);
        throw error;
      }
      if (file.document) {
        try {
          await this.confirmEncoding(projectId, record.id, "extract", owner);
        } catch (error) {
          if (this.deps.owner() !== owner) throw error;
        }
      }
    }
    return this.list(projectId);
  }
  previewEncoding(
    projectId: string,
    id: string,
    encoding: string,
  ): { text: string } {
    this.assertOwner();
    this.store.folder(projectId);
    const record = this.record(projectId, id);
    if (record.document) throw Error("This document needs text extraction.");
    const data = this.data(projectId, record);
    return {
      text: new TextDecoder(checkedKnowledgeEncoding(encoding), {
        fatal: false,
      })
        .decode(data.subarray(0, 4 * knowledgeEncodingPreviewChars))
        .slice(0, knowledgeEncodingPreviewChars),
    };
  }
  private record(
    projectId: string,
    id: string,
    completed = false,
  ): StoredPending {
    if (typeof id !== "string" || !pendingId.test(id))
      throw Error("This pending file is no longer available.");
    const record = this.read(projectId).find(
      (entry) => entry.id === id && (completed || entry.status !== "completed"),
    );
    if (!record) throw Error("This pending file is no longer available.");
    return record;
  }
  async confirmEncoding(
    projectId: string,
    id: string,
    encoding: string,
    capturedOwner = this.boundOwner,
  ): Promise<Snapshot> {
    const owner = this.check(projectId, capturedOwner),
      record = this.record(projectId, id, true);
    const choice = record.document
      ? "extract"
      : checkedKnowledgeEncoding(encoding);
    if (record.document && encoding !== "extract")
      throw Error("Choose text extraction for this document.");
    if (record.status === "completed") {
      if (record.encoding !== choice)
        throw Error("This pending file is no longer available.");
      return this.list(projectId);
    }
    const conversion = path.join(this.folder(projectId), id);
    if (activeConversions.has(conversion))
      throw Error(
        "This file is already being read. Try again when it finishes.",
      );
    const data = this.data(projectId, record);
    activeConversions.add(conversion);
    let folder: string | undefined;
    try {
      let text: string;
      if (record.document) {
        // Reuse the real document reader after a bounded ZIP preflight. A
        // small compressed Office file must not inflate beyond the disk limit.
        unzipSkill(data, {
          files: 500,
          bytes: knowledgeFileLimit,
          message: "This document is too large to extract safely.",
        });
        folder = fs.mkdtempSync(
          path.join(this.folder(projectId, true), "extract-"),
        );
        const original = path.join(
          folder,
          `document.${extension(record.name)}`,
        );
        fs.writeFileSync(original, data, { flag: "wx", mode: 0o600 });
        text = await documentText(original, record.name);
      } else text = new TextDecoder(choice, { fatal: false }).decode(data);
      this.check(projectId, owner);
      const outputName = knowledgePath(
        record.document ? `${record.name}.txt` : record.name,
      );
      this.store.add(projectId, [
        { name: outputName, data: Buffer.from(text, "utf8") },
      ]);
      const records = this.read(projectId).filter(
        (entry) =>
          entry.id === id ||
          entry.status !== "completed" ||
          entry.outputName !== outputName,
      );
      this.write(
        projectId,
        records.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                status: "completed",
                encoding: choice,
                outputName,
                error: undefined,
              }
            : entry,
        ),
      );
      fs.unlinkSync(path.join(this.folder(projectId), `${id}.bin`));
      return this.list(projectId);
    } catch (error) {
      if (this.deps.owner() === owner) {
        const reason =
          error instanceof Error ? error.message : "File upload failed.";
        this.write(
          projectId,
          this.read(projectId).map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: "failed",
                  encoding: choice,
                  error: reason.slice(0, 500),
                }
              : entry,
          ),
        );
      }
      throw error;
    } finally {
      activeConversions.delete(conversion);
      if (folder) fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  removePending(projectId: string, id: string): Snapshot {
    this.check(projectId);
    this.record(projectId, id);
    if (activeConversions.has(path.join(this.folder(projectId), id)))
      throw Error(
        "This file is already being read. Try again when it finishes.",
      );
    this.write(
      projectId,
      this.read(projectId).filter((entry) => entry.id !== id),
    );
    try {
      fs.unlinkSync(path.join(this.folder(projectId), `${id}.bin`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.list(projectId);
  }
}
