import { fromBinary } from "@bufbuild/protobuf";
import { prepareDerivedTextAttachment } from "../../electron/official-ui/api/derived-text-attachment";
import { nativeCompletionInlineSchema } from "../../electron/official-ui/api/completion-attachments";
import { registryFor } from "../../electron/official-ui/api/timeline";
import { officialUiActionPath, isOfficialUiCompletionSubmission, type OfficialUiReadRequest } from "../../shared/official-ui-web";

const excerptName = "excerpt_from_previous_claude_message.txt";

/** The exact inline excerpt produced by the original Reply control. */
export function validOfficialExcerpt(item: {
  fileName?: unknown;
  fileType?: unknown;
  fileSize?: unknown;
  extractedContent?: unknown;
}): boolean {
  if (
    item.fileName !== excerptName ||
    item.fileType !== "txt" ||
    typeof item.extractedContent !== "string" ||
    item.extractedContent.length > 20_000 ||
    !item.extractedContent.trim() ||
    item.extractedContent.includes("\0") ||
    Array.from(item.extractedContent).length > 10000
  )
    return false;
  return item.fileSize === BigInt(Buffer.byteLength(item.extractedContent, "utf8"));
}

/** Validate the extracted text emitted by the original file picker. */
function prepareOfficialInline(item: {
  fileName?: unknown;
  fileType?: unknown;
  fileSize?: unknown;
  extractedContent?: unknown;
}) {
  if (item.fileName === excerptName && !validOfficialExcerpt(item)) return undefined;
  if (typeof item.fileName !== "string" || typeof item.fileType !== "string" ||
      typeof item.fileSize !== "bigint" || item.fileSize < 0n ||
      item.fileSize > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  try { return prepareDerivedTextAttachment(item); }
  catch { return undefined; }
}

export function validOfficialInline(item: Parameters<typeof prepareOfficialInline>[0]): boolean {
  return prepareOfficialInline(item) !== undefined;
}

const actionUploads = new WeakMap<OfficialUiReadRequest, {
  body: Uint8Array;
  root: string;
  files: NonNullable<ReturnType<typeof prepareOfficialInline>>[];
}>();

/** An internal upload may only contain bytes from the active original action. */
export function matchesOfficialInlineUpload(
  request: OfficialUiReadRequest,
  root: string,
  args: unknown[],
  isExistingTemporary: (id: string) => boolean = () => false,
): boolean {
  if (
    request.method !== "POST" ||
    request.path !== officialUiActionPath ||
    !/^application\/proto(?:\s*;.*)?$/i.test(request.contentType ?? "") ||
    !(request.body instanceof Uint8Array) ||
    (args.length !== 2 && args.length !== 3) ||
    typeof args[0] !== "string" ||
    !(args[1] instanceof Uint8Array)
  )
    return false;
  try {
    let uploads = actionUploads.get(request);
    if (!uploads || uploads.body !== request.body || uploads.root !== root) {
      const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest");
      if (!schema) return false;
      const parsed: any = fromBinary(schema, request.body);
      if (parsed.action?.case !== "sendMessage") return false;
      const inline: Parameters<typeof prepareOfficialInline>[0][] = parsed.action.value.inlineAttachments ?? [];
      if (inline.length > 12) return false;
      const files = inline.map(prepareOfficialInline).filter(file => file !== undefined);
      if (files.length !== inline.length) return false;
      uploads = { body: request.body, root, files };
      actionUploads.set(request, uploads);
    }
    const [name, data, options] = args;
    if (options !== undefined) {
      const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest");
      if (!schema) return false;
      const parsed: any = fromBinary(schema, request.body);
      const id = parsed.header?.conversationId;
      if (!validPrivateOwner(options, id) || !(parsed.action?.value?.isTemporary || isExistingTemporary(id))) return false;
    }
    return uploads.files.some(file => file.name === name &&
      Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength).equals(data));
  } catch {
    return false;
  }
}


function validPrivateOwner(options: unknown, id: unknown): boolean {
  return typeof id === "string" && !!options && typeof options === "object" && !Array.isArray(options) &&
    Object.keys(options).length === 1 && "incognitoDraft" in options && options.incognitoDraft === id;
}

/** Bind REST fallback uploads to exact, validated inline text in this request. */
export function matchesOfficialRestTextUpload(request:OfficialUiReadRequest,args:unknown[],isExistingTemporary: (id: string) => boolean = () => false):boolean {
  if(!isOfficialUiCompletionSubmission(request.method,request.path) || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType??"") || !(request.body instanceof Uint8Array) || (args.length!==2 && args.length!==3) || typeof args[0]!=="string" || !(args[1] instanceof Uint8Array))return false;
  try {
    const parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(request.body));
    if (args.length === 3) {
      const id = request.path.split("/")[5];
      if (!validPrivateOwner(args[2], id) || !(parsed.create_conversation_params?.is_temporary === true || isExistingTemporary(id))) return false;
    }
    const attachments=nativeCompletionInlineSchema.safeParse(parsed.attachments);
    if(!attachments.success)return false;
    return attachments.data.some(item=>{
      if(item.kind === "excerpt" ? !validRestExcerpt(item) : item.quote_message_uuid !== undefined || item.file_name === excerptName)return false;
      const derived=prepareDerivedTextAttachment({fileName:item.file_name,fileType:item.file_type,extractedContent:item.extracted_content});
      return derived.name===args[0] && Buffer.from(derived.data).equals(Buffer.from(args[1] as Uint8Array));
    });
  } catch {return false;}
}
export function validRestExcerpt(item:any):boolean {
  if(!item || item.kind!=="excerpt" || !Number.isSafeInteger(item.file_size) || item.file_size<0)return false;
  return validOfficialExcerpt({fileName:item.file_name,fileType:item.file_type,fileSize:BigInt(item.file_size),extractedContent:item.extracted_content});
}
