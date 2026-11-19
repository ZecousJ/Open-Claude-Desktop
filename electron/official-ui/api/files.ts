import { officialCodeUploadOrganization, officialCodeUploadMaxBytes } from "../../../shared/official-code-followup";
import { knowledgeFileLimit } from "../../../shared/collections-api";
import { isOfficialUiDocumentConversion, officialChatUploadMaxBytes, officialChatUploadOrganization, officialUiRequestLimit } from "../../../shared/official-ui-web";
import { extractKnowledgeDocument, KnowledgeDocumentError } from "../../workspace/knowledge-document";
import { OfficeRuntimeUnavailable } from "../../workspace/office-conversion";
/**
 * Files the front-end uploads and shows (official consumers: shared-3 `jm`
 * for `POST /api/<org>/upload`, `jJ` for cowork attachments, the composer's
 * file tiles and the transcript's attachment tiles):
 *   upload → the Claudex attachment store (`addAttachmentData`), so a send
 *            carries it like a file the classic composer attached (a cloud
 *            conversation uploads it to the runner on send);
 *   GET …/files/<id>/(preview|thumbnail|contents|content_preview) → the bytes.
 * The registry also learns the files of the turns the timeline draws.
 */
import fs from "node:fs";
import { fileReadObserver, withFileReadDiagnostics, type FileReadObserver } from "./file-read-diagnostics";
import { createHash } from "node:crypto";
import path from "node:path";
import type http from "node:http";
import type { Attachment, Conversation } from "../../../shared/types";
import {
  readBody,
  reply as jsonReply,
  organizationUuid,
  type AdapterContext,
} from "./context";
import { readState, writeState } from "./state";
import { ScopedMap, currentAdapterScope, bindAdapterScope, scopedValue } from "./scope";
import { registerIncognitoRegistryCleanup } from "../../app/incognito-retirement";
import { readBoundedBytes, RequestBodyError } from "./request-body";
import { attachmentFileName } from "../../engine/composer-files";
import { incognitoDraftId, incognitoUploadFolder } from "../../workspace/incognito-upload";
import {
  attachmentKind,
  attachmentTypes,
  builtInAttachmentBytes,
} from "../../../shared/client-policy";
const privateFileHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "sandbox; default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
};
const reply = (res: http.ServerResponse, data: unknown, status = 200) =>
  jsonReply(res, data, status, privateFileHeaders);
