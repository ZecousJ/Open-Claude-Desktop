import { dialog, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  maxPreviewBytes,
  type ArtifactPreviews,
} from "../artifacts/artifact-previews";
import type { GeneratedBlobs } from "../artifacts/generated-blobs";
import { snapshotChosenFile } from "../artifacts/generated-files";
import type { ArtifactShares } from "../artifacts/artifact-shares";
import type { ArtifactPopouts } from "../artifacts/artifact-popouts";
import type { AppEvent } from "../../shared/types";
import type { AppContext, IpcHandle } from "../app/app-context";
import { artifactCompleteHandler } from "../artifacts/artifact-complete";
import { registerArtifactToolHandlers } from "../artifacts/artifact-tools";
import {
  documentBytesInput,
  documentHtmlInput,
  documentTitleInput,
} from "../../shared/artifact-document-input";
import { ArtifactDocumentCloud } from "../artifacts/artifact-document-cloud";
import { artifactTranslationHandler } from "../artifacts/artifact-translation";
import { artifactDownloadGuard } from "../artifacts/artifact-download";
import { ArtifactData } from "../artifacts/artifact-data";
import {
  validResourceFile,
  maxResourceBytes,
  type McpResourceFile,
} from "../../shared/message-resources";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly root: string;
  readonly window: BrowserWindow | undefined;
  /** Sends an event to every app window (the main and separate ones, R2). */
  push(event: AppEvent): void;
  previews: ArtifactPreviews;
  readonly shares: ArtifactShares;
  popouts: ArtifactPopouts;
  readonly blobs: GeneratedBlobs;
  /** A conversation's working folders (its cwd and added folders). */
  conversationFolders(conversationId: string): string[];
}
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const string = z.string().min(1).max(500);
// Any text artifact: a public link (R1) takes markdown, code and the rest;
// only HTML and SVG get a link on this computer (setArtifactShare below).
const artifactShareSchema = z.object({
  identity: z.string().min(1).max(3_000_000),
  title: z.string().min(1).max(200),
  language: z.string().min(1).max(30),
  content: z.string().max(2 * 1024 * 1024),
});
const locallyShareable = new Set(["html", "svg"]);
const popoutSourceSchema = z
  .object({
    pdfLabel: z.string().max(200).optional(),
    pdfError: z.string().max(500).optional(),
    filename: z.string().min(1).max(200).optional(),
    source: z
      .string()
      .max(10 * 1024 * 1024)
      .optional(),
    sourceBase64: z
      .string()
      .max(maxPreviewBytes)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
    previewDownload: z.boolean().optional(),
    language: z.string().max(30).optional(),
  })
  .strict();
const artifactSharePatchSchema = z
  .object({
    visibility: z.enum(["private", "link"]).optional(),
    showInList: z.boolean().optional(),
  })
  .strict();
