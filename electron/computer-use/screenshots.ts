/**
 * Computer-use screenshots (R10 design §3.1): every image a driver returns
 * is scaled down (long edge at most 1568 px) and re-encoded as JPEG before
 * the model sees it, and kept on this computer so the transcript can show
 * it: `<profile>/computer-use/screenshots/<conversationId>/<id>.jpg`
 * (0600, folder 0700). Incognito chats keep theirs in memory only (the 50
 * newest). The transcript refers to a screenshot by
 * `claudex-screenshot://<id>`, never by its bytes.
 *
 * Image work is injected (`Transcoder`) so this module runs without
 * Electron; the app passes one built on `nativeImage`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isScreenshotId } from "../../shared/computer-use";

export interface TranscodedImage {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
  /** The size of the image before scaling. */
  sourceWidth: number;
  sourceHeight: number;
}

/** Scales an image so its long edge is at most `maxEdge` and encodes it as JPEG. */
export type Transcoder = (
  data: Buffer,
  mimeType: string,
  maxEdge: number,
) => TranscodedImage;

export const modelImageEdge = 1568;
export const thumbnailEdge = 480;
const memoryLimit = 50;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export interface SavedScreenshot {
  id: string;
  /** Base64 JPEG for the model. */
  data: string;
  mimeType: string;
  /** Multiply a point in the saved image by this to get the driver's coordinates. */
  scale: number;
}

export class ScreenshotStore {
  private memory = new Map<string, { conversationId: string; data: Buffer }>();
  constructor(
    /** `<profile>/computer-use/screenshots` */
    readonly root: string,
    private transcode: Transcoder,
  ) {}

  private folder(conversationId: string) {
    if (!idPattern.test(conversationId))
      throw new Error("Unknown conversation.");
    return path.join(this.root, conversationId);
  }

  /** Scales, encodes and keeps a driver image; returns what the model gets. */
  save(
    conversationId: string,
    incognito: boolean,
    image: Buffer,
    mimeType: string,
  ): SavedScreenshot {
    const out = this.transcode(image, mimeType, modelImageEdge);
    const id = crypto.randomUUID();
    if (incognito) {
      this.memory.set(id, { conversationId, data: out.data });
      while (this.memory.size > memoryLimit)
        this.memory.delete(this.memory.keys().next().value!);
    } else {
      const folder = this.folder(conversationId);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(folder, `${id}.jpg`), out.data, {
        mode: 0o600,
      });
    }
    return {
      id,
      data: out.data.toString("base64"),
      mimeType: out.mimeType,
      scale: out.width > 0 ? out.sourceWidth / out.width : 1,
    };
  }

  private bytesOf(id: string): Buffer | undefined {
    if (!isScreenshotId(id)) return undefined;
    const kept = this.memory.get(id);
    if (kept) return kept.data;
    let folders: string[];
    try {
      folders = fs.readdirSync(this.root);
    } catch {
      return undefined;
    }
    for (const folder of folders) {
      if (!idPattern.test(folder)) continue;
      try {
        return fs.readFileSync(path.join(this.root, folder, `${id}.jpg`));
      } catch {}
    }
    return undefined;
  }

  /** A saved screenshot as a data URL (a thumbnail or the full image); null once removed. */
  read(id: string, size: "thumb" | "full"): string | null {
    const data = this.bytesOf(id);
    if (!data) return null;
    if (size === "full")
      return `data:image/jpeg;base64,${data.toString("base64")}`;
    const thumb = this.transcode(data, "image/jpeg", thumbnailEdge);
    return `data:${thumb.mimeType};base64,${thumb.data.toString("base64")}`;
  }

  /** Forgets a conversation's screenshots (the conversation was deleted). */
  deleteConversation(conversationId: string) {
    for (const [id, kept] of this.memory)
      if (kept.conversationId === conversationId) this.memory.delete(id);
    if (!idPattern.test(conversationId)) return;
    fs.rmSync(this.folder(conversationId), { recursive: true, force: true });
  }

  /** Removes the folders of conversations that no longer exist. */
  prune(existing: ReadonlySet<string>) {
    let folders: string[];
    try {
      folders = fs.readdirSync(this.root);
    } catch {
      return;
    }
    for (const folder of folders)
      if (idPattern.test(folder) && !existing.has(folder))
        fs.rmSync(path.join(this.root, folder), {
          recursive: true,
          force: true,
        });
  }

  /** Bytes the saved screenshots take on disk (Settings → Storage). */
  bytes(): number {
    let total = 0;
    let folders: string[];
    try {
      folders = fs.readdirSync(this.root);
    } catch {
      return 0;
    }
    for (const folder of folders) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(this.root, folder));
      } catch {
        continue;
      }
      for (const file of files)
        try {
          total += fs.statSync(path.join(this.root, folder, file)).size;
        } catch {}
    }
    return total;
  }

  /** Forgets the incognito screenshots (sign-out). */
  clearMemory() {
    this.memory.clear();
  }
}