/** Active/unknown documents are bytes to download, never executable app-origin pages. */
export function attachmentResponseHeaders(file: Pick<KnownFile, "name">, type: string, download = false) {
  const inline = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "application/pdf",
    "text/plain",
  ]);
  if (inline.has(type) && !download) return { ...privateFileHeaders, "Content-Type": type };
  const name =
    Array.from(
      Buffer.from(path.basename(file.name.replace(/\\/g, "/")))
        .toString("utf8")
        .replace(/[\u0000-\u001f\u007f]/g, "_"),
    )
      .slice(0, 200)
      .join("") || "attachment";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return {
    ...privateFileHeaders,
    "Content-Type": inline.has(type) ? type : "application/octet-stream",
    "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
    ...(inline.has(type) ? {} : {
      "Content-Security-Policy":
        "sandbox; default-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    }),
  };
}

export interface InlineDisplay {
  file_name: string;
  file_type: string;
  kind?: string;
  quote_message_uuid?: string;
  sha256: string;
}
export interface KnownFile {
  /** Display metadata only; bytes remain in the owned attachment service. */
  inlineDisplay?: InlineDisplay;
  id: string;
  name: string;
  /** On this computer; missing for a cloud turn's file this computer never had. */
  path?: string;
  size: number;
  mediaType: string;
  kind: "image" | "document" | "blob";
  /** The conversation whose turn refers to it, for reading it where that conversation runs. */
  conversationId?: string;
  /** The turn row's own id when it differs from `id` (a cloud copy of a local upload). */
  rowId?: string;
  width?: number;
  height?: number;
  createdAt: number;
  incognitoDraft?: string;
}

const files = new ScopedMap<string, KnownFile>("files");
/** A cloud turn's attachment id → the local file it was uploaded from. */
const cloudAliases = new ScopedMap<string, string>("cloud-file-aliases");
// Read bindings come from owned history and do not authorize legacy display metadata.
const historyReads = new ScopedMap<KnownFile, { conversationId: string; rowId: string }>(
  "history-file-reads",
);

const mediaTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  doc: "application/msword",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  epub: "application/epub+zip",
  xls: "application/vnd.ms-excel",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  xlt: "application/vnd.ms-excel",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  xltm: "application/vnd.ms-excel.template.macroenabled.12",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const mediaTypeOf = (name: string) =>
  mediaTypes[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ??
  "application/octet-stream";

export function knownFile(id: string): KnownFile | undefined {
  return files.get(id) ?? files.get(cloudAliases.get(id) ?? "");
}

/** A file the timeline shows (a turn's attachment), so its tiles can load. */
export function learnAttachment(
  a: Attachment,
  conversationId?: string,
  temporary = false,
): KnownFile {
  const existing = knownFile(a.id);
  if (existing) {
    if (conversationId && !existing.conversationId && existing.inlineDisplay)
      historyReads.set(existing, { conversationId, rowId: a.id });
    if (conversationId && !existing.conversationId && !existing.inlineDisplay && (!temporary || existing.incognitoDraft)) {
      existing.conversationId = conversationId;
      if (existing.id !== a.id) existing.rowId = a.id;
      persist();
    }
    return existing;
  }
  const mediaType = mediaTypeOf(a.name);
  const file: KnownFile = {
    id: a.id,
    name: a.name,
    // Imported transcript paths are untrusted; the owned service resolves history.
    path: !conversationId && a.path && fs.existsSync(a.path) ? a.path : undefined,
    size: a.size,
    mediaType,
    kind:
      a.kind === "image"
        ? "image"
        : mediaType === "application/pdf"
          ? "document"
          : "blob",
    ...(conversationId ? { conversationId } : {}),
    ...(temporary && conversationId ? { incognitoDraft: conversationId } : {}),
    createdAt: Date.now(),
  };
  files.set(a.id, file);
  persist();
  return file;
}

/** Internal native preparation only: a fresh derived upload keeps its real name/path. */
export function rememberInlineDisplay(file: KnownFile, input: {file_name:string;file_type:string;kind?:string;quote_message_uuid?:string}, text:string) {
  if (knownFile(file.id) !== file || file.size !== Buffer.byteLength(text) || file.mediaType !== "text/plain")
    throw new FileReadError(409, "The attachment identity changed.");
  file.inlineDisplay = {
    file_name: attachmentFileName(input.file_name),
    file_type: input.file_type,
    ...(input.kind ? {kind:input.kind} : {}),
    ...(input.quote_message_uuid ? {quote_message_uuid:input.quote_message_uuid} : {}),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  persist();
}
/** Display metadata only, recovered by a confirmed receipt or verified same-conversation bytes. */
export async function restoreConfirmedUploadDisplay(ctx: AdapterContext, conversation: Conversation, localIds: readonly string[], current: () => void) {
  const sources=localIds.map(id=>files.get(id)).filter((file):file is KnownFile=>!!file?.inlineDisplay);
  if(!sources.length)return;
  const allowed=new Set(sources.map(file=>file.id));
  // This hook belongs only to append-send completion, never historical branches.
  const appended=conversation.turns?.at(-1)?.attachments??[];
  if(appended.length>12)return;
  const seen=new Set<string>();
  const rows=appended.filter(row=>{
    if(seen.has(row.id) || !sources.some(file=>file.name===row.name && file.size===row.size))return false;
    seen.add(row.id);return true;
  });
  for(const row of rows){
    current();
    if(!ctx.readConfirmedUpload){
      const eligible=sources.filter(file=>file.conversationId===conversation.id && file.name===row.name && file.size===row.size && file.size<=builtInAttachmentBytes.text);
      if(!eligible.length)continue;
      const result=await ctx.call("turnAttachment",conversation.id,row.id) as {name?:unknown;data?:unknown}|null;
      current();
      if(result?.name!==row.name || !(result.data instanceof Uint8Array) || result.data.byteLength!==row.size)continue;
      const digest=createHash("sha256").update(result.data).digest("hex");
      const matching=eligible.filter(file=>file.inlineDisplay?.sha256===digest && (row.id===file.id || !cloudAliases.has(row.id)));
      const displays=new Map(matching.map(file=>[JSON.stringify(file.inlineDisplay),file.inlineDisplay!]));
      if(displays.size!==1)continue;
      const candidate=[...displays.values()][0];
      if(candidate.quote_message_uuid){
        try{
          const [{resolveCompletionQuoteSources},{userMessageId,assistantMessageId}]=await Promise.all([import('./completion-quote-source'),import('./conversations')]);
          current();
          const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(result.data);
          resolveCompletionQuoteSources({conversation,current:()=>{try{current();return true;}catch{return false;}},userMessageId,assistantMessageId},[{passage:{case:'excerpt',value:{text,targetMessageId:candidate.quote_message_uuid}}}]);
        }catch{current();continue;}
      }
      const target=files.get(row.id)??learnAttachment(row,conversation.id);
      if(target.id!==row.id || target.name!==row.name || target.size!==row.size || (target.conversationId && target.conversationId!==conversation.id))continue;
      const previous=target.inlineDisplay,display={...candidate};target.inlineDisplay=display;
      try{persist();}catch(error){if(target.inlineDisplay===display)target.inlineDisplay=previous;throw error;}
      continue;
    }
    const receipt=await ctx.readConfirmedUpload(conversation.id,row.id);
    current();
    if(!receipt || receipt.conversationId!==conversation.id || receipt.rowId!==row.id || !allowed.has(receipt.localId) ||
       receipt.name!==row.name || receipt.size!==row.size)continue;
    const local=files.get(receipt.localId);
    if(!local?.inlineDisplay || local.name!==receipt.name || local.size!==receipt.size ||
       local.inlineDisplay.sha256!==receipt.sha256 || !(receipt.data instanceof Uint8Array) ||
       receipt.data.byteLength!==receipt.size || createHash("sha256").update(receipt.data).digest("hex")!==receipt.sha256)continue;
    // A legacy positional alias is not proof and must not turn two rows into one object.
    if(row.id!==local.id && cloudAliases.has(row.id))continue;
    const target=files.get(row.id)??learnAttachment(row,conversation.id);
    if(target.id!==row.id || target.name!==row.name || target.size!==row.size ||
       (target.conversationId && target.conversationId!==conversation.id))continue;
    const previous=target.inlineDisplay;
    const display={...local.inlineDisplay};
    target.inlineDisplay=display;
    try{persist();}catch(error){if(target.inlineDisplay===display)target.inlineDisplay=previous;throw error;}
  }
}

/** After a cloud send: the runner's attachment rows are the files sent from here, in order. */
export function aliasCloudAttachments(local: string[], cloud: Attachment[]) {
  cloud.forEach((row, i) => {
    if (local[i] && row.id !== local[i]) cloudAliases.set(row.id, local[i]);
  });
  persist();
}

/**
 * The registry survives restarts (the page keeps showing a sent file's tile
 * and the cloud row stays tied to the local copy).
 */
export function loadFileRegistry() {
  const data = readState<{ files?: KnownFile[]; aliases?: [string, string][] }>(
    "files",
    {},
  );
  for (const file of data.files ?? []) if (file?.id) files.set(file.id, file);
  for (const [cloud, local] of data.aliases ?? [])
    cloudAliases.set(cloud, local);
  registerIncognitoRegistryCleanup(currentAdapterScope().sessionIdentity,
    bindAdapterScope((conversation, remaining) => forgetIncognitoFiles(conversation, remaining)));
}
export function ensureFileRegistry() {
  const state = scopedValue("files-loaded", () => ({ loaded: false }));
  if (!state.loaded) {
    loadFileRegistry();
    state.loaded = true;
  }
}
function persist() {
  writeState("files", () => {
    // The newest 2000 files are enough for the tiles a person scrolls back to.
    const recent = [...files.values()].filter(file => !file.incognitoDraft)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 2000);
    const keep = new Set(recent.map((f) => f.id));
    return {
      files: recent,
      aliases: [...cloudAliases].filter(([, local]) => keep.has(local)),
    };
  });
}

// Ephemeral proof minted only after this activation's owned upload completes.
// Never serialized or inferred from a transcript/registry path.
const ownedUploadReads = new WeakMap<KnownFile, (bytes?: Uint8Array) => void>();
function rememberOwnedUploadRead(ctx: AdapterContext, file: KnownFile, digest: string) {
  const owner=ctx.account()?.id, identity=ctx.sessionIdentity?.(), root=ctx.stateDirectory?.(), scope=currentAdapterScope();
  if (!owner || identity == null || !root || !file.path)
    throw new FileReadError(503,"Invalid owned upload location.");
  const base = path.join(root, "attachments");
  const folder = file.incognitoDraft ? incognitoUploadFolder(root, file.incognitoDraft) : base;
  if (file.path !== path.join(folder, file.id, file.name))
    throw new FileReadError(503,"Invalid owned upload location.");
  const paths=[root,base,...(file.incognitoDraft ? [incognitoUploadFolder(root), folder] : []),path.join(folder,file.id),file.path];
  const fileIndex = paths.length - 1;
  let original: fs.Stats[];
  let canonicalRoot: string;
  try {
    // System parent aliases such as macOS /var are valid profile locations.
    // Pin their resolved destination; never allow a later retarget or linked
    // profile/attachment directory to replace this activation's upload store.
    canonicalRoot=fs.realpathSync(root);
    original=paths.map(p=>fs.lstatSync(p));
    if(original.some((v,i)=>v.isSymbolicLink() || (i===fileIndex ? !v.isFile() || v.size!==file.size : !v.isDirectory())))throw Error();
  } catch { throw new FileReadError(503,"The owned upload could not be verified."); }
  const validate=(bytes?:Uint8Array,registered=true)=>{
    if(currentAdapterScope()!==scope || ctx.account()?.id!==owner || ctx.sessionIdentity?.()!==identity ||
       ctx.stateDirectory?.()!==root || ctx.isCurrent?.()===false || (registered && knownFile(file.id)!==file) ||
       file.path!==paths[fileIndex]) throw new FileReadError(409,"The attachment activation changed.");
    try {
      if(fs.realpathSync(root)!==canonicalRoot)throw Error();
      paths.forEach((p,i)=>{
        const now=fs.lstatSync(p), before=original[i];
        if(now.isSymbolicLink() || now.dev!==before.dev || now.ino!==before.ino ||
           (i===fileIndex ? !now.isFile() || now.size!==before.size || now.mtimeMs!==before.mtimeMs || now.ctimeMs!==before.ctimeMs : !now.isDirectory()))throw Error();
      });
    }catch{throw new FileReadError(503,"The owned attachment changed. Reload its conversation.");}
    if(bytes && createHash("sha256").update(bytes).digest("hex")!==digest)
      throw new FileReadError(503,"The owned attachment content changed.");
  };
  const fd=fs.openSync(file.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const before=fs.fstatSync(fd), expected=original[fileIndex];
    if(!before.isFile() || before.dev!==expected.dev || before.ino!==expected.ino || before.size!==file.size)throw new FileReadError(503,"The owned upload changed.");
    const data=Buffer.alloc(file.size+1);let count=0;
    while(count<data.length){const n=fs.readSync(fd,data,count,data.length-count,count);if(!n)break;count+=n;}
    const after=fs.fstatSync(fd);
    if(count!==file.size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)throw new FileReadError(503,"The owned upload changed during verification.");
    validate(data.subarray(0,count),false);
  }finally{fs.closeSync(fd);}
  ownedUploadReads.set(file,validate);
}

const fileReadLimit = 64 * 1024 * 1024;
class FileReadError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 501 | 503,
    message: string,
  ) {
    super(message);
  }
}
/** Bound history always uses the authoritative service, never a transcript-supplied path. */
async function fileBytes(
  ctx: AdapterContext,
  file: KnownFile,
  observe?: FileReadObserver,
): Promise<Buffer | undefined> {
  const historyRead = historyReads.get(file);
  const conversationId = file.conversationId ?? historyRead?.conversationId;
  const rowId = historyRead?.rowId ?? file.rowId ?? file.id;
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > (conversationId ? 32 * 1024 * 1024 : fileReadLimit)
  )
    throw new FileReadError(
      413,
      "The stored file exceeds the attachment read limit.",
    );
  const ownedRead = ownedUploadReads.get(file);
  ownedRead?.();
  if (file.path && (!conversationId || ownedRead)) {
    try {
      const named = fs.lstatSync(file.path);
      if (!named.isSymbolicLink()) {
        if (!named.isFile())
          throw new FileReadError(503, "The attachment is not a regular file.");
        const fd = fs.openSync(
          file.path,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const before = fs.fstatSync(fd);
          if (
            !before.isFile() ||
            before.dev !== named.dev ||
            before.ino !== named.ino ||
            before.size !== file.size
          )
            throw new FileReadError(
              503,
              "The attachment changed. Reload its conversation.",
            );
          // Allocate only the validated source size plus one byte to detect growth.
          const data = Buffer.alloc(before.size + 1);
          let size = 0;
          while (size < data.length) {
            const count = fs.readSync(fd, data, size, data.length - size, size);
            if (!count) break;
            size += count;
          }
          const after = fs.fstatSync(fd),
            latest = fs.lstatSync(file.path);
          if (
            size !== file.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            latest.isSymbolicLink() ||
            latest.dev !== before.dev ||
            latest.ino !== before.ino
          )
            throw new FileReadError(
              503,
              "The attachment changed during the read. Retry.",
            );
          ownedRead?.(data.subarray(0, size));
          return data.subarray(0, size);
        } finally {
          fs.closeSync(fd);
        }
      }
      // Stored uploads are regular copies. For legacy linked rows, only the
      // owned conversation service can validate profile-store confinement.
      if (!conversationId)
        throw new FileReadError(
          503,
          "This linked attachment requires an owned conversation.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error instanceof FileReadError
          ? error
          : new FileReadError(503, "The attachment could not be read. Retry.");
    }
  }
  if (!conversationId) return undefined;
  if(ctx.readConfirmedUpload){
    const owner=ctx.account()?.id, activation=ctx.sessionIdentity?.(), root=ctx.stateDirectory?.(), scope=currentAdapterScope();
    const current=()=>{
      if(!owner || activation==null || ctx.isCurrent?.()!==true || currentAdapterScope()!==scope ||
         ctx.account()?.id!==owner || ctx.sessionIdentity?.()!==activation || ctx.stateDirectory?.()!==root)
        throw new FileReadError(409,"The upload account changed.");
    };
    current();
    let receipt: Awaited<ReturnType<NonNullable<AdapterContext["readConfirmedUpload"]>>>;
    try{receipt=await ctx.readConfirmedUpload(conversationId,rowId);}
    catch{current();throw new FileReadError(503,"The confirmed upload could not be read.");}
    current();
    if(receipt!==undefined){
      if(receipt.conversationId!==conversationId || receipt.rowId!==rowId || receipt.name!==file.name ||
         receipt.size!==file.size || !(receipt.data instanceof Uint8Array) || receipt.data.byteLength!==file.size ||
         !/^[a-f0-9]{64}$/.test(receipt.sha256) || createHash("sha256").update(receipt.data).digest("hex")!==receipt.sha256)
        throw new FileReadError(503,"The confirmed upload identity changed.");
      return Buffer.from(receipt.data);
    }
  }
  let read: unknown;
  try {
    read = await withFileReadDiagnostics(observe, () => ctx.call(
      "turnAttachment",
      conversationId,
      rowId,
    ));
  } catch (error) {
    observe?.("service-error", 503, error);
    throw new FileReadError(
      503,
      "The attachment service could not read this file. Retry.",
    );
  }
  if (read === null || read === undefined) { observe?.("service-null",404); return undefined; }
  const data = (read as { data?: unknown }).data;
  if (
    !(data instanceof Uint8Array) ||
    data.byteLength !== file.size ||
    data.byteLength > 32 * 1024 * 1024
  )
    {
      observe?.(data instanceof Uint8Array ? "invalid-bytes-size" : "invalid-bytes-type",503);
      throw new FileReadError(503,"The attachment service returned invalid file bytes.");
    }
  observe?.("read-success");
  return Buffer.from(data);
}