export function registerArtifactHandlers(handle: Handle, context: Context) {
  const download = artifactDownloadGuard();
  handle("saveMcpResourceFile", async (file: McpResourceFile) => {
    if (!validResourceFile(file)) throw new Error("The request failed.");
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.length > maxResourceBytes) throw new Error("The request failed.");
    const result = await dialog.showSaveDialog(context.window!, {
      defaultPath: path.basename(file.name),
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, bytes, { mode: 0o600 });
    return result.filePath;
  });
  handle("artifactData", (identity: unknown, request: unknown) =>
    new ArtifactData(context.root).request(
      z.string().min(1).max(3_000_000).parse(identity),
      request,
    ),
  );
  handle("artifactDataUsage", (identity: unknown) =>
    new ArtifactData(context.root).usage(
      z.string().min(1).max(3_000_000).parse(identity),
    ),
  );
  handle("requestArtifactStorageLimit", (identity: unknown) =>
    new ArtifactData(context.root).requestLimit(
      z.string().min(1).max(3_000_000).parse(identity),
    ),
  );
  handle("saveArtifactBytes", async (name: unknown, raw: unknown) => {
    const filename = documentTitleInput.parse(name);
    const bytes = Buffer.from(documentBytesInput.parse(raw), "base64");
    const result = await dialog.showSaveDialog(context.window!, {
      defaultPath: path.basename(filename),
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, bytes, { mode: 0o600 });
    return result.filePath;
  });
  handle("exportDocumentPdf", async (title: unknown, html: unknown) => {
    const name = documentTitleInput.parse(title);
    const content = documentHtmlInput.parse(html);
    const { saveDocumentPdf } = await import("../artifacts/design-pdf");
    return saveDocumentPdf(context.window!, name, content);
  });
  handle("createArtifactPreview", (content: unknown) =>
    context.previews.create(z.string().max(maxPreviewBytes).parse(content)),
  );
  handle("captureArtifactScreenshot", async (raw: unknown) => {
    const html = z.string().max(maxPreviewBytes).parse(raw);
    const { captureArtifactScreenshot } =
      await import("../artifacts/artifact-screenshot");
    return captureArtifactScreenshot(context.previews, html);
  });
  handle("syncArtifactShare", (raw: unknown) =>
    context.shares.sync(artifactShareSchema.parse(raw)),
  );
  handle("setArtifactShare", (raw: unknown, patch: unknown) => {
    const input = artifactShareSchema.parse(raw);
    const change = artifactSharePatchSchema.parse(patch);
    if (change.visibility === "link" && !locallyShareable.has(input.language))
      throw new Error(
        "Only HTML and SVG artifacts can be shared on this computer.",
      );
    const result = context.shares.update(input, change);
    context.push({
      type: "artifact-shares",
      shares: context.shares.list(),
    });
    return result;
  });
  handle(
    "popOutArtifact",
    (title: unknown, content: unknown, source: unknown) =>
      context.popouts.open(
        z.string().min(1).max(200).parse(title),
        z.string().max(maxPreviewBytes).parse(content),
        popoutSourceSchema.parse(source ?? {}),
      ),
  );
  handle("releaseArtifactPreview", (url: unknown) =>
    context.previews.release(string.parse(url)),
  );
  // Binary generated files are read and saved by digest only, from the profile snapshot.
  handle("readGeneratedFile", (raw: unknown) =>
    context.blobs.read(digest.parse(raw)).toString("base64"),
  );
  // The path comes from the transcript; the store checks it is in Codex's image folder.
  handle("imageGenerationSnapshot", (raw: unknown) =>
    context.blobs.snapshotImage(z.string().min(1).max(2000).parse(raw)),
  );
  handle("viewedImageSnapshot", (conversation: unknown, file: unknown) =>
    context.blobs.snapshotViewedImage(
      z.string().min(1).max(2000).parse(file),
      context.conversationFolders(string.parse(conversation)),
    ),
  );
  handle("saveGeneratedFile", async (raw: unknown, name: unknown) => {
    const source = context.blobs.path(digest.parse(raw));
    return download(fs.statSync(source).size, async () => {
      const result = await dialog.showSaveDialog(context.window!, {
        defaultPath: path.basename(z.string().min(1).max(200).parse(name)),
      });
      if (result.canceled || !result.filePath) return null;
      fs.copyFileSync(source, result.filePath);
      return result.filePath;
    });
  });
  // File ▸ Open File…: any file the person picks, shown in the file viewer.
  handle("chooseLocalFile", async () => {
    const result = await dialog.showOpenDialog(context.window!, {
      properties: ["openFile"],
    });
    const chosen = result.filePaths[0];
    return chosen ? snapshotChosenFile(chosen, context.blobs) : null;
  });
  handle("saveArtifact", async (name: any, content: any) => {
    const filename = z.string().max(200).parse(name);
    const text = z.string().parse(content);
    return download(Buffer.byteLength(text, "utf8"), async () => {
      const result = await dialog.showSaveDialog(context.window!, {
        defaultPath: path.basename(filename),
      });
      if (result.canceled || !result.filePath) return null;
      fs.writeFileSync(result.filePath, text);
      return result.filePath;
    });
  });
}

/** AI-powered artifacts. */
export function registerArtifactCompleteHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const documents = new ArtifactDocumentCloud(ctx);
  handle("translateArtifactDocument", artifactTranslationHandler(ctx));
  handle("artifactDocumentConnectors", () => documents.connectors());
  handle("saveArtifactDocument", (input: unknown) => documents.save(input));
  handle("artifactComplete", artifactCompleteHandler(ctx));
  registerArtifactToolHandlers(handle, ctx);
}