const fileUrl = (org: string, id: string, variant: string) =>
  `/api/${org}/files/${id}/${variant}`;

/** Display-only metadata; never changes the owned storage name, path, or identity. */
export function fileDisplayName(file: KnownFile): string {
  const name = file.inlineDisplay?.file_name;
  return typeof name === "string" && name.length > 0 && name.length <= 500 &&
    attachmentFileName(name) === name ? name : file.name;
}

/** The upload answer the composer reads (file_uuid, file_kind, assets). */
export function uploadAnswer(org: string, file: KnownFile) {
  const base = {
    success: true,
    file_uuid: file.id,
    file_name: fileDisplayName(file),
    sanitized_name: file.name,
    size_bytes: file.size,
    created_at: new Date(file.createdAt).toISOString(),
  };
  if (file.kind === "image") {
    const asset = (variant: string) => ({
      url: fileUrl(org, file.id, variant),
      file_variant: variant,
      primary_color: "ffffff",
      image_width: file.width ?? 0,
      image_height: file.height ?? 0,
    });
    return {
      ...base,
      file_kind: "image",
      thumbnail_url: fileUrl(org, file.id, "thumbnail"),
      preview_url: fileUrl(org, file.id, "preview"),
      thumbnail_asset: asset("thumbnail"),
      preview_asset: asset("preview"),
    };
  }
  return { ...base, file_kind: "blob", path: `/${file.name}`, download_source: "files-api",
    ...(file.inlineDisplay ? {text_extracted:true} : {}) };
}

/** Reads a multipart body's first file part. */
export async function filePart(
  req: http.IncomingMessage,
  maxBytes?: number,
): Promise<{ name: string; type: string; data: Uint8Array; incognitoDraft?: string } | undefined> {
  const body =
    maxBytes === undefined
      ? await readBody(req)
      : await readBoundedBytes(req, maxBytes);
  const form = await new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": String(req.headers["content-type"] ?? "") },
    body: new Uint8Array(body),
  }).formData();
  const drafts = form.getAll("claudex_incognito_draft");
  const draft = incognitoDraftId.safeParse(drafts[0]);
  if (drafts.length > 1 || drafts.length === 1 && !draft.success)
    throw new FileReadError(400, "Invalid temporary attachment draft.");
  for (const value of form.values()) {
    if (typeof value === "string") continue;
    return {
      name: value.name || "file",
      type: value.type,
      data: new Uint8Array(await value.arrayBuffer()),
      ...(draft.success ? { incognitoDraft: draft.data } : {}),
    };
  }
  return undefined;
}

/** Stores uploaded bytes as a Claudex attachment and remembers them for the file routes. */
export async function storeUpload(
  ctx: AdapterContext,
  name: string,
  data: Uint8Array,
  type?: string,
  incognitoDraft?: string,
): Promise<KnownFile> {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.();
  const current = () => {
    if (
      !owner ||
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation ||
      ctx.stateDirectory?.() !== root ||
      (incognitoDraft && !isIncognitoUploadOpen(incognitoDraft))
    )
      throw new FileReadError(
        409,
        "The account changed. The attachment outcome is not confirmed.",
      );
  };
  current();
  if (activation === undefined || activation === null)
    throw new FileReadError(503, "Attachment session identity is unavailable.");
  if (!root || !path.isAbsolute(root))
    throw new FileReadError(
      503,
      "The account attachment store is unavailable.",
    );
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 500 ||
    !(data instanceof Uint8Array)
  )
    throw new FileReadError(400, "Choose a valid attachment.");
  const normalizedName = attachmentFileName(name);
  const extension = path.extname(normalizedName).slice(1).toLowerCase(),
    kind = attachmentKind(extension);
  if (!attachmentTypes.includes(extension))
    throw new FileReadError(400, "This attachment type is not supported.");
  if (data.byteLength > builtInAttachmentBytes[kind])
    throw new FileReadError(
      413,
      "The attachment exceeds its file-type size limit.",
    );
  let image: { width: number; height: number } | undefined;
  if (kind === "image") {
    if (!ctx.image)
      throw new FileReadError(
        501,
        "Image validation is unavailable on this host.",
      );
    try {
      image = await ctx.image.size(Buffer.from(data));
    } catch {
      current();
      throw new FileReadError(503, "Image validation is unavailable on this host.");
    }
    current();
    if (
      !image ||
      !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) ||
      image.width < 1 ||
      image.height < 1
    )
      throw new FileReadError(400, "The attachment is not a readable image.");
  } else if (extension === "pdf") {
    if (Buffer.from(data.subarray(0, 5)).toString("ascii") !== "%PDF-")
      throw new FileReadError(400, "The attachment has no valid PDF header.");
  } else if (kind === "text") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\0")) throw Error();
    } catch {
      throw new FileReadError(
        400,
        "Text attachments must contain UTF-8 text, not binary data.",
      );
    }
  }
  current();
  const uploadDigest = createHash("sha256").update(data).digest("hex");
  const folder = incognitoDraft ? incognitoUploadFolder(root, incognitoDraft) : path.join(root, "attachments");
  const attachment = (await ctx.call(
    "addAttachmentData",
    name,
    data,
    ...(incognitoDraft ? [{ incognitoDraft }] : []),
  )) as Attachment;
  current();
  if (
    !attachment ||
    typeof attachment.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(attachment.id) ||
    attachment.name !== normalizedName ||
    attachment.size !== data.byteLength ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.kind !== kind ||
    typeof attachment.path !== "string" ||
    attachment.path !==
      path.join(folder, attachment.id, normalizedName) ||
    knownFile(attachment.id)
  )
    throw new FileReadError(
      503,
      "The attachment service returned invalid metadata. Check the upload before retrying.",
    );
  // Browser MIME declarations are not authoritative and must not turn plain
  // attachments into executable HTML or mislabel an image/PDF.
  const mediaType = mediaTypeOf(attachment.name);
  const file: KnownFile = {
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
    mediaType,
    kind:
      attachment.kind === "image"
        ? "image"
        : mediaType === "application/pdf"
          ? "document"
          : "blob",
    ...(image ? { width: image.width, height: image.height } : {}),
    createdAt: Date.now(),
    ...(incognitoDraft ? { incognitoDraft } : {}),
  };
  current();
  rememberOwnedUploadRead(ctx, file, uploadDigest);
  files.set(file.id, file);
  persist();
  return file;
}

const uploadPaths = [
  /^\/api\/([^/]+)\/upload$/,
  /^\/api\/organizations\/([^/]+)\/cowork\/attachments$/,
  /^\/api\/organizations\/([^/]+)\/conversations\/[^/]+\/wiggle\/upload-file$/,
];

export async function filesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const matched =
    /^\/api\/(?:organizations\/)?([^/]+)\/(?:upload|cowork\/attachments|conversations\/[^/]+\/wiggle\/upload-file|convert_document|convert_pdf_token|files\/[^/]+\/(?:preview|thumbnail|contents|content_preview|document_pdf))$/.exec(
      p,
    );
  if (!matched) return false;
  const observe = (method === "GET" || method === "HEAD") && /\/files\/[^/]+\/contents$/.test(p)
    ? fileReadObserver((...args) => ctx.log(...args)) : undefined;
  observe?.("request");
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  if (!owner || matched[1] !== organizationUuid(owner)) {
    observe?.("unauthorized",403);
    return reply(res, { error: "unauthorized" }, 403);
  }
  const check = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      throw new FileReadError(409, "The account changed during this request.");
  };
  // Read-only transformations/token issuance do not store an attachment. Only
  // actual upload routes are mutations; their existing host policy still applies.
  const codeUpload = ctx.officialCodeUpload === true &&
    officialCodeUploadOrganization(method, req.url ?? "");
  const chatUpload = ctx.officialChatUpload === true &&
    officialChatUploadOrganization(method, req.url ?? "");
  if (
    ctx.readOnly &&
    method === "POST" &&
    uploadPaths.some((pattern) => pattern.test(p)) &&
    !codeUpload && !chatUpload
  )
    return reply(
      res,
      { error: "File changes are unavailable on this host." },
      501,
    );
  try {
    check();
    const conversation =
      /^\/api\/organizations\/[^/]+\/conversations\/([^/]+)\/wiggle\/upload-file$/.exec(
        p,
      );
    if (conversation) {
      const owned = await ctx.loadConversation(conversation[1]);
      check();
      if (!owned || owned.id !== conversation[1])
        return reply(res, { error: "Conversation not found." }, 404);
    }
    const conversionToken =
      /^\/api\/organizations\/([^/]+)\/convert_pdf_token$/.exec(p);
    if (conversionToken) {
      if (method !== "POST")
        return reply(res, { error: "method_not_allowed" }, 405);
      const account = ctx.account();
      if (!account || conversionToken[1] !== organizationUuid(account.id))
        return reply(res, { error: "unauthorized" }, 403);
      if (!ctx.documentPreviewToken)
        return reply(res, { error: "document_converter_unavailable" }, 503);
      return reply(res, { token: ctx.documentPreviewToken() });
    }
    if (method === "POST") {
      const upload = uploadPaths.map((re) => re.exec(p)).find(Boolean);
      if (upload) {
        const part = await filePart(req, codeUpload ? officialCodeUploadMaxBytes
          : chatUpload ? officialChatUploadMaxBytes : 64 * 1024 * 1024 + 64 * 1024);
        check();
        if (req.aborted)
          throw new FileReadError(409, "The attachment upload was cancelled.");
        if (part && part.data.byteLength > 64 * 1024 * 1024)
          return reply(res, { error: "The file is too large." }, 413);
        if (!part)
          return reply(
            res,
            {
              error: {
                type: "invalid_request_error",
                message: "No file in the upload.",
              },
            },
            400,
          );
        if (part.incognitoDraft && (!officialChatUploadOrganization(method, p) || !isIncognitoUploadOpen(part.incognitoDraft)))
          return reply(res, { error: "This temporary attachment draft is closed." }, 409);
        try {
          const uploadContext = {
            ...ctx,
            isCurrent: () => ctx.isCurrent?.() !== false && !req.aborted,
          };
          const file = await storeUpload(
            uploadContext,
            part.name,
            part.data,
            part.type,
            part.incognitoDraft,
          );
          check();
          return reply(res, uploadAnswer(upload[1], file));
        } catch (error) {
          if (error instanceof FileReadError) throw error;
          const message =
            "The file could not be stored for this account. Check the upload before retrying.";
          return reply(
            res,
            {
              type: "error",
              error: { type: "invalid_request_error", message },
            },
            400,
          );
        }
      }
      if (isOfficialUiDocumentConversion(method, req.url ?? p)) {
        const part = await filePart(req, officialUiRequestLimit(method, p));
        check();
        if (part && part.data.byteLength > knowledgeFileLimit)
          return reply(res, { error: "The file is too large." }, 413);
        if (!part)
          return reply(res, { error: { type: "invalid_request_error", message: "No file." } }, 400);
        const mediaType = part.type || mediaTypeOf(part.name);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.once?.("close", cancel);
        try {
          if (req.aborted) cancel();
          const text = await extractKnowledgeDocument({
            data: Buffer.from(part.data.buffer, part.data.byteOffset, part.data.byteLength),
            name: part.name,
            mediaType,
            runtime: ctx.documentRuntime,
            signal: abort.signal,
          });
          check();
          return reply(res, {
            file_name: part.name,
            file_size: part.data.byteLength,
            file_type: mediaType,
            extracted_content: text,
          });
        } catch (error) {
          check();
          if (abort.signal.aborted) throw new FileReadError(409, "The document conversion was cancelled.");
          if (error instanceof OfficeRuntimeUnavailable)
            return reply(res, { error: { type: "document_converter_unavailable", message: error.message } }, 503);
          if (!(error instanceof KnowledgeDocumentError)) throw error;
          const status = { invalid_text: 400, invalid_file_type: 415, extraction_failed: 422, file_too_large: 413 }[error.kind];
          return reply(res, { error: { type: error.kind, message: error.message } }, status);
        } finally {
          res.off?.("close", cancel);
        }
      }
    }
    const served =
      /^\/api\/(?:organizations\/)?[^/]+\/files\/([^/]+)\/(preview|thumbnail|contents|content_preview|document_pdf)$/.exec(
        p,
      );
    if (served && (method === "GET" || method === "HEAD")) {
      const file = knownFile(served[1]);
      observe?.(file ? "registry-hit" : "registry-miss");
      const bytes = file ? await fileBytes(ctx, file, observe) : undefined;
      check();
      if (ctx.isCurrent && !ctx.isCurrent())
        return reply(
          res,
          {
            type: "error",
            error: {
              type: "authentication_error",
              message: "The account changed during this request.",
            },
          },
          401,
        );
      if (!file || !bytes) {
        observe?.("response",404);
        return reply(
          res,
          {
            type: "error",
            error: { type: "not_found_error", message: "File not found" },
          },
          404,
        );
      }
      let data: Buffer = bytes;
      let type = file.mediaType;
      if (served[2] === "thumbnail" && file.kind === "image" && ctx.image) {
        const small = ctx.image.thumbnail?.(data, 400);
        if (small) {
          data = small;
          type = "image/png";
        }
      }
      if (served[2] === "document_pdf") {
        if (
          type !== "application/pdf" ||
          !data.subarray(0, 8).toString("ascii").startsWith("%PDF-")
        )
          return reply(
            res,
            { error: "PDF conversion is unavailable for this attachment." },
            501,
          );
      }
      if (served[2] === "content_preview") {
        if (!(
          type.startsWith("text/") ||
          ["application/json", "application/xml"].includes(type)
        ))
          return reply(
            res,
            {
              error: "Text extraction is unavailable for this attachment type.",
            },
            501,
          );
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          return reply(
            res,
            { error: "The attachment is not valid UTF-8 text." },
            400,
          );
        }
        if (content.includes("\0"))
          return reply(
            res,
            { error: "Binary content is not a text preview." },
            400,
          );
        return reply(res, { content: content.slice(0, 20000) });
      }
      observe?.("response",200);
      res.writeHead(200, {
        ...attachmentResponseHeaders(file, type, served[2] === "contents"),
        "Content-Length": data.length,
        ...(!file.incognitoDraft && req.headers?.["x-claudex-object-transfer"] === "1"
          ? { "X-Claudex-Store-Attachment": encodeURIComponent(file.name) } : {}),
      });
      res.end(method === "HEAD" ? undefined : data);
      return true;
    }
    return reply(res, { error: "method_not_allowed" }, 405);
  } catch (error) {
    observe?.("response",error instanceof RequestBodyError || error instanceof FileReadError ? error.status : 400);
    return reply(
      res,
      {
        error: {
          type: "invalid_request_error",
          message:
            error instanceof RequestBodyError || error instanceof FileReadError
              ? error.message
              : "The file request could not be completed. Retry.",
        },
      },
      error instanceof RequestBodyError || error instanceof FileReadError
        ? error.status
        : 400,
    );
  }
}

/** Forget only this temporary conversation's registry entries; shared ordinary files survive. */
export function forgetIncognitoFiles(conversation: Conversation, remaining: Conversation[]) {
  const attachmentIds = (c: Conversation) => [
    ...(c.turns ?? []).flatMap(t => t.attachments ?? []),
    ...(c.savedBranches ?? []).flatMap(b => (b.turns ?? []).flatMap(t => t.attachments ?? [])),
  ].map(a => a.id);
  const keep = new Set(remaining.flatMap(attachmentIds));
  const keepFiles = new Set([...keep].map(id => knownFile(id)));
  const retiring = new Set(attachmentIds(conversation));
  const retiringFiles = new Set([...retiring].map(id => knownFile(id)));
  for (const [id, file] of files) {
    if (!retiring.has(id) && !retiringFiles.has(file) && file.conversationId !== conversation.id) continue;
    if (borrowedOrdinaryFiles.has(file) && !file.incognitoDraft) continue;
    if (keepFiles.has(file) || keep.has(id) || (file.rowId && keep.has(file.rowId))) {
      if (file.conversationId === conversation.id) {
        const survivor = remaining.find(c => attachmentIds(c).some(a => knownFile(a) === file || a === id || a === file.rowId));
        file.conversationId = survivor?.id;
      }
      continue;
    }
    ownedUploadReads.delete(file);
    files.delete(id);
    for (const [alias, local] of cloudAliases) if (alias === id || local === id) cloudAliases.delete(alias);
  }
  persist();
  flushFileRegistry();
}

/** Finish a previously queued registry save before confirming temporary exit. */
export function flushFileRegistry() { readState("files", {}); }

const closedIncognitoDrafts = new ScopedMap<string, "closing" | "closed">("closed-incognito-drafts");
const incognitoDraftOwners = new ScopedMap<string, string>("incognito-draft-owners");
const borrowedOrdinaryFiles = new WeakSet<KnownFile>();
function isIncognitoUploadOpen(draftId: string) {
  return !closedIncognitoDrafts.has(draftId);
}
export function bindIncognitoFiles(ids: string[], conversationId?: string) {
  const drafts = new Set(ids.flatMap(id => {
    const draft = knownFile(id)?.incognitoDraft;
    return draft ? [draft] : [];
  }));
  for (const draft of drafts) {
    const owner = incognitoDraftOwners.get(draft);
    if (!conversationId || !isIncognitoUploadOpen(draft) || (owner && owner !== conversationId))
      throw Error("An attachment belongs to another temporary chat. Attach it again.");
  }
  if (conversationId) {
    for (const draft of drafts) incognitoDraftOwners.set(draft, conversationId);
    for (const id of ids) {
      const file = knownFile(id);
      if (file && !file.incognitoDraft) borrowedOrdinaryFiles.add(file);
    }
  }
}
export function incognitoConversationDrafts(conversationId: string, draftId?: string) {
  if (draftId && incognitoDraftOwners.has(draftId) && incognitoDraftOwners.get(draftId) !== conversationId)
    throw Error("This temporary attachment draft belongs to another chat.");
  return [...incognitoDraftOwners].filter(([, owner]) => owner === conversationId).map(([draft]) => draft);
}
export function beginIncognitoUploadDiscard(draftIds: string[]) {
  if (draftIds.some(id => closedIncognitoDrafts.get(id) === "closing"))
    throw Error("The temporary chat is already closing.");
  const open = draftIds.filter(isIncognitoUploadOpen);
  for (const id of open) closedIncognitoDrafts.set(id, "closing");
  return (confirmed: boolean) => {
    for (const id of open) {
      if (confirmed) closedIncognitoDrafts.set(id, "closed");
      else closedIncognitoDrafts.delete(id);
    }
  };
}
export function forgetIncognitoUploadDraft(draftId: string) {
  incognitoDraftOwners.delete(draftId);
  for (const [id, file] of files) {
    if (file.incognitoDraft !== draftId) continue;
    files.delete(id);
    ownedUploadReads.delete(file);
  }
}
